// Three-layer cache: per-isolate memory -> KV (if bound as CACHE) -> Workers Cache API.
// Works with none of them bound (memory only), which is what tests and plain Node use.

const memory = new Map();
const MEMORY_MAX = 400;

export async function hashKey(prefix, value) {
  const text = stableStringify(value);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}:${hex.slice(0, 40)}`;
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function cacheApi() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

// Synthetic, never-routed URL used only as a Cache API key.
const cacheUrl = (key) => `https://lineuplab-cache.invalid/${encodeURIComponent(key)}`;

export function createCache(env = {}) {
  const kv = env.CACHE && typeof env.CACHE.get === 'function' ? env.CACHE : null;
  const layers = ['memory', kv ? 'kv' : null, cacheApi() ? 'cache-api' : null].filter(Boolean);

  return {
    layers,
    async get(key) {
      const hit = memory.get(key);
      if (hit) {
        if (hit.exp > Date.now()) return hit.value;
        memory.delete(key);
      }
      try {
        if (kv) {
          const v = await kv.get(key, 'json');
          if (v != null) {
            remember(key, v, 300);
            return v;
          }
        }
        const c = cacheApi();
        if (c) {
          const res = await c.match(cacheUrl(key));
          if (res) {
            const v = await res.json();
            remember(key, v, 300);
            return v;
          }
        }
      } catch {
        // A cache miss is never fatal.
      }
      return null;
    },
    async put(key, value, ttlSeconds) {
      remember(key, value, ttlSeconds);
      try {
        if (kv) await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
        const c = cacheApi();
        if (c) {
          await c.put(
            cacheUrl(key),
            new Response(JSON.stringify(value), {
              headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSeconds}` },
            }),
          );
        }
      } catch {
        // Ignore cache write failures.
      }
    },
  };
}

function remember(key, value, ttlSeconds) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
}

export function clearMemoryCache() {
  memory.clear();
}
