// The LineupLab agent: a deterministic tool pipeline that the LLM steers.
//
//   1  plan        LLM      venue free text -> Qloo location query + vibe keywords
//   2  qloo_tags   Qloo     keywords -> tag ids            (unmatched keywords are dropped, out loud)
//   3  qloo_search Qloo     past acts -> entity ids        (seeds + a draw-size sanity check)
//   4  insights    Qloo     artists for THIS neighbourhood + age, under the room's ceiling,
//                           trend-biased; relaxes step by step on an empty 200
//   5  insights x2 Qloo     same query without location / without trend bias -> local + trend signals
//   6  lineup      LLM      picks + orders from Qloo candidates only; unknown names rejected
//   7  insights x2 Qloo     places near the venue + brands the chosen acts' fans over-index on
//   8  copy        LLM      partnership ideas + announcement blurbs
//   B  baseline    LLM      the same brief with no Qloo, then Qloo-checked for room size
//
// Every step is emitted to the UI as a trace event.
import { CAPACITY_TIERS, AGE_BANDS, LIMITS, QLOO } from './config.js';
import { buildArtistParams, buildPlaceParams, buildBrandParams, popularityBand, sizeFit, RELAX_STEPS } from './params.js';
import { planPrompt, lineupPrompt, copyPrompt, baselinePrompt } from './prompts.js';

// ---------- input ----------

export function validateInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const venueName = str(b.venueName, LIMITS.venueName);
  const location = str(b.location, LIMITS.location);
  const tierId = typeof b.capacity === 'string' ? b.capacity : '';
  const age = typeof b.age === 'string' && Object.prototype.hasOwnProperty.call(AGE_BANDS, b.age) ? b.age : 'any';
  const genres = str(b.genres, LIMITS.genres);
  const pastActs = (Array.isArray(b.pastActs) ? b.pastActs : typeof b.pastActs === 'string' ? b.pastActs.split(/[\n,;]/) : [])
    .map((a) => str(a, LIMITS.pastAct))
    .filter(Boolean)
    .slice(0, LIMITS.maxPastActs);
  const dates = Number.parseInt(b.dates, 10);
  if (!location) errors.push('Tell us the neighbourhood or city the venue is in.');
  if (!CAPACITY_TIERS[tierId]) errors.push('Choose a capacity tier.');
  if (!(dates >= 1 && dates <= LIMITS.maxDates)) errors.push(`Dates to fill must be between 1 and ${LIMITS.maxDates}.`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: { venueName: venueName || 'Your venue', location, tier: CAPACITY_TIERS[tierId], age, genres, pastActs, dates },
  };
}

export function normalizedKey(input) {
  return {
    venueName: input.venueName.toLowerCase(),
    location: input.location.toLowerCase(),
    tier: input.tier.id,
    age: input.age,
    genres: input.genres.toLowerCase().split(/[,/;]|\band\b/).map((s) => s.trim()).filter(Boolean).sort(),
    pastActs: input.pastActs.map((a) => a.toLowerCase()).sort(),
    dates: input.dates,
  };
}

// ---------- helpers ----------

const r2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const lc = (s) => String(s || '').toLowerCase().trim();

// Qloo answers a location it cannot match to a locality with HTTP 400, not an empty 200
// (docs: signal.location.query). So every location-bearing call can walk down this list:
// the planner's phrase, the user's own words, then each broader comma tail ("Chicago, IL").
// One- to three-letter tails ("IL") are skipped - a fuzzy match on those lands anywhere.
export function localityLadder(...names) {
  const out = [];
  const add = (s) => {
    const t = clip(s, LIMITS.location);
    if (t && !out.some((x) => lc(x) === lc(t))) out.push(t);
  };
  names.forEach(add);
  for (const n of names) {
    const parts = clip(n, LIMITS.location).split(',').map((p) => p.trim()).filter(Boolean);
    for (let i = 1; i < parts.length; i++) if (parts.slice(i).join('').length > 3) add(parts.slice(i).join(', '));
  }
  return out.slice(0, 4);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function topStats(entities) {
  const aff = entities.map((e) => e.affinity).filter((n) => typeof n === 'number');
  const pop = entities.map((e) => e.popularity).filter((n) => typeof n === 'number');
  const stats = [{ label: 'results', value: String(entities.length) }];
  if (aff.length) stats.push({ label: 'top affinity', value: Math.max(...aff).toFixed(2) });
  if (pop.length) stats.push({ label: 'popularity range', value: `${Math.min(...pop).toFixed(2)}-${Math.max(...pop).toFixed(2)}` });
  return stats;
}

export function fallbackKeywords(genres) {
  return String(genres || '')
    .split(/[,/;+]|\band\b|&(?!b)/i)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s.length <= 30)
    .slice(0, QLOO.maxTagKeywords);
}

