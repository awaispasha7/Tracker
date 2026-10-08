import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter } from '../src/ingestion/adapters.ts';

test('aerofeed: normalizes registration, IATA codes, local time + offset, dollar strings and Y/N', () => {
  const { observations, issues } = runAdapter('aerofeed', {
    flights: [{
      id: 77, reg: 'n-100a', dep_iata: 'teb', arr_iata: 'PBI', dep_date: '2026-10-03', dep_time_local: '08:00',
      tz_offset: '-04:00', flex_hours: 2, price_usd: '$12,500.50', avail: 'Y', aircraft: 'Challenger 350',
    }],
  }, 'aerofeed', 0);
  assert.equal(issues.length, 0);
  const o = observations[0].obs;
  assert.equal(o.externalId, '77');
  assert.equal(o.tail, 'N100A');
  assert.equal(o.fromIcao, 'KTEB');
  assert.equal(o.toIcao, 'KPBI');
  assert.equal(o.departEarliest, Date.parse('2026-10-03T10:00:00Z'));
  assert.equal(o.departLatest, Date.parse('2026-10-03T14:00:00Z'));
  assert.equal(o.askCents, 1_250_050);
  assert.equal(o.status, 'available');
  assert.equal(o.typeHint, 'Challenger 350');
});

test('aerofeed: "POA" means no price, "N" means unavailable', () => {
  const { observations } = runAdapter('aerofeed', [{
    id: 'a', reg: 'N100A', dep_iata: 'TEB', arr_iata: 'PBI', dep_date: '2026-10-03', dep_time_local: '08:00', tz_offset: '+00:00', price_usd: 'POA', avail: 'N',
  }], 'aerofeed', 0);
  assert.equal(observations[0].obs.askCents, null);
  assert.equal(observations[0].obs.status, 'unavailable');
});

test('bad records become issues instead of guesses', () => {
  const { observations, issues } = runAdapter('native', [
    { externalId: 'ok', tailNumber: 'N1', from: 'TEB', to: 'PBI', departureEarliest: '2026-10-03T08:00:00Z' },
    { externalId: 'no-tz', tailNumber: 'N100A', from: 'TEB', to: 'PBI', departureEarliest: '2026-10-03T08:00:00' },
    { externalId: 'airport', tailNumber: 'N100A', from: 'ZZZ', to: 'PBI', departureEarliest: '2026-10-03T08:00:00Z' },
    { externalId: 'same', tailNumber: 'N100A', from: 'TEB', to: 'KTEB', departureEarliest: '2026-10-03T08:00:00Z' },
    { externalId: 'window', tailNumber: 'N100A', from: 'TEB', to: 'PBI', departureEarliest: '2026-10-03T08:00:00Z', departureLatest: '2026-10-03T07:00:00Z' },
    { externalId: 'price', tailNumber: 'N100A', from: 'TEB', to: 'PBI', departureEarliest: '2026-10-03T08:00:00Z', price: { amount: 12.5, currency: 'USD' } },
    { externalId: 'status', tailNumber: 'N100A', from: 'TEB', to: 'PBI', departureEarliest: '2026-10-03T08:00:00Z', status: 'maybe' },
  ], 'src', 0);
  assert.deepEqual(issues.map((i) => i.code), ['bad_tail', 'bad_time', 'unknown_airport', 'same_airport', 'bad_window', 'bad_price', 'bad_status']);
  assert.equal(observations.length, 0);
});

test('csv: parses rows, major-unit prices, and reports bad rows by line number', () => {
  const csv = 'tail,from,to,earliest,latest,price,currency,status\n' +
    'N100A,TEB,PBI,2026-10-03T08:00:00Z,2026-10-03T10:00:00Z,"9,800",USD,available\n' +
    'N100A,TEB,XXX,2026-10-04T08:00:00Z,,9800,USD,available\n';
  const { observations, issues } = runAdapter('csv', csv, 'src', 0);
  assert.equal(observations.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].externalId, 'row 3');
  assert.equal(issues[0].code, 'unknown_airport');
});
