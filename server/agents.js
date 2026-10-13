// The agents. Every function here is one "agent step" with its own role and prompt.
//
//  1. reader      – reads ONE source (LinkedIn or Instagram) and writes field notes with evidence
//  2. analyst     – merges both notes into the person's profile (needs, hobbies, interests, ...)
//  3. matchmaker  – the person's agent screens every other profile and shortlists who to date
//  4. dater       – the person's agent goes on a turn-by-turn date with another agent
//  5. debrief     – after the date, each agent privately reports back to its own person
//
// Guardrails shared by all agents: only use the two sources, cite evidence, never infer
// protected/sensitive attributes, never invent facts about the person.
import { chatJSON, llmConfig } from './llm.js';
import * as mock from './mock.js';

const GUARDRAILS = `Rules:
- Your ONLY sources are the person's public LinkedIn and public Instagram data given to you. Never invent facts.
- Do NOT infer or mention religion, caste, ethnicity, health, sexual orientation, political views, finances or exact age.
- When evidence is thin, say so instead of guessing.`;

const isMock = () => llmConfig().isMock;

// ---------------------------------------------------------------- 1. reader
export async function readSource(sourceData) {
  if (isMock()) return mock.readSource(sourceData);
  const label = sourceData.source === 'linkedin' ? 'LinkedIn' : 'Instagram';
  return chatJSON({
    temperature: 0.3,
    system: `You are a perceptive dating-agent researcher. You are reading a person's public ${label} profile to understand who they are as a potential partner: what they do, love, value, and how they live.
${GUARDRAILS}`,
    user: `${label} data (JSON):
${JSON.stringify(sourceData).slice(0, 14000)}

Write field notes. Return JSON:
{
  "observations": [ { "note": "short insight about the person", "evidence": "exact detail from the data that supports it (quote a caption, job, hashtag, bio line...)" } ],   // 6-12 items, most revealing first
  "keywords": ["5-10 short tags"],
  "dataQuality": "rich | moderate | thin",
  "gaps": ["what this source does NOT tell us"]
}`,
  });
}

// ---------------------------------------------------------------- 2. analyst
export async function buildProfile({ linkedin, instagram, liNotes, igNotes }) {
  if (isMock()) return mock.buildProfile({ linkedin, instagram, liNotes, igNotes });
  const basics = {
    linkedin: linkedin && !linkedin.manual ? { name: linkedin.name, headline: linkedin.headline, location: linkedin.location } : linkedin,
    instagram: instagram && !instagram.manual ? { username: instagram.username, name: instagram.name, bio: instagram.bio } : instagram,
  };
  return chatJSON({
    temperature: 0.4,
    maxTokens: 3500,
    system: `You are a person's personal dating agent. You have just read their public LinkedIn and Instagram. Build the profile you will use to date on their behalf. Be specific and insightful (not generic horoscope language), and back each claim with evidence and its source.
${GUARDRAILS}`,
    user: `Basics: ${JSON.stringify(basics).slice(0, 3000)}

LinkedIn field notes: ${JSON.stringify(liNotes || {}).slice(0, 6000)}

Instagram field notes: ${JSON.stringify(igNotes || {}).slice(0, 6000)}

Return JSON:
{
  "name": "full name",
  "headline": "what they do, short",
  "location": "city/region if known, else null",
  "oneLiner": "a warm one-sentence dating bio in third person",
  "summary": "3-4 sentences on who they are as a partner",
  "needs": [ { "need": "what they need in a partner/relationship", "why": "reasoning", "source": "linkedin|instagram|both" } ],   // 3-5
  "hobbies": [ { "name": "", "evidence": "", "source": "linkedin|instagram" } ],
  "interests": [ { "name": "", "evidence": "", "source": "linkedin|instagram" } ],
  "values": [ { "name": "", "evidence": "" } ],
  "personality": [ { "trait": "", "evidence": "" } ],
  "vibe": { "adventurous": 0-100, "social": 0-100, "ambitious": 0-100, "spontaneous": 0-100, "creative": 0-100 },  // 50 = no signal
  "lifestyle": { "work": "", "weekends": "", "travel": "", "fitness": "" },
  "communicationStyle": "",
  "greenFlags": ["why they'd be a great partner"],
  "frictions": ["what could clash with the wrong person"],
  "idealMatch": "who would fit them best and why",
  "dateIdeas": ["3 specific date ideas they'd enjoy"],
  "conversationStarters": ["3 openers"],
  "confidence": 0-100,
  "dataGaps": ["what we could not learn"]
}`,
  });
}

// A short "public card" - what another agent gets to see, like a dating app listing.
export function card(p) {
  const pr = p.profile || {};
  return {
    id: p.id,
    name: pr.name,
    headline: pr.headline,
    location: pr.location,
    oneLiner: pr.oneLiner,
    interests: [...(pr.hobbies || []), ...(pr.interests || [])].map((x) => x.name).slice(0, 8),
    values: (pr.values || []).map((v) => v.name).slice(0, 4),
    needs: (pr.needs || []).map((n) => n.need).slice(0, 3),
    vibe: pr.vibe,
  };
}