function categoryOf(e) {
  const t = e.tags.find((x) => /category/.test(x.type) || /category/.test(x.id)) || e.tags[0];
  return t ? t.name : null;
}

// ---------- signals ----------

export function localSignal(rankHere, rankGeneral) {
  if (rankGeneral == null) return { here: rankHere, general: null, label: 'Local pick', text: `#${rankHere} here, outside the top 50 without the location signal` };
  const gap = rankGeneral - rankHere;
  const label = gap >= 5 ? 'Over-indexes here' : gap > 0 ? 'Slightly local' : 'Broad appeal';
  return { here: rankHere, general: rankGeneral, label, text: `#${rankHere} here vs #${rankGeneral} without location` };
}

export function trendSignal(rankTrend, rankNoTrend) {
  if (rankNoTrend == null) return { delta: null, label: 'Rising', text: 'only surfaces with trend bias' };
  const delta = rankNoTrend - rankTrend;
  const label = delta >= 3 ? 'Rising' : delta <= -3 ? 'Cooling' : 'Steady';
  return { delta, label, text: delta === 0 ? 'same rank with or without trend bias' : `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} with trend bias` };
}

export function buildCandidates(main, noLocation, noTrend, tier, excludeIds = []) {
  const rank = (list) => new Map(list.map((e, i) => [e.entity_id || lc(e.name), i + 1]));
  const gen = rank(noLocation);
  const nt = rank(noTrend);
  const skip = new Set(excludeIds);
  // Measured 10-15 on the hackathon key: bias.trends low/medium/high returned the same ranks
  // as no bias at all. When it moves nothing, a 'Steady' on every card is not a finding, so
  // the signal is marked inert and the UI drops it.
  const inert = noTrend.length > 0 && main.every((e, i) => nt.get(e.entity_id || lc(e.name)) === i + 1);
  return main
    .filter((e) => !skip.has(e.entity_id))
    .map((e, i) => {
      const key = e.entity_id || lc(e.name);
      return {
        name: e.name,
        entity_id: e.entity_id,
        affinity: r2(e.affinity),
        popularity: r2(e.popularity),
        popularity_band: popularityBand(e.popularity),
        fit: sizeFit(e.popularity, tier),
        local: localSignal(i + 1, gen.get(key) ?? null),
        trend: inert ? { delta: 0, label: 'n/a', text: "Qloo's trend bias did not change any rank for this query", inert: true } : trendSignal(i + 1, nt.get(key) ?? null),
        tags: e.tags.filter((t) => /genre/.test(t.type) || /genre/.test(t.id)).map((t) => t.name).slice(0, 4),
        explainability: e.explainability,
      };
    });
}

export function evidenceWhy(c, input) {
  const who = input.age !== 'any' ? `${AGE_BANDS[input.age].toLowerCase()} listeners` : 'listeners';
  const parts = [`Affinity ${c.affinity?.toFixed(2) ?? 'n/a'} with ${who} around ${input.location}`];
  parts.push(c.local.general == null ? 'only ranks with the location signal' : `${c.local.text}`);
  if (typeof c.popularity === 'number') parts.push(`popularity ${c.popularity.toFixed(2)} under your ${input.tier.popMax.toFixed(2)} ceiling`);
  if (c.trend.label !== 'Steady' && !c.trend.inert) parts.push(c.trend.label.toLowerCase() + ' with trend bias');
  return parts.join('; ') + '.';
}

