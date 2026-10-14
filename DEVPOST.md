# LineupLab: Devpost submission draft

**Tagline:** An AI talent buyer for independent venues: book the acts your block already
loves, sized to your room.

**Links (fill in before submitting):** live demo https://lineuplab.s-n-psaradellis.workers.dev · repo https://github.com/Stephen-Psaradellis/lineuplab

---

## Inspiration

Small venues keep music scenes alive, and most of them book by gut. The owner of a 150-cap
bar has no data team and no agency. Ask a general-purpose AI who to book and it names the
acts everybody has heard of, which are exactly the acts that bar cannot afford or fill.
The answer the owner needs is local and size-aware: who does *my* neighbourhood's crowd
over-index on, that is still small enough to book? That is a taste question, and taste
across places and audiences is what Qloo models.

## What it does

A venue enters its neighbourhood, capacity tier, main crowd age band, optional vibe and
past acts that drew well, and how many dates to fill. LineupLab's agent then:

- asks Qloo which artists that neighbourhood and age band over-index on, with the room's
  capacity converted into a popularity ceiling so a 150-cap room is never told to book an
  arena act;
- re-runs the query without location and without trend bias to show, per act, whether it
  is a local favourite and whether it is rising;
- builds one card per date (headliner + support) with the Qloo affinity, popularity band
  against the room, local and trend signals, and a one-line reason grounded in those
  numbers;
- finds nearby places and brands that the lineup's fans over-index on (Qloo cross-domain)
  and suggests a concrete co-promotion for each;
- writes a ready-to-post announcement per date, aimed at that audience's adjacent tastes;
- shows a **Without Qloo** view: the same LLM with the same brief and no Qloo, with each of
  its suggestions size-checked in Qloo. It reliably names famous acts several times too big
  for the room, with no tie to the neighbourhood.

Every step streams to the page as a live trace, including each Qloo request and its key
numbers. The result exports as copyable text or a one-page printable booking brief.

## How we built it

- **Cloudflare Workers** serves the static front end (Workers Static Assets) and a
  Server-Sent-Events API, so the agent's steps appear as they happen.
- **Workers AI** (Llama 3.3 70B) steers a deterministic tool pipeline. It turns the brief
  into Qloo inputs, picks and orders the lineup from Qloo's candidates, and writes
  partnership ideas and blurbs. Every LLM step asks for JSON, is parsed tolerantly, and has
  a deterministic fallback.
- **Qloo Taste AI** provides the three tools the agent calls: `qloo_search`, `qloo_tags`
  and `qloo_insights`. The key stays server-side.
- Server-side caching (memory, optional KV, Workers Cache API) keyed on the normalised
  brief protects both API quotas, and a light per-IP limit protects the free tier.
- Vanilla JS front end, no framework or build step, light and dark themes, keyboard
  accessible, works on a phone.
- A demo mode with synthetic fixtures (invented names, real response shapes) runs the
  whole app offline and in tests, and announces itself with a banner.

## The Qloo-powered part

Qloo is not an add-on to LineupLab; it is the product. The lineup comes from
`/v2/insights` with `signal.location.query` and `signal.demographics.age` (whose taste),
`filter.popularity.max` from the room's capacity (what the room can hold),
`signal.interests.tags` and `signal.interests.entities` from the venue's vibe and past
draws, and `bias.trends` (who is rising). LineupLab then uses Qloo as an instrument rather
than a list: it re-asks the same question without the location signal and without trend
bias, and the rank differences become the "local" and "rising" evidence on every card.
Cross-domain `/v2/insights` calls for places (within 3 km of the venue) and brands, seeded
with the chosen artists, turn a lineup into a promotion plan. Finally, Qloo audits the LLM:
the Without Qloo tab looks up every act the model suggests on its own and shows how far
above the room's ceiling they sit. Take Qloo away and what remains is that generic,
wrong-sized answer.

## Request to result (redacted)

One brief, start to finish. The key stays in a Worker secret; the browser never sees it.

1. Brief: "The Basement, Nashville TN, small room (under 300), indie rock, past draw:
   Snail Mail, 3 dates".
