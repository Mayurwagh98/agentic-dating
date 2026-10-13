// Orchestration: people -> scrape -> read -> profile -> screen -> date -> debrief -> rank.
// Every step emits events on `bus`, which the server streams to the browser (SSE) so you
// can watch the agents read and date live.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import { parseLinkedIn, parseInstagram, scrapeLinkedIn, scrapeInstagram, scrapeLinkedInBatch, scrapeInstagramBatch, manualSource } from './scrape.js';
import * as agents from './agents.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const emit = (type, data) => bus.emit('event', { type, ...data, at: Date.now() });
const log = (msg, level = 'info') => {
  console.log(`[${level}] ${msg}`);
  emit('log', { msg, level });
};

export const run = { running: false, stage: 'idle', done: 0, total: 0, startedAt: null };
const setRun = (patch) => {
  Object.assign(run, patch);
  emit('run', { run });
};

const db = () => store.get();
export const findPerson = (id) => db().people.find((p) => p.id === id);
const ready = () => db().people.filter((p) => p.status === 'ready');
const firstName = (p) => (p.profile?.name || p.igUsername || p.liSlug || 'someone').split(' ')[0];

// ------------------------------------------------------------------ people
export function addPerson({ linkedinUrl, instagramUrl, gender, seeking, manualLinkedin, manualInstagram, sample }) {
  const li = parseLinkedIn(linkedinUrl);
  const ig = parseInstagram(instagramUrl);
  if (!li) throw new Error(`Not a LinkedIn profile URL: ${linkedinUrl || '(empty)'}`);
  if (!ig) throw new Error(`Not an Instagram profile URL: ${instagramUrl || '(empty)'}`);
  const dup = db().people.find((p) => p.liSlug.toLowerCase() === li.slug.toLowerCase() || p.igUsername === ig.username);
  if (dup) throw new Error(`Already added (${dup.profile?.name || dup.liSlug})`);
  const p = {
    id: store.id('p'),
    linkedinUrl: li.url,
    instagramUrl: ig.url,
    liSlug: li.slug,
    igUsername: ig.username,
    gender: gender || 'unspecified',
    seeking: seeking || 'everyone',
    manual: { linkedin: manualLinkedin || '', instagram: manualInstagram || '' },
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  if (sample) p.sample = sample;
  db().people.push(p);
  store.save();
  emit('person', { person: publicPerson(p) });
  log(`Added ${li.slug} / @${ig.username}`);
  return p;
}

export function removePerson(id) {
  const d = db();
  d.people = d.people.filter((p) => p.id !== id);
  d.dates = d.dates.filter((x) => x.a !== id && x.b !== id);
  delete d.compat[id];
  for (const k of Object.keys(d.compat)) delete d.compat[k][id];
  store.save();
  emit('reload', {});
}

export function publicPerson(p) {
  return {
    id: p.id,
    status: p.status,
    error: p.error,
    linkedinUrl: p.linkedinUrl,
    instagramUrl: p.instagramUrl,
    igUsername: p.igUsername,
    liSlug: p.liSlug,
    gender: p.gender,
    seeking: p.seeking,
    avatar: p.avatarFile || p.avatar,
    name: p.profile?.name,
    headline: p.profile?.headline,
    location: p.profile?.location,
    oneLiner: p.profile?.oneLiner,
    tags: [...(p.profile?.hobbies || []), ...(p.profile?.interests || [])].map((x) => x.name).slice(0, 5),
  };
}

function setStatus(p, status, error) {
  p.status = status;
  p.error = error || undefined;
  store.save();
  emit('person', { person: publicPerson(p) });
}

// ------------------------------------------------------------------ cache
// Scraped profiles are cached by LinkedIn slug / Instagram username (survives removing and
// re-adding a person). Analyses are cached by a hash of the scraped data, so the LLM only
// re-reads someone when their data actually changed.
const CACHE_DAYS = () => Number(process.env.SCRAPE_CACHE_DAYS || 7);
const cacheKey = (source, p) => (source === 'linkedin' ? p.liSlug.toLowerCase() : p.igUsername);
function cacheGet(source, p) {
  const e = db().cache?.[source]?.[cacheKey(source, p)];
  if (!e) return null;
  const ageDays = (Date.now() - new Date(e.at).getTime()) / 86400000;
  return ageDays <= CACHE_DAYS() ? e.data : null;
}
function cacheSet(source, p, data) {
  db().cache[source][cacheKey(source, p)] = { at: new Date().toISOString(), data };
}
// Hash only the content the agent reads. Image URLs are re-signed on every fetch and follower
// counts tick constantly, so they'd make unchanged profiles look "new".
const VOLATILE = new Set(['avatar', 'image', 'url', 'followers', 'following', 'postCount', 'fromCache']);
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => !VOLATILE.has(k)).map((k) => [k, stable(v[k])])) : v);
const hashRaw = (raw) => crypto.createHash('sha1').update(JSON.stringify(stable(raw || {}))).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ 1. scrape
const fromBatch = (v) => (v === undefined ? undefined : v instanceof Error ? Promise.reject(v) : Promise.resolve(v));

