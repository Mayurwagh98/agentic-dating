// Scraping layer. LinkedIn and Instagram both block plain HTTP scraping, so we run
// Apify actors (headless browsers + residential proxies) through Apify's REST API:
//   POST /v2/acts/{actor}/run-sync-get-dataset-items  -> returns the scraped items directly.
// Raw results are normalised into a compact shape the analyst agent can read.

const APIFY = 'https://api.apify.com/v2';

// ---------- URL parsing / validation ----------
export function parseLinkedIn(url) {
  const m = String(url || '').trim().match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/\/$/, '');
  return { slug, url: `https://www.linkedin.com/in/${slug}` };
}

export function parseInstagram(url) {
  const raw = String(url || '').trim();
  const m = raw.match(/instagram\.com\/([A-Za-z0-9._]+)/i) || raw.match(/^@?([A-Za-z0-9._]{1,30})$/);
  if (!m) return null;
  const username = m[1].toLowerCase();
  if (['p', 'reel', 'reels', 'stories', 'explore', 'accounts'].includes(username)) return null;
  return { username, url: `https://www.instagram.com/${username}/` };
}

// ---------- Apify ----------
// Apify's free plan allows max 5 concurrent actor runs, so we never run more than 2 at once
// and batch many profiles into a single run instead of one run per person.
let apifyActive = 0;
const apifyQueue = [];
async function apifySlot() {
  const max = Number(process.env.APIFY_CONCURRENCY || 2);
  if (apifyActive < max) { apifyActive++; return; }
  await new Promise((r) => apifyQueue.push(r));
  apifyActive++;
}
function apifyRelease() {
  apifyActive--;
  apifyQueue.shift()?.();
}

async function runActor(actor, input) {
  await apifySlot();
  try { return await runActorRaw(actor, input); } finally { apifyRelease(); }
}