// Deterministic lineup used when the LLM's answer is missing or invalid.
export function fallbackLineup(candidates, dates, tier) {
  const pool = candidates.slice(0, Math.max(dates * 4, 12));
  const used = new Set();
  const headScore = (c) => (c.affinity ?? 0) * 0.6 + (1 - Math.abs((c.popularity ?? 0) - tier.sweet)) * 0.4;
  const byHeadliner = [...pool].sort((a, b) => headScore(b) - headScore(a));
  const out = [];
  for (let d = 0; d < dates; d++) {
    const head = byHeadliner.find((c) => !used.has(c.name));
    if (!head) break;
    used.add(head.name);
    const shared = (c) => c.tags.some((t) => head.tags.includes(t));
    const support =
      pool.find((c) => !used.has(c.name) && (c.popularity ?? 0) <= (head.popularity ?? 1) && shared(c)) ||
      pool.find((c) => !used.has(c.name) && (c.popularity ?? 0) <= (head.popularity ?? 1)) ||
      pool.find((c) => !used.has(c.name));
    if (!support) break;
    used.add(support.name);
    out.push({ head, support, theme: head.tags[0] ? `${head.tags[0]} night` : '' });
  }
  return out;
}

// Validate the LLM's picks against the Qloo candidate set; fill any gap deterministically.
export function reconcileLineup(llmData, candidates, dates, tier) {
  const byName = new Map(candidates.map((c) => [lc(c.name), c]));
  const used = new Set();
  const rejected = [];
  const picks = [];
  const rows = Array.isArray(llmData?.dates) ? llmData.dates : Array.isArray(llmData) ? llmData : [];
  for (const row of rows.slice(0, dates)) {
    if (!row || typeof row !== 'object') continue;
    const head = byName.get(lc(row.headliner));
    const sup = byName.get(lc(row.support));
    if (!head) rejected.push(clip(String(row.headliner ?? ''), 60));
    if (!sup) rejected.push(clip(String(row.support ?? ''), 60));
    if (!head || !sup || head === sup || used.has(head.name) || used.has(sup.name)) continue;
    used.add(head.name);
    used.add(sup.name);
    let h = { c: head, why: clip(row.why_headliner, 220) };
    let s = { c: sup, why: clip(row.why_support, 220) };
    if ((sup.popularity ?? 0) - (head.popularity ?? 0) > 0.1) [h, s] = [s, h];
    picks.push({ head: h.c, support: s.c, headWhy: h.why, supWhy: s.why, theme: clip(row.theme, 48), source: 'llm' });
  }
  if (picks.length < dates) {
    const rest = fallbackLineup(candidates.filter((c) => !used.has(c.name)), dates - picks.length, tier);
    for (const r of rest) picks.push({ head: r.head, support: r.support, headWhy: '', supWhy: '', theme: r.theme, source: 'fallback' });
  }
  return { picks, rejected: rejected.filter(Boolean) };
}

const IDEAS = [
  [/coffee|bakery/i, 'Show-week cup sleeves or table cards, plus a discount for anyone holding a ticket stub the morning after.'],
  [/record|vinyl|pressing/i, 'In-store acoustic set the week before, and a ticket-plus-record bundle sold at the counter.'],
  [/brew|beer|seltzer|kombucha|spirit|mezcal|wine/i, 'A one-night tap or can named after the show, poured at the venue and promoted by both sides.'],
  [/bar|barcade|ramen|taco|taqueria|pizza/i, 'Pre-show happy hour for ticket holders and a shared post on both accounts.'],
  [/gallery|tattoo|book|plant|vintage|skate|ceramic|candle|knit|stationery/i, 'Co-hosted pop-up at the venue on show night, with a flyer wall and a shared giveaway.'],
];
export function fallbackIdea(p) {
  const hay = `${p.category || ''} ${p.name}`;
  for (const [re, idea] of IDEAS) if (re.test(hay)) return idea;
  return 'Ticket-and-product giveaway announced on both audiences\' channels the week of the show.';
}