// Scrape many people with as few Apify runs as possible (batched, max 2 concurrent runs).
async function scrapeMany(people, force = false) {
  const mode = (process.env.SCRAPER || 'apify').toLowerCase();
  people.forEach((p) => setStatus(p, 'scraping'));
  const needs = (source, p) => !p.manual?.[source]?.trim() && (force || !cacheGet(source, p));
  let li = new Map();
  let ig = new Map();
  if (mode === 'apify') {
    const liUrls = people.filter((p) => needs('linkedin', p)).map((p) => p.linkedinUrl);
    const igUsers = people.filter((p) => needs('instagram', p)).map((p) => p.igUsername);
    const cached = people.length * 2 - liUrls.length - igUsers.length;
    log(`Scraping ${liUrls.length} LinkedIn + ${igUsers.length} Instagram profiles in batches${cached ? ` (${cached} served from cache)` : ''}`);
    [li, ig] = await Promise.all([
      liUrls.length ? scrapeLinkedInBatch(liUrls) : new Map(),
      igUsers.length ? scrapeInstagramBatch(igUsers) : new Map(),
    ]);
  }
  for (const p of people) {
    await scrapePerson(p, { li, ig }, force);
    setRun({ done: run.done + 1 });
  }
}
export async function scrapePerson(p, prefetched, force = false) {
  setStatus(p, 'scraping');
  const mode = (process.env.SCRAPER || 'apify').toLowerCase();
  const raw = {};
  const errors = [];

  const get = async (source, fn) => {
    if (p.manual?.[source]?.trim()) {
      log(`${source}: using manually pasted text for ${p.liSlug}`);
      return manualSource(source, p.manual[source]);
    }
    const hit = !force && cacheGet(source, p);
    if (hit) {
      log(`${source}: cache hit for ${p.liSlug} (no scrape needed)`);
      return { ...hit, fromCache: true };
    }
    if (mode === 'mock') {
      if (p.sample?.[source]) return p.sample[source];
      throw new Error('SCRAPER=mock only works for fictional sample people');
    }
    return fn();
  };

  await Promise.all([
    get('linkedin', () => fromBatch(prefetched?.li?.get(p.liSlug.toLowerCase())) ?? scrapeLinkedIn(p.linkedinUrl))
      .then((r) => { const { fromCache, ...d } = r; raw.linkedin = d; if (!fromCache && !d.manual) { cacheSet('linkedin', p, d); log(`LinkedIn scraped: ${d.name || p.liSlug}`); } })
      .catch((e) => errors.push(`LinkedIn: ${e.message}`)),
    get('instagram', () => fromBatch(prefetched?.ig?.get(p.igUsername)) ?? scrapeInstagram(p.igUsername))
      .then((r) => { const { fromCache, ...d } = r; raw.instagram = d; if (!fromCache && !d.manual) { cacheSet('instagram', p, d); log(`Instagram scraped: @${p.igUsername} (${d.posts?.length ?? 0} posts)`); } })
      .catch((e) => errors.push(`Instagram: ${e.message}`)),
  ]);

  if (!raw.linkedin && !raw.instagram) {
    setStatus(p, 'error', errors.join(' | '));
    log(`Scrape failed for ${p.liSlug}: ${errors.join(' | ')}`, 'error');
    return false;
  }
  p.raw = raw;
  p.scrapeWarnings = errors;
  p.avatar = raw.instagram?.avatar || raw.linkedin?.avatar || p.avatar;
  if (!p.avatarFile || force) await cacheAvatar(p);
  p.scrapedAt = new Date().toISOString();
  if (errors.length) log(`Partial data for ${p.liSlug}: ${errors.join(' | ')}`, 'warn');
  setStatus(p, 'scraped');
  return true;
}

