import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readReply, SkyAccessClient, SkyAccessError } from '../src/integrations/skyaccess/client.ts';
import { SkyAccessMock } from '../src/integrations/skyaccess/mock.ts';
import { mapToSchema, normalizeFlight } from '../src/integrations/skyaccess/service.ts';
import { buildRouter } from '../src/http/routes.ts';
import { AppError, HOUR } from '../src/domain/types.ts';
import type { FetchLike } from '../src/integrations/aviapages/client.ts';
import { T0, testApp } from './helpers.ts';

function setup() {
  const mock = new SkyAccessMock({ now: () => T0 });
  const { app, clock } = testApp({ skyaccess: { mode: 'mock', mock } });
  return { app, clock, mock, sky: app.skyaccess! };
}

const day = (h: number) => new Date(T0 + h * HOUR).toISOString().slice(0, 10);

test('reads JSON-RPC replies sent as plain JSON or as a single SSE message', () => {
  const msg = { jsonrpc: '2.0', id: 7, result: { ok: true } };
  assert.deepEqual(readReply(JSON.stringify(msg), 'application/json', 7)?.result, { ok: true });
  assert.deepEqual(readReply(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, 'text/event-stream', 7)?.result, { ok: true });
  assert.equal(readReply('<html>', 'text/html', 7), null);
});

