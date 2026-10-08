import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, iso, T0 } from './helpers.ts';
import { DAY, HOUR } from '../src/domain/types.ts';

async function market() {
  const h = testApp();
  await h.app.ingest.ingest('api:op_a', [
    nativeLeg({ externalId: 'teb-pbi', tailNumber: 'N100A', from: 'KTEB', to: 'KPBI', departureEarliest: iso(T0 + 2 * DAY), departureLatest: iso(T0 + 2 * DAY + 2 * HOUR) }),
    nativeLeg({ externalId: 'teb-ase', tailNumber: 'N200A', from: 'KTEB', to: 'KASE', departureEarliest: iso(T0 + 5 * DAY), departureLatest: iso(T0 + 5 * DAY), price: null }),
    nativeLeg({ externalId: 'bad', tailNumber: 'N100A', from: 'KPBI', to: 'KTEB', departureEarliest: iso(T0 + 9 * DAY), departureLatest: iso(T0 + 9 * DAY), price: { amount: 50_00, currency: 'USD' } }),
  ]);
  await h.app.ingest.ingest('api:op_b', [
    nativeLeg({ externalId: 'vny-las', tailNumber: 'N300B', from: 'KVNY', to: 'KLAS', departureEarliest: iso(T0 + 3 * DAY), departureLatest: iso(T0 + 3 * DAY), price: { amount: 3_200_00, currency: 'USD' } }),
  ]);
  return h;
}

test('nearby-airport matching: searching White Plains finds Teterboro departures', async () => {
  const { app } = await market();
  const r = app.search.search({ from: 'HPN', radiusNm: 40 }, T0);
  assert.deepEqual(r.results.map((h) => h.to.iata).sort(), ['ASE', 'PBI']);
  assert.ok(r.results[0].matchNotes.some((n) => n.includes('Departs TEB')));
  assert.equal(app.search.search({ from: 'HPN', radiusNm: 0 }, T0).results.length, 0);
});

test('destination radius: Fort Lauderdale finds a Palm Beach arrival', async () => {
  const { app } = await market();
  const r = app.search.search({ from: 'TEB', to: 'FLL', radiusNm: 50 }, T0);
  assert.deepEqual(r.results.map((h) => h.to.iata), ['PBI']);
});

test('date flexibility', async () => {
  const { app } = await market();
  const date = new Date(T0 + 4 * DAY).toISOString().slice(0, 10);
  assert.deepEqual(app.search.search({ from: 'TEB', date, flexDays: 0 }, T0).results.length, 0);
  assert.deepEqual(app.search.search({ from: 'TEB', date, flexDays: 1 }, T0).results.map((h) => h.to.iata), ['ASE']);
  assert.equal(app.search.search({ from: 'TEB', date, flexDays: 2 }, T0).results.length, 2);
});

test('seats and category filters', async () => {
  const { app } = await market();
  assert.deepEqual(app.search.search({ from: 'TEB', pax: 8 }, T0).results.map((h) => h.aircraft.tail), ['N100A']);
  assert.deepEqual(app.search.search({ from: 'TEB', categories: ['light'] }, T0).results.map((h) => h.aircraft.tail), ['N200A']);
});

test('legs whose price fails guardrails are hidden and counted', async () => {
  const { app } = await market();
  const r = app.search.search({ from: 'PBI' }, T0);
  assert.equal(r.results.length, 0);
  assert.equal(r.meta.priceBlocked, 1);
});

test('sorting and max price', async () => {
  const { app } = await market();
  const byPrice = app.search.search({ from: 'TEB', sort: 'price' }, T0).results.map((h) => h.price.totalCents);
  assert.deepEqual(byPrice, [...byPrice].sort((a, b) => a - b));
  const cap = byPrice[0] + 1;
  assert.equal(app.search.search({ from: 'TEB', maxPriceCents: cap }, T0).results.length, 1);
});

test('search reflects inventory changes immediately (index invalidation)', async () => {
  const { app } = await market();
  assert.equal(app.search.search({ from: 'VNY' }, T0).results.length, 1);
  const r = await app.ingest.ingest('api:op_b', [nativeLeg({ externalId: 'vny-las', tailNumber: 'N300B', from: 'KVNY', to: 'KLAS', departureEarliest: iso(T0 + 3 * DAY), departureLatest: iso(T0 + 3 * DAY), status: 'sold' })]);
  assert.equal(r.accepted, 1);
  assert.equal(app.search.search({ from: 'VNY' }, T0).results.length, 0);
});

test('latency: 2,000 live legs searched well under 50ms', async () => {
  const { app } = testApp();
  const airports = ['KTEB', 'KHPN', 'KPBI', 'KVNY', 'KAPA', 'KDAL', 'KBOS', 'KMDW', 'KSDL', 'KLAS'];
  for (let i = 0; i < 400; i++) app.fleet.upsertAircraft({ tail: `N${1000 + i}T`, operatorId: 'op_a', typeCode: 'C56X', seats: 8, homeBase: 'KTEB', year: 2019 });
  const legs = [];
  for (let i = 0; i < 2000; i++) {
    const from = airports[i % airports.length];
    const to = airports[(i * 7 + 3) % airports.length] === from ? 'KASE' : airports[(i * 7 + 3) % airports.length];
    // Each of the 400 tails flies 5 legs, 3 days apart, so no schedule overlaps.
    const t = T0 + 6 * HOUR + Math.floor(i / 400) * 3 * DAY;
    legs.push(nativeLeg({ externalId: `l${i}`, tailNumber: `N${1000 + (i % 400)}T`, from, to, departureEarliest: iso(t), departureLatest: iso(t), price: null }));
  }
  await app.ingest.ingest('api:op_a', legs);
  assert.equal(app.search.search({ from: 'TEB' }, T0).meta.indexSize, 2000);
  const started = performance.now();
  for (let i = 0; i < 20; i++) app.search.search({ from: airports[i % airports.length], radiusNm: 150, pax: 2 }, T0);
  const avg = (performance.now() - started) / 20;
  assert.ok(avg < 50, `avg ${avg.toFixed(1)}ms`);
});
