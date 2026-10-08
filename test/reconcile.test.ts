import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg, iso, T0 } from './helpers.ts';
import { HOUR } from '../src/domain/types.ts';

const aerofeed = (over: Record<string, unknown> = {}) => ({
  id: 'af-1', reg: 'N-100A', dep_iata: 'TEB', arr_iata: 'PBI', dep_date: '2026-10-03', dep_time_local: '12:00',
  tz_offset: '+00:00', flex_hours: 1, price_usd: '14,000', avail: 'Y', aircraft: 'Challenger 350', ...over,
});

test('operator report is authoritative over aggregators on status, time and price', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  // Aggregator: same flight, 30 min off, claims it is sold, and quotes its own retail price.
  await app.ingest.ingest('aerofeed', [aerofeed({ dep_time_local: '12:30', avail: 'N' })]);
  const leg = await onlyLeg(app);
  assert.equal(leg.supplyStatus, 'available');
  assert.equal(leg.departEarliest, T0 + 48 * HOUR);
  assert.equal(leg.askCents, 9_000_00);
  assert.equal(leg.provenance.status, 'api:op_a');
  assert.ok(leg.conflicts.some((c) => c.code === 'status_disagreement' && !c.blocking));
  assert.ok(leg.confidence >= 0.9);
});

test('reports of the same flight from different sources merge into one leg, even via a nearby airport', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  await app.ingest.ingest('aerofeed', [aerofeed({ dep_iata: 'JFK' })]); // 13nm from TEB
  const leg = await onlyLeg(app);
  assert.equal(leg.fromIcao, 'KTEB');
  assert.ok(leg.conflicts.some((c) => c.code === 'route_disagreement' && !c.blocking));
});

test('registry wins on aircraft type; the mismatch is recorded', async () => {
  const { app } = testApp();
  await app.ingest.ingest('aerofeed', [aerofeed({ aircraft: 'Citation XLS' })]);
  const leg = await onlyLeg(app);
  assert.equal(leg.typeCode, 'CL35');
  assert.ok(leg.conflicts.some((c) => c.code === 'aircraft_type_mismatch'));
});

test('aggregator-only legs need re-confirmation: confidence decays and they expire after TTL', async () => {
  const { app, clock } = testApp();
  await app.ingest.ingest('aerofeed', [aerofeed()]);
  let leg = await onlyLeg(app);
  assert.equal(leg.confidence, 0.7);
  assert.equal(leg.provenance.price, 'rate-model', 'aggregator retail price is not used as operator cost');

  clock.advance(3 * HOUR);
  await app.ingest.refresh();
  leg = await onlyLeg(app);
  assert.ok(leg.confidence < 0.55, `decayed to ${leg.confidence}`);

  clock.advance(4 * HOUR);
  await app.ingest.refresh();
  leg = await onlyLeg(app);
  assert.equal(leg.supplyStatus, 'expired');
});

test('two agreeing third-party sources corroborate each other', async () => {
  const { app } = testApp();
  await app.ingest.ingest('aerofeed', [aerofeed()]);
  await app.ingest.ingest('agg2', [nativeLeg({ departureEarliest: iso(Date.parse('2026-10-03T11:00:00Z')), departureLatest: iso(Date.parse('2026-10-03T13:00:00Z')), price: null })]);
  const leg = await onlyLeg(app);
  assert.ok(leg.confidence > 0.9, `noisy-or of 0.7 and 0.7 = 0.91, got ${leg.confidence}`);
});

test('without an operator report, a tie on availability resolves to unavailable', async () => {
  const { app } = testApp();
  await app.ingest.ingest('aerofeed', [aerofeed({ avail: 'N' })]);
  await app.ingest.ingest('agg2', [nativeLeg({ departureEarliest: iso(Date.parse('2026-10-03T11:00:00Z')), departureLatest: iso(Date.parse('2026-10-03T13:00:00Z')), price: null })]);
  const leg = await onlyLeg(app);
  assert.equal(leg.supplyStatus, 'withdrawn');
});

test('unknown tails and suspended operators are quarantined', async () => {
  const { app } = testApp();
  await app.ingest.ingest('aerofeed', [aerofeed({ id: 'u', reg: 'N999ZZ' })]);
  await app.ingest.ingest('api:op_x', [nativeLeg({ externalId: 'x', tailNumber: 'N400X' })]);
  const legs = app.legs.listActive(T0);
  assert.equal(legs.length, 2);
  const codes = legs.flatMap((l) => l.conflicts.filter((c) => c.blocking).map((c) => c.code)).sort();
  assert.deepEqual(codes, ['operator_inactive', 'unknown_tail']);
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 0);
});

test('an operator listing a tail it does not operate is only a weak witness', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_b', [nativeLeg({ tailNumber: 'N100A' })]);
  const leg = await onlyLeg(app);
  assert.ok(leg.conflicts.some((c) => c.code === 'source_not_owner'));
  assert.ok(leg.confidence < 0.5);
});

test('one tail cannot fly two overlapping legs: the less certain one is quarantined', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  // Aggregator claims the same aircraft departs VNY one hour later.
  await app.ingest.ingest('aerofeed', [aerofeed({ id: 'other', dep_iata: 'VNY', arr_iata: 'LAS' })]);
  const legs = app.legs.listActive(T0);
  assert.equal(legs.length, 2);
  const op = legs.find((l) => l.fromIcao === 'KTEB')!;
  const agg = legs.find((l) => l.fromIcao === 'KVNY')!;
  assert.ok(!op.conflicts.some((c) => c.blocking));
  assert.ok(agg.conflicts.some((c) => c.code === 'tail_schedule_overlap' && c.blocking));
});

test('version only moves on material change, so re-sending identical data never invalidates quotes', async () => {
  const { app, clock } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  const v1 = (await onlyLeg(app)).version;
  clock.advance(HOUR);
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  assert.equal((await onlyLeg(app)).version, v1);
  await app.ingest.ingest('api:op_a', [nativeLeg({ price: { amount: 8_000_00, currency: 'USD' } })]);
  assert.equal((await onlyLeg(app)).version, v1 + 1);
});

test('records for flights that already departed are rejected', async () => {
  const { app } = testApp();
  const r = await app.ingest.ingest('api:op_a', [nativeLeg({ departureEarliest: iso(T0 - 5 * HOUR), departureLatest: iso(T0 - 4 * HOUR) })]);
  assert.equal(r.rejected, 1);
  assert.equal(r.issues[0].code, 'departed');
});
