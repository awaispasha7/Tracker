import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, T0 } from './helpers.ts';
import { HOUR, MINUTE } from '../src/domain/types.ts';
import { findAirport } from '../src/reference/airports.ts';
import { findAircraftType } from '../src/reference/aircraft-types.ts';
import { SOURCE_ID } from '../src/integrations/aviapages/mapping.ts';

function setup(budget?: number) {
  const h = testApp({ aviapages: { mode: 'mock', budgets: budget ? { empty_legs: budget } : {} } });
  h.app.market.set('fx_usd_per_GBP', 1.27, T0);
  const avp = h.app.aviapages!;
  return { ...h, avp, mock: avp.mock! };
}

const avpLegs = (app: ReturnType<typeof setup>['app']) =>
  app.legs.listActive(app.clock.now()).filter((l) => l.provenance.status?.includes(SOURCE_ID) || l.provenance.route?.includes(SOURCE_ID));

test('full sync ingests every listing and learns airports, aircraft types, operators and tails', async () => {
  const { app, avp, mock } = setup();
  const r = await avp.sync.full();
  assert.equal(r.error, null);
  assert.ok(r.complete);
  const expected = mock.activeLegs().filter((l) => l.arr).length;
  assert.equal(r.received, expected);
  assert.ok(r.skipped.unsupported_aircraft >= 1, 'the helicopter listing is skipped');
  assert.equal(r.ingested + (r.skipped.unsupported_aircraft ?? 0), expected);

  // Airports and types outside the curated lists were learned.
  assert.ok(findAirport('KMMU'), 'Morristown learned from the feed');
  assert.ok(findAirport('LFLB'), 'Chambery learned from the feed');
  assert.equal(findAircraftType('B350')?.category, 'turboprop');
  assert.equal(findAircraftType('GLF5')?.category, 'ultra-long');
  assert.ok(app.reference.airports().some((a) => a.icao === 'KMMU'), 'persisted for the next restart');

  // Operators and tails registered with contact details, photos and amenities.
  const ops = app.fleet.listOperators().filter((o) => o.source === 'aviapages');
  assert.ok(ops.length >= 10);
  assert.ok(ops.every((o) => o.contact?.email?.includes('@')));
  const tail = app.fleet.listAircraft().find((a) => a.source === 'aviapages')!;
  assert.ok(tail.images!.length > 0);
  assert.equal(typeof tail.amenities!.wireless_internet, 'boolean');
  assert.ok(avpLegs(app).length > 0);
});

test('operator-posted prices are used as the operator ask, converted from EUR/GBP', async () => {
  const { app, avp, mock } = setup();
  await avp.sync.full();
  const priced = mock.activeLegs().find((l) => l.arr && l.price !== null && l.currency === 'EUR' && mock.types.get(mock.aircraft.get(l.aircraftId)!.typeId)!.classId !== 9)!;
  const leg = app.legs.get(app.legs.linkedLegId(SOURCE_ID, String(priced.id))!)!;
  assert.equal(leg.askCents, Math.round(priced.price! * 100));
  assert.equal(leg.currency, 'EUR');
  assert.equal(leg.provenance.price, SOURCE_ID);
  const seats = app.fleet.getAircraft(leg.tail)!.seats;
  const p = app.pricing.price({ leg, pax: 1, seats, now: app.clock.now() });
  assert.ok(p.lines.find((l) => l.code === 'operator_rate')!.amountCents === Math.round(priced.price! * 100 * 1.1));
});

test('synced legs are searchable, including from airports we only learned from the feed', async () => {
  const { app, avp, mock } = setup();
  await avp.sync.full();
  const fromLearned = mock.activeLegs().find((l) => l.dep === 'KMMU' && l.arr);
  const r = app.search.search({ from: fromLearned ? 'MMU' : 'TEB', radiusNm: 0 }, app.clock.now());
  assert.ok(r.meta.indexSize > 20);
  if (fromLearned) assert.ok(r.results.some((h) => h.from.icao === 'KMMU') || r.meta.priceBlocked > 0);
});

