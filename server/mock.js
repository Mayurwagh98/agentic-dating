// Offline stand-in for the LLM (LLM_PROVIDER=mock). Lets you click through the whole app
// without an API key. Output is rule-based, so it's only for testing the plumbing.
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (arr, seed) => arr[seed % arr.length];

function textOf(src) {
  if (!src) return '';
  if (src.manual) return src.text;
  if (src.source === 'linkedin') return [src.headline, src.about, ...(src.skills || []), ...(src.experience || []).map((e) => e.title)].join(' ');
  return [src.bio, ...(src.posts || []).map((p) => `${p.caption} ${(p.hashtags || []).join(' ')}`)].join(' ');
}

const TOPICS = ['travel', 'trekking', 'music', 'coffee', 'books', 'fitness', 'cooking', 'photography', 'startups', 'design', 'football', 'art', 'yoga', 'gaming', 'food', 'running', 'dance', 'cricket', 'films', 'ai'];

export function readSource(src) {
  const t = textOf(src).toLowerCase();
  const found = TOPICS.filter((k) => t.includes(k));
  return {
    observations: found.slice(0, 6).map((k) => ({ note: `Shows a recurring interest in ${k}`, evidence: `mentions "${k}" in their ${src.source}` })),
    keywords: found.slice(0, 8),
    dataQuality: found.length > 3 ? 'rich' : found.length ? 'moderate' : 'thin',
    gaps: ['Mock mode: real analysis needs an LLM key'],
  };
}

export function buildProfile({ linkedin, instagram, liNotes, igNotes }) {
  const name = linkedin?.name || instagram?.name || instagram?.username || 'Unknown';
  const kws = [...new Set([...(liNotes?.keywords || []), ...(igNotes?.keywords || [])])];
  const h = hash(name);
  const v = (o) => 30 + ((h >>> o) % 60);
  return {
    name,
    headline: linkedin?.headline || 'Professional',
    location: linkedin?.location || null,
    oneLiner: `${name.split(' ')[0]} is into ${kws.slice(0, 2).join(' and ') || 'good conversations'}.`,
    summary: `${name} (mock analysis). Interests detected: ${kws.join(', ') || 'none'}.`,
    needs: [{ need: 'Someone who shares their curiosity', why: 'mock', source: 'both' }],
    hobbies: kws.slice(0, 3).map((k) => ({ name: k, evidence: 'keyword match', source: 'instagram' })),
    interests: kws.slice(3, 6).map((k) => ({ name: k, evidence: 'keyword match', source: 'linkedin' })),
    values: [{ name: pick(['growth', 'family', 'adventure', 'creativity'], h), evidence: 'mock' }],
    personality: [{ trait: pick(["curious", "warm", "driven", "witty"], h >>> 2), evidence: 'mock' }],
    vibe: { adventurous: v(1), social: v(3), ambitious: v(5), spontaneous: v(7), creative: v(9) },
    lifestyle: { work: linkedin?.headline || '', weekends: kws[0] || '', travel: '', fitness: '' },
    communicationStyle: 'mock',
    greenFlags: ['mock green flag'],
    frictions: ['mock friction'],
    idealMatch: 'Someone who shares their interests (mock)',
    dateIdeas: [`A ${kws[0] || 'coffee'} date`],
    conversationStarters: ['What are you excited about lately?'],
    confidence: 20,
    dataGaps: ['Mock mode'],
  };
}

const interestsOf = (p) => new Set([...(p.profile.hobbies || []), ...(p.profile.interests || [])].map((x) => x.name));

export function scoreCandidates(self, others) {
  const mine = interestsOf(self);
  return others.map((o) => {
    const shared = [...interestsOf(o)].filter((x) => mine.has(x));
    return { id: o.id, score: Math.min(95, 35 + shared.length * 15 + (hash(self.id + o.id) % 15)), reason: shared.length ? `Both into ${shared.join(', ')}` : 'Little overlap found' };
  });
}

export function dateTurn({ self, other, turn, totalTurns }) {
  const shared = [...interestsOf(self)].filter((x) => interestsOf(other).has(x));
  const topic = shared[turn % Math.max(shared.length, 1)] || 'coffee';
  const lines = [
    `Hey ${other.profile.name.split(' ')[0]}! How about we grab a ${topic} themed evening?`,
    `That sounds fun. I've been really into ${topic} lately.`,
    `What got you into ${topic}?`,
    `Work keeps me busy, but I always make time for what I love.`,
    `What matters most to you in a relationship?`,
    `I can be a bit of a planner. Does that bother you?`,
    turn === totalTurns - 2 ? `Honestly I'm having a good time.` : `Tell me more.`,
    `I'd be up for a second date.`,
  ];
  return { message: lines[Math.min(turn, lines.length - 1)], thought: shared.length ? `Overlap on ${shared.join(', ')}` : 'Not much overlap.' };
}

export function debrief({ self, other }) {
  const shared = [...interestsOf(self)].filter((x) => interestsOf(other).has(x));
  const score = Math.min(92, 40 + shared.length * 14 + (hash(self.id + other.id) % 12));
  return {
    score,
    chemistry: score - 5,
    needsMet: score,
    lifestyleFit: score - 3,
    valuesFit: score + 2,
    greenFlags: shared.map((s) => `Shared love of ${s}`),
    redFlags: shared.length ? [] : ['Few shared interests'],
    secondDate: score >= 60,
    verdict: score >= 60 ? 'Worth a second date.' : 'Pleasant, no spark.',
    reportToPerson: `(mock) ${other.profile.name} scored ${score}.`,
  };
}
