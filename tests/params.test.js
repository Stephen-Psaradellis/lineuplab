import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArtistParams, buildPlaceParams, buildBrandParams, toQueryString, describeRequest, popularityBand, sizeFit, RELAX_STEPS } from '../src/params.js';
import { CAPACITY_TIERS } from '../src/config.js';

const base = { location: 'Wicker Park, Chicago', age: '25_to_29' };

test('each capacity tier maps to its popularity ceiling', () => {
  assert.equal(buildArtistParams({ ...base, tier: 'small' })['filter.popularity.max'], 0.6);
  assert.equal(buildArtistParams({ ...base, tier: 'medium' })['filter.popularity.max'], 0.8);
  assert.equal(buildArtistParams({ ...base, tier: 'large' })['filter.popularity.max'], 0.92);
  assert.equal(buildArtistParams({ ...base, tier: CAPACITY_TIERS.large })['filter.popularity.max'], 0.92);
});

test('artist params carry every required Qloo field', () => {
  const p = buildArtistParams({ ...base, tier: 'small', tagIds: ['urn:tag:genre:music:shoegaze', 'urn:tag:genre:music:dream_pop'], entityIds: ['e1'] });
  assert.equal(p['filter.type'], 'urn:entity:artist');
  assert.equal(p['signal.location.query'], 'Wicker Park, Chicago');
  assert.equal(p['signal.demographics.age'], '25_to_29');
  assert.equal(p['signal.interests.tags'], 'urn:tag:genre:music:shoegaze,urn:tag:genre:music:dream_pop');
  assert.equal(p['signal.interests.entities'], 'e1');
  assert.equal(p['bias.trends'], 'medium');
  assert.equal(p.take, 50);
  assert.equal(p['feature.explainability'], true);
});

test('empty and "any" signals are omitted, not sent blank', () => {
  const p = buildArtistParams({ location: null, age: 'any', tier: 'medium', trends: null });
  for (const k of ['signal.location.query', 'signal.demographics.age', 'signal.interests.tags', 'signal.interests.entities', 'bias.trends']) {
    assert.equal(k in p, false, `${k} should be omitted`);
  }
  assert.equal(buildArtistParams({ ...base, age: 'not_a_band', tier: 'small' })['signal.demographics.age'], undefined);
});

test('relax boost widens the ceiling but never past 0.99', () => {
  assert.equal(buildArtistParams({ ...base, tier: 'small', popBoost: 0.05 })['filter.popularity.max'], 0.65);
  assert.equal(buildArtistParams({ ...base, tier: 'large', popBoost: 0.5 })['filter.popularity.max'], 0.99);
});

test('unknown tier throws', () => {
  assert.throws(() => buildArtistParams({ ...base, tier: 'stadium' }));
});

test('place and brand params are cross-domain on the chosen artists', () => {
  const pl = buildPlaceParams({ location: 'Wicker Park, Chicago', artistIds: ['a', 'b'], age: 'any' });
  assert.equal(pl['filter.type'], 'urn:entity:place');
  assert.equal(pl['filter.location.query'], 'Wicker Park, Chicago');
  assert.equal(pl['filter.location.radius'], 3000);
  assert.equal(pl['signal.interests.entities'], 'a,b');
  const br = buildBrandParams({ location: 'Wicker Park, Chicago', artistIds: ['a'], age: '30_to_34' });
  assert.equal(br['filter.type'], 'urn:entity:brand');
  assert.equal(br['signal.interests.entities'], 'a');
  assert.equal(br['signal.demographics.age'], '30_to_34');
});

test('query string and trace line encode params faithfully', () => {
  const p = buildArtistParams({ ...base, tier: 'small' });
  const qs = new URLSearchParams(toQueryString(p));
  assert.equal(qs.get('signal.location.query'), 'Wicker Park, Chicago');
  assert.equal(qs.get('filter.popularity.max'), '0.6');
  assert.match(describeRequest('/v2/insights', p), /^GET \/v2\/insights\?filter\.type=urn:entity:artist&/);
});

test('popularity bands and size fit read as room sizes', () => {
  assert.equal(popularityBand(0.1), 'Emerging');
  assert.equal(popularityBand(0.5), 'Club');
  assert.equal(popularityBand(0.97), 'Arena');
  assert.equal(sizeFit(0.55, 'small').ok, true);
  const big = sizeFit(0.99, 'small');
  assert.equal(big.ok, false);
  assert.equal(big.ratio, 1.65);
  assert.equal(sizeFit(null, 'small').ok, null);
});

test('relax ladder starts with all signals and drops one constraint at a time', () => {
  const o = { tagIds: ['t'], entityIds: ['e'], age: '25_to_29' };
  assert.deepEqual(RELAX_STEPS[0].change(o), o);
  assert.deepEqual(RELAX_STEPS[1].change(o).tagIds, []);
  assert.deepEqual(RELAX_STEPS[2].change(o).entityIds, []);
  assert.equal(RELAX_STEPS[3].change(o).popBoost, 0.05);
  assert.equal(RELAX_STEPS[4].change(o).age, 'any');
});