// Instagram/LinkedIn image URLs expire and refuse to load on other sites, so we save a copy.
async function cacheAvatar(p) {
  const url = p.avatar;
  if (!url || !/^https?:/.test(url)) return;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return;
    const dir = path.resolve(process.env.DATA_DIR || 'data', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${p.id}.jpg`), Buffer.from(await res.arrayBuffer()));
    p.avatarFile = `/avatars/${p.id}.jpg`;
  } catch { /* fall back to the remote URL */ }
}

// ------------------------------------------------------------------ 2. read + analyse
export async function analyzePerson(p, { force = false } = {}) {
  const h = hashRaw(p.raw);
  const cached = db().cache.analysis[h];
  if (!force && p.profile && p.rawHash === h) {
    setStatus(p, 'ready');
    log(`${p.profile.name}: data unchanged, keeping existing analysis`);
    return true;
  }
  if (!force && cached) {
    p.notes = cached.notes;
    p.profile = cached.profile;
    p.rawHash = h;
    p.analyzedAt = cached.at;
    setStatus(p, 'ready');
    log(`${p.profile.name}: analysis served from cache (same data as before)`);
    return true;
  }
  setStatus(p, 'analyzing');
  try {
    const read = async (source) => {
      if (!p.raw?.[source]) return null;
      emit('reading', { personId: p.id, source, phase: 'start' });
      const notes = await agents.readSource(p.raw[source]);
      emit('reading', { personId: p.id, source, phase: 'done', notes });
      return notes;
    };
    const [liNotes, igNotes] = await Promise.all([read('linkedin'), read('instagram')]);
    p.notes = { linkedin: liNotes, instagram: igNotes };
    emit('reading', { personId: p.id, source: 'analyst', phase: 'start' });
    p.profile = await agents.buildProfile({ linkedin: p.raw.linkedin, instagram: p.raw.instagram, liNotes, igNotes });
    p.analyzedAt = new Date().toISOString();
    p.rawHash = h;
    db().cache.analysis[h] = { at: p.analyzedAt, notes: p.notes, profile: p.profile };
    setStatus(p, 'ready');
    log(`Agent finished reading ${p.profile.name}`);
    return true;
  } catch (e) {
    setStatus(p, 'error', `Analysis failed: ${e.message}`);
    log(`Analysis failed for ${p.liSlug}: ${e.message}`, 'error');
    return false;
  }
}

// ------------------------------------------------------------------ 3. screen
function wants(seeker, target) {
  const s = seeker.seeking || 'everyone';
  const g = target.gender || 'unspecified';
  if (s === 'everyone' || g === 'unspecified') return true;
  return (s === 'women' && g === 'woman') || (s === 'men' && g === 'man');
}
export const compatible = (a, b) => a.id !== b.id && wants(a, b) && wants(b, a);

export async function screenFor(p) {
  const others = ready().filter((o) => compatible(p, o));
  if (!others.length) return;
  // chunk so prompts stay small even with lots of people
  for (let i = 0; i < others.length; i += 25) {
    const chunk = others.slice(i, i + 25);
    const scores = await agents.scoreCandidates(p, chunk);
    for (const s of scores) {
      if (chunk.some((o) => o.id === s.id)) store.setCompat(p.id, s.id, { score: Math.round(Number(s.score) || 0), reason: s.reason });
    }
  }
  store.save();
  log(`${firstName(p)}'s agent screened ${others.length} profiles`);
}

// ------------------------------------------------------------------ 4. date
const dateBetween = (a, b) => db().dates.find((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a));

export async function runDate(aId, bId) {
  const a = findPerson(aId);
  const b = findPerson(bId);
  if (!a?.profile || !b?.profile) throw new Error('Both people need finished profiles first');
  const existing = dateBetween(aId, bId);
  if (existing?.status === 'live') return existing;
  if (existing) db().dates = db().dates.filter((d) => d !== existing);

  const total = Number(process.env.DATE_TURNS || 8);
  const date = { id: store.id('d'), a: aId, b: bId, status: 'live', turns: [], startedAt: new Date().toISOString() };
  db().dates.push(date);
  emit('date:start', { date: dateSummary(date) });
  log(`Date started: ${a.profile.name} x ${b.profile.name}`);

  try {
    for (let t = 0; t < total; t++) {
      const [self, other, side] = t % 2 === 0 ? [a, b, 'a'] : [b, a, 'b'];
      const transcript = date.turns.map((m) => ({ name: m.name, text: m.text }));
      emit('date:typing', { dateId: date.id, side, name: self.profile.name });
      const out = await agents.dateTurn({ self, other, transcript, turn: t, totalTurns: total });
      const msg = { side, personId: self.id, name: self.profile.name, text: String(out.message || '').trim(), thought: out.thought || '' };
      date.turns.push(msg);
      emit('date:msg', { dateId: date.id, msg });
    }
    const transcript = date.turns.map((m) => ({ name: m.name, text: m.text }));
    const [da, dbb] = await Promise.all([
      agents.debrief({ self: a, other: b, transcript }),
      agents.debrief({ self: b, other: a, transcript }),
    ]);
    date.debrief = { a: da, b: dbb };
    date.mutual = mutualScore(da.score, dbb.score);
    date.match = !!(da.secondDate && dbb.secondDate);
    date.status = 'done';
    date.endedAt = new Date().toISOString();
    store.save();
    emit('date:done', { date: dateSummary(date), debrief: date.debrief });
    log(`Date done: ${a.profile.name} x ${b.profile.name} -> mutual ${date.mutual}${date.match ? ' (both want a 2nd date!)' : ''}`);
    return date;
  } catch (e) {
    date.status = 'error';
    date.error = e.message;
    db().dates = db().dates.filter((d) => d !== date);
    emit('date:error', { dateId: date.id, error: e.message });
    log(`Date failed (${a.profile.name} x ${b.profile.name}): ${e.message}`, 'error');
    throw e;
  }
}

function mutualScore(x, y) {
  x = Number(x) || 0;
  y = Number(y) || 0;
  if (!x || !y) return 0;
  return Math.round((2 * x * y) / (x + y)); // harmonic mean: a match must work for BOTH
}

export function dateSummary(d) {
  const a = findPerson(d.a);
  const b = findPerson(d.b);
  return {
    id: d.id,
    a: d.a,
    b: d.b,
    aName: a?.profile?.name,
    bName: b?.profile?.name,
    aAvatar: a?.avatarFile || a?.avatar,
    bAvatar: b?.avatarFile || b?.avatar,
    status: d.status,
    mutual: d.mutual,
    match: d.match,
    turnCount: d.turns.length,
    opener: d.turns[0]?.text,
    startedAt: d.startedAt,
  };
}

// Which pairs go on real dates: each agent's top-K shortlist (union, deduped).
function pairsToDate(k = Number(process.env.SHORTLIST_K || 4), onlyFor) {
  const people = ready();
  const pairs = new Map();
  for (const p of people) {
    if (onlyFor && p.id !== onlyFor) continue;
    const ranked = people
      .filter((o) => compatible(p, o))
      .map((o) => ({ o, s: store.getCompat(p.id, o.id)?.score ?? store.getCompat(o.id, p.id)?.score ?? 0 }))
      .sort((x, y) => y.s - x.s)
      .slice(0, k);
    for (const { o } of ranked) {
      const key = [p.id, o.id].sort().join('|');
      if (!pairs.has(key) && !dateBetween(p.id, o.id)) pairs.set(key, [p.id, o.id]);
    }
  }
  return [...pairs.values()];
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch { /* logged inside */ }
      setRun({ done: run.done + 1 });
    }
  });
  await Promise.all(workers);
}

