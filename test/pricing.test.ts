import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg, iso, T0 } from './helpers.ts';
import { HOUR, DAY, type Leg } from '../src/domain/types.ts';

async function legWith(over: Parameters<typeof nativeLeg>[0] = {}) {
  const h = testApp();
  await h.app.ingest.ingest('api:op_a', [nativeLeg(over)]);
  const leg = await onlyLeg(h.app);
  const price = (l: Leg = leg, pax = 1) => h.app.pricing.price({ leg: l, pax, seats: 9, now: h.clock.now() });
  return { ...h, leg, price };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('all-in price: lines add up, operator gets exactly their ask, US domestic taxes applied', async () => {
  const { price } = await legWith();
  const p = price(undefined, 3);
  assert.ok(p.ok, JSON.stringify(p.failures));
  assert.equal(sum(p.lines.map((l) => l.amountCents)), p.totalCents);
  assert.equal(p.operatorPayoutCents, 9_000_00);
  assert.equal(p.basis, 'operator_ask');
  const transport = p.operatorPayoutCents + p.platformFeeCents;
  assert.equal(p.lines.find((l) => l.code === 'fet')!.amountCents, Math.round(transport * 0.075));
  assert.equal(p.lines.find((l) => l.code === 'segment_fees')!.amountCents, 3 * 5_30);
  assert.equal(p.taxCents + transport, p.totalCents);
  // Super-midsize margin target is 10% of payout; > 14 days out adds 1%, 2 days out adds nothing.
  assert.equal(p.platformFeeCents, 900_00);
  assert.ok(p.savingsPct > 0);
});

test('international legs pay US international head tax instead of FET', async () => {
  const { price } = await legWith({ to: 'MYNN' });
  const p = price(undefined, 2);
  assert.ok(p.ok, JSON.stringify(p.failures));
  assert.equal(p.lines.find((l) => l.code === 'fet'), undefined);
  assert.equal(p.lines.find((l) => l.code === 'intl_taxes')!.amountCents, 2 * 23_00);
});

test('no operator ask: price is modelled from repositioning economics and falls as departure nears', async () => {
  const { leg, price } = await legWith({ price: null, departureEarliest: iso(T0 + 10 * DAY), departureLatest: iso(T0 + 10 * DAY) });
  const far = price();
  assert.ok(far.ok, JSON.stringify(far.failures));
  assert.equal(far.basis, 'rate_model');
  assert.ok(far.lines.some((l) => l.code === 'handling'));
  const near = price({ ...leg, departEarliest: T0 + 30 * HOUR, departLatest: T0 + 30 * HOUR });
  assert.ok(near.ok, JSON.stringify(near.failures));
  assert.ok(near.totalCents < far.totalCents * 0.85, `${near.totalCents} vs ${far.totalCents}`);
});

test('fuel above baseline adds a surcharge to modelled prices', async () => {
  const { app, price } = await legWith({ price: null });
  const before = price();
  app.market.set('fuel_cents_per_gal', 700, T0);
  const after = price();
  const surcharge = after.lines.find((l) => l.code === 'fuel_surcharge');
  assert.ok(surcharge && surcharge.amountCents > 0);
  assert.ok(after.totalCents > before.totalCents);
});

test('margin is compressed to stay under the full-charter ceiling, and the leg is blocked if even that fails', async () => {
  const { leg, price } = await legWith();
  const full = price().fullCharterEstimateCents;
  // An ask just under the ceiling leaves no room for the normal margin: margin shrinks.
  const tight = price({ ...leg, askCents: Math.round(full * 0.85 / 1.075) - 800_00 });
  assert.ok(tight.ok, JSON.stringify(tight.failures));
  assert.ok(tight.notes.some((n) => n.includes('margin compressed')));
  assert.ok(tight.netMarginCents >= 150_00, 'compression never goes below break-even');
  // An ask at full-charter level is not a deal at all.
  const greedy = price({ ...leg, askCents: Math.round(full * 0.9) });
  assert.ok(!greedy.ok);
  assert.ok(greedy.failures.some((f) => f.code === 'FULL_CHARTER_CEILING'));
});

test('guardrail: a fat-fingered price (dollars entered as cents) never reaches a customer', async () => {
  const { price } = await legWith({ price: { amount: 90_00, currency: 'USD' } });
  const p = price();
  assert.ok(!p.ok);
  assert.ok(p.failures.some((f) => f.code === 'PRICE_SANITY'));
});

test('guardrail: a large move vs. the last published price is held for review', async () => {
  const { leg, price } = await legWith();
  const shown = price().totalCents;
  const p = price({ ...leg, lastPublishedPriceCents: shown, askCents: 5_000_00 });
  assert.ok(!p.ok);
  const f = p.failures.find((x) => x.code === 'PRICE_JUMP')!;
  assert.equal(f.severity, 'review');
  assert.ok(price({ ...leg, lastPublishedPriceCents: shown, askCents: 8_500_00 }).ok, 'small moves pass');
});

test('guardrails: stale supply, stale market data, capacity, lead time, low confidence, conflicts', async () => {
  const { app, clock, leg, price } = await legWith();
  const codes = (l: Leg, pax = 1) => price(l, pax).failures.map((f) => f.code);
  assert.deepEqual(codes(leg, 10), ['CAPACITY']);
  assert.deepEqual(codes({ ...leg, confidence: 0.3 }), ['LEG_CONFIDENCE']);
  assert.deepEqual(codes({ ...leg, conflicts: [{ code: 'unknown_tail', blocking: true, detail: '' }] }), ['LEG_UNCONFLICTED']);
  assert.deepEqual(codes({ ...leg, departEarliest: T0 + 2 * HOUR, departLatest: T0 + 2 * HOUR }), ['LEAD_TIME']);
  clock.advance(7 * HOUR);
  assert.ok(codes(leg).includes('LEG_FRESH'), 'operator has not re-confirmed in 7h');
  app.market.set('fuel_cents_per_gal', 600, clock.now() - 3 * DAY);
  assert.ok(codes({ ...leg, lastSeenAt: clock.now() }).includes('MARKET_FRESH'));
});

test('foreign-currency asks are converted with a fresh FX rate, and blocked without one', async () => {
  const { leg, price } = await legWith({ price: { amount: 8_000_00, currency: "EUR" } });
  const p = price();
  assert.ok(p.ok, JSON.stringify(p.failures));
  assert.equal(p.operatorPayoutCents, 8_800_00);
  const chf = price({ ...leg, currency: 'CHF' });
  assert.ok(chf.failures.some((f) => f.code === 'FX_AVAILABLE'));
});

test('margin floor: cheap legs pay the minimum fee, and the fee always covers card processing', async () => {
  const { leg, price } = await legWith({ tailNumber: 'N200A', price: { amount: 2_000_00, currency: 'USD' }, to: 'KHPN' });
  const cheap = price({ ...leg, typeCode: 'E55P' });
  assert.equal(cheap.platformFeeCents, 300_00);
  for (const ask of [1_500_00, 9_000_00, 40_000_00]) {
    const p = price({ ...leg, typeCode: 'E55P', askCents: ask });
    assert.ok(p.netMarginCents >= 150_00, `ask ${ask}: net ${p.netMarginCents}`);
  }
});