export function fallbackBlurb(input, d, places, brands) {
  const near = places[0] ? places[0].name : null;
  const brand = brands[0] ? brands[0].name : null;
  const taste = near && brand ? ` If your week already runs through ${near} and ${brand}, this one is for you.` : near ? ` Spotted at ${near}? This one is for you.` : '';
  const vibe = d.headliner.tags[0] ? ` A ${d.headliner.tags[0].toLowerCase()} night` : ' A night';
  return `${input.venueName} presents ${d.headliner.name} with support from ${d.support.name}.${vibe} picked for ${input.location}.${taste} Small room, limited tickets.`.slice(0, 400);
}

// ---------- the agent ----------

export async function runAgent(input, { qloo, llm, emit = () => {} }) {
  const started = Date.now();
  let seq = 0;
  const trace = [];
  const step = (s) => {
    const ev = { id: ++seq, t: Date.now() - started, lane: 'agent', status: 'ok', ...s };
    trace.push(ev);
    emit(ev);
    return ev;
  };
  const tier = input.tier;

  step({
    lane: 'agent',
    title: 'Reading the brief',
    detail: `${input.venueName}, ${input.location}. ${tier.label} capacity, so Qloo will only return acts under popularity ${tier.popMax.toFixed(2)}.`,
    stats: [
      { label: 'dates', value: String(input.dates) },
      { label: 'ceiling', value: tier.popMax.toFixed(2) },
      { label: 'age', value: AGE_BANDS[input.age] },
    ],
  });

  // Lane B starts immediately and runs alongside the Qloo lane.
  const baselineP = runBaseline(input, { qloo, llm, step }).catch((err) => {
    step({ lane: 'baseline', status: 'error', title: 'Without-Qloo comparison failed', detail: safeMsg(err) });
    return null;
  });

  // 1. plan
  const plan = planPrompt(input);
  const planRes = await llm.json({ task: 'plan', ...plan, context: input, maxTokens: 300 });
  let locationQuery = clip(planRes.data?.location_query, LIMITS.location) || input.location;
  let keywords = Array.isArray(planRes.data?.keywords)
    ? planRes.data.keywords.filter((k) => typeof k === 'string').map((k) => clip(k, 30).toLowerCase()).filter(Boolean).slice(0, QLOO.maxTagKeywords)
    : null;
  const planFallback = !planRes.ok || keywords === null;
  if (keywords === null) keywords = fallbackKeywords(input.genres);
  const audienceNote = clip(planRes.data?.audience_note, 200);

  // Every location-bearing Qloo call goes through here. On a 400 with a location set it
  // moves to the next broader name and retries. With none left, a location SIGNAL (artists,
  // brands) is dropped and the run goes on; a location FILTER (places) returns empty, since
  // places anywhere are useless. A 400 that survives without a location is a real error.
  const ladder = localityLadder(locationQuery, input.location);
  let rung = 0;
  async function insightsAt(build, o, { filter = false } = {}) {
    for (;;) {
      const loc = o.location === null ? null : ladder[rung] ?? null;
      if (filter && !loc) return { entities: [], request: 'skipped: no matched locality', cached: false, ms: 0 };
      try {
        const r = await qloo.insights(build({ ...o, location: loc }));
        if (loc) locationQuery = loc;
        return { ...r, located: !!loc };
      } catch (err) {
        if (!(err && err.name === 'QlooError' && err.status === 400 && loc)) throw err;
        rung++;
        const next = ladder[rung];
        step({
          lane: 'qloo',
          status: 'fallback',
          title: `qloo_insights: Qloo matched no locality for "${loc}"`,
          detail: next
            ? `Qloo answers an unmatched place name with HTTP 400, so the agent retries with the broader "${next}".`
            : filter
              ? 'No broader name left, so nearby places are skipped.'
              : 'No broader name left, so the agent continues without the location signal: picks fit the audience, not this neighbourhood.',
        });
      }
    }
  }
  if (llm.degradedReason) {
    step({
      lane: 'llm',
      status: 'fallback',
      title: 'Workers AI unavailable: switching to the demo model',
      detail: 'The AI binding did not answer (normal under wrangler dev --local). Qloo is on demo fixtures too, so the run continues on the deterministic demo model.',
    });
  }
  step({
    lane: 'llm',
    status: planFallback ? 'fallback' : 'ok',
    title: 'Planner: brief to Qloo inputs',
    detail: planFallback
      ? planRes.error
        ? 'The model call failed, so the brief was used as typed.'
        : 'The model\'s answer did not parse, so the brief was used as typed.'
      : `Location "${locationQuery}"${keywords.length ? `, vibe keywords: ${keywords.join(', ')}` : ', no vibe keywords'}.`,
    stats: [{ label: 'model ms', value: String(planRes.ms) }],
    ms: planRes.ms,
  });

  // 2. tags
  const tagPicks = await pool(keywords, 4, async (kw) => {
    let r = await qloo.tags(kw);
    let note = '';
    if (!r.tags.length) {
      r = await qloo.tags(kw, { typed: false });
      note = ' (retried without the music tag-type filter)';
    }
    const pick = r.tags.find((t) => /music|genre/.test(t.type + t.id)) || r.tags[0] || null;
    step({
      lane: 'qloo',
      status: pick ? (r.cached ? 'cached' : 'ok') : 'empty',
      title: `qloo_tags "${kw}"`,
      detail: pick
        ? `Matched tag ${pick.name}${note}.`
        : `No tag matched${note}. Keyword dropped: Qloo silently ignores tag ids it does not know, so sending a guess would quietly do nothing.`,
      request: r.request,
      stats: [{ label: 'results', value: String(r.tags.length) }, ...(pick ? [{ label: 'tag', value: pick.id }] : [])],
      ms: r.ms,
    });
    return pick;
  });
  const tags = tagPicks.filter(Boolean);

  // 3. seeds
  const seeds = await pool(input.pastActs, 3, async (name) => {
    const r = await qloo.search(name);
    const hit = r.entities.find((e) => e.types.includes('urn:entity:artist')) || r.entities[0] || null;
    const fit = hit ? sizeFit(hit.popularity, tier) : null;
    step({
      lane: 'qloo',
      status: hit ? (r.cached ? 'cached' : 'ok') : 'empty',
      title: `qloo_search "${name}"`,
      detail: hit
        ? `Found ${hit.name}${typeof hit.popularity === 'number' ? `, popularity ${hit.popularity.toFixed(2)}` : ''}. ${fit && fit.ok === false ? 'Bigger than this room usually holds: used as a taste seed, not as a size reference.' : 'Used as a taste seed.'}`
        : 'Not found in Qloo; skipped as a seed.',
      request: r.request,
      stats: [{ label: 'results', value: String(r.entities.length) }, ...(hit && typeof hit.popularity === 'number' ? [{ label: 'popularity', value: hit.popularity.toFixed(2) }] : [])],
      ms: r.ms,
    });
    return hit ? { input: name, name: hit.name, entity_id: hit.entity_id, popularity: r2(hit.popularity) } : { input: name, name: null, entity_id: null };
  });
  const seedIds = seeds.map((s) => s.entity_id).filter(Boolean);

  // 4. main artist query with relax ladder. Qloo can also MATCH a neighbourhood and hold no
  // taste data for it: "East Nashville, Nashville, TN" is an empty 200 with every signal
  // relaxed, while "Nashville, TN" returns 50 acts (live, 10-16). So when the whole relax
  // ladder comes back empty and a broader locality is left, start over one rung up.
  const baseOpts = { location: locationQuery, age: input.age, tier, tagIds: tags.map((t) => t.id), entityIds: seedIds };
  let opts = baseOpts;
  let main = null;
  for (;;) {
    let used = null;
    for (const rs of RELAX_STEPS) {
      const o = rs.change(opts);
      if (rs.id !== 'full' && used && JSON.stringify(o) === JSON.stringify(used)) continue; // nothing to relax
      const params = buildArtistParams(o);
      const r = await insightsAt(buildArtistParams, o);
      used = o;
      const empty = r.entities.length === 0;
      step({
        lane: 'qloo',
        status: empty ? 'empty' : r.cached ? 'cached' : 'ok',
        title: rs.id === 'full' ? 'qloo_insights: artists this neighbourhood over-indexes on' : `qloo_insights retry (${rs.label})`,
        detail: empty
          ? 'Empty 200. Qloo answers an ignored or over-tight parameter with zero results rather than an error, so the agent relaxes one constraint and asks again.'
          : `${r.entities.length} acts under popularity ${params['filter.popularity.max']} for this audience, trend bias ${params['bias.trends'] || 'off'}.`,
        request: r.request,
        stats: topStats(r.entities),
        ms: r.ms,
      });
      if (!empty) {
        main = r.entities;
        opts = o;
        break;
      }
    }
    if (main || rung + 1 >= ladder.length) break;
    const thin = ladder[rung];
    rung++;
    step({
      lane: 'qloo',
      status: 'fallback',
      title: `qloo_insights: no taste data for "${thin}"`,
      detail: `Qloo matched the place but returned no artists for it even with every optional signal relaxed, so the agent starts over with the broader "${ladder[rung]}".`,
    });
    opts = { ...baseOpts, location: ladder[rung] };
  }
  if (!main) {
    const err = new Error('Qloo returned no artists for this brief, even after relaxing every optional signal. Check the neighbourhood spelling.');
    err.userFacing = true;
    throw err;
  }

  // 5. local + trend signals
  const [noLoc, noTrend] = await Promise.all([qloo.insights(buildArtistParams({ ...opts, location: null })), insightsAt(buildArtistParams, { ...opts, trends: null })]);
  step({
    lane: 'qloo',
    status: noLoc.cached ? 'cached' : 'ok',
    title: 'qloo_insights: same query without the location signal',
    detail: 'Ranks each act with and without the neighbourhood, to find who over-indexes HERE rather than everywhere.',
    request: noLoc.request,
    stats: topStats(noLoc.entities),
    ms: noLoc.ms,
  });
  step({
    lane: 'qloo',
    status: noTrend.cached ? 'cached' : 'ok',
    title: 'qloo_insights: same query without trend bias',
    detail: 'The rank change between the two runs is the trend signal on each card.',
    request: noTrend.request,
    stats: topStats(noTrend.entities),
    ms: noTrend.ms,
  });
  const candidates = buildCandidates(main, noLoc.entities, noTrend.entities, tier, seedIds);
  const overIndex = candidates.filter((c) => c.local.label === 'Over-indexes here' || c.local.label === 'Local pick').length;
  step({
    lane: 'agent',
    title: 'Scored the candidate pool',
    detail: `${candidates.length} candidates. ${overIndex} rank clearly higher here than without the location signal; ${candidates.some((c) => c.trend.inert) ? "Qloo's trend bias changed no rank, so cards carry no trend signal." : `${candidates.filter((c) => c.trend.label === 'Rising').length} rise with trend bias.`}`,
    stats: [
      { label: 'candidates', value: String(candidates.length) },
      { label: 'local over-index', value: String(overIndex) },
    ],
  });
  if (candidates.length < input.dates * 2) {
    const err = new Error(`Qloo returned ${candidates.length} usable acts, not enough for ${input.dates} dates. Try fewer dates or a wider area.`);
    err.userFacing = true;
    throw err;
  }

  // 6. lineup
  const shortlist = candidates.slice(0, Math.min(24, Math.max(12, input.dates * 4)));
  const lp = lineupPrompt(input, shortlist, input.dates);
  const lRes = await llm.json({ task: 'lineup', ...lp, context: { input, candidates: shortlist, dates: input.dates }, maxTokens: 250 + input.dates * 160 });
  const { picks, rejected } = reconcileLineup(lRes.data, shortlist.length >= input.dates * 2 ? shortlist : candidates, input.dates, tier);
  const fb = picks.filter((p) => p.source === 'fallback').length;
  step({
    lane: 'llm',
    status: fb ? 'fallback' : 'ok',
    title: 'Lineup picker: choose and order from Qloo candidates',
    detail:
      (rejected.length ? `Rejected ${rejected.length} name(s) not in Qloo's candidates (${rejected.slice(0, 3).join(', ')}). ` : 'Every pick is a Qloo candidate. ') +
      (fb ? `${fb} date(s) filled by the deterministic picker.` : `${picks.length} date(s) planned by the model.`),
    stats: [
      { label: 'shortlist', value: String(shortlist.length) },
      { label: 'rejected', value: String(rejected.length) },
    ],
    ms: lRes.ms,
  });

  const act = (c, why) => ({
    name: c.name,
    entity_id: c.entity_id,
    affinity: c.affinity,
    popularity: c.popularity,
    popularity_band: c.popularity_band,
    fit: c.fit,
    local: c.local,
    trend: c.trend,
    tags: c.tags,
    why: why || evidenceWhy(c, input),
    evidence: evidenceWhy(c, input),
  });
  const lineup = picks.map((p, i) => ({ date: i + 1, theme: p.theme || '', headliner: act(p.head, p.headWhy), support: act(p.support, p.supWhy), blurb: '' }));
  const chosenIds = lineup.flatMap((d) => [d.headliner.entity_id, d.support.entity_id]).filter(Boolean).slice(0, 8);

  // 7. cross-domain: places near the venue + brands
  let placesR = await insightsAt(buildPlaceParams, { location: locationQuery, artistIds: chosenIds, age: input.age }, { filter: true });
  let placeNote = '';
  if (!placesR.entities.length && placesR.located) {
    step({ lane: 'qloo', status: 'empty', title: 'qloo_insights: nearby places (empty)', detail: 'Empty 200; retrying with a wider radius and no age signal.', request: placesR.request, stats: [{ label: 'results', value: '0' }], ms: placesR.ms });
    placesR = await insightsAt(buildPlaceParams, { location: locationQuery, artistIds: chosenIds, radius: QLOO.placeRadiusMeters * 3 }, { filter: true });
    placeNote = ' (wider radius)';
  }
  const brandsR = await insightsAt(buildBrandParams, { location: locationQuery, artistIds: chosenIds, age: input.age });
  step({
    lane: 'qloo',
    status: placesR.entities.length ? (placesR.cached ? 'cached' : 'ok') : 'empty',
    title: 'qloo_insights: places near the venue these fans over-index on',
    detail: placesR.located
      ? `Cross-domain: places within ${placeNote ? QLOO.placeRadiusMeters * 3 : QLOO.placeRadiusMeters} m of "${locationQuery}", ranked by the taste of the ${chosenIds.length} acts on the lineup${placeNote}.`
      : 'Qloo matched no locality for this venue, so nearby places are skipped rather than guessed.',
    request: placesR.request,
    stats: topStats(placesR.entities),
    ms: placesR.ms,
  });
  step({
    lane: 'qloo',
    status: brandsR.entities.length ? (brandsR.cached ? 'cached' : 'ok') : 'empty',
    title: 'qloo_insights: brands the same fans over-index on',
    detail: brandsR.entities.length ? 'Cross-domain brand affinity for the lineup\'s audience.' : 'Empty 200; brand partners skipped rather than guessed.',
    request: brandsR.request,
    stats: topStats(brandsR.entities),
    ms: brandsR.ms,
  });
  const toPartner = (e) => ({ name: e.name, entity_id: e.entity_id, affinity: r2(e.affinity), popularity: r2(e.popularity), category: categoryOf(e), address: e.address, idea: '' });
  const places = placesR.entities.slice(0, 6).map(toPartner);
  const brands = brandsR.entities.slice(0, 6).map(toPartner);

  // 8. copy
  const cp = copyPrompt(input, lineup, places, brands, keywords);
  const cRes = await llm.json({ task: 'copy', ...cp, context: { input, lineup, places, brands, keywords }, maxTokens: 300 + input.dates * 120 + (places.length + brands.length) * 40 });
  const ideaMap = new Map((Array.isArray(cRes.data?.partnerships) ? cRes.data.partnerships : []).filter((x) => x && typeof x === 'object').map((x) => [lc(x.name), clip(x.idea, 220)]));
  let ideaFallbacks = 0;
  for (const p of [...places, ...brands]) {
    p.idea = ideaMap.get(lc(p.name)) || '';
    if (!p.idea) {
      p.idea = fallbackIdea(p);
      ideaFallbacks++;
    }
  }
  const blurbRows = Array.isArray(cRes.data?.blurbs) ? cRes.data.blurbs : [];
  let blurbFallbacks = 0;
  for (const d of lineup) {
    const row = blurbRows.find((b) => b && Number(b.date) === d.date) || blurbRows[d.date - 1];
    d.blurb = clip(row && typeof row === 'object' ? row.text : typeof row === 'string' ? row : '', 480);
    if (!d.blurb) {
      d.blurb = fallbackBlurb(input, d, places, brands);
      blurbFallbacks++;
    }
  }
  step({
    lane: 'llm',
    status: ideaFallbacks || blurbFallbacks ? 'fallback' : 'ok',
    title: 'Copywriter: partnership ideas and announcements',
    detail: ideaFallbacks || blurbFallbacks ? `${ideaFallbacks} idea(s) and ${blurbFallbacks} blurb(s) came from templates because the model's answer was incomplete.` : 'Written to the audience\'s adjacent tastes from the Qloo places and brands.',
    ms: cRes.ms,
  });

  const baseline = await baselineP;

  const result = {
    venue: {
      name: input.venueName,
      location: input.location,
      capacity: { id: tier.id, label: tier.label, popMax: tier.popMax },
      age: { id: input.age, label: AGE_BANDS[input.age] },
      genres: input.genres,
      pastActs: input.pastActs,
      dates: input.dates,
    },
    plan: { location_query: locationQuery, keywords, audience_note: audienceNote, tags: tags.map((t) => ({ id: t.id, name: t.name })), seeds },
    lineup,
    copromote: { places, brands },
    baseline,
    stats: { qloo_calls: qloo.calls, llm_calls: llm.calls, candidates: candidates.length, ms: Date.now() - started },
  };
  step({
    lane: 'agent',
    title: 'Lineup ready',
    detail: `${lineup.length} date(s), ${places.length} places and ${brands.length} brands to co-promote with.`,
    stats: [
      { label: 'Qloo calls', value: String(qloo.calls) },
      { label: 'LLM calls', value: String(llm.calls) },
      { label: 'total ms', value: String(Date.now() - started) },
    ],
  });
  result.trace = trace;
  return result;
}

