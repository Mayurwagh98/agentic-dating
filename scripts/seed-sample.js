// Loads 8 FICTIONAL test people (fake links) so you can test the pipeline for free with
// SCRAPER=mock. Never use these for the real submission: use 25 real, consenting people.
import fs from 'node:fs';
import * as store from '../server/store.js';
import { addPerson } from '../server/pipeline.js';

store.load();
const rows = JSON.parse(fs.readFileSync(new URL('./sample-fictional.json', import.meta.url)));
for (const r of rows) {
  const slug = 'fictional-' + r.n.toLowerCase().replace(/\s+/g, '-');
  try {
    addPerson({
      linkedinUrl: `https://www.linkedin.com/in/${slug}`,
      instagramUrl: `https://www.instagram.com/${slug.replace(/-/g, '_')}`,
      sample: {
        linkedin: { source: 'linkedin', name: r.n, headline: r.h, location: r.loc, about: r.about, skills: r.skills, experience: [{ title: r.h }] },
        instagram: { source: 'instagram', username: slug, name: r.n, bio: r.bio, posts: r.posts.map((c) => ({ caption: c, hashtags: (c.match(/#\w+/g) || []).map((h) => h.slice(1)) })) },
      },
    });
  } catch (e) { console.log(e.message); }
}
store.flush();
console.log('Seeded fictional sample people. Start with: npm run mock  (or SCRAPER=mock npm start for a real LLM)');
process.exit(0);
