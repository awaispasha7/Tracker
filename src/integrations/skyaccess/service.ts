// SkyAccess partner inventory: flights we can show but don't sell.
//
// SkyAccess legs are booked on SkyAccess, not through our quote -> authorize -> confirm flow,
// so they are never ingested as our legs. Instead travelers see them beside our own results,
// with two ways forward:
//   - "Book on SkyAccess"   booking_handoff link; the traveler books and pays on SkyAccess.
//   - "Ask SkyAccess"       request_booking: name, email and trip go to a SkyAccess specialist,
//                           who replies by email. No payment, no booking. Logged in
//                           skyaccess_requests so ops can see what was sent on whose behalf.
//
// The server's response shapes aren't formally specified, so normalization is tolerant (several
// candidate keys per field) and every flight keeps its raw record. `npm run skyaccess:check`
// prints the live shapes.

import type { Database } from '../../db/database.ts';
import type { Clock } from '../../domain/types.ts';
import { AppError, DAY } from '../../domain/types.ts';
import { newId } from '../../domain/ids.ts';
import { findAirport } from '../../reference/airports.ts';
import { SkyAccessError, type SkyAccessClient, type ToolInfo } from './client.ts';

export interface PartnerPlace {
  /** Airport code as SkyAccess gave it (IATA or ICAO), or null when only a city was given. */
  code: string | null;
  name: string | null;
  city: string | null;
}

export interface PartnerFlight {
  source: 'skyaccess';
  flightId: string;
  from: PartnerPlace;
  to: PartnerPlace;
  /** ISO departure time, or null when SkyAccess only gave something unparseable. */
  departAt: string | null;
  /** Whole-aircraft price in USD; null = "Contact for price". Taxes and fees are added at SkyAccess checkout. */
  priceUsd: number | null;
  aircraft: string | null;
  category: string | null;
  seats: number | null;
  amenities: string[];
  bookingUrl: string | null;
  raw: unknown;
}

export interface PartnerSearch {
  origin?: string;
  destination?: string;
  dateFrom?: string;
  dateTo?: string;
  passengers?: number;
  maxPriceUsd?: number;
}

export interface BookingRequestInput {
  flightId?: string;
  name: string;
  email: string;
  phone?: string;
  origin: string;
  destination: string;
  /** YYYY-MM-DD */
  departureDate: string;
  passengers: number;
  notes?: string;
}

export interface BookingRequestView {
  id: string;
  status: 'sent' | 'failed';
  message: string;
  createdAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_TTL_MS = 60_000;
export const ESTIMATE_CATEGORIES = ['TURBOPROP', 'VERY_LIGHT_JET', 'LIGHT_JET', 'MID_SIZE_JET', 'SUPER_MID_SIZE_JET', 'HEAVY_JET', 'ULTRA_LONG_RANGE'] as const;

/** Our logical booking fields → names the server's request_booking schema might use for them. */
const FIELD_ALIASES: Record<keyof BookingRequestInput, string[]> = {
  name: ['name', 'fullName', 'full_name', 'travelerName', 'contactName'],
  email: ['email', 'contactEmail', 'travelerEmail'],
  phone: ['phone', 'phoneNumber', 'contactPhone'],
  origin: ['origin', 'from'],
  destination: ['destination', 'to'],
  departureDate: ['departureDate', 'date', 'departure_date'],
  passengers: ['passengers', 'pax'],
  notes: ['notes', 'message', 'comments'],
  flightId: ['flightId', 'flight_id'],
};

export class SkyAccessService {
  readonly client: SkyAccessClient;
  readonly mode: 'live' | 'mock';
  private db: Database;
  private clock: Clock;
  private searchCache = new Map<string, { at: number; flights: PartnerFlight[]; text: string }>();

  constructor(deps: { client: SkyAccessClient; db: Database; clock: Clock; mode: 'live' | 'mock' }) {
    this.client = deps.client;
    this.db = deps.db;
    this.clock = deps.clock;
    this.mode = deps.mode;
  }

  /** Up to 5 SkyAccess flights. Identical searches within a minute are served from cache (30 calls/min limit). */
  async search(q: PartnerSearch): Promise<{ flights: PartnerFlight[]; text: string }> {
    const args = {
      origin: q.origin, destination: q.destination, departureDateFrom: q.dateFrom, departureDateTo: q.dateTo,
      passengers: q.passengers, max_price: q.maxPriceUsd,
    };
    const key = JSON.stringify(args);
    const now = this.clock.now();
    const hit = this.searchCache.get(key);
    if (hit && now - hit.at < SEARCH_TTL_MS) return { flights: hit.flights, text: hit.text };
    const r = await this.call(() => this.client.callTool('search_empty_legs', args));
    const flights = listOf(r.data).map(normalizeFlight).filter((f): f is PartnerFlight => !!f);
    if (this.searchCache.size > 200) this.searchCache.clear();
    this.searchCache.set(key, { at: now, flights, text: r.text });
    return { flights, text: r.text };
  }

