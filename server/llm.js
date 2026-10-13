// Provider-agnostic LLM client. Every major provider (Gemini, OpenAI, Groq, OpenRouter)
// exposes an OpenAI-compatible /chat/completions endpoint, so one fetch call covers all.
//
// Model fallback: each provider has an ordered chain of models. If a model is retired (404),
// rejected (400 "model"), or out of quota (429 after retries), we move to the next one, and
// remember whichever worked so later calls go straight to it. If the whole chain fails, we
// ask the provider's /models endpoint what's actually available and try those.

const PRESETS = {
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-flash-latest'],
  },
  openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'] },
  groq: { base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  openrouter: { base: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'google/gemini-flash-1.5'] },
};

let activeModel = null; // last model that worked (sticky)
let discovered = null; // models found via /models when the chain fails
const dead = new Set(); // models that returned 404 / "not available"

export function llmConfig() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const preset = PRESETS[provider] || { models: [] };
  const key = process.env.LLM_API_KEY || '';
  const isMock = provider === 'mock' || !key;
  // LLM_MODELS="a,b,c" (or LLM_MODEL="a") goes first, then the preset chain
  const custom = (process.env.LLM_MODELS || process.env.LLM_MODEL || '').split(',').map((m) => m.trim()).filter(Boolean);
  const chain = [...new Set([...custom, ...preset.models])];
  return {
    provider: isMock ? 'mock' : provider,
    model: isMock ? 'mock' : activeModel || chain[0],
    chain,
    base: process.env.LLM_BASE_URL || preset.base,
    key,
    isMock,
  };
}

// --- simple concurrency gate so we don't blow through rate limits ---
let active = 0;
const queue = [];
function gate() {
  const max = Number(process.env.LLM_CONCURRENCY || 4);
  return new Promise((resolve) => {
    const tryRun = () => {
      if (active < max) {
        active++;
        resolve(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      } else queue.push(tryRun);
    };
    tryRun();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ModelUnavailable extends Error {}
class Fatal extends Error {}

// One model, with retries for transient errors.
async function callModel(cfg, model, { system, user, temperature, maxTokens }) {
  let noReasoningParam = false;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (cfg.provider === 'gemini') {
      // keep "thinking" short: faster, and it doesn't eat the output budget
      if (!noReasoningParam) body.reasoning_effort = /2\.5-flash/.test(model) ? 'none' : 'low';
      body.max_tokens = maxTokens + 1500;
    }
    let res;
    const t0 = Date.now();
    try {
      // hard timeout so a hanging request can never freeze the pipeline
      res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 60000)),
      });
    } catch (e) {
      lastErr = new Error(`${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
      console.warn(`[llm] ${lastErr.message} (attempt ${attempt + 1})`);
      if (e.name === 'TimeoutError' && attempt >= 1) break; // slow model: move on to the next one
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (process.env.LLM_DEBUG) console.log(`[llm] ${model} ${res.status} in ${Date.now() - t0}ms`);
    if (res.ok) {
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content;
      if (text) return text;
      lastErr = new Error(`${model} returned an empty response`);
      continue;
    }
    const errText = (await res.text()).slice(0, 400);
    if (res.status === 401 || res.status === 403) throw new Fatal(`LLM ${res.status} (check LLM_API_KEY): ${errText}`);
    if (res.status === 404 || /not found|no longer available|does not exist|not supported|unknown model|invalid model/i.test(errText)) {
      throw new ModelUnavailable(`${model}: ${res.status} ${errText.slice(0, 160)}`);
    }
    if (res.status === 400 && body.reasoning_effort) {
      noReasoningParam = true; // provider didn't like the param: retry without it
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`LLM ${res.status} on ${model}: ${errText.slice(0, 160)}`);
      if (res.status === 503 && attempt >= 1) break; // overloaded: don't wait, use the next model
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    throw new Fatal(`LLM ${res.status} on ${model}: ${errText}`);
  }
  // still failing after retries (quota / overload): let the caller try the next model
  throw new ModelUnavailable(lastErr?.message || `${model} kept failing`);
}

async function discoverModels(cfg) {
  if (discovered) return discovered;
  try {
    const res = await fetch(`${cfg.base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } });
    const json = await res.json();
    const ids = (json.data || json.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    const score = (id) => (/flash/.test(id) ? 2 : /mini|instant/.test(id) ? 1 : 0) - (/lite|preview|exp|tts|image|embed|audio|live/.test(id) ? 3 : 0);
    discovered = ids.filter((id) => score(id) > 0).sort((a, b) => score(b) - score(a) || b.localeCompare(a, undefined, { numeric: true })).slice(0, 6);
    console.log(`[llm] discovered models: ${discovered.join(', ') || '(none)'}`);
  } catch (e) {
    discovered = [];
  }
  return discovered;
}

/**
 * chat({ system, user, temperature, maxTokens }) -> string
 */
export async function chat({ system, user, temperature = 0.7, maxTokens = 2000 }) {
  const cfg = llmConfig();
  if (cfg.isMock) throw new Error('chat() called in mock mode');
  const release = await gate();
  const opts = { system, user, temperature, maxTokens };
  const errors = [];
  try {
    const tryList = async (models) => {
      for (const model of models) {
        if (dead.has(model)) continue;
        try {
          const text = await callModel(cfg, model, opts);
          if (activeModel !== model) {
            activeModel = model;
            console.log(`[llm] using model: ${model}`);
          }
          return text;
        } catch (e) {
          if (e instanceof Fatal) throw e;
          errors.push(e.message);
          if (/404|not found|no longer available|does not exist/i.test(e.message)) dead.add(model);
          if (activeModel === model) activeModel = null;
          console.warn(`[llm] ${e.message.slice(0, 160)} -> trying next model`);
        }
      }
      return null;
    };
    const ordered = activeModel ? [activeModel, ...cfg.chain.filter((m) => m !== activeModel)] : cfg.chain;
    let text = await tryList(ordered);
    if (text == null) text = await tryList((await discoverModels(cfg)).filter((m) => !ordered.includes(m)));
    if (text == null) throw new Error(`All models failed. Set LLM_MODEL in .env to one your key can use. Errors: ${errors.join(' | ').slice(0, 600)}`);
    return text;
  } finally {
    release();
  }
}

/** Ask for JSON and parse it robustly (handles ```json fences and chatter). */
export async function chatJSON(opts) {
  const system = `${opts.system}\n\nRespond with ONLY a valid JSON object. No markdown fences, no commentary.`;
  try {
    return parseJSON(await chat({ ...opts, system }));
  } catch (e) {
    if (!/parse JSON|Unexpected|JSON/.test(e.message)) throw e;
    // one retry with a firmer nudge (truncated or chatty output)
    return parseJSON(await chat({ ...opts, system: system + '\nKeep it concise so the JSON is complete.', temperature: 0.3 }));
  }
}

export function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Could not parse JSON from model output: ' + cleaned.slice(0, 200));
  }
}
