# LineupLab

**An AI talent buyer for independent venues.** Tell it about your room (where it is, how
many people it holds, who comes) and an agent asks the Qloo Taste AI API which artists
*this neighbourhood's* audience over-indexes on, keeps only acts your room can actually
hold, and returns a booking plan: a lineup with the evidence for each act, local places and
brands to co-promote with, and announcement copy ready to post.

Built for the Qloo Agentic Hackathon. MIT licensed.

## Who it is for

The people who book 100-to-1,000-capacity rooms: bar and club owners, brewery taprooms,
DIY spaces, small promoters. Most of them book by gut, by who emailed last, or by what is
big right now. Big right now is the trap: the acts a generic recommender names are the ones
everybody knows, which means they are priced and sized for theatres and arenas. A 150-cap
room needs acts that its own block already loves and that are still small enough to book.

## Why Qloo is decisive

Remove Qloo and LineupLab cannot work, and the app shows you this on every run:

| What the venue needs | Where it comes from |
|---|---|
| Acts this neighbourhood + age band over-index on | `signal.location.query` + `signal.demographics.age` on `/v2/insights` |
| Acts small enough for the room | `filter.popularity.max` from the capacity tier |
| Who is local rather than just popular | the same query re-run **without** the location signal; the rank gap is the "local" chip |
| Who is rising | the same query re-run **without** `bias.trends`; the rank change is the trend chip |
| Who to co-promote with | cross-domain `/v2/insights` for `urn:entity:place` near the venue and `urn:entity:brand`, seeded with the chosen artists |
| Proof the LLM alone gets it wrong | the "Without Qloo" tab: the same model and brief with no Qloo, then each name size-checked with `/search` |

The LLM only interprets the brief, chooses and orders from Qloo's candidates, and writes
copy. It never invents an act: any name it returns that is not in Qloo's candidate set is
rejected in code and replaced.

## The agent

A deterministic tool pipeline that the LLM steers. Every step streams to the page as a
trace line showing the exact Qloo request, the result count and the key numbers.

1. **Planner (LLM)** turns the free-text brief into a clean `location_query` and up to four
   vibe keywords.
2. **`qloo_tags`** resolves each keyword to a Qloo tag id. Unmatched keywords are dropped
   out loud, because Qloo silently ignores unknown tag ids.
3. **`qloo_search`** resolves past acts that drew well into entity ids (taste seeds) and
   flags any that are bigger than the room.
4. **`qloo_insights` (artists)** with location, age, tags, seeds, popularity ceiling,
   `bias.trends=medium`, `take=50`, `feature.explainability=true`. An empty 200 (Qloo's
   answer to an ignored or over-tight parameter) is shown as such and the agent relaxes one
   constraint at a time: tags, then seeds, then +0.05 ceiling, then age.
5. **`qloo_insights` x2**: the same query without location and without trend bias, giving
   the local and trend signals.
6. **Lineup picker (LLM)** chooses a headliner and support per date from the top
   candidates, citing the numbers. Picks are validated against the candidate set; gaps are
   filled by a deterministic picker.
7. **`qloo_insights` (places + brands)**: cross-domain partners for the chosen acts' fans,
   places within 3 km of the venue.
8. **Copywriter (LLM)**: one partnership idea per partner and one announcement per date.
9. **Baseline lane (runs in parallel)**: the same model with the same brief and no Qloo,
   then every name it suggests is looked up in Qloo to check its popularity against the
   room's ceiling.

Every LLM step asks for JSON only, is parsed tolerantly (fences, prose, trailing commas,
smart quotes) and has a deterministic fallback, so a bad model answer degrades a step
rather than breaking the run.

### Capacity tiers

Qloo's `popularity` is a 0-1 percentile against all entities of the same type. LineupLab
sends the room's ceiling as `filter.popularity.max` (constants in `src/config.js`):

| Tier | Ceiling | Reasoning |
|---|---|---|
| Up to 150 | 0.60 | local and regional acts, rising club names |
| 150-400 | 0.80 | established club circuit, touring support slots |
| 400-1,000 | 0.92 | theatre-level draws, still under the arena tier |

These are editorial defaults to tune per market, not Qloo facts.

## Architecture

