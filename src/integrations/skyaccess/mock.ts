// In-process stand-in for the SkyAccess MCP server, for tests and offline demos (SKYACCESS_MODE=mock).
// Speaks the same JSON-RPC over the FetchLike interface. Its flight records follow the field names
// SkyAccess documents (flightId, price in USD or null, booking link); the rest of the shape is
// illustrative, which is why the service normalizes tolerantly.

import type { FetchLike } from '../aviapages/client.ts';
import { DAY, HOUR } from '../../domain/types.ts';

export interface MockFlight {
  flightId: string;
  origin: { code: string; name: string; city: string };
  destination: { code: string; name: string; city: string };
  departureTime: string;
  price: number | null;
  aircraft: { type: string; category: string; seats: number };
  amenities: string[];
  bookingUrl: string;
}

export interface MockBookingRequest {
  arguments: Record<string, unknown>;
  at: number;
}

const P = {
  VNY: { code: 'VNY', name: 'Van Nuys', city: 'Los Angeles' },
  LAS: { code: 'LAS', name: 'Harry Reid Intl', city: 'Las Vegas' },
  TEB: { code: 'TEB', name: 'Teterboro', city: 'New York' },
  PBI: { code: 'PBI', name: 'Palm Beach Intl', city: 'West Palm Beach' },
  OPF: { code: 'OPF', name: 'Miami-Opa Locka Executive', city: 'Miami' },
  NAS: { code: 'NAS', name: 'Lynden Pindling Intl', city: 'Nassau' },
  ASE: { code: 'ASE', name: 'Aspen-Pitkin County', city: 'Aspen' },
  DAL: { code: 'DAL', name: 'Dallas Love Field', city: 'Dallas' },
};

export const REQUEST_BOOKING_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' }, email: { type: 'string' }, origin: { type: 'string' }, destination: { type: 'string' },
    departureDate: { type: 'string' }, passengers: { type: 'number' }, notes: { type: 'string' },
  },
  required: ['name', 'email', 'origin', 'destination', 'departureDate', 'passengers'],
};

export class SkyAccessMock {
  flights: MockFlight[];
  bookingRequests: MockBookingRequest[] = [];
  calls: Array<{ method: string; tool?: string }> = [];
  /** When set, the next tool call answers 429 / -32029. */
  rateLimitNext = false;

  constructor(opts: { now?: () => number } = {}) {
    const t0 = (opts.now ?? Date.now)();
    const at = (h: number) => new Date(Math.floor((t0 + h * HOUR) / HOUR) * HOUR).toISOString();
    const f = (id: string, o: keyof typeof P, d: keyof typeof P, h: number, price: number | null, type: string, category: string, seats: number, amenities: string[]): MockFlight => ({
      flightId: id, origin: P[o], destination: P[d], departureTime: at(h), price, aircraft: { type, category, seats }, amenities,
      bookingUrl: `https://skyaccess.com/flights/${id}`,
    });
    this.flights = [
      f('sa_1001', 'VNY', 'LAS', 30, 6900, 'Citation CJ3', 'LIGHT_JET', 7, ['Wi-Fi']),
      f('sa_1002', 'VNY', 'LAS', 76, 8400, 'Challenger 300', 'SUPER_MID_SIZE_JET', 9, ['Wi-Fi', 'Lavatory']),
      f('sa_1003', 'TEB', 'PBI', 52, 14500, 'Citation XLS+', 'MID_SIZE_JET', 8, ['Lavatory']),
      f('sa_1004', 'TEB', 'PBI', 120, null, 'Gulfstream G450', 'HEAVY_JET', 14, ['Wi-Fi', 'Lavatory', 'Cabin crew']),
      f('sa_1005', 'OPF', 'NAS', 44, 5200, 'King Air 350', 'TURBOPROP', 8, []),
      f('sa_1006', 'DAL', 'ASE', 96, 11800, 'Phenom 300', 'LIGHT_JET', 7, ['Wi-Fi']),
    ];
  }

  readonly fetch: FetchLike = async (_url, init) => {
    const req = JSON.parse(init.body ?? '{}') as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    this.calls.push({ method: req.method, tool: req.params?.name });
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => ({ 'content-type': 'application/json', ...headers } as Record<string, string>)[n.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    });
    const ok = (result: unknown) => reply(200, { jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize') {
      return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'SkyAccess (mock)', version: '0.0.0' } });
    }
    if (req.method === 'tools/list') {
      return ok({ tools: [
        { name: 'search_empty_legs', annotations: { readOnlyHint: true } },
        { name: 'get_flight', annotations: { readOnlyHint: true } },
        { name: 'booking_handoff', annotations: { readOnlyHint: true } },
        { name: 'get_charter_estimate', annotations: { readOnlyHint: true } },
        { name: 'request_booking', inputSchema: REQUEST_BOOKING_SCHEMA, annotations: { readOnlyHint: false } },
      ] });
    }
    if (req.method !== 'tools/call') return reply(200, { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
    if (this.rateLimitNext) {
      this.rateLimitNext = false;
      return reply(429, { jsonrpc: '2.0', id: req.id, error: { code: -32029, message: 'Max 30 requests per minute' } }, { 'ratelimit-reset': '42' });
    }
    const a = req.params?.arguments ?? {};
    const tool = (data: unknown, text: string, isError = false) => ok({ content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}), isError });
    const byId = (id: unknown) => this.flights.find((x) => x.flightId === id);
    switch (req.params?.name) {
      case 'search_empty_legs': {
        const near = (p: MockFlight['origin'], q: unknown) => !q || [p.code, p.city, p.name].some((s) => s.toLowerCase() === String(q).toLowerCase());
        const from = a.departureDateFrom ? Date.parse(String(a.departureDateFrom)) : -Infinity;
        const to = a.departureDateTo ? Date.parse(String(a.departureDateTo)) + DAY : Infinity;
        const hits = this.flights.filter((x) => near(x.origin, a.origin) && near(x.destination, a.destination)
          && Date.parse(x.departureTime) >= from && Date.parse(x.departureTime) < to
          && (!a.passengers || x.aircraft.seats >= Number(a.passengers))
          && (!a.max_price || x.price === null || x.price <= Number(a.max_price))).slice(0, 5);
        return tool({ flights: hits }, hits.length ? `Found ${hits.length} empty leg flight(s).` : 'No empty leg flights match that search.');
      }
      case 'get_flight': {
        const x = byId(a.flightId);
        return x ? tool({ flight: x }, `${x.origin.code} to ${x.destination.code}`) : tool(null, 'No published empty leg flight matches that id.', true);
      }
      case 'booking_handoff': {
        const x = byId(a.flightId);
        return x ? tool({ bookingUrl: x.bookingUrl }, `Book here: ${x.bookingUrl}`) : tool(null, 'No published empty leg flight matches that id.', true);
      }
      case 'get_charter_estimate':
        return tool({ estimates: [{ category: 'LIGHT_JET', low: 18000, high: 24000, flightTimeMinutes: 75 }] }, 'Indicative one-way charter: light jet $18,000–$24,000.');
      case 'request_booking': {
        const missing = REQUEST_BOOKING_SCHEMA.required.filter((k) => a[k] === undefined);
        if (missing.length) return tool(null, `Missing: ${missing.join(', ')}`, true);
        this.bookingRequests.push({ arguments: a, at: Date.now() });
        return tool({ received: true }, 'Thanks! A SkyAccess specialist will email you shortly to confirm availability and price.');
      }
      default:
        return reply(200, { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Unknown tool' } });
    }
  };
}