2. Tag choice: the agent asks `/v2/tags` for "indie rock" restricted to music genres
   (`filter.tag.types=urn:tag:genre:music`), so a same-named place or film tag cannot slip
   in; a keyword with no match is dropped and the trace says so.
3. Main ask: `GET /v2/insights?filter.type=urn:entity:artist&signal.location.query=Nashville, TN
   &signal.interests.tags=<indie-rock tag id>&signal.interests.entities=<Snail Mail id>
   &filter.popularity.max=<small-room ceiling>&bias.trends=medium`
4. Two control asks: the same call without the location signal, and without trend bias.
   Rank gaps become the "local" and "rising" badges on each card.
5. Promotion asks: `/v2/insights` for places within 3 km and for brands, seeded with the
   chosen acts.
6. Llama 3.3 picks dates and writes the pitch from Qloo candidates only; a name outside
   that set is rejected in code. Live run on the demo deployment: 14 Qloo calls, 4 LLM
   calls, about 14 seconds.

## Try it from a clean machine

Live: https://lineuplab.s-n-psaradellis.workers.dev. Locally, with Node 20+:

```bash
git clone https://github.com/Stephen-Psaradellis/lineuplab && cd lineuplab
npm install
npx wrangler dev --env demo   # offline, no key, synthetic data, says so on screen
npm test                      # 39 tests, no network
```

For live data, put a hackathon key in `.dev.vars` as `QLOO_API_KEY` and run
`npx wrangler dev`.

## Known limitations

- Qloo describes what audiences in a place tend to like, not what any one person will
  buy a ticket for. A high rank is a reason to make an offer, not a turnout forecast.
- Room size comes from Qloo popularity, not from an act's real fee or routing; a booker
  still checks availability and price.
- "Local" and "rising" are differences between two Qloo answers, so they inherit Qloo's
  coverage: thin markets give thin signals, and the app says when a result came back empty.
- No personal data is sent to Qloo: only the venue's city, an age band, tags and act names.

## Challenges we ran into

- **Empty 200s.** Qloo ignores parameters it does not understand and can answer an
  over-tight query with zero results instead of an error. The agent treats an empty result
  as a signal: it shows it in the trace and relaxes one constraint at a time (tags, seeds,
  ceiling, age) rather than silently showing nothing.
- **Place names Qloo cannot match.** An unmatched locality is the opposite case: a 400,
  not an empty 200. The agent walks from the planner's phrase to the user's words to the
  city ("Wicker Park, Chicago" -> "Chicago"), says so in the trace, and if nothing matches
  it drops the location signal for acts and skips nearby places instead of failing the run.
- **Keeping the LLM honest.** Models like to name famous acts. The lineup picker only sees
  Qloo candidates, and any name it returns that is not in that set is rejected in code and
  replaced by a deterministic pick, with the rejection shown in the trace.
- **Making numbers mean something to a venue owner.** A popularity percentile means little
  on its own, so each act is shown as a room size (Emerging, Club, Theatre, Arena) against
  the room's ceiling.
- **Free-tier budgets.** Caching on the normalised brief and on each Qloo call keeps repeat
  demos free for both APIs.

## Accomplishments that we're proud of

- The comparison is visible, not claimed: one click shows the same model, without Qloo,
  recommending acts several times too big for the room.
- The agent's reasoning is fully inspectable, down to each Qloo request string.
- Local and trend signals derived from Qloo itself (with/without comparisons), not from
  a second data source.
- A complete small product: empty, loading and error states, export, print, phone layout,
  dark mode, and tests that prove the API key never reaches the browser.

## What we learned

Taste data is most useful when you ask it comparative questions. "Who is popular here" is
a list; "who ranks higher here than everywhere else, and under this size" is a decision.

## What's next

- Budget tiers alongside capacity, and calendar awareness (weeknight vs weekend).
- Booking-agent contact handoff and hold requests from the brief.
- Post-show feedback: feed actual turnout back as seeds so each venue's lineup sharpens.
- A promoter view across several rooms in one city, using Qloo's audience comparisons to
  avoid booking the same crowd twice in one week.

## Built with

Qloo Taste AI API · Cloudflare Workers · Workers AI (Llama 3.3 70B) · Workers Static
Assets · JavaScript · Server-Sent Events
