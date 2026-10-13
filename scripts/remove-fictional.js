// Removes the fictional sample people (and their dates/scores) from data/db.json.
// Stop the server first (Ctrl+C), then: npm run clean:fictional
import * as store from '../server/store.js';
const db = store.load();
const ids = new Set(db.people.filter((p) => p.liSlug.startsWith('fictional-')).map((p) => p.id));
db.people = db.people.filter((p) => !ids.has(p.id));
db.dates = db.dates.filter((d) => !ids.has(d.a) && !ids.has(d.b));
for (const id of ids) delete db.compat[id];
for (const k of Object.keys(db.compat)) for (const id of ids) delete db.compat[k][id];
store.flush();
console.log(`Removed ${ids.size} fictional people. ${db.people.length} real people left.`);
process.exit(0);
