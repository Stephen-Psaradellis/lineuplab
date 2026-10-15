// LineupLab configuration. Every tunable lives here so the README can point at one file.

// Workers AI model used for every LLM step (planner, lineup picker, copywriter, baseline).
export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const QLOO_BASE_URL = 'https://hackathon.api.qloo.com';

// Bump to invalidate every cached result after a pipeline change.
export const RESULT_VERSION = 'r4';

// Capacity tiers -> Qloo popularity ceiling.
//
// Qloo's `popularity` is a 0..1 percentile of an entity against every other entity of the
// same type. A 150-cap bar cannot pay, or fill a room for, an act at the 95th percentile;
// telling it to book one is the classic failure of a generic recommender. So the ceiling
// is passed to Qloo as `filter.popularity.max`, and Qloo only returns acts below it.
//
//   small  (<=150)    0.60  - local and regional acts, rising club names
//   medium (150-400)  0.80  - established club circuit, touring support slots
//   large  (400-1000) 0.92  - theatre-level draws, still under the arena tier
//
// `sweet` is where a headliner for that room most often sits; the fallback picker prefers
// headliners near it and supports below it. These are editorial defaults, not Qloo facts:
// tune them per market.
export const CAPACITY_TIERS = {
  small: { id: 'small', label: 'Up to 150', short: '<=150 cap', popMax: 0.6, sweet: 0.5 },
  medium: { id: 'medium', label: '150 to 400', short: '150-400 cap', popMax: 0.8, sweet: 0.68 },
  large: { id: 'large', label: '400 to 1,000', short: '400-1000 cap', popMax: 0.92, sweet: 0.82 },
};

// Qloo demographic age bands (signal.demographics.age). 'any' omits the signal.
export const AGE_BANDS = {
  any: 'Mixed / all ages',
  '24_and_younger': '24 and younger',
  '25_to_29': '25 to 29',
  '30_to_34': '30 to 34',
  '35_to_44': '35 to 44',
  '45_to_54': '45 to 54',
  '55_and_older': '55 and older',
};

// Display bands for popularity, so a number reads as a room size.
export const POPULARITY_BANDS = [
  { max: 0.3, label: 'Emerging' },
  { max: 0.6, label: 'Club' },
  { max: 0.8, label: 'Club circuit' },
  { max: 0.92, label: 'Theatre' },
  { max: 1.01, label: 'Arena' },
];

export const QLOO = {
  take: 50, // the hackathon API maximum
  trends: 'medium', // bias.trends for the main artist query
  placeRadiusMeters: 3000, // filter.location.radius for co-promotion places
  placesTake: 12,
  brandsTake: 12,
  timeoutMs: 12000,
  perSecond: 4, // the hackathon key allows 5/s; one spare for the other isolate
  attempts: 4, // per request: 429 / 5xx / network errors wait and retry
  maxTagKeywords: 4,
};

export const LIMITS = {
  maxDates: 6,
  maxPastActs: 3,
  venueName: 80,
  location: 120,
  genres: 200,
  pastAct: 80,
};

export const LLM = {
  timeoutMs: 30000,
  temperature: 0.4,
};

export const CACHE_TTL = {
  qloo: 60 * 60 * 24, // 24h - Qloo responses (private, server side only)
  result: 60 * 60 * 6, // 6h - full results for identical inputs
};

// Light per-IP limit on lineup builds (best effort, per isolate; cached results are free).
export const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 12 };
