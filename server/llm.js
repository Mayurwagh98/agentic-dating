// Provider-agnostic LLM client. Every major provider (Gemini, OpenAI, Groq, OpenRouter)
// exposes an OpenAI-compatible /chat/completions endpoint, so one fetch call covers all.
//
// Resilience (free-tier friendly):
//  * A "target" is provider + model. Targets come from the primary provider's model chain, then
//    any extra providers that have a key set (GROQ_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY,
//    GEMINI_API_KEY) as backups.
//  * 429 (quota) / 503 (overloaded) / timeout -> that target goes on COOLDOWN (using the
//    provider's retryDelay when given) and the call moves on immediately. No hammering.
//  * 404 / retired model -> target is marked dead for this run.
//  * If every target is cooling down, we wait for the first one to come back instead of failing.
//  * Calls rotate across healthy targets, so separate per-model quotas add up.

const PROVIDERS = {
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'],
  },
  groq: { base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'] },
  openrouter: { base: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'google/gemini-flash-1.5'] },
  openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4.1-mini'] },
};
const EXTRA_KEYS = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY' };

const cooldown = new Map(); // target id -> timestamp when usable again
// --- stop support: cancelAll() aborts in-flight requests and makes queued/waiting calls throw ---
let llmGen = 0;
let stopCtrl = new AbortController();
export function cancelAll() {
  llmGen++;
  stopCtrl.abort();
  stopCtrl = new AbortController();
}
const anySignal = (signals) => {
  if (AbortSignal.any) return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  return c.signal;
};
const dead = new Set(); // target ids that are gone for this run
let rr = 0; // round-robin cursor

export function llmConfig() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const key = process.env.LLM_API_KEY || '';
  const isMock = provider === 'mock' || !key;
  const targets = [];
  const add = (prov, base, k, models) => models.forEach((m) => targets.push({ id: `${prov}:${m}`, provider: prov, base, key: k, model: m }));
  if (!isMock) {
    const custom = (process.env.LLM_MODELS || process.env.LLM_MODEL || '').split(',').map((m) => m.trim()).filter(Boolean);
    const preset = PROVIDERS[provider] || { models: [] };
    add(provider, process.env.LLM_BASE_URL || preset.base, key, [...new Set([...custom, ...preset.models])]);
    for (const [prov, envName] of Object.entries(EXTRA_KEYS)) {
      if (prov !== provider && process.env[envName]) add(prov, PROVIDERS[prov].base, process.env[envName], PROVIDERS[prov].models);
    }
  }
  const healthy = targets.find((t) => !dead.has(t.id) && (cooldown.get(t.id) || 0) <= Date.now());
  return {
    provider: isMock ? 'mock' : provider,
    model: isMock ? 'mock' : healthy?.model || targets[0]?.model,
    chain: targets.map((t) => t.model),
    targets,
    base: targets[0]?.base,
    key,
    isMock,
  };
}

// --- concurrency gate so we don't blow through per-minute limits ---
let active = 0;
const queue = [];
function gate() {
  const max = Number(process.env.LLM_CONCURRENCY || 2);
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
class Unavailable extends Error { constructor(msg, { cool = 0, gone = false } = {}) { super(msg); this.cool = cool; this.gone = gone; } }
class Fatal extends Error {}

function retryDelayMs(text, fallback) {
  const m = text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/) || text.match(/try again in (\d+(?:\.\d+)?)s/i);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : fallback;
}