// ------------------------------------------------------------------ full run
export async function runAll() {
  if (run.running) throw new Error('A run is already in progress');
  setRun({ running: true, startedAt: Date.now() });
  try {
    const people = db().people;

    const toScrape = people.filter((p) => ['new', 'error'].includes(p.status) && !p.raw);
    setRun({ stage: 'Scraping LinkedIn + Instagram', done: 0, total: toScrape.length });
    await scrapeMany(toScrape);

    const toAnalyze = people.filter((p) => p.raw && !p.profile && p.status !== 'analyzing');
    setRun({ stage: 'Agents reading their people', done: 0, total: toAnalyze.length });
    await pool(toAnalyze, 4, analyzePerson);

    const toScreen = ready().filter((p) => ready().some((o) => compatible(p, o) && !store.getCompat(p.id, o.id)));
    setRun({ stage: 'Agents screening candidates', done: 0, total: toScreen.length });
    await pool(toScreen, 4, screenFor);

    const pairs = pairsToDate();
    setRun({ stage: 'Agents on dates', done: 0, total: pairs.length });
    await pool(pairs, 3, ([a, b]) => runDate(a, b));

    setRun({ stage: 'Rankings ready', done: 0, total: 0 });
    log(`Run complete: ${ready().length} profiles, ${db().dates.length} dates`);
  } finally {
    setRun({ running: false });
    store.flush();
  }
}

