// Live contract check: calls every Aviapages endpoint this app depends on (one call each),
// validates each response against the official OpenAPI spec, and reports what works.
// Run it on day 1 of a trial: it tells you in a minute whether the integration will work with
// your key, your plan's permissions and the live data, before you spend the trial on it.
//
// Read-only by default. `includeWrites` also creates (and immediately archives) one quote
// request addressed to no operator and copied to yourself, to prove RFQs work end to end.

import { avpMinute, AviapagesError, type AviapagesClient } from './client.ts';
import { validateResponse } from './openapi.ts';
import type { Paginated } from './types.ts';

export interface ProbeResult {
  name: string;
  feature: string;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  ok: boolean;
  schemaErrors: string[];
  note: string;
}

interface Probe {
  name: string;
  feature: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string | ((ctx: Ctx) => string | null);
  query?: Record<string, unknown>;
  body?: (ctx: Ctx) => unknown;
  after?: (body: unknown, ctx: Ctx) => void;
  write?: boolean;
}

interface Ctx {
  emptyLegId?: number;
  companyId?: number;
  tail?: string;
  replyId?: number;
  quoteRequestId?: number;
  dep: string;
  arr: string;
}

const firstId = (body: unknown) => (body as Paginated<{ id: number }>)?.results?.[0]?.id;