  /** Re-reads one flight; null when SkyAccess no longer publishes it. */
  async flight(flightId: string): Promise<PartnerFlight | null> {
    if (!flightId.trim()) throw new AppError(400, 'bad_request', 'flightId is required');
    try {
      const r = await this.call(() => this.client.callTool('get_flight', { flightId }));
      const rec = listOf(r.data)[0] ?? (isObj(r.data) ? r.data : null);
      const f = rec ? normalizeFlight(isObj(rec) && isObj(rec.flight) ? rec.flight : rec) : null;
      if (f) {
        if (!f.bookingUrl) f.bookingUrl = await this.bookingLink(flightId).catch(() => null);
        return f;
      }
      return null;
    } catch (e) {
      if (e instanceof AppError && e.code === 'partner_tool_error') return null;
      throw e;
    }
  }

  /** SkyAccess's booking page for a flight. Creates, holds or changes nothing. */
  async bookingLink(flightId: string): Promise<string | null> {
    const r = await this.call(() => this.client.callTool('booking_handoff', { flightId }));
    const d = isObj(r.data) ? r.data : {};
    return safeUrl(pickStr(d, 'bookingUrl', 'booking_url', 'url', 'link', 'bookingLink')) ?? safeUrl(r.text.match(/https:\/\/\S+/)?.[0]?.replace(/[).,]+$/, '') ?? null);
  }

  /** Indicative full-charter price ranges per aircraft category (not a quote). */
  async estimate(input: { origin: string; destination: string; passengers?: number; category?: string }): Promise<{ data: unknown; text: string }> {
    if (!input.origin?.trim() || !input.destination?.trim()) throw new AppError(400, 'bad_request', 'origin and destination are required');
    const category = input.category?.trim().toUpperCase() || undefined;
    if (category && !(ESTIMATE_CATEGORIES as readonly string[]).includes(category)) {
      throw new AppError(400, 'bad_category', `category must be one of ${ESTIMATE_CATEGORIES.join(', ')}`);
    }
    return this.call(() => this.client.callTool('get_charter_estimate', {
      origin: input.origin, destination: input.destination, passengers: input.passengers, aircraftCategory: category,
    }));
  }

  /**
   * Sends the traveler's enquiry to SkyAccess (request_booking). Only call when the traveler asked
   * to be contacted: this is the one call that sends personal data. Every attempt is logged.
   */
  async requestBooking(input: BookingRequestInput): Promise<BookingRequestView> {
    const b = validateBooking(input, this.clock.now());
    const schema = await this.client.tool('request_booking').catch(() => undefined);
    const args = mapToSchema(b, schema);
    const id = newId('sar');
    const now = this.clock.now();
    let status: BookingRequestView['status'] = 'sent';
    let message: string;
    let error: unknown = null;
    try {
      const r = await this.client.callTool('request_booking', args);
      message = r.text || 'Request sent. A SkyAccess specialist will reply by email.';
    } catch (e) {
      status = 'failed';
      error = e;
      message = e instanceof Error ? e.message : String(e);
    }
    this.db.run(
      `INSERT INTO skyaccess_requests (id, flight_id, contact_name, contact_email, contact_phone, origin, destination, departure_date, pax, notes, status, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, b.flightId ?? null, b.name, b.email, b.phone ?? null, b.origin, b.destination, b.departureDate, b.passengers, b.notes ?? null,
      status, message, now,
    );
    if (error) throw toAppError(error);
    return { id, status, message, createdAt: new Date(now).toISOString() };
  }

  /** For the ops console. */
  recentRequests(limit = 50): Array<Record<string, unknown>> {
    return this.db.all<Record<string, unknown>>('SELECT * FROM skyaccess_requests ORDER BY created_at DESC LIMIT ?', limit)
      .map((r) => ({ ...r, created_at: new Date(Number(r.created_at)).toISOString() }));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toAppError(e);
    }
  }
}

function toAppError(e: unknown): unknown {
  if (!(e instanceof SkyAccessError)) return e;
  if (e.code === 'rate_limited') {
    return new AppError(429, 'partner_rate_limited', 'SkyAccess is busy right now. Please try again shortly.', { retryAfterS: e.retryAfterS });
  }
  if (e.code === 'tool_error') return new AppError(422, 'partner_tool_error', e.message);
  return new AppError(502, 'partner_unavailable', 'SkyAccess is unavailable right now.', { reason: e.message });
}

function validateBooking(input: BookingRequestInput, now: number): BookingRequestInput {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const b: BookingRequestInput = {
    flightId: s(input?.flightId) || undefined,
    name: s(input?.name),
    email: s(input?.email),
    phone: s(input?.phone) || undefined,
    origin: s(input?.origin),
    destination: s(input?.destination),
    departureDate: s(input?.departureDate),
    passengers: Math.floor(Number(input?.passengers)),
    notes: s(input?.notes).slice(0, 1000) || undefined,
  };
  const problems: string[] = [];
  if (b.name.length < 2) problems.push('name is required');
  if (!EMAIL_RE.test(b.email)) problems.push('a valid email is required');
  if (!b.origin) problems.push('origin is required');
  if (!b.destination) problems.push('destination is required');
  if (!DATE_RE.test(b.departureDate) || Number.isNaN(Date.parse(b.departureDate))) problems.push('departureDate must be YYYY-MM-DD');
  else if (Date.parse(b.departureDate) < now - DAY) problems.push('departureDate is in the past');
  if (!Number.isFinite(b.passengers) || b.passengers < 1 || b.passengers > 50) problems.push('passengers must be between 1 and 50');
  if (problems.length) throw new AppError(400, 'bad_request', problems.join('; '), { problems });
  return b;
}

/** Uses the server's own property names when its schema is known; README names otherwise. */
export function mapToSchema(b: BookingRequestInput, schema: ToolInfo | undefined): Record<string, unknown> {
  const props = schema?.inputSchema?.properties;
  const hasPhoneField = !!props && FIELD_ALIASES.phone.some((a) => a in props);
  if (b.phone && !hasPhoneField) b = { ...b, phone: undefined, notes: [b.notes, `Phone: ${b.phone}`].filter(Boolean).join('\n') };
  const out: Record<string, unknown> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[keyof BookingRequestInput, string[]]>) {
    const value = b[field];
    if (value === undefined) continue;
    if (!props) {
      if (field !== 'flightId' && field !== 'phone') out[aliases[0]] = value;
      continue;
    }
    const key = aliases.find((a) => a in props);
    if (key) out[key] = value;
  }
  const missing = (schema?.inputSchema?.required ?? []).filter((k) => !(k in out));
  if (missing.length) throw new AppError(502, 'partner_schema_changed', `SkyAccess now requires fields we don't send: ${missing.join(', ')}`);
  return out;
}

// ---------- normalization ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function listOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObj(data)) return [];
  for (const k of ['flights', 'results', 'emptyLegs', 'empty_legs', 'items', 'data']) {
    if (Array.isArray(data[k])) return data[k] as unknown[];
  }
  return [];
}

function get(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);
}

