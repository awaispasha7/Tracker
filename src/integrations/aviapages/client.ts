// Aviapages API v3 client.
//
// Built for a metered API on a short trial:
//   - Every call is counted per endpoint per month and checked against a budget before it is
//     made; interactive features keep a reserve so background syncs can't starve them.
//   - Every response is archived raw, so what we paid for outlives the trial.
//   - Retries only where retrying is safe and useful (429 honouring Retry-After, 5xx, network),
//     with backoff; auth and validation errors fail fast with the provider's message.

import type { Database } from '../../db/database.ts';
import type { Clock } from '../../domain/types.ts';
import type {
  AircraftTypeRecord, AvpEmptyLeg, CharterAircraft, CharterCompany, CharterPriceRequest, CharterPriceResponse,
  CharterSearchAircraftResult, CharterSearchRequest, EmptyLegQuery, FlightCalcRequest, FlightCalcResponse, Paginated,
  PriceCalcRequest, PriceCalcResponse, QuoteReply, QuoteRequest, QuoteRequestCreate, Reaction,
} from './types.ts';

export const PROVIDER = 'aviapages';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Endpoint groups, as metered. Keys match the first path segment after /v3/. */
export type Endpoint =
  | 'empty_legs' | 'charter_quote_requests' | 'charter_quote_replies' | 'operator_quote_messages' | 'flight_calculator'
  | 'price_calculator' | 'charter_prices' | 'charter_searches' | 'charter_search_aircraft' | 'charter_companies'
  | 'charter_aircraft' | 'airports' | 'aircraft_types' | 'aircraft_classes' | 'tokens';

export interface AviapagesConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Monthly call budget per endpoint; endpoints not listed use defaultBudget. */
  budgets: Partial<Record<Endpoint, number>>;
  defaultBudget: number;
  archive: boolean;
}

export const DEFAULT_CONFIG: Omit<AviapagesConfig, 'apiKey'> = {
  baseUrl: 'https://api.aviapages.com',
  timeoutMs: 20_000,
  maxRetries: 3,
  budgets: {},
  defaultBudget: 1000,
  archive: true,
};

export class AviapagesError extends Error {
  code: 'budget_exceeded' | 'auth' | 'http' | 'timeout' | 'network' | 'disabled';
  status: number | null;
  endpoint: string;
  body: unknown;
  constructor(code: AviapagesError['code'], endpoint: string, message: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.code = code;
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

/** Query params whose arrays are sent as repeated keys rather than comma-joined. */
const REPEATED = new Set(['state_filter', 'reaction_filter']);

export interface CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Keep this many calls of the endpoint's monthly budget for interactive use. */
  reserve?: number;
}

export class AviapagesClient {
  readonly config: AviapagesConfig;
  private fetchImpl: FetchLike;
  private db: Database;
  private clock: Clock;
  private sleep: (ms: number) => Promise<void>;