test('search returns normalized flights filtered by route, dates and passengers', async () => {
  const { sky } = setup();
  const { flights } = await sky.search({ origin: 'VNY', destination: 'LAS', passengers: 8 });
  assert.equal(flights.length, 1, 'the 7-seat CJ3 is filtered out for 8 passengers');
  const f = flights[0];
  assert.equal(f.flightId, 'sa_1002');
  assert.equal(f.from.code, 'VNY');
  assert.equal(f.to.city, 'Las Vegas');
  assert.equal(f.priceUsd, 8400);
  assert.equal(f.aircraft, 'Challenger 300');
  assert.equal(f.seats, 9);
  assert.match(f.bookingUrl!, /^https:\/\/skyaccess\.com\//);

  const dated = await sky.search({ origin: 'VNY', dateFrom: day(0), dateTo: day(40) });
  assert.deepEqual(dated.flights.map((x) => x.flightId), ['sa_1001']);
});

test('identical searches within a minute are served from cache (30 calls/min limit)', async () => {
  const { sky, mock, clock } = setup();
  await sky.search({ origin: 'TEB' });
  await sky.search({ origin: 'TEB' });
  assert.equal(mock.calls.filter((c) => c.tool === 'search_empty_legs').length, 1);
  clock.advance(61_000);
  await sky.search({ origin: 'TEB' });
  assert.equal(mock.calls.filter((c) => c.tool === 'search_empty_legs').length, 2);
});

test('a flight with no published price keeps price null ("Contact for price")', async () => {
  const { sky } = setup();
  const { flights } = await sky.search({ origin: 'TEB', destination: 'PBI' });
  assert.equal(flights.find((f) => f.flightId === 'sa_1004')?.priceUsd, null);
});

test('get_flight re-reads one flight; a withdrawn flight is null, not an error', async () => {
  const { sky, mock } = setup();
  assert.equal((await sky.flight('sa_1003'))?.aircraft, 'Citation XLS+');
  mock.flights = mock.flights.filter((f) => f.flightId !== 'sa_1003');
  assert.equal(await sky.flight('sa_1003'), null);
});

test('rate limiting surfaces as a 429 with the reset time', async () => {
  const { sky, mock } = setup();
  mock.rateLimitNext = true;
  await assert.rejects(sky.search({ origin: 'OPF' }), (e: AppError) => e.status === 429 && e.code === 'partner_rate_limited' && (e.details as { retryAfterS: number }).retryAfterS === 42);
});

test('an unreachable server is a 502, not a crash', async () => {
  const fetch: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
  const { app } = testApp({ skyaccess: { mode: 'live', fetch } });
  await assert.rejects(app.skyaccess!.search({ origin: 'TEB' }), (e: AppError) => e.status === 502 && e.code === 'partner_unavailable');
});

test('request_booking sends the enquiry in the server schema and logs it', async () => {
  const { sky, mock, app } = setup();
  const out = await sky.requestBooking({
    flightId: 'sa_1001', name: 'Grace Hopper', email: 'grace@example.com', phone: '+1 555 0100',
    origin: 'VNY', destination: 'LAS', departureDate: day(30), passengers: 4, notes: 'Two golf bags',
  });
  assert.equal(out.status, 'sent');
  assert.match(out.message, /specialist/);
  assert.equal(mock.bookingRequests.length, 1);
  const sent = mock.bookingRequests[0].arguments;
  assert.equal(sent.name, 'Grace Hopper');
  assert.equal(sent.passengers, 4);
  assert.equal(sent.flightId, undefined, 'fields the schema lacks are not sent');
  assert.match(String(sent.notes), /Two golf bags\nPhone: \+1 555 0100/, 'phone rides in notes when the schema has no phone field');
  const [row] = app.skyaccess!.recentRequests();
  assert.equal(row.contact_email, 'grace@example.com');
  assert.equal(row.status, 'sent');
});

test('request_booking validates before anything leaves the building', async () => {
  const { sky, mock } = setup();
  await assert.rejects(
    sky.requestBooking({ name: '', email: 'nope', origin: 'VNY', destination: '', departureDate: '2020-01-01', passengers: 0 }),
    (e: AppError) => e.status === 400 && /name is required/.test(e.message) && /valid email/.test(e.message) && /past/.test(e.message),
  );
  assert.equal(mock.bookingRequests.length, 0);
});

test('a schema that requires a field we do not send fails loudly', () => {
  const schema = { name: 'request_booking', inputSchema: { properties: { name: {}, email: {}, company: {} }, required: ['name', 'email', 'company'] } };
  assert.throws(() => mapToSchema({ name: 'A', email: 'a@b.co', origin: 'X', destination: 'Y', departureDate: '2026-10-10', passengers: 1 }, schema),
    (e: AppError) => e.code === 'partner_schema_changed');
});

test('normalization tolerates other shapes and drops unsafe booking links', () => {
  const f = normalizeFlight({ id: 'x1', from: 'KTEB', to: 'Palm Beach (PBI)', departure_time: '2026-10-05T14:00:00Z', price: { amount: '12,500' }, aircraft: 'Learjet 45', bookingUrl: 'javascript:alert(1)' });
  assert.equal(f?.flightId, 'x1');
  assert.equal(f?.from.code, 'KTEB');
  assert.equal(f?.to.code, 'PBI');
  assert.equal(f?.priceUsd, 12500);
  assert.equal(f?.aircraft, 'Learjet 45');
  assert.equal(f?.bookingUrl, null);
  assert.equal(normalizeFlight({ route: 'no id' }), null);
});

test('client parses text-only JSON results and raises tool errors', async () => {
  const fetch: FetchLike = async (_u, init) => {
    const { id, params } = JSON.parse(init.body!);
    const result = params.name === 'get_flight'
      ? { content: [{ type: 'text', text: 'No published empty leg flight matches that id.' }], isError: true }
      : { content: [{ type: 'text', text: '{"flights":[{"flightId":"t1"}]}' }] };
    return { status: 200, headers: { get: () => 'text/event-stream' }, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n` };
  };
  const client = new SkyAccessClient({ fetch });
  assert.deepEqual((await client.callTool('search_empty_legs', { origin: 'TEB', destination: '' })).data, { flights: [{ flightId: 't1' }] });
  await assert.rejects(client.callTool('get_flight', { flightId: 'zz' }), (e: SkyAccessError) => e.code === 'tool_error');
});

test('HTTP: partner search, flight detail and booking request', async () => {
  const { app } = setup();
  const router = buildRouter(app, { adminKey: 'admin' });
  const server = createServer(async (req, res) => { if (!(await router.handle(req, res))) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const search = await (await fetch(`${base}/api/partners/skyaccess/search?from=TEB&to=PBI&pax=2`)).json();
    assert.equal(search.flights.length, 2);
    const detail = await (await fetch(`${base}/api/partners/skyaccess/flights/sa_1003`)).json();
    assert.equal(detail.flightId, 'sa_1003');
    assert.equal((await fetch(`${base}/api/partners/skyaccess/flights/missing`)).status, 404);
    const res = await fetch(`${base}/api/partners/skyaccess/booking-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flightId: 'sa_1003', name: 'Ada Lovelace', email: 'ada@example.com', origin: 'TEB', destination: 'PBI', departureDate: day(52), passengers: 2 }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).status, 'sent');
    const admin = await (await fetch(`${base}/api/admin/skyaccess`, { headers: { authorization: 'Bearer admin' } })).json();
    assert.equal(admin.tools.length, 5);
    assert.equal(admin.requests.length, 1);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(cfg.skyaccess, { enabled: true, mode: 'mock' });
  } finally {
    server.close();
  }
});