function pickStr(o: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    const v = get(o, p);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function pickNum(o: unknown, ...paths: string[]): number | null {
  for (const p of paths) {
    const v = get(o, p);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,\s]/g, '')))) return Number(v.replace(/[$,\s]/g, ''));
  }
  return null;
}

function place(v: unknown): PartnerPlace {
  if (typeof v === 'string') {
    const code = /^[A-Z0-9]{3,4}$/.test(v.trim()) ? v.trim() : (/\(([A-Z0-9]{3,4})\)/.exec(v)?.[1] ?? null);
    const known = code ? findAirport(code) : undefined;
    return { code, name: known?.name ?? (code === v.trim() ? null : v.trim()), city: known?.city ?? null };
  }
  if (!isObj(v)) return { code: null, name: null, city: null };
  const code = pickStr(v, 'code', 'iata', 'icao', 'airportCode', 'airport.code', 'airport.iata', 'airport.icao');
  return { code, name: pickStr(v, 'name', 'airportName', 'airport.name'), city: pickStr(v, 'city', 'cityName', 'municipality') };
}

function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeFlight(rec: unknown): PartnerFlight | null {
  if (!isObj(rec)) return null;
  const flightId = pickStr(rec, 'flightId', 'id', 'flight_id');
  if (!flightId) return null;
  const from = place(get(rec, 'origin') ?? get(rec, 'from') ?? get(rec, 'departure.airport') ?? get(rec, 'departureAirport') ?? get(rec, 'route.origin'));
  const to = place(get(rec, 'destination') ?? get(rec, 'to') ?? get(rec, 'arrival.airport') ?? get(rec, 'arrivalAirport') ?? get(rec, 'route.destination'));
  const when = pickStr(rec, 'departureTime', 'departure_time', 'departureDate', 'departure.time', 'departure.date', 'departure', 'departAt', 'date');
  const ms = when ? Date.parse(when) : NaN;
  const price = get(rec, 'price');
  const priceUsd = price === null ? null : isObj(price) ? pickNum(price, 'amount', 'usd', 'value') : pickNum(rec, 'price', 'priceUsd', 'price_usd');
  const aircraftObj = get(rec, 'aircraft');
  const amenities = get(rec, 'amenities');
  return {
    source: 'skyaccess',
    flightId,
    from,
    to,
    departAt: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
    priceUsd,
    aircraft: typeof aircraftObj === 'string' ? aircraftObj : pickStr(rec, 'aircraft.type', 'aircraft.model', 'aircraft.name', 'aircraftType', 'aircraft_type'),
    category: pickStr(rec, 'aircraft.category', 'category', 'aircraftCategory'),
    seats: pickNum(rec, 'seats', 'availableSeats', 'aircraft.seats', 'maxPassengers'),
    amenities: Array.isArray(amenities)
      ? amenities.map((a) => (typeof a === 'string' ? a : pickStr(a, 'name', 'label'))).filter((a): a is string => !!a)
      : isObj(amenities) ? Object.entries(amenities).filter(([, v]) => v === true).map(([k]) => k) : [],
    bookingUrl: safeUrl(pickStr(rec, 'bookingUrl', 'booking_url', 'bookingLink', 'url', 'link')),
    raw: rec,
  };
}
