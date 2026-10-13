import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import * as store from './store.js';
import * as pipe from './pipeline.js';
import { llmConfig } from './llm.js';

store.load();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.resolve('public')));
app.use('/avatars', express.static(path.resolve(process.env.DATA_DIR || 'data', 'avatars')));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
const admin = (req, res, next) => {
  const t = process.env.ADMIN_TOKEN;
  if (t && req.get('x-admin-token') !== t) return res.status(403).json({ error: 'Admin token required' });
  next();
};

// ---------- config / state ----------
app.get('/api/config', (req, res) => {
  const llm = llmConfig();
  res.json({
    llm: { provider: llm.provider, model: llm.model },
    scraper: (process.env.SCRAPER || 'apify').toLowerCase(),
    apify: !!process.env.APIFY_TOKEN,
    dateTurns: Number(process.env.DATE_TURNS || 8),
    shortlistK: Number(process.env.SHORTLIST_K || 4),
    adminLocked: !!process.env.ADMIN_TOKEN,
  });
});

app.get('/api/state', (req, res) => {
  const d = store.get();
  res.json({
    people: d.people.map(pipe.publicPerson),
    dates: d.dates.map(pipe.dateSummary).sort((a, b) => (b.mutual || 0) - (a.mutual || 0)),
    run: pipe.run,
  });
});

// ---------- people ----------
app.post('/api/people', wrap(async (req, res) => {
  if (!req.body.consent) throw new Error('Please confirm this person agreed to be added.');
  const p = pipe.addPerson(req.body);
  if (req.body.autoRun !== false && !pipe.run.running) pipe.processPerson(p.id).catch(() => {});
  res.json({ person: pipe.publicPerson(p) });
}));

// Bulk: one person per line -> "linkedinUrl, instagramUrl" (comma, tab or space separated)
app.post('/api/people/bulk', wrap(async (req, res) => {
  if (!req.body.consent) throw new Error('Please confirm everyone listed agreed to be added.');
  const added = [];
  const errors = [];
  for (const line of String(req.body.text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(/[\s,;|]+/).filter(Boolean);
    const li = parts.find((x) => /linkedin\.com/i.test(x));
    const ig = parts.find((x) => /instagram\.com/i.test(x)) || parts.find((x) => x.startsWith('@'));
    try {
      added.push(pipe.publicPerson(pipe.addPerson({ linkedinUrl: li, instagramUrl: ig })));
    } catch (e) {
      errors.push(`${line.slice(0, 80)} -> ${e.message}`);
    }
  }
  res.json({ added, errors });
}));

app.get('/api/people/:id', wrap(async (req, res) => {
  const p = pipe.findPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { sample, ...rest } = p;
  res.json({
    person: { ...rest, ...pipe.publicPerson(p) },
    rankings: pipe.rankingsFor(p.id),
    dates: store.get().dates.filter((d) => d.a === p.id || d.b === p.id).map(pipe.dateSummary),
  });
}));

app.post('/api/people/:id/process', wrap(async (req, res) => {
  const p = pipe.findPerson(req.params.id);
  if (!p) throw new Error('Not found');
  // refresh: re-scrape (bypass cache). reanalyze: re-run the LLM on the same data. Neither: resume.
  const { refresh = false, reanalyze = false } = req.body || {};
  pipe.processPerson(p.id, { refresh, reanalyze }).catch(() => {});
  res.json({ ok: true });
}));

app.patch('/api/people/:id', admin, wrap(async (req, res) => {
  const { person, sourceChanged } = pipe.updatePerson(req.params.id, req.body || {});
  if (sourceChanged && !pipe.run.running) pipe.processPerson(person.id).catch(() => {});
  res.json({ person: pipe.publicPerson(person), sourceChanged });
}));

app.delete('/api/people/:id', admin, wrap(async (req, res) => {
  pipe.removePerson(req.params.id);
  res.json({ ok: true });
}));

// ---------- pipeline ----------
app.post('/api/run', wrap(async (req, res) => {
  if (pipe.run.running) throw new Error('Already running');
  pipe.runAll().catch((e) => console.error(e));
  res.json({ ok: true });
}));

app.post('/api/stop', (req, res) => {
  pipe.stopAll();
  res.json({ ok: true });
});

app.get('/api/rankings', (req, res) => {
  const out = store.get().people.filter((p) => p.status === 'ready').map((p) => ({
    ...pipe.publicPerson(p),
    top: pipe.rankingsFor(p.id).slice(0, 5),
  }));
  res.json({ rankings: out });
});

// ---------- dates ----------
app.get('/api/dates/:id', wrap(async (req, res) => {
  const d = store.get().dates.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ date: { ...pipe.dateSummary(d), ...d } });
}));

app.post('/api/dates', wrap(async (req, res) => {
  const { a, b } = req.body;
  if (!pipe.compatible(pipe.findPerson(a) || {}, pipe.findPerson(b) || {})) throw new Error('These two are not a compatible pair');
  const date = pipe.runDate(a, b);
  date.catch(() => {});
  // wait until the date record exists so we can return its id
  await new Promise((r) => setTimeout(r, 50));
  const d = store.get().dates.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  res.json({ dateId: d?.id });
}));

// ---------- data ----------
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="agentic-dating-export.json"');
  res.json(store.get());
});
app.post('/api/import', admin, wrap(async (req, res) => {
  if (!Array.isArray(req.body.people)) throw new Error('Invalid export file');
  store.replaceAll(req.body);
  res.json({ ok: true });
}));
app.post('/api/reset', admin, wrap(async (req, res) => {
  store.reset();
  res.json({ ok: true });
}));

// ---------- live event stream (SSE) ----------
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: 'run', run: pipe.run });
  pipe.bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    pipe.bus.off('event', send);
  });
});

// SPA fallback
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.resolve('public/index.html')));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // Resume anyone who was scraped but not yet read when the server last stopped (no Apify cost).
  const pending = store.get().people.filter((p) => p.status === 'scraped');
  if (pending.length) {
    console.log(`  Resuming ${pending.length} agent(s) that were waiting to read their person...`);
    (async () => { for (const p of pending) await pipe.processPerson(p.id).catch(() => {}); })();
  }
  const llm = llmConfig();
  console.log(`\n  Agentic Dating running on http://localhost:${port}`);
  console.log(`  LLM: ${llm.provider} (${llm.model})  |  scraper: ${process.env.SCRAPER || 'apify'}  |  Apify token: ${process.env.APIFY_TOKEN ? 'yes' : 'NO'}`);
  if (llm.isMock) console.log('  ! No LLM_API_KEY set: running with the offline MOCK agent (for testing only).');
  console.log('');
});

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
