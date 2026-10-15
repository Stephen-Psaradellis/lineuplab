import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, retryDelayMs, createQloo } from '../src/qloo.js';

// a fake clock: sleep advances time instead of waiting
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('limiter allows at most N starts in any rolling second', async () => {
  const c = clock();
  const take = createLimiter(4, c.now, c.sleep);
  const at = [];
  await Promise.all(Array.from({ length: 10 }, () => take().then(() => at.push(c.now()))));
  assert.equal(at.length, 10);
  for (let i = 4; i < at.length; i++) assert.ok(at[i] - at[i - 4] >= 1000, `start ${i} at ${at[i]} vs ${at[i - 4]}`);
});

test('retryDelayMs honours the per-second reset header', () => {
  const res = (h) => ({ headers: new Map(Object.entries(h)) });
  assert.equal(retryDelayMs(res({ 'x-second-ratelimit-reset': '0.42' }), 0), 470);
  assert.equal(retryDelayMs(res({}), 1), 1000);
  assert.equal(retryDelayMs(res({ 'x-second-ratelimit-reset': '9999' }), 0), 700); // absurd value ignored
});

test('a 429 is retried after the reset and then succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n < 3) return { ok: false, status: 429, headers: new Map([['x-second-ratelimit-reset', '0.1']]) };
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: { tags: [{ id: 'urn:tag:genre:music:jazz', name: 'Jazz', type: 'urn:tag:genre:music' }] } }) };
  };
  const slept = [];
  const q = createQloo({ env: { QLOO_API_KEY: 'k' }, fetchImpl, limiter: async () => {}, sleep: async (ms) => slept.push(ms) });
  const r = await q.tags('jazz');
  assert.equal(n, 3);
  assert.equal(r.tags[0].name, 'Jazz');
  assert.deepEqual(slept, [150, 450]);
});

test('a persistent 429 surfaces the friendly rate-limit message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: new Map() });
  const q = createQloo({ env: { QLOO_API_KEY: 'k' }, fetchImpl, limiter: async () => {}, sleep: async () => {} });
  await assert.rejects(q.tags('jazz'), /rate limit/);
});

test('a trend bias that moves no rank is marked inert, not Steady', async () => {
  const { buildCandidates } = await import('../src/agent.js');
  const { CAPACITY_TIERS } = await import('../src/config.js');
  const ent = (n) => ({ name: n, entity_id: n, affinity: 0.5, popularity: 0.4, tags: [] });
  const main = [ent('a'), ent('b'), ent('c')];
  const same = buildCandidates(main, main, [ent('a'), ent('b'), ent('c')], CAPACITY_TIERS.small);
  assert.ok(same.every((c) => c.trend.inert && c.trend.label === 'n/a'));
  const moved = buildCandidates(main, main, [ent('c'), ent('b'), ent('a')], CAPACITY_TIERS.small);
  assert.ok(moved.every((c) => !c.trend.inert));
});
