// Keeps the mock honest: every endpoint the app uses must return what the official Aviapages
// OpenAPI spec says it returns. If this passes but the live check fails, the provider deviates
// from its own spec, and `npm run aviapages:check` will say where.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AviapagesMock } from '../src/integrations/aviapages/mock.ts';
import { validateResponse } from '../src/integrations/aviapages/openapi.ts';
import { FakeClock } from './helpers.ts';
import { MINUTE } from '../src/domain/types.ts';

function call(mock: AviapagesMock, method: string, path: string, body?: Record<string, unknown>, query = '') {
  const r = mock.handle(method, path, new URLSearchParams(query), body, `Token ${mock.validKey}`);
  const errors = validateResponse(method, path, r.status, r.body);
  return { ...r, errors };
}

test('every mock endpoint conforms to the official OpenAPI spec', () => {
  const clock = new FakeClock();
  const mock = new AviapagesMock({ clock });
  const leg = mock.activeLegs().find((l) => l.arr && l.price !== null)!;
  const ac = mock.aircraft.get(leg.aircraftId)!;
  const qr = call(mock, 'POST', '/v3/charter_quote_requests/', {
    legs: [{ departure_airport: { icao: leg.dep }, arrival_airport: { icao: leg.arr }, pax: 2, departure_datetime: '2026-10-20T14:00' }],
    quote_messages: [{ company: { id: ac.companyId } }], aircraft: [{ tail_number: ac.reg }], channels: ['Email'], comment: 'test',
  });
  clock.advance(10 * MINUTE);
  const qrId = (qr.body as { id: number }).id;
  const replies = call(mock, 'GET', '/v3/charter_quote_replies/', undefined, `quote_request_id=${qrId}`);
  const replyId = (replies.body as { results: Array<{ id: number }> }).results[0].id;

  const cases: Array<[string, ReturnType<typeof call>]> = [
    ['empty_legs list', call(mock, 'GET', '/v3/empty_legs/')],
    ['empty_legs page 2', call(mock, 'GET', '/v3/empty_legs/', undefined, 'page=2')],
    ['empty_legs retrieve', call(mock, 'GET', `/v3/empty_legs/${leg.id}/`)],
    ['quote request create', qr],
    ['quote request retrieve', call(mock, 'GET', `/v3/charter_quote_requests/${qrId}/`)],
    ['quote request list', call(mock, 'GET', '/v3/charter_quote_requests/')],
    ['quote request patch', call(mock, 'PATCH', `/v3/charter_quote_requests/${qrId}/`, { comment: 'updated' })],
    ['quote replies list', replies],
    ['quote reply retrieve', call(mock, 'GET', `/v3/charter_quote_replies/${replyId}/`)],
    ['quote reply reaction', call(mock, 'PATCH', `/v3/charter_quote_replies/${replyId}/`, { reaction: 'Seen' })],
    ['operator quote messages', call(mock, 'GET', '/v3/operator_quote_messages/')],
    ['flight calculator', call(mock, 'POST', '/v3/flight_calculator/', { departure_airport: 'KTEB', arrival_airport: 'KPBI', aircraft: 'C56X', airway_time_weather_impacted: true })],
    ['price calculator', call(mock, 'POST', '/v3/price_calculator/', { aircraft: ac.reg, flights: [{ departure_airport: 'KTEB', arrival_airport: 'KPBI', pax: 2 }] })],
    ['charter prices', call(mock, 'POST', '/v3/charter_prices/', { legs: [{ departure_airport: { icao: 'KTEB' }, arrival_airport: { icao: 'KPBI' }, pax: 2, departure_datetime: '2026-10-20T14:00' }], aircraft: [{ ac_class: 'Midsize jet' }], currency_code: 'USD', range: true })],
    ['charter search aircraft', call(mock, 'POST', '/v3/charter_search_aircraft/', { legs: [{ departure_airport: { icao: 'KTEB' }, arrival_airport: { icao: 'KPBI' }, pax: 2, departure_datetime: '2026-10-20T14:00' }] })],
    ['charter searches', call(mock, 'POST', '/v3/charter_searches/', { legs: [{ departure_airport: { icao: 'KTEB' }, arrival_airport: { icao: 'KPBI' }, pax: 2, departure_datetime: '2026-10-20T14:00' }] })],
    ['companies list', call(mock, 'GET', '/v3/charter_companies/')],
    ['company retrieve', call(mock, 'GET', `/v3/charter_companies/${ac.companyId}/`)],
    ['aircraft list', call(mock, 'GET', '/v3/charter_aircraft/')],
    ['airports list', call(mock, 'GET', '/v3/airports/', undefined, 'search=geneva')],
    ['aircraft types', call(mock, 'GET', '/v3/aircraft_types/')],
    ['aircraft classes', call(mock, 'GET', '/v3/aircraft_classes/')],
    ['tokens', call(mock, 'GET', '/v3/tokens/')],
  ];
  const failures = cases.filter(([, r]) => r.status !== 200 || r.errors.length > 0)
    .map(([name, r]) => `${name}: HTTP ${r.status} ${r.errors.slice(0, 5).join(' | ')}`);
  assert.deepEqual(failures, []);
});

test('mock rejects bad tokens like the real API', () => {
  const mock = new AviapagesMock({ clock: new FakeClock() });
  assert.equal(mock.handle('GET', '/v3/empty_legs/', new URLSearchParams(), undefined, 'Token wrong').status, 401);
});

test('validator catches shape violations', () => {
  const errors = validateResponse('GET', '/v3/empty_legs/1/', 200, { id: 'not-a-number', from_date_utc: null });
  assert.ok(errors.some((e) => e.includes('$.id: expected integer')));
  assert.ok(errors.some((e) => e.includes('required field missing')));
});
