// Pure builders for Qloo request parameters. No I/O; fully unit tested.
import { CAPACITY_TIERS, AGE_BANDS, QLOO, POPULARITY_BANDS } from './config.js';

export const ENTITY = {
  artist: 'urn:entity:artist',
  place: 'urn:entity:place',
  brand: 'urn:entity:brand',
};

export function tierFor(id) {
  return CAPACITY_TIERS[id] || null;
}

function ageParam(age) {
  return age && age !== 'any' && Object.prototype.hasOwnProperty.call(AGE_BANDS, age) ? age : undefined;
}

function list(ids) {
  const clean = (ids || []).filter(Boolean);
  return clean.length ? clean.join(',') : undefined;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Main artist query: who does THIS neighbourhood's audience over-index on, under the
// room's popularity ceiling, with a trend bias.
//   opts.location   free-text neighbourhood -> signal.location.query (omitted when null)
//   opts.trends     'medium' etc. -> bias.trends (omitted when falsy)
//   opts.popBoost   widens the ceiling during a relax step (never above 0.99)
export function buildArtistParams({
  location,
  age,
  tier,
  tagIds = [],
  entityIds = [],
  trends = QLOO.trends,
  popBoost = 0,
  take = QLOO.take,
}) {
  const t = typeof tier === 'string' ? tierFor(tier) : tier;
  if (!t) throw new Error('unknown capacity tier');
  const p = {
    'filter.type': ENTITY.artist,
    'signal.location.query': location || undefined,
    'signal.demographics.age': ageParam(age),
    'signal.interests.entities': list(entityIds),
    'signal.interests.tags': list(tagIds),
    'filter.popularity.max': round2(Math.min(0.99, t.popMax + popBoost)),
    'bias.trends': trends || undefined,
    take,
    'feature.explainability': true,
  };
  return compact(p);
}

// Places the chosen artists' fans over-index on, physically near the venue.
export function buildPlaceParams({ location, artistIds, age, take = QLOO.placesTake, radius = QLOO.placeRadiusMeters }) {
  return compact({
    'filter.type': ENTITY.place,
    'filter.location.query': location,
    'filter.location.radius': radius,
    'signal.interests.entities': list(artistIds),
    'signal.demographics.age': ageParam(age),
    take,
    'feature.explainability': true,
  });
}

// Brands the same fans over-index on (cross-domain taste).
export function buildBrandParams({ location, artistIds, age, take = QLOO.brandsTake }) {
  return compact({
    'filter.type': ENTITY.brand,
    'signal.interests.entities': list(artistIds),
    'signal.location.query': location || undefined,
    'signal.demographics.age': ageParam(age),
    take,
    'feature.explainability': true,
  });
}

export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

export function toQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.append(k, String(v));
  return usp.toString();
}

// The human-readable request line shown in the agent trace.
export function describeRequest(path, params) {
  const parts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  return `GET ${path}${parts.length ? '?' + parts.join('&') : ''}`;
}

export function popularityBand(pop) {
  if (typeof pop !== 'number' || Number.isNaN(pop)) return 'Unknown';
  return POPULARITY_BANDS.find((b) => pop < b.max).label;
}

export function sizeFit(pop, tier) {
  const t = typeof tier === 'string' ? tierFor(tier) : tier;
  if (typeof pop !== 'number') return { ok: null, ceiling: t.popMax, ratio: null, note: 'No Qloo popularity found' };
  const ratio = pop / t.popMax;
  if (pop <= t.popMax) return { ok: true, ceiling: t.popMax, ratio: round2(ratio), note: `Fits a ${t.short} room` };
  return {
    ok: false,
    ceiling: t.popMax,
    ratio: round2(ratio),
    note: `Too big for a ${t.short} room (popularity ${pop.toFixed(2)} vs ceiling ${t.popMax.toFixed(2)})`,
  };
}

// Relax ladder when Qloo returns an empty 200 (usually an ignored param or a too-tight filter).
export const RELAX_STEPS = [
  { id: 'full', label: 'all signals', change: (o) => o },
  { id: 'no-tags', label: 'drop vibe tags', change: (o) => ({ ...o, tagIds: [] }) },
  { id: 'no-seeds', label: 'drop past-act seeds', change: (o) => ({ ...o, tagIds: [], entityIds: [] }) },
  { id: 'wider', label: 'widen ceiling +0.05', change: (o) => ({ ...o, tagIds: [], entityIds: [], popBoost: 0.05 }) },
  { id: 'no-age', label: 'drop age signal', change: (o) => ({ ...o, tagIds: [], entityIds: [], popBoost: 0.05, age: 'any' }) },
];
