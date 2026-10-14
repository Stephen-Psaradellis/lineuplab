// The Qloo API key must never reach the browser: not in results, traces, errors or SSE.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { resetRateLimits, redact } from '../src/worker.js';
import { clearMemoryCache } from '../src/cache.js';
import { mockQlooFetch } from '../src/mock/qloo-mock.js';

const KEY = 'qk_TESTSECRET_9f8e7d6c5b4a';
const BRIEF = { venueName: 'Back Room', location: 'Echo Park, Los Angeles', capacity: 'medium', age: '30_to_34', genres: 'garage rock', pastActs: ['Someone'], dates: 2 };
const realFetch = globalThis.fetch;
let seenKeys;
let aiInputs;

function aiBinding() {
  return {
    run: async (model, input) => {
      aiInputs.push(JSON.stringify(input));
      return { response: 'not json at all' }; // forces every fallback path too
    },
  };
}

beforeEach(() => {
  clearMemoryCache();
  resetRateLimits();
  seenKeys = [];
  aiInputs = [];
  globalThis.fetch = async (url, init) => {
    seenKeys.push(init?.headers?.['X-Api-Key']);
    return mockQlooFetch(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (q = '?format=json') => new Request(`http://localhost/api/lineup${q}`, { method: 'POST', body: JSON.stringify(BRIEF) });

test('live mode sends the key to Qloo as a header and nowhere else', async () => {
  const env = { QLOO_API_KEY: KEY, AI: aiBinding() };
  const res = await worker.fetch(post(), env);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(seenKeys.length > 0 && seenKeys.every((k) => k === KEY), 'key travels in the X-Api-Key header');
  assert.equal(text.includes(KEY), false, 'key absent from JSON response');
  assert.equal(JSON.parse(text).result.meta.mode.qloo, 'live');
  assert.ok(aiInputs.length > 0);
  assert.ok(aiInputs.every((s) => !s.includes(KEY)), 'key never sent to the LLM');
});

test('key is absent from the SSE stream', async () => {
  const res = await worker.fetch(post(''), { QLOO_API_KEY: KEY, AI: aiBinding() });
  const text = await res.text();
  assert.match(text, /event: result/);
  assert.equal(text.includes(KEY), false);
});

test('key is absent from errors, even when Qloo echoes it back', async () => {
  globalThis.fetch = async () => new Response(`bad key ${KEY}`, { status: 401 });
  for (const q of ['?format=json', '']) {
    clearMemoryCache();
    const res = await worker.fetch(post(q), { QLOO_API_KEY: KEY });
    const text = await res.text();
    assert.equal(text.includes(KEY), false, `leak in ${q || 'sse'}`);
    assert.match(text, /Qloo rejected the API key/);
  }
});

test('key is absent from health', async () => {
  const text = await (await worker.fetch(new Request('http://localhost/api/health'), { QLOO_API_KEY: KEY })).text();
  assert.equal(text.includes(KEY), false);
  assert.match(text, /"qloo":"live"/);
});

test('redact is a backstop for any string that does contain the key', () => {
  assert.equal(redact(`x ${KEY} y`, { QLOO_API_KEY: KEY }), 'x [redacted] y');
  assert.equal(redact('nothing', {}), 'nothing');
});
