// SYNTHETIC Qloo fixtures for demo mode, local dev and tests.
//
// Every artist, place and brand below is invented. Nothing here is, or was derived from,
// real Qloo response data. The generator only reproduces the response SHAPE
// ({success, results:{entities:[...]}}) and the behaviour that matters for the demo:
// filter.popularity.max is honoured, location / age / tags / seeds / trend bias each move
// the ranking, and a missing filter.type returns an empty 200 like the real API does
// when it ignores a parameter.

const ADJ = ['Juniper', 'Marrow', 'Cinder', 'Halcyon', 'Brindle', 'Saffron', 'Tallow', 'Quince', 'Vellum', 'Larkspur', 'Pewter', 'Thimble', 'Sorrel', 'Gossamer', 'Bramble', 'Tamarind', 'Ochre', 'Wicklow'];
const NOUN = ['Static', 'Parlour', 'Ferns', 'Orchard', 'Signal', 'Union', 'Choir', 'Engine', 'Motel', 'Bloom', 'Assembly', 'Harbor', 'Satellite', 'Fable', 'Weather', 'Society'];
const FIRST = ['Mara', 'Tamsin', 'Odile', 'Ruben', 'Ines', 'Calla', 'Desmond', 'Yara', 'Felix', 'Noor', 'Augustin', 'Lio'];
const LAST = ['Quell', 'Vey', 'Marchetti', 'Okonkwo-Hale', 'Brightwater', 'Lindqvist', 'Sabe', 'Corvo', 'Achterberg', 'Paz'];

export const GENRES = [
  'indie rock', 'dream pop', 'shoegaze', 'post-punk', 'folk', 'americana', 'country', 'hip hop',
  'r&b', 'neo soul', 'jazz', 'funk', 'house', 'techno', 'disco', 'synthpop', 'punk', 'metal',
  'emo', 'singer-songwriter', 'latin', 'cumbia', 'afrobeats', 'bluegrass', 'blues', 'garage rock',
  'ambient', 'electronic', 'reggae', 'soul',
];
const SYN = { rnb: 'r&b', 'r and b': 'r&b', 'hip-hop': 'hip hop', rap: 'hip hop', edm: 'electronic', dance: 'house', 'indie': 'indie rock', rock: 'garage rock', acoustic: 'singer-songwriter', 'alt country': 'americana', 'alt-country': 'americana', soulful: 'soul', dreamy: 'dream pop', 'lo-fi': 'dream pop', experimental: 'ambient', hardcore: 'punk', club: 'house' };

const slug = (s) => s.toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export const tagId = (g) => `urn:tag:genre:music:${slug(g)}`;

// FNV-1a -> [0,1)
export function h01(str) {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 0x01000193);
  }
  return ((x >>> 0) % 100000) / 100000;
}
const hex = (str, n = 12) => {
  let out = '';
  let i = 0;
  while (out.length < n) out += Math.floor(h01(str + ':' + i++) * 0xffff).toString(16).padStart(4, '0');
  return out.slice(0, n);
};
const mockId = (kind, name) => `${hex(kind + name, 8)}-${hex(name + kind, 4)}-4${hex(name, 3)}-a${hex(kind, 3)}-${hex(name + 'x', 12)}`;
const r2 = (n) => Math.round(n * 1000) / 1000;