async function runActorRaw(actor, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set');
  const res = await fetch(
    `${APIFY}/acts/${actor.replace('/', '~')}/run-sync-get-dataset-items?token=${token}&timeout=240`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );
  if (!res.ok) throw new Error(`Apify ${actor} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const items = await res.json();
  if (!Array.isArray(items) || !items.length) throw new Error(`Apify ${actor} returned no data`);
  return items;
}

function linkedinInput(actor, urls) {
  if (actor.startsWith('harvestapi/')) return { profileScraperMode: 'Profile details no email ($4 per 1k)', queries: urls };
  if (actor.startsWith('dev_fusion/')) return { profileUrls: urls };
  return { urls, profileUrls: urls, queries: urls };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const slugOf = (s) => (String(s || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i)?.[1] || String(s || '')).toLowerCase().replace(/\/$/, '');

/**
 * Batch scrape: one actor run per 10 LinkedIn profiles (free-plan cap) and per 25 Instagram
 * profiles. Returns Map(key -> normalised profile | Error).
 */
export async function scrapeLinkedInBatch(urls) {
  const actor = process.env.LINKEDIN_ACTOR || 'harvestapi/linkedin-profile-scraper';
  const out = new Map();
  for (const group of chunk(urls, Number(process.env.LINKEDIN_BATCH || 10))) {
    let items = [];
    try { items = await runActor(actor, linkedinInput(actor, group)); } catch (e) { group.forEach((u) => out.set(slugOf(u), e)); continue; }
    for (const u of group) {
      const slug = slugOf(u);
      const item = items.find((i) => [i.publicIdentifier, i.linkedinUrl, i.url, i.profileUrl, i.query, i.originalQuery?.query].some((v) => v && slugOf(v) === slug));
      if (!item) out.set(slug, new Error('LinkedIn: profile not returned by scraper'));
      else if (item.error) out.set(slug, new Error(`LinkedIn: ${item.error}`));
      else out.set(slug, normalizeLinkedIn(item));
    }
  }
  return out;
}

export async function scrapeInstagramBatch(usernames) {
  const actor = process.env.INSTAGRAM_ACTOR || 'apify/instagram-profile-scraper';
  const out = new Map();
  for (const group of chunk(usernames, 25)) {
    let items = [];
    try { items = await runActor(actor, { usernames: group }); } catch (e) { group.forEach((u) => out.set(u, e)); continue; }
    for (const u of group) {
      const item = items.find((i) => (i.username || '').toLowerCase() === u || (i.inputUrl || '').toLowerCase().includes(`/${u}`));
      if (!item) out.set(u, new Error('Instagram: profile not returned (does it exist?)'));
      else if (item.error) out.set(u, new Error(`Instagram: ${item.errorDescription || item.error}`));
      else {
        const norm = normalizeInstagram(item);
        out.set(u, norm.isPrivate ? new Error('Instagram profile is private. Only public profiles are allowed.') : norm);
      }
    }
  }
  return out;
}

export async function scrapeLinkedIn(url) {
  const actor = process.env.LINKEDIN_ACTOR || 'harvestapi/linkedin-profile-scraper';
  const items = await runActor(actor, linkedinInput(actor, [url]));
  const item = items.find((i) => !i.error) || items[0];
  if (item.error) throw new Error(`LinkedIn: ${item.error}`);
  return normalizeLinkedIn(item);
}

export async function scrapeInstagram(username) {
  const actor = process.env.INSTAGRAM_ACTOR || 'apify/instagram-profile-scraper';
  const items = await runActor(actor, { usernames: [username] });
  const item = items.find((i) => (i.username || '').toLowerCase() === username) || items[0];
  if (item.error) throw new Error(`Instagram: ${item.errorDescription || item.error}`);
  const norm = normalizeInstagram(item);
  if (norm.isPrivate) throw new Error('Instagram profile is private. Only public profiles are allowed.');
  return norm;
}

// ---------- normalisation ----------
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const trim = (s, n = 600) => (typeof s === 'string' ? s.slice(0, n) : s);

export function normalizeLinkedIn(i) {
  const name = first(i.fullName, [i.firstName, i.lastName].filter(Boolean).join(' '), i.name);
  const exp = first(i.experience, i.experiences, i.positions, []) || [];
  const edu = first(i.education, i.educations, []) || [];
  const skills = first(i.skills, []) || [];
  const listText = (arr, fn) => (Array.isArray(arr) ? arr.slice(0, 12).map(fn).filter(Boolean) : []);
  return {
    source: 'linkedin',
    name,
    headline: first(i.headline, i.occupation, i.jobTitle),
    about: trim(first(i.about, i.summary, i.description), 2000),
    location: first(i.location?.linkedinText, i.location?.default, i.addressWithCountry, i.location, i.geoLocationName),
    avatar: first(i.photo, i.profilePicture, i.profilePic, i.profilePicHighQuality, i.pictureUrl),
    experience: listText(exp, (e) => ({
      title: first(e.position, e.title, e.jobTitle),
      company: first(e.companyName, e.company, e.subtitle),
      duration: first(e.duration, e.caption, e.dateRange, [e.startDate?.text, e.endDate?.text].filter(Boolean).join(' - ')),
      description: trim(first(e.description, e.subComponents?.[0]?.description?.[0]?.text), 400),
    })),
    education: listText(edu, (e) => ({
      school: first(e.title, e.schoolName, e.school),
      degree: first(e.degree, e.subtitle, [e.degreeName, e.fieldOfStudy].filter(Boolean).join(', ')),
      period: first(e.period, e.caption, e.dateRange),
    })),
    skills: listText(skills, (s) => (typeof s === 'string' ? s : first(s.name, s.title))).slice(0, 25),
    languages: listText(first(i.languages, []), (l) => (typeof l === 'string' ? l : first(l.name, l.title))),
    volunteering: listText(first(i.volunteering, i.volunteerExperience, []), (v) => [first(v.role, v.title), first(v.organizationName, v.subtitle)].filter(Boolean).join(' @ ')),
    certifications: listText(first(i.certifications, i.licenseAndCertificates, []), (c) => first(c.title, c.name)),
    projects: listText(first(i.projects, []), (p) => first(p.title, p.name)),
    awards: listText(first(i.honorsAndAwards, i.honors, []), (a) => first(a.title, a.name)),
    followers: first(i.followerCount, i.followers),
  };
}

export function normalizeInstagram(i) {
  const posts = (i.latestPosts || i.posts || []).slice(0, 15).map((p) => ({
    caption: trim(p.caption || '', 500),
    hashtags: p.hashtags || [],
    location: p.locationName || null,
    type: p.type,
    date: p.timestamp ? String(p.timestamp).slice(0, 10) : null,
    alt: trim(p.alt || p.accessibilityCaption || '', 200),
    url: p.url,
    image: p.displayUrl,
  }));
  return {
    source: 'instagram',
    username: i.username,
    name: i.fullName,
    bio: i.biography || '',
    website: i.externalUrl || null,
    category: i.businessCategoryName || null,
    followers: i.followersCount,
    following: i.followsCount,
    postCount: i.postsCount,
    isPrivate: !!i.private,
    avatar: i.profilePicUrlHD || i.profilePicUrl,
    posts,
  };
}

// Manual fallback: text copied by hand from the same two official profiles.
export function manualSource(source, text) {
  return { source, manual: true, text: String(text).slice(0, 6000) };
}