// One new person added through the UI: run their whole journey right away.
const inflight = new Set();
/**
 * opts.refresh  -> re-scrape both profiles even if cached (then re-analyse only if data changed)
 * opts.reanalyze -> run the LLM analysis again on the same data
 */
export async function processPerson(id, opts = {}) {
  const p = findPerson(id);
  if (!p || inflight.has(id)) return; // already being processed
  inflight.add(id);
  try { await processPersonInner(p, opts); } finally { inflight.delete(id); }
}
async function processPersonInner(p, { refresh = false, reanalyze = false } = {}) {
  if ((refresh || !p.raw) && !(await scrapePerson(p, null, refresh))) return;
  if ((refresh || reanalyze || !p.profile) && !(await analyzePerson(p, { force: reanalyze }))) return;
  await screenFor(p);
  const pairs = pairsToDate(undefined, p.id);
  log(`${firstName(p)}'s agent is going on ${pairs.length} dates`);
  for (const [a, b] of pairs) {
    try { await runDate(a, b); } catch { /* logged */ }
  }
  emit('rankings', { personId: p.id });
}

// ------------------------------------------------------------------ 5. rank
export function rankingsFor(pid) {
  const p = findPerson(pid);
  if (!p?.profile) return [];
  return ready()
    .filter((q) => compatible(p, q))
    .map((q) => {
      const c1 = store.getCompat(p.id, q.id);
      const c2 = store.getCompat(q.id, p.id);
      const cs = [c1?.score, c2?.score].filter((x) => typeof x === 'number');
      const compat = cs.length ? Math.round(cs.reduce((s, x) => s + x, 0) / cs.length) : null;
      const d = dateBetween(p.id, q.id);
      const done = d?.status === 'done';
      const mine = done ? (d.a === p.id ? d.debrief.a : d.debrief.b) : null;
      const theirs = done ? (d.a === p.id ? d.debrief.b : d.debrief.a) : null;
      const score = done ? Math.round(0.7 * d.mutual + 0.3 * (compat ?? d.mutual)) : Math.round((compat ?? 0) * 0.85);
      return {
        id: q.id,
        name: q.profile.name,
        headline: q.profile.headline,
        avatar: q.avatarFile || q.avatar,
        score,
        compat,
        compatReason: c1?.reason || c2?.reason || null,
        dated: done,
        dateId: done ? d.id : null,
        mutual: done ? d.mutual : null,
        myAgentScore: mine?.score ?? null,
        theirAgentScore: theirs?.score ?? null,
        match: done ? d.match : false,
        verdict: mine?.verdict || null,
        report: mine?.reportToPerson || null,
      };
    })
    .sort((x, y) => y.score - x.score || Number(y.dated) - Number(x.dated));
}