// Fictional artist universe (built once).
const ARTISTS = (() => {
  const out = [];
  const seen = new Set();
  let i = 0;
  while (out.length < 150 && i < 2000) {
    const k = `a${i++}`;
    const pick = h01(k + 'kind');
    let name;
    if (pick < 0.62) name = `${ADJ[Math.floor(h01(k + 'adj') * ADJ.length)]} ${NOUN[Math.floor(h01(k + 'noun') * NOUN.length)]}`;
    else if (pick < 0.82) name = `${FIRST[Math.floor(h01(k + 'f') * FIRST.length)]} ${LAST[Math.floor(h01(k + 'l') * LAST.length)]}`;
    else name = `The ${ADJ[Math.floor(h01(k + 'a2') * ADJ.length)]} ${NOUN[Math.floor(h01(k + 'n2') * NOUN.length)]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const g1 = GENRES[Math.floor(h01(k + 'g1') * GENRES.length)];
    const g2 = GENRES[Math.floor(h01(k + 'g2') * GENRES.length)];
    // Popularity skews low, like the long tail of real artists.
    const pop = r2(Math.min(0.995, Math.pow(h01(k + 'pop'), 0.75)));
    out.push({
      name,
      id: mockId('artist', name),
      genres: g1 === g2 ? [g1] : [g1, g2],
      pop,
      general: h01(k + 'gen'),
      momentum: h01(k + 'mom') * 2 - 1,
    });
  }
  return out;
})();

// Names the "LLM alone" mock suggests: famous-sounding, invented, arena sized.
export const BASELINE_ARENA_NAMES = ['The Gilded Anthems', 'Monarch Skyline', 'Aurora Grandstand', 'Big Sky Revival', 'The Platinum Hours', 'Crown and Comet', 'Starfield Coliseum', 'Velvet Empire', 'Northern Pageant', 'The Golden Mile Band', 'Heatwave Republic', 'Midnight Cathedral'];

const PLACE_KINDS = [
  ['coffee', 'Coffee shop', 'Coffee'], ['record', 'Record store', 'Records'], ['brewery', 'Brewery', 'Brewing'],
  ['bar', 'Cocktail bar', 'Bar'], ['vintage', 'Vintage clothing', 'Vintage'], ['books', 'Bookstore', 'Books'],
  ['tacos', 'Taqueria', 'Taqueria'], ['pizza', 'Pizza by the slice', 'Pizza'], ['gallery', 'Art gallery', 'Gallery'],
  ['skate', 'Skate shop', 'Skate Shop'], ['ramen', 'Ramen bar', 'Ramen'], ['bakery', 'Bakery', 'Bakery'],
  ['tattoo', 'Tattoo studio', 'Tattoo'], ['plants', 'Plant shop', 'Plant Co.'], ['wine', 'Natural wine bar', 'Wine Bar'],
  ['arcade', 'Barcade', 'Barcade'],
];
const PLACE_NAMES = ['Hollowpine', 'Copper Kettle', 'Fernhouse', 'Lowlight', 'Second Spin', 'Ruby Tram', 'Moth and Lamp', 'Tinderbox', 'Gravel Garden', 'Night Owl', 'Parcel Post', 'Little Comet', 'Rook and Rye', 'Sundial', 'Blue Heron', 'Mason Jar', 'Odd Fellows', 'Paper Lantern', 'Wild Clover', 'Ferris'];
const BRANDS = [
  ['Northpaw Outdoor', 'Outdoor apparel'], ['Fizzwick Seltzer', 'Hard seltzer'], ['Tidewater Denim', 'Denim'],
  ['Grainline Supply', 'Workwear'], ['Lumen Bikes', 'Bicycles'], ['Paloma Grove Mezcal', 'Spirits'],
  ['Backbeat Audio', 'Headphones'], ['Small Hours Cold Brew', 'Coffee'], ['Kiln and Fern', 'Ceramics'],
  ['Halfpipe Skate Co.', 'Skate'], ['Moonmilk Kombucha', 'Kombucha'], ['Ledger Notebooks', 'Stationery'],
  ['Saltmarsh Surf', 'Surf apparel'], ['Cassette Club Radio', 'Streaming radio'], ['Oddsock Knitwear', 'Knitwear'],
  ['Sparrow Vinyl Pressing', 'Record pressing'], ['Driftwood Candle Co.', 'Candles'], ['Pocket Synth Labs', 'Instruments'],
];

function matchGenres(keyword) {
  const k = String(keyword || '').toLowerCase().trim();
  if (!k) return [];
  const target = SYN[k] || k;
  const exact = GENRES.filter((g) => g === target);
  if (exact.length) return exact;
  return GENRES.filter((g) => g.includes(target) || (target.length > 3 && target.includes(g))).slice(0, 3);
}

function artistEntity(a, affinity, explain) {
  return {
    entity_id: a.id,
    name: a.name,
    type: 'urn:entity',
    subtype: 'urn:entity:artist',
    types: ['urn:entity:artist'],
    popularity: a.pop,
    properties: { short_description: `Fictional ${a.genres.join(' / ')} act (demo data).` },
    tags: a.genres.map((g) => ({ id: tagId(g), name: g.replace(/\b\w/g, (c) => c.toUpperCase()), type: 'urn:tag:genre:music' })),
    query: { affinity: r2(affinity), explainability: explain },
  };
}

function seedGenres(ids) {
  const set = new Set();
  for (const id of ids) {
    const a = ARTISTS.find((x) => x.id === id);
    if (a) a.genres.forEach((g) => set.add(g));
    else set.add(GENRES[Math.floor(h01(id) * GENRES.length)]);
  }
  return set;
}

function insightsArtists(p) {
  const popMax = p.has('filter.popularity.max') ? +p.get('filter.popularity.max') : 1;
  const loc = (p.get('signal.location.query') || '').toLowerCase();
  const age = p.get('signal.demographics.age') || '';
  const tags = (p.get('signal.interests.tags') || '').split(',').filter(Boolean);
  const seeds = (p.get('signal.interests.entities') || '').split(',').filter(Boolean);
  const trends = p.get('bias.trends');
  const take = Math.min(50, +(p.get('take') || 20));
  const wantGenres = new Set(GENRES.filter((g) => tags.includes(tagId(g))));
  const sg = seedGenres(seeds);
  const scored = ARTISTS.filter((a) => a.pop <= popMax && !seeds.includes(a.id)).map((a) => {
    const local = loc ? h01(loc + '|' + a.name) : 0;
    const base = loc ? 0.3 * a.general + 0.7 * local : a.general;
    const tagHit = a.genres.some((g) => wantGenres.has(g)) ? 1 : 0;
    const seedHit = a.genres.some((g) => sg.has(g)) ? 1 : 0;
    const ageFit = age ? h01(age + '|' + a.name) : 0.5;
    const trend = trends ? ({ low: 0.05, medium: 0.1, high: 0.18 }[trends] || 0.1) * a.momentum : 0;
    const score = 0.48 * base + 0.24 * tagHit + 0.14 * seedHit + 0.1 * ageFit + trend;
    const explain = {};
    if (loc) explain['signal.location.query'] = r2(0.7 * local);
    if (age) explain['signal.demographics.age'] = r2(0.1 * ageFit);
    if (tags.length) explain['signal.interests.tags'] = r2(0.24 * tagHit);
    if (seeds.length) explain['signal.interests.entities'] = r2(0.14 * seedHit);
    return { a, score, explain };
  });
  scored.sort((x, y) => y.score - x.score);
  const top = scored[0]?.score || 1;
  return scored.slice(0, take).map((s) => artistEntity(s.a, Math.max(0.05, Math.min(0.99, 0.99 * (s.score / top))), s.explain));
}

function insightsPlaces(p) {
  const loc = p.get('filter.location.query') || p.get('signal.location.query') || 'here';
  const seeds = p.get('signal.interests.entities') || '';
  const take = Math.min(50, +(p.get('take') || 10));
  const items = PLACE_NAMES.map((n, i) => {
    const kind = PLACE_KINDS[Math.floor(h01(loc + n) * PLACE_KINDS.length)];
    const name = `${n} ${kind[2]}`;
    const aff = 0.35 + 0.64 * h01(seeds + '|' + loc + '|' + n);
    return {
      entity_id: mockId('place', name + loc),
      name,
      type: 'urn:entity',
      subtype: 'urn:entity:place',
      types: ['urn:entity:place'],
      popularity: r2(0.2 + 0.7 * h01(n + 'pop')),
      properties: { address: `${100 + i * 37} Example Street (demo address)`, price_level: 1 + Math.floor(h01(n + 'price') * 3) },
      tags: [{ id: `urn:tag:category:place:${kind[0]}`, name: kind[1], type: 'urn:tag:category:place' }],
      query: { affinity: r2(aff), explainability: { 'signal.interests.entities': r2(aff * 0.8) } },
    };
  });
  items.sort((a, b) => b.query.affinity - a.query.affinity);
  return items.slice(0, take);
}

function insightsBrands(p) {
  const seeds = p.get('signal.interests.entities') || '';
  const loc = p.get('signal.location.query') || '';
  const take = Math.min(50, +(p.get('take') || 10));
  const items = BRANDS.map(([name, cat]) => {
    const aff = 0.3 + 0.69 * h01(seeds + '|' + loc + '|' + name);
    return {
      entity_id: mockId('brand', name),
      name,
      type: 'urn:entity',
      subtype: 'urn:entity:brand',
      types: ['urn:entity:brand'],
      popularity: r2(0.15 + 0.6 * h01(name + 'pop')),
      properties: { short_description: `Fictional ${cat.toLowerCase()} brand (demo data).` },
      tags: [{ id: `urn:tag:category:brand:${slug(cat)}`, name: cat, type: 'urn:tag:category:brand' }],
      query: { affinity: r2(aff), explainability: { 'signal.interests.entities': r2(aff * 0.85) } },
    };
  });
  items.sort((a, b) => b.query.affinity - a.query.affinity);
  return items.slice(0, take);
}

function search(p) {
  const q = (p.get('query') || '').trim();
  if (!q) return [];
  const exact = ARTISTS.find((a) => a.name.toLowerCase() === q.toLowerCase());
  if (exact) return [artistEntity(exact, 1, null)];
  const arena = BASELINE_ARENA_NAMES.find((n) => n.toLowerCase() === q.toLowerCase());
  const pop = arena ? r2(0.955 + 0.04 * h01(q)) : r2(0.25 + 0.7 * h01(q.toLowerCase()));
  const g = GENRES[Math.floor(h01(q.toLowerCase() + 'g') * GENRES.length)];
  return [
    {
      entity_id: mockId('artist', q.toLowerCase()),
      name: q,
      types: ['urn:entity:artist'],
      popularity: pop,
      properties: { short_description: 'Synthetic match (demo data).' },
      tags: [{ id: tagId(g), name: g, type: 'urn:tag:genre:music' }],
    },
  ];
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// fetch()-compatible: (url, init) -> Response
export async function mockQlooFetch(url) {
  const u = new URL(url);
  const p = u.searchParams;
  if (u.pathname === '/search') return json({ success: true, results: search(p) });
  if (u.pathname === '/v2/tags') {
    const genres = matchGenres(p.get('filter.query'));
    return json({ success: true, results: { tags: genres.map((g) => ({ id: tagId(g), name: g.replace(/\b\w/g, (c) => c.toUpperCase()), type: 'urn:tag:genre:music' })) } });
  }
  if (u.pathname === '/v2/insights') {
    const type = p.get('filter.type');
    if (type === 'urn:entity:artist') return json({ success: true, results: { entities: insightsArtists(p) } });
    if (type === 'urn:entity:place') return json({ success: true, results: { entities: insightsPlaces(p) } });
    if (type === 'urn:entity:brand') return json({ success: true, results: { entities: insightsBrands(p) } });
    return json({ success: true, results: { entities: [] } }); // empty 200, like an ignored param
  }
  return json({ success: false, error: 'not found' }, 404);
}