```
 Browser (public/: index.html, app.js, styles.css; vanilla JS, no build)
    |  POST /api/lineup  (Server-Sent Events: meta, step*, result, done)
    v
 Cloudflare Worker (src/worker.js)
    |-- validate input, per-IP rate limit, result cache lookup
    |-- runAgent (src/agent.js)
    |      |-- llm.json()  --> Workers AI binding `AI`
    |      |                   @cf/meta/llama-3.3-70b-instruct-fp8-fast
    |      |-- qloo.tags / qloo.search / qloo.insights
    |      |                   --> https://hackathon.api.qloo.com  (X-Api-Key, server side)
    |      '-- emit(step) ----> SSE to the browser
    '-- cache (src/cache.js): memory -> KV `CACHE` (optional) -> Workers Cache API
 Static assets served by Workers Static Assets ([assets] in wrangler.toml)
```

| File | Role |
|---|---|
| `src/config.js` | model id, tiers, Qloo limits, cache TTLs, rate limit |
| `src/params.js` | pure Qloo parameter builders, popularity bands, relax ladder |
| `src/qloo.js` | Qloo client and response normalisers |
| `src/llm.js` | Workers AI wrapper and tolerant JSON parser |
| `src/prompts.js` | the four prompts |
| `src/agent.js` | the pipeline, signals, validation and fallbacks |
| `src/worker.js` | routes, SSE, caching, rate limiting, key redaction |
| `src/mock/` | synthetic Qloo fixtures and a deterministic demo model |
| `harness/dev-server.mjs` | runs the Worker under plain Node, no dependencies |

### API

- `GET /api/health` returns `{ mode: { qloo, llm, demo }, model, cache }`.
- `POST /api/lineup` with JSON `{ venueName, location, capacity: "small"|"medium"|"large",
  age, genres, pastActs: [..], dates: 1-6 }` streams SSE. Add `?format=json` for a single
  JSON document.

## Run locally

Requires Node 20+.

```bash
npm install            # installs wrangler (dev dependency)
npx wrangler dev       # http://localhost:8787
```

With no `QLOO_API_KEY`, the app runs in **demo mode** on synthetic fixtures and shows a
"Demo data" banner. Workers AI bindings always run remotely, so in local mode
(`wrangler dev --local`, or without a Cloudflare login) the AI binding is unavailable and
the run switches to the deterministic demo model, saying so in the trace. Fully offline:

```bash
npx wrangler dev --env demo      # no AI binding, no key, forced demo mode
npm run dev:node                 # same Worker under plain Node, no wrangler at all
```

For live data locally, copy `.dev.vars.example` to `.dev.vars` (gitignored), set
`QLOO_API_KEY`, and run `npx wrangler dev` while logged in to Cloudflare (Workers AI calls
are billed to that account, within its free allocation).

Tests (Node's built-in runner, no dependencies):

```bash
npm test
```

They cover parameter building per capacity tier, LLM JSON parsing and fallbacks, the mock
pipeline end to end (JSON and SSE), the empty-200 relax path, caching, rate limiting, and
that the API key never appears in any response, stream, error or LLM prompt.

## Deploy

```bash
npx wrangler login
npx wrangler secret put QLOO_API_KEY
# optional, recommended for a public demo: shared cache across isolates
npx wrangler kv namespace create CACHE    # then uncomment [[kv_namespaces]] in wrangler.toml
npx wrangler deploy
```

### Environment

| Name | Kind | Purpose |
|---|---|---|
| `QLOO_API_KEY` | secret | Qloo hackathon key. Absent = demo mode. Only ever sent to Qloo as a header. |
| `AI` | binding | Workers AI. Absent = demo model. |
| `CACHE` | KV binding, optional | cross-isolate cache for Qloo responses (24 h) and results (6 h) |
| `QLOO_BASE_URL` | var, optional | defaults to `https://hackathon.api.qloo.com` |
| `LINEUPLAB_MOCK` | var, optional | `"1"` forces demo mode |

### Cost and limits

An uncached build makes about 10-16 Qloo calls and 4 LLM calls. Identical briefs
(normalised for case and spacing) are served from the result cache and do not count toward
the per-IP limit (12 builds per 10 minutes per isolate). Qloo responses are cached
server-side only; they are never written to the repository.

## Demo mode and data policy

`src/mock/qloo-mock.js` generates **synthetic** artists, places and brands with invented
names. It reproduces Qloo's response shape and the behaviours the agent depends on
(popularity ceiling honoured, each signal moves the ranking, missing `filter.type` returns
an empty 200), and nothing in it comes from real Qloo responses. The UI shows a banner
whenever any part of a run is synthetic, and the printed brief is stamped "DEMO DATA".

## Licence

MIT, see `LICENSE`.