async function runBaseline(input, { qloo, llm, step }) {
  const bp = baselinePrompt(input);
  const res = await llm.json({ task: 'baseline', ...bp, context: input, maxTokens: 200 + input.dates * 90 });
  const rows = (Array.isArray(res.data?.dates) ? res.data.dates : []).filter((r) => r && typeof r === 'object').slice(0, input.dates);
  step({
    lane: 'baseline',
    status: rows.length ? 'ok' : 'fallback',
    title: 'Without Qloo: same model, same brief, no taste data',
    detail: rows.length ? `The model suggested ${rows.length} date(s) from memory alone.` : 'The model gave no usable lineup.',
    ms: res.ms,
  });
  const names = [...new Set(rows.flatMap((r) => [clip(r.headliner, 80), clip(r.support, 80)]).filter(Boolean))].slice(0, 12);
  const checks = new Map();
  await pool(names, 4, async (n) => {
    try {
      const r = await qloo.search(n);
      const hit = r.entities[0] || null;
      checks.set(lc(n), hit ? { found: true, matched: hit.name, popularity: r2(hit.popularity), fit: sizeFit(hit.popularity, input.tier), band: popularityBand(hit.popularity) } : { found: false });
    } catch {
      checks.set(lc(n), { found: false });
    }
  });
  const tooBig = [...checks.values()].filter((c) => c.fit && c.fit.ok === false).length;
  if (names.length) {
    step({
      lane: 'baseline',
      status: 'ok',
      title: 'qloo_search: size-check the model\'s own picks',
      detail: `${tooBig} of ${names.length} suggested acts sit above this room's popularity ceiling of ${input.tier.popMax.toFixed(2)}.`,
      stats: [
        { label: 'checked', value: String(names.length) },
        { label: 'too big', value: String(tooBig) },
      ],
    });
  }
  const side = (n, reason) => ({ name: clip(n, 80) || 'n/a', reason: clip(reason, 200), qloo: checks.get(lc(n)) || { found: false } });
  return {
    lineup: rows.map((r, i) => ({ date: i + 1, headliner: side(r.headliner, r.reason), support: side(r.support, '') })),
    too_big: tooBig,
    checked: names.length,
  };
}

export function safeMsg(err) {
  if (err && err.userFacing) return err.message;
  if (err && err.name === 'QlooError') return err.message;
  return 'Something went wrong while building the lineup.';
}