export async function runContractCheck(client: AviapagesClient, opts: { includeWrites?: boolean; now?: number } = {}): Promise<{ results: ProbeResult[]; summary: { passed: number; failed: number; skipped: number } }> {
  const now = opts.now ?? Date.now();
  const ctx: Ctx = { dep: 'KTEB', arr: 'KPBI' };
  const leg = (dep: string, arr: string) => ({ departure_airport: { icao: dep }, arrival_airport: { icao: arr }, pax: 2, departure_datetime: avpMinute(now + 7 * 86_400_000) });
  const probes: Probe[] = [
    { name: 'Token valid', feature: 'Authentication', method: 'GET', path: '/v3/tokens/' },
    {
      name: 'Empty legs: list', feature: 'Live empty-leg inventory', method: 'GET', path: '/v3/empty_legs/', query: { has_arrival_airport: true, from_date_utc: avpMinute(now) },
      after: (b) => {
        const l = (b as Paginated<{ id: number; dep_airport?: { icao?: string }; arr_airport?: { icao?: string }; aircraft?: { registration_number?: string; company?: { id: number } } }>).results?.[0];
        if (l) {
          ctx.emptyLegId = l.id;
          ctx.dep = l.dep_airport?.icao ?? ctx.dep;
          ctx.arr = l.arr_airport?.icao ?? ctx.arr;
          ctx.tail = l.aircraft?.registration_number ?? undefined;
          ctx.companyId = l.aircraft?.company?.id;
        }
      },
    },
    { name: 'Empty legs: incremental', feature: 'Live empty-leg inventory', method: 'GET', path: '/v3/empty_legs/', query: { updated_at_gt: new Date(now - 3_600_000).toISOString() } },
    { name: 'Empty legs: one', feature: 'Live empty-leg inventory', method: 'GET', path: (c) => (c.emptyLegId ? `/v3/empty_legs/${c.emptyLegId}/` : null) },
    { name: 'Flight calculator', feature: 'Flight time for pricing', method: 'POST', path: '/v3/flight_calculator/', body: (c) => ({ departure_airport: c.dep, arrival_airport: c.arr, aircraft: 'C56X', airway_time_weather_impacted: true, great_circle_distance: true, advise_techstops: true }) },
    { name: 'Charter prices', feature: 'Market price for "% below charter"', method: 'POST', path: '/v3/charter_prices/', body: (c) => ({ legs: [leg(c.dep, c.arr)], aircraft: [{ ac_class: 'Midsize jet' }], currency_code: 'USD', range: true }) },
    { name: 'Price calculator', feature: 'Operator cost model', method: 'POST', path: (c) => (c.tail ? '/v3/price_calculator/' : null), body: (c) => ({ aircraft: c.tail, currency: 'USD', flights: [{ departure_airport: c.dep, arrival_airport: c.arr, pax: 2 }] }) },
    { name: 'Charter search: aircraft', feature: 'Custom charter requests', method: 'POST', path: '/v3/charter_search_aircraft/', body: (c) => ({ legs: [leg(c.dep, c.arr)] }) },
    { name: 'Charter search: companies', feature: 'Custom charter requests', method: 'POST', path: '/v3/charter_searches/', body: (c) => ({ legs: [leg(c.dep, c.arr)] }) },
    { name: 'Quote requests: list', feature: 'Operator communication (RFQs)', method: 'GET', path: '/v3/charter_quote_requests/', after: (b) => { ctx.quoteRequestId = firstId(b); } },
    { name: 'Quote replies: list', feature: 'Operator communication (offers)', method: 'GET', path: '/v3/charter_quote_replies/', after: (b) => { ctx.replyId = firstId(b); } },
    { name: 'Quote reply: one', feature: 'Operator communication (offers)', method: 'GET', path: (c) => (c.replyId ? `/v3/charter_quote_replies/${c.replyId}/` : null) },
    { name: 'Operator quote messages', feature: 'Inbound RFQs (if you also operate aircraft)', method: 'GET', path: '/v3/operator_quote_messages/' },
    {
      name: 'Quote request: create (to yourself)', feature: 'Operator communication (RFQs)', method: 'POST', path: '/v3/charter_quote_requests/', write: true,
      body: (c) => ({ legs: [leg(c.dep, c.arr)], quote_messages: [], aircraft: [], channels: ['Email'], comment: 'Integration test - please ignore', post_to_trip_board: false, send_to_self: true }),
      after: (b) => { ctx.quoteRequestId = (b as { id?: number })?.id ?? ctx.quoteRequestId; },
    },
    { name: 'Charter companies', feature: 'Operator directory', method: 'GET', path: '/v3/charter_companies/', query: { is_operator: true }, after: (b) => { ctx.companyId ??= firstId(b); } },
    { name: 'Charter company: one', feature: 'Operator directory', method: 'GET', path: (c) => (c.companyId ? `/v3/charter_companies/${c.companyId}/` : null) },
    { name: 'Charter aircraft', feature: 'Fleet directory', method: 'GET', path: '/v3/charter_aircraft/' },
    { name: 'Airports', feature: 'Airport directory', method: 'GET', path: '/v3/airports/', query: { search: 'geneva' } },
    { name: 'Aircraft types', feature: 'Aircraft type catalog', method: 'GET', path: '/v3/aircraft_types/' },
    { name: 'Aircraft classes', feature: 'Aircraft type catalog', method: 'GET', path: '/v3/aircraft_classes/' },
  ];

  const results: ProbeResult[] = [];
  for (const p of probes) {
    const path = typeof p.path === 'function' ? p.path(ctx) : p.path;
    if (!path || (p.write && !opts.includeWrites)) {
      results.push({ name: p.name, feature: p.feature, method: p.method, path: path ?? '-', status: null, ms: 0, ok: false, schemaErrors: [], note: p.write ? 'skipped (read-only run; use --with-writes)' : 'skipped (no sample data from earlier probes)' });
      continue;
    }
    const body = p.body?.(ctx);
    const started = performance.now();
    try {
      const res = await client.call<unknown>(p.method, path, { query: p.query, body });
      const ms = Math.round(performance.now() - started);
      const status = p.method === 'POST' && path === '/v3/charter_quote_requests/' ? 200 : p.method === 'POST' && path === '/v3/empty_legs/' ? 201 : 200;
      const schemaErrors = validateResponse(p.method, path, status, res);
      p.after?.(res, ctx);
      results.push({ name: p.name, feature: p.feature, method: p.method, path, status, ms, ok: schemaErrors.length === 0, schemaErrors, note: schemaErrors.length ? 'response differs from the published spec' : 'ok' });
    } catch (e) {
      const ms = Math.round(performance.now() - started);
      const err = e as AviapagesError;
      results.push({ name: p.name, feature: p.feature, method: p.method, path, status: err.status ?? null, ms, ok: false, schemaErrors: [], note: err.message ?? String(e) });
    }
  }
  if (opts.includeWrites && ctx.quoteRequestId) {
    try {
      await client.archiveQuoteRequest(ctx.quoteRequestId);
    } catch {
      // best effort cleanup
    }
  }
  const skipped = results.filter((r) => r.status === null && r.note.startsWith('skipped')).length;
  const passed = results.filter((r) => r.ok).length;
  return { results, summary: { passed, failed: results.length - passed - skipped, skipped } };
}