  constructor(deps: { config: AviapagesConfig; fetch: FetchLike; db: Database; clock: Clock; sleep?: (ms: number) => Promise<void> }) {
    this.config = deps.config;
    this.fetchImpl = deps.fetch;
    this.db = deps.db;
    this.clock = deps.clock;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---------- budget ----------

  month(now = this.clock.now()): string {
    return new Date(now).toISOString().slice(0, 7);
  }

  budget(endpoint: Endpoint): number {
    return this.config.budgets[endpoint] ?? this.config.defaultBudget;
  }

  used(endpoint: Endpoint): number {
    return this.db.get<{ calls: number }>('SELECT calls FROM api_usage WHERE provider = ? AND month = ? AND endpoint = ?', PROVIDER, this.month(), endpoint)?.calls ?? 0;
  }

  remaining(endpoint: Endpoint): number {
    return Math.max(0, this.budget(endpoint) - this.used(endpoint));
  }

  usage(): Array<{ endpoint: string; calls: number; errors: number; budget: number; lastStatus: number | null; lastAt: string | null }> {
    const rows = this.db.all<{ endpoint: Endpoint; calls: number; errors: number; last_status: number | null; last_at: number | null }>(
      'SELECT endpoint, calls, errors, last_status, last_at FROM api_usage WHERE provider = ? AND month = ? ORDER BY endpoint', PROVIDER, this.month(),
    );
    return rows.map((r) => ({
      endpoint: r.endpoint, calls: r.calls, errors: r.errors, budget: this.budget(r.endpoint),
      lastStatus: r.last_status, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    }));
  }

  private record(endpoint: Endpoint, status: number | null, method: string, request: unknown, body: string): void {
    const now = this.clock.now();
    const failed = status === null || status >= 400 ? 1 : 0;
    this.db.run(
      `INSERT INTO api_usage (provider, month, endpoint, calls, errors, last_status, last_at) VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(provider, month, endpoint) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors,
         last_status = excluded.last_status, last_at = excluded.last_at`,
      PROVIDER, this.month(now), endpoint, failed, status, now,
    );
    if (this.config.archive) {
      this.db.run(
        'INSERT INTO api_archive (provider, endpoint, method, request, status, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        PROVIDER, endpoint, method, JSON.stringify(request), status ?? 0, body, now,
      );
    }
  }

  // ---------- transport ----------

  buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(path.startsWith('http') ? path : this.config.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        if (REPEATED.has(k)) v.forEach((x) => url.searchParams.append(k, String(x)));
        else url.searchParams.set(k, v.join(','));
      } else url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
    const endpoint = endpointOf(path);
    if (!this.config.apiKey) throw new AviapagesError('disabled', endpoint, 'Aviapages API key not configured');
    const url = this.buildUrl(path, opts.query);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    let attempt = 0;
    for (;;) {
      if (this.remaining(endpoint) <= (opts.reserve ?? 0)) {
        throw new AviapagesError('budget_exceeded', endpoint,
          `Monthly budget for ${endpoint} exhausted (${this.used(endpoint)}/${this.budget(endpoint)}${opts.reserve ? `, ${opts.reserve} reserved` : ''})`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let status: number | null = null;
      let text = '';
      let retryAfterMs = 0;
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Token ${this.config.apiKey}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body,
          signal: controller.signal,
        });
        status = res.status;
        text = await res.text();
        const ra = res.headers.get('retry-after');
        if (ra) retryAfterMs = (Number(ra) || 1) * 1000;
      } catch (e) {
        const timedOut = (e as Error).name === 'AbortError';
        this.record(endpoint, null, method, { url, body: opts.body }, String(e));
        if (attempt++ < this.config.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new AviapagesError(timedOut ? 'timeout' : 'network', endpoint, `${method} ${path}: ${timedOut ? 'timed out' : (e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      this.record(endpoint, status, method, { url, body: opts.body }, text);
      const parsed = parseJson(text);
      if (status >= 200 && status < 300) return parsed as T;
      if (status === 429 && /monthly/i.test(describeError(parsed) ?? text)) {
        // The provider's own monthly cap: retrying is pointless. Align our counter so we stop asking.
        this.db.run('UPDATE api_usage SET calls = MAX(calls, ?) WHERE provider = ? AND month = ? AND endpoint = ?',
          this.budget(endpoint), PROVIDER, this.month(), endpoint);
        throw new AviapagesError('budget_exceeded', endpoint, `Aviapages monthly limit reached for ${endpoint}: ${describeError(parsed)}`, 429, parsed);
      }
      if ((status === 429 || status >= 500) && attempt++ < this.config.maxRetries) {
        await this.sleep(Math.max(retryAfterMs, backoff(attempt)));
        continue;
      }
      const detail = describeError(parsed) ?? text.slice(0, 300);
      if (status === 401 || status === 403) throw new AviapagesError('auth', endpoint, `Aviapages rejected the API key (${status}): ${detail}`, status, parsed);
      throw new AviapagesError('http', endpoint, `${method} ${path} failed (${status}): ${detail}`, status, parsed);
    }
  }

  /** Follows `next` links. Stops at maxPages or when the budget would drop below `reserve`. */
  async *paginate<T>(path: string, query: Record<string, unknown>, opts: { maxPages?: number; reserve?: number } = {}): AsyncGenerator<{ page: Paginated<T>; pageNo: number }> {
    let next: string | null = path;
    let q: Record<string, unknown> | undefined = query;
    let pageNo = 0;
    while (next && pageNo < (opts.maxPages ?? Infinity)) {
      const page: Paginated<T> = await this.call<Paginated<T>>('GET', next, { query: q, reserve: opts.reserve });
      pageNo++;
      yield { page, pageNo };
      next = page.next;
      q = undefined; // `next` already carries the query string
    }
  }

  // ---------- empty legs ----------
  listEmptyLegs(query: EmptyLegQuery) { return this.call<Paginated<AvpEmptyLeg>>('GET', '/v3/empty_legs/', { query: query as Record<string, unknown> }); }
  getEmptyLeg(id: number) { return this.call<AvpEmptyLeg>('GET', `/v3/empty_legs/${id}/`); }

  // ---------- quoting: talking to operators ----------
  createQuoteRequest(body: QuoteRequestCreate) { return this.call<QuoteRequest>('POST', '/v3/charter_quote_requests/', { body }); }
  getQuoteRequest(id: number) { return this.call<QuoteRequest>('GET', `/v3/charter_quote_requests/${id}/`); }
  listQuoteRequests(query: Record<string, unknown> = {}) { return this.call<Paginated<QuoteRequest>>('GET', '/v3/charter_quote_requests/', { query }); }
  updateQuoteRequest(id: number, body: { comment?: string; channels?: string[]; post_to_trip_board?: boolean }) {
    return this.call<QuoteRequest>('PATCH', `/v3/charter_quote_requests/${id}/`, { body });
  }
  archiveQuoteRequest(id: number) { return this.call<unknown>('POST', `/v3/charter_quote_requests/${id}/archive/`, { body: {} }); }
  listQuoteReplies(query: Record<string, unknown> = {}) { return this.call<Paginated<QuoteReply>>('GET', '/v3/charter_quote_replies/', { query }); }
  getQuoteReply(id: number) { return this.call<QuoteReply>('GET', `/v3/charter_quote_replies/${id}/`); }
  reactToReply(id: number, reaction: Reaction) { return this.call<QuoteReply>('PATCH', `/v3/charter_quote_replies/${id}/`, { body: { reaction } }); }
  listOperatorQuoteMessages(query: Record<string, unknown> = {}) { return this.call<Paginated<unknown>>('GET', '/v3/operator_quote_messages/', { query }); }

  // ---------- calculators & search ----------
  flightCalculator(body: FlightCalcRequest) { return this.call<FlightCalcResponse>('POST', '/v3/flight_calculator/', { body }); }
  priceCalculator(body: PriceCalcRequest) { return this.call<PriceCalcResponse>('POST', '/v3/price_calculator/', { body }); }
  charterPrice(body: CharterPriceRequest) { return this.call<CharterPriceResponse>('POST', '/v3/charter_prices/', { body }); }
  charterSearchAircraft(body: CharterSearchRequest) { return this.call<{ aircraft: CharterSearchAircraftResult[] }>('POST', '/v3/charter_search_aircraft/', { body }); }
  charterSearch(body: CharterSearchRequest) { return this.call<{ companies: unknown[] }>('POST', '/v3/charter_searches/', { body }); }

  // ---------- directories ----------
  listCompanies(query: Record<string, unknown> = {}) { return this.call<Paginated<CharterCompany>>('GET', '/v3/charter_companies/', { query }); }
  getCompany(id: number) { return this.call<CharterCompany>('GET', `/v3/charter_companies/${id}/`); }
  listAircraft(query: Record<string, unknown> = {}) { return this.call<Paginated<CharterAircraft>>('GET', '/v3/charter_aircraft/', { query }); }
  listAirports(query: Record<string, unknown> = {}) { return this.call<Paginated<Record<string, unknown>>>('GET', '/v3/airports/', { query }); }
  listAircraftTypes(query: Record<string, unknown> = {}) { return this.call<Paginated<AircraftTypeRecord>>('GET', '/v3/aircraft_types/', { query }); }
  listAircraftClasses(query: Record<string, unknown> = {}) { return this.call<Paginated<{ aircraft_class_id: number; name: string }>>('GET', '/v3/aircraft_classes/', { query }); }
  listTokens() { return this.call<Array<{ name: string; is_active: boolean }>>('GET', '/v3/tokens/'); }
}

export function endpointOf(path: string): Endpoint {
  const p = path.startsWith('http') ? new URL(path).pathname : path;
  const m = /\/v3\/([a-z_]+)\//.exec(p);
  return (m?.[1] ?? 'unknown') as Endpoint;
}

/** "yyyy-mm-ddThh:mm" in UTC, the format Aviapages uses for date filters and leg times. */
export function avpMinute(t: number): string {
  return new Date(t).toISOString().slice(0, 16);
}

/** Aviapages returns times as "2026-10-20T14:00" or full ISO; both are UTC. */
export function parseAvpTime(s: string | null | undefined): number {
  if (!s) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}${s.length === 16 ? ':00' : ''}Z`;
  return Date.parse(iso);
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** DRF-style error bodies: {"detail": "..."} or {"field": ["msg"]}. */
function describeError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.detail === 'string') return b.detail;
  const parts = Object.entries(b).slice(0, 5).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : JSON.stringify(v)}`);
  return parts.length ? parts.join('; ') : null;
}
