import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { rateLimited, resetRateLimits } from '../src/worker.js';
import { clearMemoryCache } from '../src/cache.js';
import { runAgent, validateInput, localityLadder } from '../src/agent.js';
import { createQloo } from '../src/qloo.js';
import { createLLM } from '../src/llm.js';
import { mockQlooFetch } from '../src/mock/qloo-mock.js';
import { RATE_LIMIT } from '../src/config.js';

const BRIEF = {
  venueName: 'The Lantern Room',
  location: 'Wicker Park, Chicago',
  capacity: 'small',
  age: '25_to_29',
  genres: 'dream pop, shoegaze, neo soul',
  pastActs: ['Juniper Static'],
  dates: 3,
};

beforeEach(() => {
  clearMemoryCache();
  resetRateLimits();
});

function post(body, query = '?format=json', headers = {}) {
  return new Request(`http://localhost/api/lineup${query}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
}

async function readSSE(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });
}

test('mock pipeline end to end produces a complete result', async () => {
  const res = await worker.fetch(post(BRIEF), {});
  assert.equal(res.status, 200);
  const { ok, result: r } = await res.json();
  assert.equal(ok, true);
  assert.deepEqual(r.meta.mode, { qloo: 'mock', llm: 'mock', demo: true });

  // (a) lineup
  assert.equal(r.lineup.length, 3);
  const acts = r.lineup.flatMap((d) => [d.headliner, d.support]);
  assert.equal(new Set(acts.map((a) => a.name)).size, 6, 'no repeated acts');
  for (const a of acts) {
    assert.equal(typeof a.affinity, 'number');
    assert.ok(a.popularity <= 0.6, `${a.name} popularity ${a.popularity} must be under the 150-cap ceiling`);
    assert.equal(a.fit.ok, true);
    assert.ok(a.popularity_band);
    assert.ok(['Rising', 'Steady', 'Cooling'].includes(a.trend.label));
    assert.ok(a.local.label);
    assert.ok(a.why.length > 10);
    assert.notEqual(a.name, 'Juniper Static', 'a past act is a seed, not a recommendation');
  }
  // (b) co-promotion
  assert.ok(r.copromote.places.length > 0);
  assert.ok(r.copromote.brands.length > 0);
  for (const p of [...r.copromote.places, ...r.copromote.brands]) assert.ok(p.idea.length > 10);
  // (c) blurbs
  for (const d of r.lineup) assert.ok(d.blurb.includes(d.headliner.name));
  // (d) baseline comparison, size-checked against Qloo
  assert.equal(r.baseline.lineup.length, 3);
  assert.ok(r.baseline.too_big > 0, 'the LLM-alone picks should be flagged as too big');

  // trace shows the agent's Qloo calls
  const qlooSteps = r.trace.filter((s) => s.lane === 'qloo');
  assert.ok(qlooSteps.some((s) => /^GET \/v2\/insights\?filter\.type=urn:entity:artist/.test(s.request)));
  assert.ok(qlooSteps.some((s) => /filter\.type=urn:entity:place/.test(s.request)));
  assert.ok(qlooSteps.some((s) => /filter\.type=urn:entity:brand/.test(s.request)));
  assert.ok(qlooSteps.some((s) => s.title.startsWith('qloo_tags')));
  assert.ok(qlooSteps.some((s) => s.title.startsWith('qloo_search')));
  assert.ok(r.trace.some((s) => s.lane === 'baseline'));
  assert.ok(r.stats.qloo_calls >= 8);
  assert.equal(r.stats.llm_calls, 4);
});

test('SSE stream emits meta, steps, result and done in order', async () => {
  const res = await worker.fetch(post(BRIEF, ''), {});
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = await readSSE(res);
  assert.equal(events[0].event, 'meta');
  assert.equal(events.at(-1).event, 'done');
  const steps = events.filter((e) => e.event === 'step');
  assert.ok(steps.length >= 12);
  const result = events.find((e) => e.event === 'result');
  assert.ok(result && result.data.lineup.length === 3);
});

test('identical briefs are served from the result cache', async () => {
  const first = await (await worker.fetch(post(BRIEF), {})).json();
  const second = await (await worker.fetch(post({ ...BRIEF, location: '  wicker park,  CHICAGO ' }), {})).json();
  assert.equal(first.result.meta.cached, false);
  assert.equal(second.result.meta.cached, true);
  assert.deepEqual(second.result.lineup.map((d) => d.headliner.name), first.result.lineup.map((d) => d.headliner.name));
});

test('each capacity tier keeps every recommended act under its ceiling', async () => {
  for (const [capacity, max] of [['small', 0.6], ['medium', 0.8], ['large', 0.92]]) {
    const { result } = await (await worker.fetch(post({ ...BRIEF, capacity, dates: 2 }), {})).json();
    for (const d of result.lineup) for (const a of [d.headliner, d.support]) assert.ok(a.popularity <= max, `${capacity}: ${a.popularity}`);
  }
});

test('an empty 200 from Qloo is surfaced in the trace and relaxed, not hidden', async () => {
  let firstArtistCall = true;
  const fetchImpl = async (url, init) => {
    if (url.includes('/v2/insights') && url.includes('urn%3Aentity%3Aartist') && firstArtistCall) {
      firstArtistCall = false;
      return new Response(JSON.stringify({ success: true, results: { entities: [] } }), { status: 200 });
    }
    return mockQlooFetch(url, init);
  };
  const v = validateInput(BRIEF);
  const env = { QLOO_API_KEY: 'test-key-123456' };
  const qloo = createQloo({ env, fetchImpl });
  const r = await runAgent(v.input, { qloo, llm: createLLM({ env: {} }) });
  const empty = r.trace.find((s) => s.status === 'empty' && s.lane === 'qloo');
  assert.ok(empty, 'empty step present');
  assert.match(empty.detail, /Empty 200/);
  assert.ok(r.trace.some((s) => /retry/.test(s.title)));
  assert.equal(r.lineup.length, 3);
});

test('bad input and wrong methods get clear errors', async () => {
  const bad = await worker.fetch(post({ capacity: 'small', dates: 2 }), {});
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).errors.join(' '), /neighbourhood/);
  const notJson = await worker.fetch(new Request('http://localhost/api/lineup', { method: 'POST', body: '{nope' }), {});
  assert.equal(notJson.status, 400);
  const get = await worker.fetch(new Request('http://localhost/api/lineup'), {});
  assert.equal(get.status, 405);
  const missing = await worker.fetch(new Request('http://localhost/api/nothing'), {});
  assert.equal(missing.status, 404);
});

test('health reports demo mode and the model', async () => {
  const j = await (await worker.fetch(new Request('http://localhost/api/health'), {})).json();
  assert.equal(j.mode.demo, true);
  assert.match(j.model, /llama-3\.3-70b/);
});

test('per-IP rate limit kicks in after the window budget', async () => {
  for (let i = 0; i < RATE_LIMIT.max; i++) assert.equal(rateLimited('1.2.3.4', 1000 + i), 0);
  assert.ok(rateLimited('1.2.3.4', 2000) > 0);
  assert.equal(rateLimited('5.6.7.8', 2000), 0);
  assert.equal(rateLimited('1.2.3.4', 1000 + RATE_LIMIT.windowMs + 50), 0);
});

test('a failing AI binding in demo mode switches to the demo model and says so', async () => {
  const env = { AI: { run: async () => { throw new Error('AI is not supported in local mode'); } } };
  const { result: r } = await (await worker.fetch(post(BRIEF), env)).json();
  assert.equal(r.meta.mode.llm, 'mock');
  assert.equal(r.meta.mode.demo, true);
  assert.ok(r.meta.llm_note);
  assert.ok(r.trace.some((s) => /Workers AI unavailable/.test(s.title)));
  assert.ok(r.baseline.lineup.length === 3, 'baseline still produced');
});

test('a failing AI binding with live Qloo degrades to templates, never to fictional names', async () => {
  const env = { QLOO_API_KEY: 'live-key-abcdef', AI: { run: async () => { throw new Error('quota'); } } };
  const v = validateInput(BRIEF);
  const qloo = createQloo({ env, fetchImpl: mockQlooFetch });
  const llm = createLLM({ env, demoFallback: false });
  const r = await runAgent(v.input, { qloo, llm });
  assert.equal(llm.mode, 'live');
  assert.equal(r.baseline.lineup.length, 0);
  assert.ok(r.lineup.every((d) => d.blurb.length > 0));
  assert.ok(r.trace.some((s) => s.status === 'fallback'));
});

test('localityLadder walks from the planner phrase to broader comma tails, skipping short ones', () => {
  assert.deepEqual(localityLadder('Wicker Park, Chicago, IL', 'Wicker Park, Chicago'), ['Wicker Park, Chicago, IL', 'Wicker Park, Chicago', 'Chicago, IL', 'Chicago']);
  assert.deepEqual(localityLadder('Bushwick', 'bushwick'), ['Bushwick']);
  assert.deepEqual(localityLadder('', 'Leith, Edinburgh'), ['Leith, Edinburgh', 'Edinburgh']);
});

// Qloo answers an unmatched locality with HTTP 400 (signal.location.query docs).
function rejectLocalities(reject) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const p = new URL(url).searchParams;
    const loc = p.get('signal.location.query') || p.get('filter.location.query');
    if (loc) seen.push(loc);
    if (loc && reject(loc)) return new Response(JSON.stringify({ success: false, error: 'locality not found' }), { status: 400 });
    return mockQlooFetch(url, init);
  };
  return { fetchImpl, seen };
}

test('an unmatched neighbourhood (Qloo 400) falls back to the city instead of failing the run', async () => {
  const { fetchImpl, seen } = rejectLocalities((loc) => /wicker park/i.test(loc));
  const v = validateInput(BRIEF);
  const qloo = createQloo({ env: { QLOO_API_KEY: 'test-key-123456' }, fetchImpl });
  const r = await runAgent(v.input, { qloo, llm: createLLM({ env: {} }) });
  assert.equal(r.lineup.length, 3);
  assert.ok(r.trace.some((s) => s.status === 'fallback' && /matched no locality/.test(s.title)));
  assert.equal(r.plan.location_query, 'Chicago');
  assert.ok(seen.includes('Chicago'));
  assert.ok(r.copromote.places.length > 0, 'places found around the broader locality');
});

test('when no name matches a locality, artists run without location and places are skipped', async () => {
  const { fetchImpl } = rejectLocalities(() => true);
  const v = validateInput(BRIEF);
  const qloo = createQloo({ env: { QLOO_API_KEY: 'test-key-123456' }, fetchImpl });
  const r = await runAgent(v.input, { qloo, llm: createLLM({ env: {} }) });
  assert.equal(r.lineup.length, 3);
  assert.equal(r.copromote.places.length, 0);
  assert.ok(r.trace.some((s) => /without the location signal/.test(s.detail || '')));
  assert.ok(r.trace.some((s) => /nearby places are skipped/.test(s.detail || '')));
});

test('a 400 that is not about the location still fails loudly', async () => {
  const fetchImpl = async (url, init) => (url.includes('/v2/insights') ? new Response('{}', { status: 400 }) : mockQlooFetch(url, init));
  const v = validateInput(BRIEF);
  const qloo = createQloo({ env: { QLOO_API_KEY: 'test-key-123456' }, fetchImpl });
  await assert.rejects(runAgent(v.input, { qloo, llm: createLLM({ env: {} }) }), (e) => e.name === 'QlooError' && e.status === 400);
});
