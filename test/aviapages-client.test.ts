import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AviapagesClient, AviapagesError, DEFAULT_CONFIG, parseAvpTime } from '../src/integrations/aviapages/client.ts';
import { AviapagesMock } from '../src/integrations/aviapages/mock.ts';
import { Database } from '../src/db/database.ts';
import { FakeClock } from './helpers.ts';

function setup(over: Partial<typeof DEFAULT_CONFIG> = {}, key = 'mock-key') {
  const clock = new FakeClock();
  const mock = new AviapagesMock({ clock, perPage: 10 });
  const db = new Database(':memory:');
  const client = new AviapagesClient({
    config: { ...DEFAULT_CONFIG, baseUrl: mock.baseUrl, apiKey: key, ...over }, fetch: mock.fetch, db, clock, sleep: async () => {},
  });
  return { clock, mock, db, client };
}

test('authenticates with "Token <key>" and parses responses', async () => {
  const { client } = setup();
  const page = await client.listEmptyLegs({});
  assert.ok(page.count > 10);
  assert.equal(page.results.length, 10);
});

test('pagination follows next links until exhausted', async () => {
  const { client, mock } = setup();
  let total = 0;
  let pages = 0;
  for await (const { page } of client.paginate('/v3/empty_legs/', {})) {
    total += page.results.length;
    pages++;
  }
  assert.equal(total, mock.activeLegs().length);
  assert.equal(pages, Math.ceil(total / 10));
});

test('a bad key fails fast with an auth error, not retries', async () => {
  const { client, mock } = setup({}, 'wrong');
  await assert.rejects(client.listEmptyLegs({}), (e: AviapagesError) => e.code === 'auth' && e.status === 401);
  assert.equal(mock.calls.length, 1);
});

test('retries 5xx and per-minute 429 with backoff, then succeeds', async () => {
  const { client, mock } = setup();
  mock.failNext(503, 1);
  mock.failNext(429, 1, { detail: 'Request was throttled. Expected available in 1 second.' });
  const page = await client.listEmptyLegs({});
  assert.ok(page.results.length > 0);
  assert.equal(mock.calls.length, 3);
});

test('provider monthly limit stops immediately and marks the endpoint exhausted', async () => {
  const { client, mock } = setup();
  mock.failNext(429, 5, { detail: 'Request was throttled. Monthly API limit exceeded' });
  await assert.rejects(client.listEmptyLegs({}), (e: AviapagesError) => e.code === 'budget_exceeded');
  assert.equal(mock.calls.length, 1);
  assert.equal(client.remaining('empty_legs'), 0);
});

test('our own monthly budget is enforced before calling, with a reserve for interactive use', async () => {
  const { client, mock } = setup({ budgets: { empty_legs: 3 } });
  await client.listEmptyLegs({});
  await client.listEmptyLegs({});
  await assert.rejects(client.call('GET', '/v3/empty_legs/', { reserve: 1 }), (e: AviapagesError) => e.code === 'budget_exceeded');
  await client.listEmptyLegs({});
  await assert.rejects(client.listEmptyLegs({}), (e: AviapagesError) => e.code === 'budget_exceeded');
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(client.usage().map((u) => [u.endpoint, u.calls, u.budget]), [['empty_legs', 3, 3]]);
});

test('every response is archived for replay after the trial', async () => {
  const { client, db } = setup();
  await client.listEmptyLegs({ has_price: true });
  const row = db.get<{ endpoint: string; status: number; body: string; request: string }>('SELECT * FROM api_archive');
  assert.equal(row?.endpoint, 'empty_legs');
  assert.equal(row?.status, 200);
  assert.ok(JSON.parse(row!.body).results.length > 0);
  assert.match(row!.request, /has_price=true/);
});

test('validation errors surface the provider message', async () => {
  const { client } = setup();
  await assert.rejects(client.createQuoteRequest({ legs: [], quote_messages: [{ company: { id: 1 } }], aircraft: [], channels: ['Email'] }),
    (e: AviapagesError) => e.code === 'http' && /Company 1 not found/.test(e.message));
});

test('array query params: comma-joined, except repeated filters', () => {
  const { client } = setup();
  const url = client.buildUrl('/v3/charter_quote_replies/', { quote_request_id_in: [1, 2], state_filter: ['OK', 'Not available'] });
  assert.match(url, /quote_request_id_in=1%2C2/);
  assert.match(url, /state_filter=OK&state_filter=Not\+available/);
});

test('disabled when no key is configured', async () => {
  const { client } = setup({}, '');
  await assert.rejects(client.listEmptyLegs({}), (e: AviapagesError) => e.code === 'disabled');
});

test('parses Aviapages time formats as UTC', () => {
  assert.equal(parseAvpTime('2026-10-20T14:00'), Date.parse('2026-10-20T14:00:00Z'));
  assert.equal(parseAvpTime('2026-10-20T14:00:00Z'), Date.parse('2026-10-20T14:00:00Z'));
  assert.equal(parseAvpTime('2026-10-20T16:00:00+02:00'), Date.parse('2026-10-20T14:00:00Z'));
});
