import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg } from './helpers.ts';

async function setup(budget?: number) {
  const h = testApp({ aviapages: { mode: 'mock', budgets: budget !== undefined ? { flight_calculator: budget, charter_prices: budget } : {} } });
  await h.app.ingest.ingest('api:op_a', [nativeLeg()]);
  const leg = await onlyLeg(h.app);
  return { ...h, leg, mock: h.app.aviapages!.mock! };
}

test('warming fetches wind-adjusted flight time and a market price once, then pricing uses them', async () => {
  const { app, leg, mock } = await setup();
  const before = app.pricing.price({ leg, pax: 2, seats: 9, now: app.clock.now() });
  assert.equal(before.flight!.source, 'estimate');
  assert.equal(before.fullCharterSource, 'model');

  const r = await app.calculators.warm(leg.fromIcao, leg.toIcao, leg.typeCode!, { tail: leg.tail, pax: 2 });
  assert.deepEqual([r.flight, r.price, r.errors], [true, true, []]);
  const after = app.pricing.price({ leg, pax: 2, seats: 9, now: app.clock.now() });
  assert.equal(after.flight!.source, 'aviapages');
  assert.equal(after.fullCharterSource, 'aviapages');
  const insight = app.calculators.flight(leg.fromIcao, leg.toIcao, leg.typeCode!)!;
  assert.equal(after.flight!.blockHours, Math.round((insight.minutes / 60 + 0.3) * 100) / 100);

  const calls = mock.calls.length;
  await app.calculators.warm(leg.fromIcao, leg.toIcao, leg.typeCode!);
  assert.equal(mock.calls.length, calls, 'cached: no second charge');
  assert.deepEqual(app.calculators.stats(), { flightTimes: 1, marketPrices: 1 });
});

test('warming respects the calculator budget reserve and never throws', async () => {
  const { app, leg, mock } = await setup(5);
  const r = await app.calculators.warm(leg.fromIcao, leg.toIcao, leg.typeCode!);
  assert.deepEqual([r.flight, r.price], [false, false]);
  assert.equal(mock.calls.length, 0);
});

test('provider errors degrade to our own estimate', async () => {
  const { app, leg, mock } = await setup();
  mock.failNext(500, 20, { detail: 'down' });
  const r = await app.calculators.warm(leg.fromIcao, leg.toIcao, leg.typeCode!);
  assert.equal(r.flight, false);
  assert.ok(r.errors.length >= 1);
  assert.ok(app.pricing.price({ leg, pax: 1, seats: 9, now: app.clock.now() }).ok);
});
