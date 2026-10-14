import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose, createLLM, llmMode } from '../src/llm.js';
import { reconcileLineup, fallbackLineup, fallbackKeywords, validateInput } from '../src/agent.js';
import { CAPACITY_TIERS } from '../src/config.js';

test('parses plain JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test('parses JSON inside markdown fences', () => {
  assert.deepEqual(parseJsonLoose('Sure!\n```json\n{"dates":[{"headliner":"X"}]}\n```\nEnjoy.'), { dates: [{ headliner: 'X' }] });
});

test('parses JSON after leading prose and before trailing prose', () => {
  assert.deepEqual(parseJsonLoose('Here is the lineup: {"a": {"b": "c}"}} hope that helps'), { a: { b: 'c}' } });
});

test('repairs trailing commas and smart quotes', () => {
  assert.deepEqual(parseJsonLoose('{"a": [1, 2,], }'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('{“a”: “b”}'), { a: 'b' });
});

test('returns null on garbage, empty input, or truncated JSON', () => {
  assert.equal(parseJsonLoose('no json here'), null);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose(null), null);
  assert.equal(parseJsonLoose('{"dates":[{"headliner":"X"'), null);
});

test('passes through objects (Workers AI may return parsed JSON)', () => {
  const o = { x: 1 };
  assert.equal(parseJsonLoose(o), o);
});

test('mode detection: mock without binding, live with binding, forced mock', () => {
  assert.equal(llmMode({}), 'mock');
  assert.equal(llmMode({ AI: { run: async () => ({}) } }), 'live');
  assert.equal(llmMode({ AI: { run: async () => ({}) }, LINEUPLAB_MOCK: '1' }), 'mock');
});

test('live LLM errors and timeouts degrade to data=null, never throw', async () => {
  const llm = createLLM({ env: { AI: { run: async () => { throw new Error('quota exceeded'); } } } });
  const r = await llm.json({ task: 'plan', system: 's', user: 'u' });
  assert.equal(r.data, null);
  assert.equal(r.ok, false);
  assert.match(r.error, /quota/);
});

test('live LLM text response is parsed', async () => {
  const llm = createLLM({ env: { AI: { run: async () => ({ response: '```json\n{"keywords":["shoegaze"]}\n```' }) } } });
  const r = await llm.json({ task: 'plan', system: 's', user: 'u' });
  assert.deepEqual(r.data, { keywords: ['shoegaze'] });
});

const cand = (name, affinity, popularity, tags = ['Indie Rock']) => ({
  name,
  entity_id: 'id-' + name,
  affinity,
  popularity,
  popularity_band: 'Club',
  fit: { ok: true },
  local: { here: 1, general: 2, label: 'Slightly local', text: '#1 here vs #2' },
  trend: { label: 'Steady', text: '' },
  tags,
});
const pool = [cand('A', 0.95, 0.55), cand('B', 0.9, 0.3), cand('C', 0.88, 0.5), cand('D', 0.8, 0.2), cand('E', 0.7, 0.45), cand('F', 0.6, 0.1)];

test('reconcile keeps valid LLM picks and rejects hallucinated names', () => {
  const llmData = { dates: [{ headliner: 'a', support: 'B', theme: 'Night one', why_headliner: 'because' }, { headliner: 'Famous Stadium Band', support: 'D' }] };
  const { picks, rejected } = reconcileLineup(llmData, pool, 2, CAPACITY_TIERS.small);
  assert.equal(picks.length, 2);
  assert.equal(picks[0].head.name, 'A');
  assert.equal(picks[0].support.name, 'B');
  assert.equal(picks[0].source, 'llm');
  assert.deepEqual(rejected, ['Famous Stadium Band']);
  assert.equal(picks[1].source, 'fallback');
  const names = picks.flatMap((p) => [p.head.name, p.support.name]);
  assert.equal(new Set(names).size, 4, 'no act repeats');
});

test('reconcile swaps a support that is much bigger than its headliner', () => {
  const { picks } = reconcileLineup({ dates: [{ headliner: 'D', support: 'A' }] }, pool, 1, CAPACITY_TIERS.small);
  assert.equal(picks[0].head.name, 'A');
  assert.equal(picks[0].support.name, 'D');
});

test('reconcile with unparseable LLM output falls back to a full deterministic lineup', () => {
  const { picks } = reconcileLineup(null, pool, 3, CAPACITY_TIERS.small);
  assert.equal(picks.length, 3);
  assert.ok(picks.every((p) => p.source === 'fallback'));
  for (const p of picks) assert.ok((p.support.popularity ?? 0) <= (p.head.popularity ?? 1));
});

test('fallback lineup never repeats an act', () => {
  const out = fallbackLineup(pool, 3, CAPACITY_TIERS.small);
  const names = out.flatMap((d) => [d.head.name, d.support.name]);
  assert.equal(new Set(names).size, names.length);
});

test('fallback keywords split the vibe text sensibly', () => {
  assert.deepEqual(fallbackKeywords('dream pop, shoegaze / neo soul and r&b'), ['dream pop', 'shoegaze', 'neo soul', 'r&b']);
  assert.deepEqual(fallbackKeywords(''), []);
});

test('input validation rejects bad briefs and trims good ones', () => {
  assert.equal(validateInput({}).ok, false);
  assert.equal(validateInput({ location: 'x', capacity: 'stadium', dates: 2 }).ok, false);
  assert.equal(validateInput({ location: 'x', capacity: 'small', dates: 9 }).ok, false);
  const v = validateInput({ location: '  Wicker   Park ', capacity: 'small', dates: '2', pastActs: ['a', 'b', 'c', 'd'], age: 'bogus' });
  assert.equal(v.ok, true);
  assert.equal(v.input.location, 'Wicker Park');
  assert.equal(v.input.pastActs.length, 3);
  assert.equal(v.input.age, 'any');
  assert.equal(v.input.dates, 2);
});
