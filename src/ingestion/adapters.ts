// Feed adapters turn each source's wire format into normalized Observations.
// Each adapter is strict about what it can't interpret: a record it can't normalize becomes an
// IngestIssue rather than a guess.

import type { AdapterName, Observation } from '../domain/types.ts';
import { HOUR } from '../domain/types.ts';
import { findAirport } from '../reference/airports.ts';
import { normalizeTail } from '../domain/ids.ts';
import type { AvpEmptyLeg } from '../integrations/aviapages/types.ts';
import { parseAvpTime } from '../integrations/aviapages/client.ts';
import { airportCode } from '../integrations/aviapages/mapping.ts';

export interface IngestIssue {
  externalId: string | null;
  code: string;
  message: string;
  raw: unknown;
}

export interface AdapterResult {
  observations: Array<{ obs: Observation; raw: unknown }>;
  issues: IngestIssue[];
}

type Normalized = Omit<Observation, 'sourceId' | 'receivedAt'>;

class RecordError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function airport(code: unknown, field: string): string {
  const a = findAirport(typeof code === 'string' ? code : null);
  if (!a) throw new RecordError('unknown_airport', `${field}: unknown airport code ${JSON.stringify(code)}`);
  return a.icao;
}

function isoTime(v: unknown, field: string): number {
  if (typeof v !== 'string' || !/[zZ]|[+-]\d\d:?\d\d$/.test(v)) {
    throw new RecordError('bad_time', `${field}: expected an ISO-8601 timestamp with an explicit offset`);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new RecordError('bad_time', `${field}: unparseable timestamp ${JSON.stringify(v)}`);
  return t;
}

function checkCommon(n: Normalized, maxWindowMs = 72 * HOUR): Normalized {
  if (!n.tail || n.tail.length < 3) throw new RecordError('bad_tail', 'missing or invalid registration');
  if (n.fromIcao === n.toIcao) throw new RecordError('same_airport', 'origin and destination are the same');
  if (n.departLatest < n.departEarliest) throw new RecordError('bad_window', 'departure window ends before it starts');
  if (n.departLatest - n.departEarliest > maxWindowMs) throw new RecordError('bad_window', `departure window wider than ${maxWindowMs / HOUR}h`);
  if (n.askCents !== null && (!Number.isInteger(n.askCents) || n.askCents <= 0)) {
    throw new RecordError('bad_price', 'price must be a positive integer amount in minor units');
  }
  if (!/^[A-Z]{3}$/.test(n.currency)) throw new RecordError('bad_currency', `bad currency ${n.currency}`);
  return n;
}

// ---------- native: our own JSON schema, used by operator APIs and the operator portal ----------

interface NativeRecord {
  externalId?: unknown;
  tailNumber?: unknown;
  from?: unknown;
  to?: unknown;
  departureEarliest?: unknown;
  departureLatest?: unknown;
  price?: { amount?: unknown; currency?: unknown } | null;
  status?: unknown;
  aircraftType?: unknown;
}

function nativeRecord(r: NativeRecord): Normalized {
  if (typeof r.externalId !== 'string' || !r.externalId) throw new RecordError('missing_id', 'externalId is required');
  const status = r.status ?? 'available';
  if (status !== 'available' && status !== 'sold' && status !== 'cancelled') {
    throw new RecordError('bad_status', `status must be available|sold|cancelled`);
  }
  const earliest = isoTime(r.departureEarliest, 'departureEarliest');
  const latest = r.departureLatest === undefined ? earliest : isoTime(r.departureLatest, 'departureLatest');
  const amount = r.price?.amount;
  return checkCommon({
    externalId: r.externalId,
    tail: normalizeTail(String(r.tailNumber ?? '')),
    fromIcao: airport(r.from, 'from'),
    toIcao: airport(r.to, 'to'),
    departEarliest: earliest,
    departLatest: latest,
    askCents: amount === undefined || amount === null ? null : Number(amount),
    currency: typeof r.price?.currency === 'string' ? r.price.currency.toUpperCase() : 'USD',
    status: status === 'available' ? 'available' : 'unavailable',
    typeHint: typeof r.aircraftType === 'string' ? r.aircraftType : null,
  });
}

// ---------- aerofeed: a third-party aggregator with its own conventions ----------
// IATA codes, local date + local time + UTC offset, a +/- flex in hours, price as a dollar string
// ("12,500.00"), availability as "Y"/"N", free-text aircraft names.

interface AeroFeedRecord {
  id?: unknown;
  reg?: unknown;
  dep_iata?: unknown;
  arr_iata?: unknown;
  dep_date?: unknown;
  dep_time_local?: unknown;
  tz_offset?: unknown;
  flex_hours?: unknown;
  price_usd?: unknown;
  avail?: unknown;
  aircraft?: unknown;
}

function aerofeedRecord(r: AeroFeedRecord): Normalized {
  if (r.id === undefined || r.id === null || r.id === '') throw new RecordError('missing_id', 'id is required');
  if (typeof r.dep_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.dep_date)) throw new RecordError('bad_time', 'dep_date must be YYYY-MM-DD');
  const time = typeof r.dep_time_local === 'string' && /^\d{2}:\d{2}$/.test(r.dep_time_local) ? r.dep_time_local : null;
  const offset = typeof r.tz_offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(r.tz_offset) ? r.tz_offset : null;
  if (!time || !offset) throw new RecordError('bad_time', 'dep_time_local (HH:MM) and tz_offset (+HH:MM) are required');
  const centre = Date.parse(`${r.dep_date}T${time}:00${offset}`);
  const flex = Math.max(0, Math.min(36, Number(r.flex_hours ?? 0) || 0));
  let askCents: number | null = null;
  if (r.price_usd !== null && r.price_usd !== undefined && r.price_usd !== '' && r.price_usd !== 'POA') {
    const dollars = Number(String(r.price_usd).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(dollars)) throw new RecordError('bad_price', `unparseable price ${JSON.stringify(r.price_usd)}`);
    askCents = Math.round(dollars * 100);
  }
  return checkCommon({
    externalId: String(r.id),
    tail: normalizeTail(String(r.reg ?? '')),
    fromIcao: airport(r.dep_iata, 'dep_iata'),
    toIcao: airport(r.arr_iata, 'arr_iata'),
    departEarliest: centre - flex * HOUR,
    departLatest: centre + flex * HOUR,
    askCents,
    currency: 'USD',
    status: r.avail === 'N' ? 'unavailable' : 'available',
    typeHint: typeof r.aircraft === 'string' ? r.aircraft : null,
  });
}