function selfBrief(p) {
  const pr = p.profile;
  return JSON.stringify({
    name: pr.name,
    headline: pr.headline,
    location: pr.location,
    summary: pr.summary,
    needs: pr.needs,
    hobbies: pr.hobbies?.map((h) => h.name),
    interests: pr.interests?.map((h) => h.name),
    values: pr.values?.map((v) => v.name),
    personality: pr.personality?.map((t) => t.trait),
    lifestyle: pr.lifestyle,
    communicationStyle: pr.communicationStyle,
    frictions: pr.frictions,
    idealMatch: pr.idealMatch,
    dateIdeas: pr.dateIdeas,
  });
}

// ---------------------------------------------------------------- 3. matchmaker
export async function scoreCandidates(self, others) {
  if (isMock()) return mock.scoreCandidates(self, others);
  const res = await chatJSON({
    temperature: 0.3,
    maxTokens: 3000,
    system: `You are ${self.profile.name}'s dating agent. You know them deeply. Screen every candidate listing and score how well each would fit YOUR person (0-100). Think about complementary needs, shared interests, lifestyle and values alignment, and likely frictions. Be discriminating: use the full range, most candidates should NOT score above 75.`,
    user: `Your person: ${selfBrief(self)}

Candidates: ${JSON.stringify(others.map(card))}

Return JSON: { "scores": [ { "id": "candidate id", "score": 0-100, "reason": "one sentence, specific" } ] }  // one entry for EVERY candidate`,
  });
  return res.scores || [];
}

// ---------------------------------------------------------------- 4. dater
const PHASES = [
  'OPEN: Propose a specific date plan (place + activity) that fits both of you, grounded in shared interests, and open warmly.',
  'RESPOND: React to the plan honestly (accept, tweak or counter-propose), then share something real about yourself.',
  'HOBBIES: Dig into what you each do for fun. Ask a genuine follow-up about something they said.',
  'AMBITIONS: Talk about work, ambitions and how work fits into life.',
  'NEEDS: Find out whether they can meet what your person needs in a relationship. Be direct but kind.',
  'FRICTION: Gently test one possible friction point between you two.',
  'WRAP: Be candid about how this date is going for you.',
  'CLOSE: Close the date. Say clearly whether you would want a second date and why.',
];
function phaseFor(i, total) {
  if (i === total - 2) return PHASES[6];
  if (i === total - 1) return PHASES[7];
  if (i <= 1) return PHASES[i];
  const middle = PHASES.slice(2, 6);
  return middle[(i - 2) % middle.length];
}

export async function dateTurn({ self, other, transcript, turn, totalTurns }) {
  if (isMock()) return mock.dateTurn({ self, other, transcript, turn, totalTurns });
  const phase = phaseFor(turn, totalTurns);
  const history = transcript.map((m) => `${m.name}: ${m.text}`).join('\n') || '(the date is just starting)';
  return chatJSON({
    temperature: 0.9,
    maxTokens: 700,
    system: `You are the AI dating agent representing ${self.profile.name}. You are on a date with the agent representing ${other.profile.name}. Speak in the first person AS ${self.profile.name}'s stand-in, using only what you know about them. Sound like a real person on a good date: natural, specific, curious, a little playful. No lists, no corporate tone. 1-3 sentences.
Your hidden goal: work out honestly whether ${other.profile.name} is a good match for ${self.profile.name}. Don't oversell; if something doesn't fit, notice it.
${GUARDRAILS}`,
    user: `Everything you know about your person: ${selfBrief(self)}

Their dating listing (all you know about them): ${JSON.stringify(card(other))}

Date so far:
${history}

This turn: ${phase}

Return JSON: { "message": "what you say out loud", "thought": "your private agent note about how this is going for your person (1 sentence)" }`,
  });
}

// ---------------------------------------------------------------- 5. debrief
export async function debrief({ self, other, transcript }) {
  if (isMock()) return mock.debrief({ self, other, transcript });
  return chatJSON({
    temperature: 0.4,
    maxTokens: 900,
    system: `You are ${self.profile.name}'s dating agent. You just came back from a date with ${other.profile.name}'s agent. Report back privately and honestly to your person. Score strictly: 50 = fine but no spark, 70 = good match, 85+ = rare, exceptional fit.`,
    user: `Your person: ${selfBrief(self)}

Their listing: ${JSON.stringify(card(other))}

Transcript:
${transcript.map((m) => `${m.name}: ${m.text}`).join('\n')}

Return JSON:
{
  "score": 0-100,
  "chemistry": 0-100,
  "needsMet": 0-100,
  "lifestyleFit": 0-100,
  "valuesFit": 0-100,
  "greenFlags": ["2-3 specific"],
  "redFlags": ["0-2 specific"],
  "secondDate": true/false,
  "verdict": "one punchy sentence",
  "reportToPerson": "2-3 sentences, addressed to your person, on why they should or shouldn't meet"
}`,
  });
}