async function callTarget(t, { system, user, temperature, maxTokens }) {
  let noReasoningParam = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model: t.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (t.provider === 'gemini') {
      if (!noReasoningParam) body.reasoning_effort = /2\.5-flash/.test(t.model) ? 'none' : 'low';
      body.max_tokens = maxTokens + 1500; // headroom if the model still "thinks"
    }
    let res;
    try {
      res = await fetch(`${t.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
        body: JSON.stringify(body),
        signal: anySignal([AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 45000)), stopCtrl.signal]),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Fatal('Stopped by user');
      if (e.name === 'TimeoutError') throw new Unavailable(`${t.id}: timed out`, { cool: 120000 });
      if (attempt === 0) { await sleep(1000); continue; } // network blip
      throw new Unavailable(`${t.id}: ${e.message}`, { cool: 30000 });
    }
    if (res.ok) {
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content;
      if (text) return text;
      throw new Unavailable(`${t.id}: empty response`, { cool: 15000 });
    }
    const errText = (await res.text()).slice(0, 600);
    if (res.status === 401 || res.status === 403) throw new Unavailable(`${t.id}: ${res.status} bad key / no access`, { gone: true });
    if (res.status === 404 || /no longer available|is not found|does not exist|not supported for generateContent|unknown model|invalid model/i.test(errText)) {
      throw new Unavailable(`${t.id}: model not available (${res.status})`, { gone: true });
    }
    if (res.status === 400 && body.reasoning_effort) { noReasoningParam = true; continue; }
    if (res.status === 429) {
      const daily = /per.?day|PerDay|daily/i.test(errText);
      throw new Unavailable(`${t.id}: quota hit${daily ? ' (daily limit)' : ''}`, { cool: daily ? 6 * 3600000 : retryDelayMs(errText, 60000) });
    }
    if (res.status >= 500) throw new Unavailable(`${t.id}: ${res.status} overloaded`, { cool: retryDelayMs(errText, 30000) });
    throw new Fatal(`LLM ${res.status} on ${t.id}: ${errText.slice(0, 300)}`);
  }
  throw new Unavailable(`${t.id}: failed`, { cool: 30000 });
}

let lastUsed = null;
/**
 * chat({ system, user, temperature, maxTokens }) -> string
 */
export async function chat({ system, user, temperature = 0.7, maxTokens = 2000 }) {
  const cfg = llmConfig();
  if (cfg.isMock) throw new Error('chat() called in mock mode');
  const g = llmGen;
  const release = await gate();
  const opts = { system, user, temperature, maxTokens };
  const errors = [];
  const stopped = () => { if (g !== llmGen) throw new Error('Stopped by user'); };
  const deadline = Date.now() + Number(process.env.LLM_MAX_WAIT_MS || 300000);
  try {
    while (Date.now() < deadline) {
      stopped();
      const now = Date.now();
      const live = cfg.targets.filter((t) => !dead.has(t.id));
      if (!live.length) break;
      const ready = live.filter((t) => (cooldown.get(t.id) || 0) <= now);
      if (!ready.length) {
        const wait = Math.min(...live.map((t) => cooldown.get(t.id))) - now;
        if (now + wait > deadline) break;
        console.warn(`[llm] all models cooling down (rate limits). Waiting ${Math.ceil(wait / 1000)}s...`);
        // sleep in small steps so Stop takes effect quickly
        const until = Date.now() + Math.max(wait, 500);
        while (Date.now() < until) { stopped(); await sleep(Math.min(1000, until - Date.now())); }
        continue;
      }
      // rotate among the first few healthy targets so per-model quotas add up
      const pool = ready.slice(0, Number(process.env.LLM_ROTATE || 3));
      const t = pool[rr++ % pool.length];
      try {
        const text = await callTarget(t, opts);
        if (lastUsed !== t.id) { lastUsed = t.id; console.log(`[llm] using model: ${t.id}`); }
        return text;
      } catch (e) {
        if (e instanceof Fatal) throw e;
        errors.push(e.message);
        if (e.gone) dead.add(t.id);
        else cooldown.set(t.id, Date.now() + e.cool);
        console.warn(`[llm] ${e.message}${e.gone ? ' (skipping for this run)' : ` (cooldown ${Math.round(e.cool / 1000)}s)`}`);
      }
    }
    throw new Error(`No model available (all rate-limited or retired). Wait a few minutes, add GROQ_API_KEY as backup, or enable billing. Last errors: ${errors.slice(-4).join(' | ')}`);
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