// ---------- csv: bulk upload from the operator portal ----------
// tail,from,to,earliest,latest,price,currency,status   (price in major units, e.g. 9800)

/** Splits one CSV line, honouring double-quoted cells ("9,800") and escaped quotes (""). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

function csvRecord(r: Record<string, string>, index: number): Normalized {
  const price = r.price ? Number(r.price.replace(/[$,]/g, '')) : null;
  if (price !== null && !Number.isFinite(price)) throw new RecordError('bad_price', `unparseable price ${r.price}`);
  return nativeRecord({
    externalId: r.id || `${normalizeTail(r.tail ?? '')}-${r.from}-${r.to}-${r.earliest}` || `row-${index}`,
    tailNumber: r.tail,
    from: r.from,
    to: r.to,
    departureEarliest: r.earliest,
    departureLatest: r.latest || r.earliest,
    price: price === null ? null : { amount: Math.round(price * 100), currency: r.currency || 'USD' },
    status: r.status || 'available',
  });
}

// ---------- aviapages: operator-posted availability from the Aviapages marketplace ----------
// Airports, types and tails are registered by the sync before records reach this adapter.

function aviapagesRecord(r: AvpEmptyLeg): Normalized {
  if (typeof r.id !== 'number') throw new RecordError('missing_id', 'id is required');
  if (!r.arr_airport) throw new RecordError('no_destination', 'open-destination availability is not an empty leg we can sell');
  const from = airportCode(r.dep_airport);
  const to = airportCode(r.arr_airport);
  const earliest = parseAvpTime(r.from_date_utc);
  const latest = parseAvpTime(r.to_date_utc);
  if (Number.isNaN(earliest) || Number.isNaN(latest)) throw new RecordError('bad_time', 'from_date_utc/to_date_utc unparseable');
  let askCents: number | null = null;
  let currency = (r.currency_code ?? 'USD').toUpperCase();
  if (typeof r.price === 'number' && r.price > 0) {
    if (r.currency_code) askCents = Math.round(r.price * 100);
    else if (typeof r.converted_prices?.usd === 'number') {
      askCents = Math.round(r.converted_prices.usd * 100);
      currency = 'USD';
    }
  }
  return checkCommon({
    externalId: String(r.id),
    tail: normalizeTail(r.aircraft?.registration_number ?? r.registration_number ?? ''),
    fromIcao: airport(from, 'dep_airport'),
    toIcao: airport(to, 'arr_airport'),
    departEarliest: earliest,
    departLatest: Math.max(earliest, latest),
    askCents,
    currency,
    status: 'available',
    typeHint: r.aircraft_type_details?.icao ?? r.aircraft_type,
    note: r.comment,
  }, 10 * 24 * HOUR);
}

// ---------- dispatcher ----------

export function runAdapter(adapter: AdapterName, payload: unknown, sourceId: string, receivedAt: number): AdapterResult {
  const result: AdapterResult = { observations: [], issues: [] };
  let records: unknown[];
  if (adapter === 'csv') {
    if (typeof payload !== 'string') {
      result.issues.push({ externalId: null, code: 'bad_payload', message: 'csv adapter expects text', raw: payload });
      return result;
    }
    records = parseCsv(payload);
  } else {
    const p = payload as { legs?: unknown; flights?: unknown } | unknown[];
    const pr = p as { legs?: unknown; flights?: unknown; results?: unknown } | unknown[];
    records = Array.isArray(pr) ? pr : Array.isArray(pr?.legs) ? pr.legs : Array.isArray(pr?.flights) ? pr.flights : Array.isArray(pr?.results) ? pr.results : [];
    if (records.length === 0 && !Array.isArray(pr) && !Array.isArray(pr?.legs) && !Array.isArray(pr?.flights) && !Array.isArray(pr?.results)) {
      result.issues.push({ externalId: null, code: 'bad_payload', message: 'expected an array of records (or {legs|flights: [...]})', raw: payload });
      return result;
    }
  }
  records.forEach((rec, i) => {
    try {
      const n = adapter === 'aerofeed'
        ? aerofeedRecord(rec as AeroFeedRecord)
        : adapter === 'aviapages'
          ? aviapagesRecord(rec as AvpEmptyLeg)
        : adapter === 'csv'
          ? csvRecord(rec as Record<string, string>, i)
          : nativeRecord(rec as NativeRecord);
      result.observations.push({ obs: { ...n, sourceId, receivedAt }, raw: rec });
    } catch (e) {
      const r = rec as { externalId?: unknown; id?: unknown };
      const externalId = r && (r.externalId ?? r.id) ? String(r.externalId ?? r.id) : adapter === 'csv' ? `row ${i + 2}` : null;
      if (e instanceof RecordError) result.issues.push({ externalId, code: e.code, message: e.message, raw: rec });
      else throw e;
    }
  });
  return result;
}
