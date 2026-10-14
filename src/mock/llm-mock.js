// Deterministic stand-in for the Workers AI model in demo mode and tests.
// It answers each agent task from the structured context (never from real data) and
// deliberately wraps some answers in markdown fences, as real models often do, so the
// tolerant JSON parser is exercised on every demo run.
import { BASELINE_ARENA_NAMES, h01 } from './qloo-mock.js';
import { fallbackKeywords } from '../agent.js';

const title = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

function plan(input) {
  return '```json\n' + JSON.stringify({
    location_query: title(input.location),
    keywords: fallbackKeywords(input.genres),
    audience_note: `A ${input.tier.label.toLowerCase()}-capacity room whose regulars like ${input.genres || 'a mix of styles'}.`,
  }, null, 2) + '\n```';
}

function lineup({ candidates, dates, input }) {
  const used = new Set();
  const pool = candidates.slice();
  const out = [];
  const near = (c) => 1 - Math.abs((c.popularity ?? 0) - input.tier.sweet);
  const heads = [...pool].sort((a, b) => b.affinity * 0.55 + near(b) * 0.45 - (a.affinity * 0.55 + near(a) * 0.45));
  for (let d = 0; d < dates; d++) {
    const h = heads.find((c) => !used.has(c.name));
    if (!h) break;
    used.add(h.name);
    const s = pool.find((c) => !used.has(c.name) && (c.popularity ?? 0) < (h.popularity ?? 1) && c.tags.some((t) => h.tags.includes(t))) || pool.find((c) => !used.has(c.name) && (c.popularity ?? 0) < (h.popularity ?? 1)) || pool.find((c) => !used.has(c.name));
    if (!s) break;
    used.add(s.name);
    out.push({
      headliner: h.name,
      support: s.name,
      theme: h.tags[0] ? `${h.tags[0]} and friends` : 'Local favourites night',
      why_headliner: `Affinity ${h.affinity.toFixed(2)} here (${h.local.text}); popularity ${h.popularity.toFixed(2)} fits the room; trend ${h.trend.label.toLowerCase()}.`,
      why_support: `Shares ${s.tags.find((t) => h.tags.includes(t)) || 'an audience'} with the headliner; affinity ${s.affinity.toFixed(2)}, popularity ${s.popularity.toFixed(2)}.`,
    });
  }
  return 'Here is the lineup:\n' + JSON.stringify({ dates: out });
}

function copy({ input, lineup: rows, places, brands }) {
  const partnerships = [...places, ...brands].map((p) => {
    const c = (p.category || '').toLowerCase();
    let idea = 'Shared giveaway: a pair of tickets plus a product bundle, announced on both accounts.';
    if (/coffee|bakery/.test(c)) idea = 'Show-week cup sleeves with a QR code to tickets, and a free drink for stub holders the next morning.';
    else if (/record/.test(c)) idea = 'Early-evening in-store set by the support act, with a ticket-plus-LP bundle at the till.';
    else if (/brew|wine|bar|barcade/.test(c)) idea = 'One-night special named after the headliner, poured at both spots, plus a pre-show discount for ticket holders.';
    else if (/taqueria|pizza|ramen/.test(c)) idea = 'Late-night menu deal for wristbands after the show; both sides post the offer.';
    else if (/apparel|denim|workwear|knit|skate|surf/.test(c)) idea = 'Limited co-branded merch run sold only at the show.';
    else if (/headphones|radio|instruments|pressing/.test(c)) idea = 'Sponsor a listening session and a raffle for gear among ticket holders.';
    return { name: p.name, idea };
  });
  const blurbs = rows.map((d) => {
    const pl = places[(d.date - 1) % Math.max(1, places.length)];
    const br = brands[(d.date - 1) % Math.max(1, brands.length)];
    const vibe = d.headliner.tags[0] ? d.headliner.tags[0].toLowerCase() : 'live music';
    return {
      date: d.date,
      text: `${d.headliner.name} headlines ${input.venueName}, with ${d.support.name} opening. A ${vibe} night for the crowd that already lives at ${pl ? pl.name : 'the neighbourhood spots'}${br ? ` and swears by ${br.name}` : ''}. ${input.tier.label} capacity, so it will feel full. Grab tickets before they go.`,
    };
  });
  return JSON.stringify({ partnerships, blurbs });
}

function baseline(input) {
  const start = Math.floor(h01(input.location + input.genres) * BASELINE_ARENA_NAMES.length);
  const names = [];
  for (let i = 0; i < input.dates * 2; i++) names.push(BASELINE_ARENA_NAMES[(start + i) % BASELINE_ARENA_NAMES.length]);
  const reasons = ['Huge crossover appeal that will pack the room.', 'A household name that sells tickets anywhere.', 'Chart-topping act with a massive fanbase.', 'Iconic live show everyone wants to see.'];
  const dates = [];
  for (let d = 0; d < input.dates; d++) dates.push({ headliner: names[d * 2], support: names[d * 2 + 1], reason: reasons[d % reasons.length] });
  return '```\n' + JSON.stringify({ dates }) + '\n```';
}

export async function mockComplete(task, context) {
  switch (task) {
    case 'plan':
      return plan(context);
    case 'lineup':
      return lineup(context);
    case 'copy':
      return copy(context);
    case 'baseline':
      return baseline(context);
    default:
      return '{}';
  }
}
