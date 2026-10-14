// LineupLab Cloudflare Worker: static assets + JSON / Server-Sent-Events API.
//
//   GET  /api/health          mode (live | mock) for Qloo and the LLM, model name
//   POST /api/lineup          body = venue form; streams trace events + the result (SSE)
//   POST /api/lineup?format=json   same, as one JSON document (curl / tests)
//
// The Qloo key (QLOO_API_KEY secret) is only ever sent to Qloo as a header. As a second
// line of defence every outgoing API body passes through redact().
import { MODEL, RATE_LIMIT, RESULT_VERSION, CACHE_TTL } from './config.js';
import { createCache, hashKey } from './cache.js';
import { createQloo, qlooMode } from './qloo.js';
import { createLLM, llmMode } from './llm.js';
import { runAgent, validateInput, normalizedKey, safeMsg } from './agent.js';

const hits = new Map();

export function rateLimited(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.max) {
    hits.set(ip, list);
    return Math.ceil((RATE_LIMIT.windowMs - (now - list[0])) / 1000);
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return 0;
}

export function resetRateLimits() {
  hits.clear();
}

export function redact(text, env) {
  const key = env && typeof env.QLOO_API_KEY === 'string' ? env.QLOO_API_KEY.trim() : '';
  if (!key || key.length < 6) return text;
  return text.split(key).join('[redacted]');
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'no-store',
};

function json(body, env, status = 200, extra = {}) {
  return new Response(redact(JSON.stringify(body), env), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

function modes(env) {
  const qloo = qlooMode(env);
  const llm = llmMode(env);
  return { qloo, llm, demo: qloo === 'mock' || llm === 'mock' };
}

async function handleLineup(request, env, ctx) {
  const url = new URL(request.url);
  const wantJson = url.searchParams.get('format') === 'json';
  let body;
  try {
    const text = await request.text();
    if (text.length > 8000) return json({ ok: false, errors: ['Request too large.'] }, env, 413);
    body = JSON.parse(text || '{}');
  } catch {
    return json({ ok: false, errors: ['Body must be JSON.'] }, env, 400);
  }
  const v = validateInput(body);
  if (!v.ok) return json({ ok: false, errors: v.errors }, env, 400);

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';
  const m = modes(env);
  const cache = createCache(env);
  const resultKey = await hashKey(`result:${RESULT_VERSION}`, { mode: m, input: normalizedKey(v.input) });
  const cached = await cache.get(resultKey);

  if (!cached) {
    const wait = rateLimited(ip);
    if (wait) return json({ ok: false, errors: [`Easy there: lineup builds are limited per visitor. Try again in about ${Math.ceil(wait / 60)} minute(s).`] }, env, 429, { 'retry-after': String(wait) });
  }

  const meta = { mode: m, model: MODEL, cached: !!cached };

  const build = async (emit) => {
    if (cached) {
      for (const ev of cached.trace || []) emit({ ...ev, replay: true });
      return { ...cached, meta: { ...meta, mode: cached.meta?.mode || m, generated_at: cached.meta?.generated_at } };
    }
    const qloo = createQloo({ env, cache });
    const llm = createLLM({ env, demoFallback: qloo.mode === 'mock' });
    const result = await runAgent(v.input, { qloo, llm, emit });
    const mode = { ...m, llm: llm.mode, demo: m.demo || llm.mode === 'mock' };
    result.meta = { ...meta, mode, generated_at: new Date().toISOString() };
    if (llm.degradedReason) result.meta.llm_note = 'Workers AI was unavailable, so the language steps used the demo model.';
    const store = cache.put(resultKey, result, CACHE_TTL.result);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(store);
    else await store;
    return result;
  };

  if (wantJson) {
    const trace = [];
    try {
      const result = await build((ev) => trace.push(ev));
      return json({ ok: true, result }, env);
    } catch (err) {
      return json({ ok: false, errors: [safeMsg(err)], trace }, env, err && err.userFacing ? 422 : 502);
    }
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${redact(JSON.stringify(data), env)}\n\n`)).catch(() => {});
  const work = (async () => {
    await send('meta', meta);
    try {
      const result = await build((ev) => send('step', ev));
      await send('result', result);
    } catch (err) {
      await send('error', { message: safeMsg(err) });
    } finally {
      await send('done', {});
      await writer.close().catch(() => {});
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...SECURITY_HEADERS, 'x-accel-buffering': 'no' },
  });
}

export default {
  async fetch(request, env = {}, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ ok: false, errors: ['Method not allowed'] }, env, 405, { allow: 'GET' });
      return json({ ok: true, mode: modes(env), model: MODEL, cache: createCache(env).layers }, env);
    }
    if (url.pathname === '/api/lineup') {
      if (request.method !== 'POST') return json({ ok: false, errors: ['Use POST'] }, env, 405, { allow: 'POST' });
      return handleLineup(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, errors: ['Not found'] }, env, 404);
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
