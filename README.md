# Proxy: an agentic dating site

**Every person is represented by an AI agent. That agent reads the person's LinkedIn and public Instagram, then goes on real, turn-by-turn dates with other people's agents and comes back with a ranked shortlist.**

```
LinkedIn + Instagram  ->  scrape (Apify)  ->  reader agent (field notes per source)
                      ->  analyst agent (profile: needs, hobbies, interests, values, vibe...)
                      ->  matchmaker (each agent screens every listing, shortlists top K)
                      ->  dates (two agents talk turn-by-turn, live over SSE)
                      ->  private debriefs from both agents  ->  mutual score  ->  rankings
```

## Run it locally

Requirements: Node.js 18+.

```bash
cd ~/Desktop/agentic-dating
npm install
cp .env.example .env        # then fill in LLM_API_KEY and APIFY_TOKEN
npm start                   # open http://localhost:3000
```

Keys you need:

| Key | Where | Notes |
|---|---|---|
| `LLM_API_KEY` | Gemini: https://aistudio.google.com/apikey (free) | Or set `LLM_PROVIDER=openai` / `groq` / `openrouter` with that key |
| `APIFY_TOKEN` | https://console.apify.com/settings/integrations | Free plan includes $5/month credit. 25 people costs well under $1 |

### Try it for free first (no keys)

```bash
npm run seed:sample   # loads 8 FICTIONAL test people
npm run mock          # offline mock agent + mock scraper
```

Open http://localhost:3000 and click **Run all agents**. This only tests the plumbing. Delete `data/db.json` before your real run.

With a real LLM key but no Apify yet: `npm run seed:sample` then `SCRAPER=mock npm start` gives real agent analysis and dates on the fictional people.

## Using it

1. **Add people**: one person at a time (their agent runs immediately), or bulk-paste one `linkedin-url, instagram-url` pair per line.
2. **Run all agents**: scrape, read, screen, date, rank. Progress shows in the top bar.
3. **Profile page** (`#/p/:id`): the reading (field notes with quoted evidence from each source), then the analysis, then that person's ranking.
4. **Date page** (`#/date/:id`): the conversation, with each agent's private notes, followed by both debriefs and the mutual score. If you open it while a date is running, messages appear live.
5. **Rankings** (`#/rankings`): the top five for everyone. On any profile you can click **Send agents on a date** for someone who hasn't been dated yet.

If Apify can't scrape a profile, expand *"Scraping blocked? Paste profile text instead"* on the Add form and paste text copied from the same two profiles.

## How the agents work

| Step | Agent | Sees | Produces |
|---|---|---|---|
| Read | `readSource` | one source (LinkedIn **or** Instagram) | 6-12 observations, each with quoted evidence, data quality, gaps |
| Analyse | `buildProfile` | both sets of notes | needs, hobbies, interests, values, personality, vibe sliders, lifestyle, green flags, frictions, ideal match, date ideas, confidence, data gaps; each item tagged with its source |
| Screen | `scoreCandidates` | own full profile + every candidate's public *listing* | 0-100 fit and a reason for each; top `SHORTLIST_K` go on dates |
| Date | `dateTurn` | own full profile + the other person's listing + transcript so far | one message + a private note per turn. A phase script runs plan → hobbies → ambitions → needs → friction test → wrap-up |
| Debrief | `debrief` | own profile + transcript | score, chemistry, needs met, lifestyle/values fit, flags, second date yes/no, report to their person |

* **Mutual score** = harmonic mean of the two agents' scores, so a match has to work for both people.
* **Ranking** = 70% mutual date score + 30% screening score for pairs that dated. Pairs that haven't dated rank on screening × 0.85.
* **Guardrails**: the agents only use the two sources and cite evidence. They never infer religion, caste, ethnicity, health, orientation, politics, finances or exact age. Gender and "interested in" are optional fields set by whoever adds the person; the agent never guesses them. A consent checkbox is required to add anyone.

## Caching (no wasted scrapes or LLM calls)

* **Scrape cache**: profiles are cached in `db.json` by LinkedIn slug / Instagram username for `SCRAPE_CACHE_DAYS` (default 7). Running again, or removing and re-adding someone, doesn't call Apify.
* **Analysis cache**: keyed by a hash of the scraped *content* (volatile fields like image URLs and follower counts are ignored), so the LLM only re-reads a person when their data actually changed.
* **Refresh data** on a profile bypasses the scrape cache. If nothing changed, the existing analysis is kept. **Re-read profile** forces a new analysis on the same data.
* Screening scores and finished dates are stored too, so a new run only does the new work.

## Tech stack

* **Scraping**: Apify REST API (`run-sync-get-dataset-items`) with `harvestapi/linkedin-profile-scraper` (no cookies) and `apify/instagram-profile-scraper`. Results are normalised in `server/scrape.js`. Private Instagram accounts are rejected, and avatars are cached locally because the CDN links expire.
* **LLM**: any OpenAI-compatible `/chat/completions` endpoint called with plain `fetch` (Gemini Flash by default). Models fall back automatically: if one is retired, rejected or out of quota, the client tries the next in the chain (`LLM_MODELS` first, then the provider defaults), then auto-discovers available models via `/models`, and remembers whichever worked. It also has retries with backoff, a concurrency gate and robust JSON parsing.
* **Server**: Node.js + Express, a JSON-file store (`data/db.json`), and Server-Sent Events for the live view.
* **Frontend**: a vanilla-JS SPA with a hash router and no build step (`public/`).

```
server/
  index.js     REST API + SSE stream
  pipeline.js  orchestration: scrape -> analyse -> screen -> date -> rank
  agents.js    all agent prompts
  scrape.js    Apify + normalisation
  llm.js       provider-agnostic LLM client
  store.js     JSON store
  mock.js      offline mock agent for testing
public/        index.html, app.js, styles.css
scripts/       fictional sample data for local testing
```

## API

`GET /api/state` · `POST /api/people` · `POST /api/people/bulk` · `GET /api/people/:id` (profile + rankings) · `POST /api/run` · `POST /api/dates {a,b}` · `GET /api/dates/:id` · `GET /api/rankings` · `GET /api/stream` (SSE) · `GET /api/export`

## Deploy (Render)

1. Push to a public GitHub repo. Commit `data/db.json` and `data/avatars/` after your 25-person run so the demo loads with data.
2. On Render: New → Web Service → connect the repo. Build: `npm install`. Start: `npm start`.
3. Add env vars: `LLM_PROVIDER`, `LLM_API_KEY`, `APIFY_TOKEN`, and `ADMIN_TOKEN` (stops visitors from deleting people).

Render's free disk is ephemeral: people added by visitors last until the next restart, while the committed demo data always comes back.
