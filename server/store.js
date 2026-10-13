// Tiny JSON-file database. Good enough for a few hundred people, zero setup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ people: [], dates: [], compat: {}, cache: { linkedin: {}, instagram: {}, analysis: {} }, createdAt: new Date().toISOString() });

let db = empty();
let timer = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } catch (e) {
      console.error('[store] db.json unreadable, starting fresh:', e.message);
      db = empty();
    }
  }
  db.cache = { linkedin: {}, instagram: {}, analysis: {}, ...(db.cache || {}) };
  // Migrate: data scraped before the cache existed counts as cached.
  for (const p of db.people) {
    const at = p.scrapedAt || new Date().toISOString();
    if (p.raw?.linkedin && !p.raw.linkedin.manual) db.cache.linkedin[p.liSlug.toLowerCase()] ||= { at, data: p.raw.linkedin };
    if (p.raw?.instagram && !p.raw.instagram.manual) db.cache.instagram[p.igUsername] ||= { at, data: p.raw.instagram };
  }
  // Anything that was mid-flight when the server stopped is reset so it can be re-run.
  for (const p of db.people) {
    if (['scraping', 'analyzing'].includes(p.status)) p.status = p.profile ? 'ready' : p.raw ? 'scraped' : 'new';
  }
  db.dates = db.dates.filter((d) => d.status === 'done');
  return db;
}

export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

export function flush() {
  clearTimeout(timer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const get = () => db;
export const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export function replaceAll(next) {
  db = { ...empty(), ...next };
  flush();
}

export function reset() {
  db = { ...empty(), cache: db.cache }; // keep the scrape/analysis cache so re-adding people is free
  flush();
}

// compat[a][b] = how well b fits a, from a's agent's point of view (0-100) + reason
export function setCompat(a, b, value) {
  db.compat[a] ||= {};
  db.compat[a][b] = value;
}
export function getCompat(a, b) {
  return db.compat[a]?.[b] || null;
}
