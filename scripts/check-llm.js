// Quick diagnostic: tries each model in the chain and prints exactly what happens.
//   npm run check:llm
import 'dotenv/config';
import { llmConfig } from '../server/llm.js';

const cfg = llmConfig();
console.log(`Provider: ${cfg.provider}   Base: ${cfg.base}   Key: ${cfg.key ? cfg.key.slice(0, 6) + '…' : 'MISSING'}\n`);
if (cfg.isMock) { console.log('No LLM_API_KEY in .env, so the app uses the mock agent.'); process.exit(0); }

try {
  const r = await fetch(`${cfg.base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const ids = (j.data || []).map((m) => String(m.id).replace(/^models\//, '')).filter((id) => /flash|mini|instant/.test(id));
  console.log(`/models -> HTTP ${r.status}. Fast models your key can use:\n  ${ids.join(', ') || JSON.stringify(j).slice(0, 300)}\n`);
} catch (e) { console.log(`/models failed: ${e.message}\n`); }

for (const model of cfg.chain) {
  const t0 = Date.now();
  try {
    const body = { model, max_tokens: 200, messages: [{ role: 'user', content: 'Reply with exactly: {"ok":true}' }] };
    if (cfg.provider === 'gemini') body.reasoning_effort = /2\.5-flash/.test(model) ? 'none' : 'low';
    const r = await fetch(`${cfg.base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`${r.ok ? '✅' : '❌'} ${model.padEnd(22)} HTTP ${r.status} in ${Date.now() - t0}ms  ${r.ok ? (JSON.parse(t).choices?.[0]?.message?.content || '').slice(0, 60) : t.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`❌ ${model.padEnd(22)} ${e.name === 'TimeoutError' ? 'TIMED OUT after 30s' : e.message}`);
  }
}
console.log('\nPut the first ✅ model in .env as LLM_MODELS=<model> to skip the others.');