test('incremental sync picks up only changed listings', async () => {
  const { app, avp, mock, clock } = setup();
  await avp.sync.full();
  clock.advance(15 * MINUTE);
  const ac = [...mock.aircraft.values()].find((a) => mock.types.get(a.typeId)!.classId === 4)!;
  const added = mock.addLeg({ aircraftId: ac.id, dep: 'LSGG', arr: 'LFMN', from: clock.now() + 30 * HOUR, price: 5900, currency: 'EUR' });
  const r = await avp.sync.incremental();
  assert.equal(r.kind, 'incremental');
  // The new listing, plus at most the few updated in the overlap minute at the cursor boundary.
  assert.ok(r.received >= 1 && r.received <= 5, `received ${r.received}`);
  assert.ok(r.received < mock.activeLegs().length / 4);
  assert.ok(app.legs.linkedLegId(SOURCE_ID, String(added.id)));
});

test('listings that disappear from a complete full sync are withdrawn', async () => {
  const { app, avp, mock, clock } = setup();
  await avp.sync.full();
  const target = mock.activeLegs().find((l) => l.arr && mock.types.get(mock.aircraft.get(l.aircraftId)!.typeId)!.classId !== 9)!;
  const legId = app.legs.linkedLegId(SOURCE_ID, String(target.id))!;
  assert.equal(app.legs.get(legId)!.supplyStatus, 'available');
  mock.removeLeg(target.id);
  clock.advance(HOUR);
  const r = await avp.sync.full();
  assert.equal(r.removed, 1);
  assert.equal(app.legs.get(legId)!.supplyStatus, 'withdrawn');
});

test('a tail owned by a directly signed operator stays theirs; the listing is a third-party report', async () => {
  const { app, avp, mock, clock } = setup();
  const ac = [...mock.aircraft.values()].find((a) => mock.types.get(a.typeId)!.classId === 5)!;
  ac.reg = 'N100A'; // our test registry has N100A under op_a
  mock.addLeg({ aircraftId: ac.id, dep: 'KTEB', arr: 'KPBI', from: clock.now() + 50 * HOUR, price: 8000, currency: 'USD' });
  await avp.sync.full();
  assert.equal(app.fleet.getAircraft('N100A')!.operatorId, 'op_a');
  assert.equal(app.fleet.getAircraft('N100A')!.source, 'direct');
  const leg = app.legs.listActive(clock.now()).find((l) => l.tail === 'N100A')!;
  assert.equal(leg.operatorId, 'op_a');
});

test('listings stay sellable for the source confirmation window, then need re-confirming', async () => {
  const { app, avp, clock } = setup();
  await avp.sync.full();
  const leg = avpLegs(app).find((l) => l.askCents !== null)!;
  assert.equal(leg.freshnessMs, 12 * HOUR);
  const seats = app.fleet.getAircraft(leg.tail)!.seats;
  clock.advance(8 * HOUR);
  assert.ok(!app.pricing.price({ leg, pax: 1, seats, now: clock.now() }).failures.some((f) => f.code === 'LEG_FRESH'));
  clock.advance(5 * HOUR);
  assert.ok(app.pricing.price({ leg, pax: 1, seats, now: clock.now() }).failures.some((f) => f.code === 'LEG_FRESH'));
});

test('budget pacing stretches full syncs when the monthly budget is tight', async () => {
  const roomy = setup(100_000);
  await roomy.avp.sync.full();
  assert.equal(roomy.avp.sync.pacedFullInterval(), 4 * HOUR);
  const tight = setup(60);
  await tight.avp.sync.full();
  assert.ok(tight.avp.sync.pacedFullInterval() > 24 * HOUR, 'a 60-call month cannot afford a full sync every 4h');
  assert.equal(tight.avp.sync.status().freshnessAtRisk, true);
});

test('scheduler: full first, then incrementals until the next full is due', async () => {
  const { avp, clock } = setup(100_000);
  assert.equal((await avp.sync.tick())?.kind, 'full');
  assert.equal(await avp.sync.tick(), null);
  clock.advance(11 * MINUTE);
  assert.equal((await avp.sync.tick())?.kind, 'incremental');
  clock.advance(4 * HOUR);
  assert.equal((await avp.sync.tick())?.kind, 'full');
});

test('API failures are reported, not thrown, and do not corrupt state', async () => {
  const { avp, mock } = setup();
  mock.failNext(401, 1, { detail: 'Invalid token.' });
  const r = await avp.sync.full();
  assert.match(r.error!, /rejected the API key/);
  assert.equal(avp.sync.state().lastFullAt, null);
});
