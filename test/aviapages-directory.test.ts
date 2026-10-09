import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import { registerCharterAircraft, registerCompany, registerTypeRecord } from '../src/integrations/aviapages/mapping.ts';
import { findAircraftType } from '../src/reference/aircraft-types.ts';
import type { AircraftTypeRecord, CharterAircraft, CharterCompany, Paginated } from '../src/integrations/aviapages/types.ts';

function setup() {
  const h = testApp({ aviapages: { mode: 'mock' } });
  return { ...h, r: { fleet: h.app.fleet, reference: h.app.reference }, client: h.app.aviapages!.client };
}

test('type catalog replaces class defaults with real range, speed and seats (curated types untouched)', async () => {
  const { r, client } = setup();
  const page = await client.call<Paginated<AircraftTypeRecord>>('GET', '/v3/aircraft_types/');
  for (const t of page.results) registerTypeRecord(r, t);
  const g550 = findAircraftType('GLF5')!;
  assert.equal(g550.rangeNm, Math.round(12500 / 1.852));
  assert.equal(g550.cruiseKts, Math.round(900 / 1.852));
  assert.equal(g550.seats, 16);
  assert.equal(findAircraftType('C56X')!.rangeNm, 2100, 'curated Citation XLS+ keeps its figures');
  assert.equal(registerTypeRecord(r, { id: 1, name: 'Bell 429', icao: 'B429', class_name: 'Helicopter', manufacturer_name: 'Bell', range_maximum: 700, pax_maximum: 7, speed_typical: 250 }), null);
});

test('operator directory: contacts and response stats; signed operators keep their source', async () => {
  const { app, r, client } = setup();
  const page = await client.call<Paginated<CharterCompany>>('GET', '/v3/charter_companies/');
  for (const c of page.results) registerCompany(r, c);
  const op = app.fleet.getOperator(`avp_${page.results[0].id}`)!;
  assert.equal(op.source, 'aviapages');
  assert.ok(op.contact!.email!.includes('@'));
  assert.ok(typeof op.contact!.responseRate === 'number');
});

test('fleet directory registers tails with bases, photos and amenities, never stealing signed tails', async () => {
  const { app, r, client } = setup();
  const page = await client.call<Paginated<CharterAircraft>>('GET', '/v3/charter_aircraft/');
  const a = page.results.find((x) => x.aircraft_type.aircraft_class.name !== 'Helicopter')!;
  assert.ok(registerCharterAircraft(r, a));
  const tail = app.fleet.getAircraft(a.registration_number!.replace(/-/g, '').toUpperCase())!;
  assert.ok(tail.images!.length > 0);
  assert.ok(tail.homeBase.length >= 3);
  assert.equal(registerCharterAircraft(r, { ...a, registration_number: 'N100A' }), false, 'N100A belongs to signed operator op_a');
  assert.equal(app.fleet.getAircraft('N100A')!.operatorId, 'op_a');
});
