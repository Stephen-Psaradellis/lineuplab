// Qloo client: the three agent tools (qloo_search, qloo_tags, qloo_insights).
// The API key is read from env and only ever placed in a request header; it never appears
// in a returned value, an error message or the trace.
import { QLOO, QLOO_BASE_URL, CACHE_TTL } from './config.js';
import { toQueryString, describeRequest, compact } from './params.js';
import { hashKey } from './cache.js';
import { mockQlooFetch } from './mock/qloo-mock.js';

export class QlooError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'QlooError';
    this.status = status;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && !Number.isNaN(+v) ? +v : null);

export function normalizeTag(t) {
  if (!t || typeof t !== 'object') return null;
  const id = t.id || t.tag_id || t.entity_id;
  if (!id || !t.name) return null;
  return { id: String(id), name: String(t.name), type: t.type || t.subtype || (Array.isArray(t.types) ? t.types[0] : '') || '' };
}

export function normalizeEntity(e) {
  if (!e || typeof e !== 'object' || !e.name) return null;
  const props = e.properties && typeof e.properties === 'object' ? e.properties : {};
  const tags = (Array.isArray(e.tags) ? e.tags : []).map(normalizeTag).filter(Boolean);
  const address = typeof props.address === 'string' ? props.address : null;
  return {
    entity_id: String(e.entity_id || e.id || ''),
    name: String(e.name),
    types: Array.isArray(e.types) ? e.types : e.subtype ? [e.subtype] : [],
    popularity: num(e.popularity ?? props.popularity),
    affinity: num(e.query?.affinity),
    explainability: e.query?.explainability && typeof e.query.explainability === 'object' ? e.query.explainability : null,
    tags: tags.slice(0, 8),
    description: typeof props.short_description === 'string' ? props.short_description.slice(0, 200) : typeof props.description === 'string' ? props.description.slice(0, 200) : null,
    address,
    price_level: num(props.price_level),
  };
}

export function entitiesFrom(json) {
  const r = json && json.results;
  const raw = Array.isArray(r?.entities) ? r.entities : Array.isArray(r) ? r : Array.isArray(json?.entities) ? json.entities : [];
  return raw.map(normalizeEntity).filter(Boolean);
}

export function tagsFrom(json) {
  const r = json && json.results;
  const raw = Array.isArray(r?.tags) ? r.tags : Array.isArray(r?.entities) ? r.entities : Array.isArray(r) ? r : Array.isArray(json?.tags) ? json.tags : [];
  return raw.map(normalizeTag).filter(Boolean);
}

export function qlooMode(env) {
  if (env && env.LINEUPLAB_MOCK === '1') return 'mock';
  return env && typeof env.QLOO_API_KEY === 'string' && env.QLOO_API_KEY.trim() ? 'live' : 'mock';
}

function friendly(status) {
  if (status === 401 || status === 403) return 'Qloo rejected the API key (check the QLOO_API_KEY secret).';
  if (status === 429) return 'Qloo rate limit reached. Try again in a minute.';
  if (status >= 500) return `Qloo is having trouble (HTTP ${status}).`;
  return `Qloo returned HTTP ${status} - usually a malformed parameter.`;
}

// The hackathon key allows 5 requests per second (X-Second-RateLimit-Limit) and 10,000 a
// month. The agent fans out in parallel, so every request first takes a slot here: at most
// `perSecond` starts in any rolling second, shared by the whole isolate.
export function createLimiter(perSecond = QLOO.perSecond, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const starts = [];
  let chain = Promise.resolve();
  return function take() {
    const turn = chain.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length && t - starts[0] >= 1000) starts.shift();
        if (starts.length < perSecond) {
          starts.push(t);
          return;
        }
        await sleep(1000 - (t - starts[0]) + 5);
      }
    });
    chain = turn.catch(() => {});
    return turn;
  };
}

const sharedLimiter = createLimiter();

// How long a 429 asks us to wait: X-Second-RateLimit-Reset is seconds (fractional).
export function retryDelayMs(res, attempt) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-second-ratelimit-reset') || res.headers.get('retry-after') : null;
  const s = num(h);
  const base = s !== null && s >= 0 && s <= 5 ? s * 1000 + 50 : 700;
  return base + attempt * 300;
}

// createQloo returns the tool set the agent calls. `onCall` receives a trace-ready record
// for every request (cached or not).
export function createQloo({ env = {}, cache, fetchImpl, onCall, limiter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const mode = qlooMode(env);
  const take = limiter || (mode === 'mock' ? async () => {} : sharedLimiter);
  const base = (env.QLOO_BASE_URL || QLOO_BASE_URL).replace(/\/+$/, '');
  const doFetch = mode === 'mock' ? mockQlooFetch : fetchImpl || ((...a) => fetch(...a));
  let calls = 0;

  async function call(tool, path, params) {
    const clean = compact(params);
    const request = describeRequest(path, clean);
    const key = await hashKey('qloo', { mode, path, clean });
    const started = Date.now();
    if (cache) {
      const hit = await cache.get(key);
      if (hit) {
        onCall?.({ tool, request, cached: true, ms: Date.now() - started });
        return { json: hit, request, cached: true, ms: Date.now() - started };
      }
    }
    calls++;
    const url = `${base}${path}?${toQueryString(clean)}`;
    let res;
    const attempts = QLOO.attempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await take();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), QLOO.timeoutMs);
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: { 'X-Api-Key': mode === 'mock' ? 'mock' : env.QLOO_API_KEY, accept: 'application/json' },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // the cause (never the key: it lives only in a header) goes to the Worker log
        console.error('qloo fetch failed', tool, path, attempt, err && err.name, err && err.message);
        if (attempt === attempts - 1) throw new QlooError(err && err.name === 'AbortError' ? 'Qloo did not answer in time.' : 'Could not reach Qloo.', 0);
        await sleep(400 + attempt * 400);
        continue;
      }
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      break;
    }
    if (!res.ok) throw new QlooError(friendly(res.status), res.status);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new QlooError('Qloo sent a response that was not JSON.', res.status);
    }
    const ms = Date.now() - started;
    if (cache) await cache.put(key, json, CACHE_TTL.qloo);
    onCall?.({ tool, request, cached: false, ms });
    return { json, request, cached: false, ms };
  }

  return {
    mode,
    get calls() {
      return calls;
    },
    // qloo_search: an act's name -> Qloo entity
    async search(name) {
      const r = await call('qloo_search', '/search', { query: name, types: 'urn:entity:artist', take: 3 });
      return { ...r, entities: entitiesFrom(r.json) };
    },
    // qloo_tags: a vibe keyword -> Qloo tag ids
    async tags(keyword, { typed = true } = {}) {
      const r = await call('qloo_tags', '/v2/tags', {
        'filter.query': keyword,
        'filter.tag.types': typed ? 'urn:tag:genre:music' : undefined,
        take: 5,
      });
      return { ...r, tags: tagsFrom(r.json) };
    },
    // qloo_insights: the recommendation engine
    async insights(params) {
      const r = await call('qloo_insights', '/v2/insights', params);
      return { ...r, entities: entitiesFrom(r.json) };
    },
  };
}
