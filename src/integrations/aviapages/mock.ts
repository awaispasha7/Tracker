// In-process stand-in for the Aviapages API v3, shaped by the official OpenAPI spec (every
// response it produces is validated against ./openapi.json in the test suite).
//
// It exists so the whole integration (sync, operator RFQs and replies, calculators, charter
// search) can be developed, demoed and tested without spending real API calls, and so the trial
// period is spent harvesting real data rather than debugging. Data is fictional but realistic:
// it deliberately includes airports and aircraft types outside the app's curated lists,
// legs without a price or a destination, helicopters, and operators that decline.

import type { Clock } from '../../domain/types.ts';
import { HOUR, MINUTE } from '../../domain/types.ts';
import { rng } from '../../dev/rng.ts';
import type { FetchLike } from './client.ts';

type J = Record<string, unknown>;

interface MAirport { id: number; name: string; icao: string; iata: string | null; lat: number; lon: number; city: string; country: string; iso2: string; iso3: string; tz: number }
interface MType { id: number; name: string; icao: string | null; classId: number; pax: number; speedKmh: number; rangeKm: number; hourlyEur: number }
interface MCompany { id: number; name: string; slug: string; email: string; phone: string; website: string; city: string; airport: string; responseRate: number; responseTime: number; declineRate: number }
interface MAircraft { id: number; reg: string; typeId: number; companyId: number; pax: number; year: number; base: string; wifi: boolean; lav: boolean }
interface MLeg { id: number; aircraftId: number; dep: string; arr: string | null; from: number; to: number; price: number | null; currency: string | null; comment: string | null; created: number; updated: number; active: boolean }
interface MQuoteRequest { id: number; created: number; state: number; comment: string | null; legs: J[]; aircraft: J[]; channels: string[]; messages: Array<{ id: number; companyId: number; created: number }>; postToTripBoard: boolean; sendToSelf: boolean }
interface MReply { id: number; created: number; requestId: number; messageId: number; companyId: number; aircraftId: number; price: number | null; currency: string; state: 'OK' | 'Not available'; comment: string; reaction: string }

const CLASSES: Array<[number, string]> = [
  [1, 'Turbo prop'], [2, 'Very light jet'], [3, 'Light jet'], [4, 'Midsize jet'], [5, 'Super midsize jet'],
  [6, 'Heavy jet'], [7, 'Ultra long range'], [8, 'VIP airliner'], [9, 'Helicopter'], [10, 'Piston'],
];

// [id, name, icao, classId, pax, cruise km/h, range km, hourly EUR]
const TYPES: Array<[number, string, string | null, number, number, number, number, number]> = [
  [101, 'Pilatus PC-12', 'PC12', 1, 8, 500, 2890, 2600], [102, 'King Air 350', 'B350', 1, 9, 560, 2800, 2900],
  [103, 'Citation Mustang', 'C510', 2, 4, 630, 2160, 2600], [104, 'HondaJet', 'HDJT', 2, 5, 780, 2650, 3000],
  [105, 'Citation CJ2', 'C25A', 3, 6, 740, 3000, 3600], [106, 'Phenom 300', 'E55P', 3, 7, 830, 3650, 4300],
  [107, 'Learjet 45', 'LJ45', 3, 8, 830, 3600, 4200], [108, 'Citation XLS', 'C56X', 4, 8, 790, 3900, 5200],
  [109, 'Citation Sovereign', 'C680', 4, 9, 800, 5200, 5600], [110, 'Hawker 800XP', 'H25B', 4, 8, 800, 4600, 5000],
  [111, 'Challenger 350', 'CL35', 5, 9, 850, 5900, 7400], [112, 'Legacy 600', 'E135', 6, 13, 830, 6000, 8200],
  [113, 'Falcon 7X', 'FA7X', 6, 14, 900, 11000, 10900], [114, 'Gulfstream G550', 'GLF5', 7, 16, 900, 12500, 12800],
  [115, 'Global 6000', 'GLEX', 7, 14, 900, 11100, 13200], [116, 'Lineage 1000', null, 8, 19, 830, 8500, 16500],
  [117, 'Bell 429', 'B429', 9, 7, 250, 700, 3200], [118, 'Challenger 605', 'CL60', 6, 12, 820, 7400, 8900],
];

// [id, name, icao, iata, lat, lon, city, country, iso2, iso3, utc offset]
const AIRPORTS: Array<[number, string, string, string | null, number, number, string, string, string, string, number]> = [
  [1, 'Teterboro', 'KTEB', 'TEB', 40.8501, -74.0608, 'New York', 'United States', 'US', 'USA', -4],
  [2, 'Morristown Municipal', 'KMMU', 'MMU', 40.7994, -74.4149, 'Morristown', 'United States', 'US', 'USA', -4],
  [3, 'Westchester County', 'KHPN', 'HPN', 41.067, -73.7076, 'White Plains', 'United States', 'US', 'USA', -4],
  [4, 'Palm Beach Intl', 'KPBI', 'PBI', 26.6832, -80.0956, 'West Palm Beach', 'United States', 'US', 'USA', -4],
  [5, 'Fort Lauderdale Executive', 'KFXE', 'FXE', 26.1973, -80.1707, 'Fort Lauderdale', 'United States', 'US', 'USA', -4],
  [6, 'Van Nuys', 'KVNY', 'VNY', 34.2098, -118.49, 'Los Angeles', 'United States', 'US', 'USA', -7],
  [7, 'Santa Barbara Municipal', 'KSBA', 'SBA', 34.4262, -119.8404, 'Santa Barbara', 'United States', 'US', 'USA', -7],
  [8, 'Napa County', 'KAPC', 'APC', 38.2132, -122.2807, 'Napa', 'United States', 'US', 'USA', -7],
  [9, 'Aspen/Pitkin County', 'KASE', 'ASE', 39.2232, -106.8688, 'Aspen', 'United States', 'US', 'USA', -6],
  [10, 'Scottsdale', 'KSDL', 'SCF', 33.6229, -111.9105, 'Scottsdale', 'United States', 'US', 'USA', -7],
  [11, 'Dallas Love Field', 'KDAL', 'DAL', 32.8471, -96.8518, 'Dallas', 'United States', 'US', 'USA', -5],
  [12, 'Nantucket Memorial', 'KACK', 'ACK', 41.2531, -70.0602, 'Nantucket', 'United States', 'US', 'USA', -4],
  [13, 'Vancouver Intl', 'CYVR', 'YVR', 49.1967, -123.1815, 'Vancouver', 'Canada', 'CA', 'CAN', -7],
  [14, 'Licenciado Gustavo Diaz Ordaz', 'MMPR', 'PVR', 20.6801, -105.2541, 'Puerto Vallarta', 'Mexico', 'MX', 'MEX', -6],
  [15, 'Queen Beatrix Intl', 'TNCA', 'AUA', 12.5014, -70.0152, 'Oranjestad', 'Aruba', 'AW', 'ABW', -4],
  [16, 'Gustaf III', 'TFFJ', 'SBH', 17.9044, -62.8436, 'St. Barthelemy', 'Saint Barthelemy', 'BL', 'BLM', -4],
  [17, 'Sangster Intl', 'MKJS', 'MBJ', 18.5037, -77.9134, 'Montego Bay', 'Jamaica', 'JM', 'JAM', -5],
  [18, 'Lynden Pindling Intl', 'MYNN', 'NAS', 25.039, -77.4662, 'Nassau', 'Bahamas', 'BS', 'BHS', -4],
  [19, 'London City', 'EGLC', 'LCY', 51.5053, 0.0553, 'London', 'United Kingdom', 'GB', 'GBR', 1],
  [20, 'Farnborough', 'EGLF', 'FAB', 51.2758, -0.7763, 'London', 'United Kingdom', 'GB', 'GBR', 1],
  [21, 'Paris Le Bourget', 'LFPB', 'LBG', 48.9694, 2.4414, 'Paris', 'France', 'FR', 'FRA', 2],
  [22, "Nice Cote d'Azur", 'LFMN', 'NCE', 43.6584, 7.2159, 'Nice', 'France', 'FR', 'FRA', 2],
  [23, 'Chambery Savoie', 'LFLB', 'CMF', 45.6381, 5.8803, 'Chambery', 'France', 'FR', 'FRA', 2],
  [24, 'Ajaccio Napoleon Bonaparte', 'LFKJ', 'AJA', 41.9236, 8.8029, 'Ajaccio', 'France', 'FR', 'FRA', 2],
  [25, 'Geneva', 'LSGG', 'GVA', 46.2381, 6.109, 'Geneva', 'Switzerland', 'CH', 'CHE', 2],
  [26, 'Engadin', 'LSZS', 'SMV', 46.5341, 9.8841, 'St. Moritz', 'Switzerland', 'CH', 'CHE', 2],
  [27, 'Venice Marco Polo', 'LIPZ', 'VCE', 45.5053, 12.3519, 'Venice', 'Italy', 'IT', 'ITA', 2],
  [28, 'Olbia Costa Smeralda', 'LIEO', 'OLB', 40.8987, 9.5176, 'Olbia', 'Italy', 'IT', 'ITA', 2],
  [29, 'Ibiza', 'LEIB', 'IBZ', 38.8729, 1.3731, 'Ibiza', 'Spain', 'ES', 'ESP', 2],
  [30, 'Malaga', 'LEMG', 'AGP', 36.6749, -4.4991, 'Malaga', 'Spain', 'ES', 'ESP', 2],
  [31, 'Berlin Brandenburg', 'EDDB', 'BER', 52.3667, 13.5033, 'Berlin', 'Germany', 'DE', 'DEU', 2],
  [32, 'Munich', 'EDDM', 'MUC', 48.3538, 11.7861, 'Munich', 'Germany', 'DE', 'DEU', 2],
  [33, 'Vienna Intl', 'LOWW', 'VIE', 48.1103, 16.5697, 'Vienna', 'Austria', 'AT', 'AUT', 2],
  [34, 'Dubrovnik', 'LDDU', 'DBV', 42.5614, 18.2682, 'Dubrovnik', 'Croatia', 'HR', 'HRV', 2],
  [35, 'Heraklion Intl', 'LGIR', 'HER', 35.3397, 25.1803, 'Heraklion', 'Greece', 'GR', 'GRC', 3],
  [36, 'Mykonos', 'LGMK', 'JMK', 37.4351, 25.3481, 'Mykonos', 'Greece', 'GR', 'GRC', 3],
  [37, 'Istanbul', 'LTFM', 'IST', 41.2753, 28.7519, 'Istanbul', 'Turkey', 'TR', 'TUR', 3],
  [38, 'Dubai Intl', 'OMDB', 'DXB', 25.2532, 55.3657, 'Dubai', 'United Arab Emirates', 'AE', 'ARE', 4],
  [39, 'Farnborough Heliport', 'EGXX', null, 51.28, -0.77, 'London', 'United Kingdom', 'GB', 'GBR', 1],
];

const REGIONS: Record<string, string[]> = {
  usEast: ['KTEB', 'KMMU', 'KHPN', 'KPBI', 'KFXE', 'KACK', 'MYNN', 'TFFJ', 'MKJS', 'TNCA', 'KDAL'],
  usWest: ['KVNY', 'KSBA', 'KAPC', 'KASE', 'KSDL', 'KDAL', 'CYVR', 'MMPR'],
  europe: ['EGLC', 'EGLF', 'LFPB', 'LFMN', 'LFLB', 'LFKJ', 'LSGG', 'LSZS', 'LIPZ', 'LIEO', 'LEIB', 'LEMG', 'EDDB', 'EDDM', 'LOWW', 'LDDU', 'LGIR', 'LGMK', 'LTFM', 'OMDB'],
};

const COMPANY_NAMES: Array<[string, string, keyof typeof REGIONS]> = [
  ['Atlantic Edge Aviation', 'KTEB', 'usEast'], ['Harbor Point Jets', 'KHPN', 'usEast'], ['Sunline Executive', 'KPBI', 'usEast'],
  ['Keystone Air Charter', 'KMMU', 'usEast'], ['Coral Wing', 'KFXE', 'usEast'], ['Bluewater Jet Group', 'KACK', 'usEast'],
  ['Pacific Crest Aviation', 'KVNY', 'usWest'], ['Redwood Air', 'KAPC', 'usWest'], ['Summit Peak Jets', 'KASE', 'usWest'],
  ['Desert Star Charter', 'KSDL', 'usWest'], ['Lonehorn Aviation', 'KDAL', 'usWest'], ['Cascadia Jets', 'CYVR', 'usWest'],
  ['Thames Executive Air', 'EGLC', 'europe'], ['Seine Aviation', 'LFPB', 'europe'], ['Azur Jet Services', 'LFMN', 'europe'],
  ['Leman Air', 'LSGG', 'europe'], ['Alpenluft Charter', 'EDDM', 'europe'], ['Laguna Jets', 'LIPZ', 'europe'],
  ['Balearic Air', 'LEIB', 'europe'], ['Aegean Executive', 'LGMK', 'europe'], ['Danube Business Aviation', 'LOWW', 'europe'],
  ['Bosphorus Wings', 'LTFM', 'europe'], ['Gulf Crown Aviation', 'OMDB', 'europe'], ['Brandenburg Jet', 'EDDB', 'europe'],
];

export interface MockOptions {
  clock: Clock;
  validKey?: string;
  baseUrl?: string;
  seed?: number;
  perPage?: number;
  /** Mock minutes before an operator replies to a quote request. */
  replyDelayMs?: number;
}

export class AviapagesMock {
  readonly validKey: string;
  readonly baseUrl: string;
  private clock: Clock;
  private perPage: number;
  private replyDelayMs: number;
  airports = new Map<string, MAirport>();
  types = new Map<number, MType>();
  companies = new Map<number, MCompany>();
  aircraft = new Map<number, MAircraft>();
  legs = new Map<number, MLeg>();
  quoteRequests = new Map<number, MQuoteRequest>();
  replies = new Map<number, MReply>();
  /** Per-company override of how the operator answers RFQs (tests use this). */
  replyPolicy = new Map<number, (req: MQuoteRequest) => { state: 'OK' | 'Not available'; price?: number; currency?: string } | null>();
  calls: Array<{ method: string; path: string; status: number }> = [];
  private failures: Array<{ status: number; body: J; times: number; path?: RegExp }> = [];
  private nextId = { leg: 50_000, qr: 9_000, qm: 70_000, reply: 30_000 };

  constructor(opts: MockOptions) {
    this.clock = opts.clock;
    this.validKey = opts.validKey ?? 'mock-key';
    this.baseUrl = opts.baseUrl ?? 'https://mock.aviapages.local';
    this.perPage = opts.perPage ?? 20;
    this.replyDelayMs = opts.replyDelayMs ?? 2 * MINUTE;
    this.buildWorld(opts.seed ?? 11);
  }

  // ---------- world ----------

  private buildWorld(seed: number): void {
    const r = rng(seed);
    for (const [id, name, icao, iata, lat, lon, city, country, iso2, iso3, tz] of AIRPORTS) {
      this.airports.set(icao, { id, name, icao, iata, lat, lon, city, country, iso2, iso3, tz });
    }
    for (const [id, name, icao, classId, pax, speedKmh, rangeKm, hourlyEur] of TYPES) this.types.set(id, { id, name, icao, classId, pax, speedKmh, rangeKm, hourlyEur });
    COMPANY_NAMES.forEach(([name, airport], i) => {
      const id = 200 + i;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      this.companies.set(id, {
        id, name, slug, email: `charter@${slug}.example`, phone: `+1 555 01${String(i).padStart(2, '0')}`,
        website: `https://${slug}.example`, city: this.airports.get(airport)!.city, airport,
        responseRate: Math.round((0.55 + r.next() * 0.43) * 100) / 100, responseTime: r.int(8, 240), declineRate: i % 6 === 5 ? 1 : 0.1,
      });
    });
    let acId = 1000;
    const regPrefix: Record<string, string> = { usEast: 'N', usWest: 'N', europe: '' };
    const euPrefixes = ['G-', 'F-', 'HB-', 'D-', 'I-', 'OE-', 'EC-', '9H-', 'SX-'];
    for (const [cIdx, [, airport, region]] of COMPANY_NAMES.entries()) {
      const companyId = 200 + cIdx;
      const n = r.int(1, 4);
      for (let k = 0; k < n; k++) {
        const typeId = cIdx === 3 && k === 0 ? 117 : cIdx === 22 && k === 0 ? 116 : r.pick(TYPES.filter((t) => t[3] <= 7 && t[0] !== 117))[0];
        const type = this.types.get(typeId)!;
        const reg = regPrefix[region] ? `N${r.int(100, 999)}${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}`
          : `${r.pick(euPrefixes)}${Array.from({ length: 4 }, () => String.fromCharCode(65 + r.int(0, 25))).join('')}`;
        this.aircraft.set(acId, { id: acId, reg, typeId, companyId, pax: type.pax - r.int(0, 1), year: r.int(2006, 2023), base: airport, wifi: r.chance(0.7), lav: type.classId >= 3 });
        acId++;
      }
    }
    const now = this.clock.now();
    const start = Math.ceil(now / (15 * MINUTE)) * 15 * MINUTE;
    for (const ac of this.aircraft.values()) {
      const region = COMPANY_NAMES[ac.companyId - 200][2];
      const pool = REGIONS[region];
      let t = start + r.int(6, 40) * HOUR;
      for (let i = 0; i < r.int(1, 4); i++) {
        const dep = i === 0 ? ac.base : r.pick(pool);
        let arr: string | null = r.pick(pool);
        if (arr === dep) arr = pool[(pool.indexOf(dep) + 1) % pool.length];
        if (r.chance(0.08)) arr = null; // open destination
        const type = this.types.get(ac.typeId)!;
        const hasPrice = r.chance(0.6);
        const currency = region === 'europe' ? r.pick(['EUR', 'EUR', 'GBP']) : 'USD';
        const km = arr ? kmBetween(this.airports.get(dep)!, this.airports.get(arr)!) : 800;
        const hours = Math.max(1, km / type.speedKmh + 0.3);
        const eur = type.hourlyEur * hours * (0.35 + r.next() * 0.25);
        const price = hasPrice ? Math.round((currency === 'USD' ? eur * 1.09 : currency === 'GBP' ? eur * 0.85 : eur) / 100) * 100 : null;
        const window = r.pick([0, 0, 2, 6, 24, 48]) * HOUR;
        const id = this.nextId.leg++;
        this.legs.set(id, {
          id, aircraftId: ac.id, dep, arr, from: t, to: t + window, price, currency: price ? currency : null,
          comment: r.chance(0.4) ? r.pick(['Flexible on timing', 'Positioning after charter', 'Catering on request', 'Pets welcome']) : null,
          created: now - r.int(1, 72) * HOUR, updated: now - r.int(0, 60) * MINUTE, active: true,
        });
        t += Math.max(hours * HOUR + 8 * HOUR, r.int(14, 80) * HOUR);
      }
    }
  }

  // ---------- control surface for tests and the dev simulator ----------

  failNext(status: number, times = 1, body: J = { detail: 'Mock failure' }, path?: RegExp): void {
    this.failures.push({ status, body, times, path });
  }

  addLeg(partial: Partial<MLeg> & Pick<MLeg, 'aircraftId' | 'dep' | 'from'>): MLeg {
    const now = this.clock.now();
    const leg: MLeg = { id: this.nextId.leg++, arr: null, to: partial.from, price: null, currency: null, comment: null, created: now, updated: now, active: true, ...partial };
    this.legs.set(leg.id, leg);
    return leg;
  }

  updateLeg(id: number, patch: Partial<MLeg>): void {
    const leg = this.legs.get(id);
    if (leg) Object.assign(leg, patch, { updated: this.clock.now() });
  }

  removeLeg(id: number): void {
    this.updateLeg(id, { active: false });
  }

  activeLegs(): MLeg[] {
    const now = this.clock.now();
    return [...this.legs.values()].filter((l) => l.active && l.to >= now);
  }

  // ---------- transport ----------

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const prefix = new URL(this.baseUrl).pathname.replace(/\/$/, '');
    const path = prefix && u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
    const { status, body } = this.handle(init.method, path, u.searchParams, init.body ? JSON.parse(init.body) : undefined, init.headers.authorization ?? init.headers.Authorization);
    this.calls.push({ method: init.method, path, status });
    const text = body === undefined ? '' : JSON.stringify(body);
    return { status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' && status === 429 ? '1' : null) }, text: async () => text };
  };

  handle(method: string, path: string, q: URLSearchParams, body: J | undefined, auth: string | undefined): { status: number; body?: unknown } {
    const failure = this.failures.find((f) => !f.path || f.path.test(path));
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return { status: failure.status, body: failure.body };
    }
    if (auth !== `Token ${this.validKey}`) return { status: 401, body: { detail: 'Invalid token.' } };
    const m = (re: RegExp) => re.exec(path);
    let x: RegExpExecArray | null;
    if (method === 'GET' && path === '/v3/empty_legs/') return this.listEmptyLegs(q);
    if (method === 'GET' && (x = m(/^\/v3\/empty_legs\/(\d+)\/$/))) {
      const leg = this.legs.get(Number(x[1]));
      return leg ? { status: 200, body: this.emptyLegJson(leg) } : { status: 404, body: { detail: 'Not found.' } };
    }
    if (method === 'POST' && path === '/v3/charter_quote_requests/') return this.createQuoteRequest(body ?? {});
    if (method === 'GET' && path === '/v3/charter_quote_requests/') return this.page(q, [...this.quoteRequests.values()].map((r) => this.quoteRequestJson(r)).reverse(), path);
    if ((x = m(/^\/v3\/charter_quote_requests\/(\d+)\/$/))) {
      const qr = this.quoteRequests.get(Number(x[1]));
      if (!qr) return { status: 404, body: { detail: 'Not found.' } };
      if (method === 'PATCH') {
        if (body?.comment !== undefined) qr.comment = body.comment as string;
        if (Array.isArray(body?.channels)) qr.channels = body.channels as string[];
        if (body?.post_to_trip_board !== undefined) qr.postToTripBoard = !!body.post_to_trip_board;
      }
      return { status: 200, body: this.quoteRequestJson(qr) };
    }
    if (method === 'POST' && (x = m(/^\/v3\/charter_quote_requests\/(\d+)\/archive\/$/))) {
      const qr = this.quoteRequests.get(Number(x[1]));
      if (!qr) return { status: 404 };
      qr.state = 1;
      return { status: 200 };
    }
    if (method === 'GET' && path === '/v3/charter_quote_replies/') return this.listReplies(q);
    if ((x = m(/^\/v3\/charter_quote_replies\/(\d+)\/$/))) {
      this.materializeReplies();
      const rep = this.replies.get(Number(x[1]));
      if (!rep) return { status: 404, body: { detail: 'Not found.' } };
      if (method === 'PATCH' && typeof body?.reaction === 'string') rep.reaction = body.reaction;
      return { status: 200, body: this.replyJson(rep) };
    }
    if (method === 'GET' && path === '/v3/operator_quote_messages/') return this.page(q, [], path);
    if (method === 'POST' && path === '/v3/flight_calculator/') return this.flightCalculator(body ?? {});
    if (method === 'POST' && path === '/v3/price_calculator/') return this.priceCalculator(body ?? {});
    if (method === 'POST' && path === '/v3/charter_prices/') return this.charterPrices(body ?? {});
    if (method === 'POST' && path === '/v3/charter_search_aircraft/') return this.searchAircraft(body ?? {});
    if (method === 'POST' && path === '/v3/charter_searches/') return this.searchCompanies(body ?? {});
    if (method === 'GET' && path === '/v3/charter_companies/') return this.page(q, [...this.companies.values()].filter((c) => !q.get('search') || c.name.toLowerCase().includes(q.get('search')!.toLowerCase())).map((c) => this.companyJson(c)), path);
    if (method === 'GET' && (x = m(/^\/v3\/charter_companies\/(\d+)\/$/))) {
      const c = this.companies.get(Number(x[1]));
      return c ? { status: 200, body: this.companyJson(c) } : { status: 404, body: { detail: 'Not found.' } };
    }
    if (method === 'GET' && path === '/v3/charter_aircraft/') return this.page(q, [...this.aircraft.values()].map((a) => this.charterAircraftJson(a)), path);
    if (method === 'GET' && path === '/v3/airports/') {
      const s = (q.get('search') ?? q.get('search_icao') ?? '').toLowerCase();
      return this.page(q, [...this.airports.values()].filter((a) => !s || a.icao.toLowerCase() === s || (a.iata ?? '').toLowerCase() === s || a.name.toLowerCase().includes(s) || a.city.toLowerCase().includes(s)).map((a) => this.airportJson(a)), path);
    }
    if (method === 'GET' && path === '/v3/aircraft_types/') return this.page(q, [...this.types.values()].map((t) => this.aircraftTypeJson(t)), path);
    if (method === 'GET' && path === '/v3/aircraft_classes/') return this.page(q, CLASSES.map(([id, name]) => ({ aircraft_class_id: id, name, priority: id })), path);
    if (method === 'GET' && path === '/v3/tokens/') return { status: 200, body: [{ token: 'hidden', name: 'default', created_at: '2026-10-01T00:00:00Z', is_active: true }] };
    return { status: 404, body: { detail: 'Not found.' } };
  }

  // ---------- endpoint implementations ----------

  private page(q: URLSearchParams, items: unknown[], path: string) {
    const page = Math.max(1, Number(q.get('page') ?? 1));
    const slice = items.slice((page - 1) * this.perPage, page * this.perPage);
    const next = page * this.perPage < items.length ? (() => {
      const nq = new URLSearchParams(q);
      nq.set('page', String(page + 1));
      return `${this.baseUrl}${path}?${nq}`;
    })() : null;
    const prev = page > 1 ? `${this.baseUrl}${path}?page=${page - 1}` : null;
    return { status: 200, body: { count: items.length, next, previous: prev, results: slice, per_page: this.perPage } };
  }

  private listEmptyLegs(q: URLSearchParams) {
    const list = (k: string) => (q.get(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const t = (k: string) => (q.get(k) ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(q.get(k)!) ? q.get(k)! : q.get(k)! + 'Z') : null);
    const updatedGt = t('updated_at_gt');
    const fromUtc = t('from_date_utc');
    const toUtc = t('to_date_utc');
    const dep = list('dep_airport_code_in');
    const arr = list('arr_airport_code_in');
    const reg = (q.get('reg') ?? '').replace(/-/g, '').toUpperCase();
    const legs = this.activeLegs().filter((l) => {
      if (updatedGt !== null && l.updated <= updatedGt) return false;
      if (fromUtc !== null && l.to < fromUtc) return false;
      if (toUtc !== null && l.from > toUtc) return false;
      if (q.get('has_arrival_airport') === 'true' && !l.arr) return false;
      if (q.get('has_price') === 'true' && l.price === null) return false;
      const a = this.airports.get(l.dep)!;
      if (dep.length && !dep.includes(a.icao) && !dep.includes(a.iata ?? '')) return false;
      if (arr.length && (!l.arr || (!arr.includes(l.arr) && !arr.includes(this.airports.get(l.arr)!.iata ?? '')))) return false;
      if (reg && this.aircraft.get(l.aircraftId)!.reg.replace(/-/g, '').toUpperCase() !== reg) return false;
      return true;
    }).sort((a, b) => a.id - b.id);
    return this.page(q, legs.map((l) => this.emptyLegJson(l)), '/v3/empty_legs/');
  }

  private createQuoteRequest(b: J) {
    const errors: J = {};
    for (const f of ['legs', 'quote_messages', 'aircraft', 'channels']) if (!Array.isArray(b[f])) errors[f] = ['This field is required.'];
    if (Object.keys(errors).length) return { status: 400, body: errors };
    const legs = (b.legs as J[]).map((l) => ({ ...l, departure_airport: this.airportRef(l.departure_airport as J), arrival_airport: this.airportRef(l.arrival_airport as J) }));
    if (legs.some((l) => !l.departure_airport || !l.arrival_airport)) return { status: 400, body: { legs: ['Airport not found.'] } };
    const now = this.clock.now();
    const messages: MQuoteRequest['messages'] = [];
    for (const m of b.quote_messages as J[]) {
      const cid = Number((m.company as J)?.id);
      if (!this.companies.has(cid)) return { status: 400, body: { quote_messages: [`Company ${cid} not found.`] } };
      messages.push({ id: this.nextId.qm++, companyId: cid, created: now });
    }
    const qr: MQuoteRequest = {
      id: this.nextId.qr++, created: now, state: 0, comment: (b.comment as string) ?? null, legs,
      aircraft: (b.aircraft as J[]).map((a) => ({ id: a.id ?? null, tail_number: a.tail_number ?? null, ac_type: a.ac_type ?? null, ac_class: a.ac_class ?? null })),
      channels: b.channels as string[], messages, postToTripBoard: !!b.post_to_trip_board, sendToSelf: !!b.send_to_self,
    };
    this.quoteRequests.set(qr.id, qr);
    return { status: 200, body: this.quoteRequestJson(qr) };
  }

  /** Operators "answer" once replyDelayMs has passed (mock time), per policy. */
  private materializeReplies(): void {
    const now = this.clock.now();
    for (const qr of this.quoteRequests.values()) {
      for (const msg of qr.messages) {
        if (now - msg.created < this.replyDelayMs) continue;
        if ([...this.replies.values()].some((rp) => rp.messageId === msg.id)) continue;
        const company = this.companies.get(msg.companyId)!;
        const policy = this.replyPolicy.get(company.id);
        let decision = policy ? policy(qr) : null;
        if (!decision) {
          const tails = qr.aircraft.map((a) => String(a.tail_number ?? '').replace(/-/g, '').toUpperCase());
          const ac = [...this.aircraft.values()].find((a) => a.companyId === company.id && tails.includes(a.reg.replace(/-/g, '').toUpperCase()))
            ?? [...this.aircraft.values()].find((a) => a.companyId === company.id)!;
          const leg = [...this.legs.values()].find((l) => l.aircraftId === ac.id && l.active && l.price !== null);
          const declines = company.declineRate >= 1;
          decision = declines ? { state: 'Not available' } : { state: 'OK', price: leg?.price ?? this.estimatePriceEur(ac, qr), currency: leg?.currency ?? 'EUR' };
        }
        const companyAircraft = [...this.aircraft.values()].filter((a) => a.companyId === company.id);
        const tails = qr.aircraft.map((a) => String(a.tail_number ?? '').replace(/-/g, '').toUpperCase());
        const ac = companyAircraft.find((a) => tails.includes(a.reg.replace(/-/g, '').toUpperCase())) ?? companyAircraft[0];
        const id = this.nextId.reply++;
        this.replies.set(id, {
          id, created: msg.created + this.replyDelayMs, requestId: qr.id, messageId: msg.id, companyId: company.id, aircraftId: ac.id,
          price: decision.state === 'OK' ? decision.price ?? null : null, currency: decision.currency ?? 'EUR', state: decision.state,
          comment: decision.state === 'OK' ? 'Available as requested. Price includes crew and fees.' : 'Unfortunately the aircraft is no longer available.',
          reaction: 'New',
        });
      }
    }
  }

  private estimatePriceEur(ac: MAircraft, qr: MQuoteRequest): number {
    const type = this.types.get(ac.typeId)!;
    const l = qr.legs[0] as { departure_airport: J; arrival_airport: J };
    const a = this.airports.get(String(l.departure_airport.icao));
    const b = this.airports.get(String(l.arrival_airport.icao));
    const km = a && b ? kmBetween(a, b) : 1000;
    return Math.round((type.hourlyEur * Math.max(1, km / type.speedKmh + 0.3)) / 100) * 100;
  }

  private listReplies(q: URLSearchParams) {
    this.materializeReplies();
    const reqId = q.get('quote_request_id');
    const reqIn = (q.get('quote_request_id_in') ?? '').split(',').filter(Boolean).map(Number);
    const fromCreated = q.get('from_created_date_utc') ? Date.parse(q.get('from_created_date_utc')! + (q.get('from_created_date_utc')!.length === 16 ? ':00Z' : '')) : null;
    const items = [...this.replies.values()].filter((r) =>
      (!reqId || r.requestId === Number(reqId)) && (!reqIn.length || reqIn.includes(r.requestId)) && (fromCreated === null || r.created >= fromCreated));
    return this.page(q, items.map((r) => this.replyJson(r)), '/v3/charter_quote_replies/');
  }

  private flightCalculator(b: J) {
    const dep = this.findAirport(String(b.departure_airport ?? ''));
    const arr = this.findAirport(String(b.arrival_airport ?? ''));
    if (!dep || !arr) return { status: 400, body: { [dep ? 'arrival_airport' : 'departure_airport']: ['Airport not found.'] } };
    const type = this.findType(String(b.aircraft ?? '')) ?? this.types.get(108)!;
    const km = kmBetween(dep, arr);
    const minutes = Math.round((km / type.speedKmh) * 60 + 12);
    const wind = Math.round(minutes * (arr.lon > dep.lon ? 0.96 : 1.06));
    const fuel = Math.round(minutes * type.pax * 9);
    const stamp = (min: number) => new Date(this.clock.now() + min * MINUTE).toISOString().slice(0, 16);
    return {
      status: 200,
      body: {
        aircraft: type.name,
        airport: { departure: dep.icao, arrival: arr.icao, techstops: km > type.rangeKm ? ['LPLA'] : [] },
        distance: { great_circle: Math.round(km), airway: Math.round(km * 1.06) },
        time: {
          departure_local: stamp(0), airway: Math.round(minutes * 1.04), arrival_local_airway: stamp(minutes),
          airway_weather_impacted: wind, arrival_local_airway_weather_impacted: stamp(wind), great_circle: minutes,
          arrival_local_great_circle: stamp(minutes), average_speed: minutes, arrival_local_average_speed: stamp(minutes),
        },
        fuel: {
          airway: fuel, airway_weather_impacted: fuel, great_circle: fuel, great_circle_detailed: [], airway_detailed: [],
          airway_weather_impacted_detailed: [], airway_block: Math.round(fuel * 1.3), airway_weather_impacted_block: Math.round(fuel * 1.3), great_circle_block: Math.round(fuel * 1.3),
        },
        great_circle_carbon_emissions: fuel * 3, airway_carbon_emissions: fuel * 3, airway_carbon_emissions_weather_impacted: fuel * 3,
        errors: [], warnings: [],
      },
    };
  }

  private priceCalculator(b: J) {
    const ac = [...this.aircraft.values()].find((a) => a.reg.replace(/-/g, '') === String(b.aircraft ?? '').replace(/-/g, '').toUpperCase());
    if (!ac) return { status: 400, body: { aircraft: ['Aircraft not found.'] } };
    const f = (b.flights as J[] | undefined)?.[0];
    const dep = this.findAirport(String(f?.departure_airport ?? ''));
    const arr = this.findAirport(String(f?.arrival_airport ?? ''));
    if (!dep || !arr) return { status: 400, body: { flights: ['Airport not found.'] } };
    const type = this.types.get(ac.typeId)!;
    const hours = Math.max(1, kmBetween(dep, arr) / type.speedKmh + 0.3);
    const flight = Math.round(type.hourlyEur * hours);
    return { status: 200, body: { price: flight + 1200, operations: [{ name: 'Flight time', amount: flight }, { name: 'Airport fees', amount: 800 }, { name: 'Handling', amount: 400 }] } };
  }

  private charterPrices(b: J) {
    const leg = (b.legs as J[] | undefined)?.[0];
    const dep = leg && this.findAirport(String((leg.departure_airport as J)?.icao ?? (leg.departure_airport as J)?.iata ?? ''));
    const arr = leg && this.findAirport(String((leg.arrival_airport as J)?.icao ?? (leg.arrival_airport as J)?.iata ?? ''));
    if (!dep || !arr) return { status: 400, body: { legs: ['Airport not found.'] } };
    const want = (b.aircraft as J[] | undefined)?.[0] ?? {};
    const type = this.findType(String(want.ac_type ?? '')) ?? [...this.types.values()].find((t) => CLASSES.find(([id]) => id === t.classId)?.[1].toLowerCase() === String(want.ac_class ?? '').toLowerCase()) ?? this.types.get(108)!;
    const hours = Math.max(1, kmBetween(dep, arr) / type.speedKmh + 0.3);
    const eur = type.hourlyEur * hours;
    const ccy = String(b.currency_code ?? 'EUR');
    const p = Math.round(ccy === 'USD' ? eur * 1.09 : eur);
    return { status: 200, body: { price: p, currency_code: ccy, price_min: b.range ? Math.round(p * 0.85) : null, price_max: b.range ? Math.round(p * 1.2) : null } };
  }

  private searchAircraft(b: J) {
    const leg = (b.legs as J[] | undefined)?.[0];
    const dep = leg && this.findAirport(String((leg.departure_airport as J)?.icao ?? ''));
    if (!dep) return { status: 400, body: { legs: ['Departure airport is required.'] } };
    const pax = Number(leg!.pax ?? 1);
    const results = [...this.aircraft.values()]
      .filter((a) => a.pax >= pax && this.types.get(a.typeId)!.classId <= 8)
      .map((a) => ({ a, d: kmBetween(dep, this.airports.get(a.base)!) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 10)
      .map(({ a }) => {
        const c = this.companies.get(a.companyId)!;
        return {
          id: a.id, slug: `${a.reg.toLowerCase()}-${a.id}`, images: [{ url: `${this.baseUrl}/media/aircraft/${a.id}/exterior.jpg`, image_type: 'exterior' }, { url: `${this.baseUrl}/media/aircraft/${a.id}/cabin.jpg`, image_type: 'cabin' }],
          company: { id: c.id, name: c.name, slug: c.slug, logo_path: null }, aircraft_type: this.types.get(a.typeId)!.name,
          passengers_max: a.pax, year_of_production: a.year, registration_number: a.reg,
        };
      });
    return { status: 200, body: { aircraft: results } };
  }

  private searchCompanies(b: J) {
    const r = this.searchAircraft(b);
    if (r.status !== 200) return r;
    const byCompany = new Map<number, J>();
    for (const a of (r.body as { aircraft: J[] }).aircraft) {
      const c = this.companies.get((a.company as J).id as number)!;
      const ac = this.aircraft.get(a.id as number)!;
      const entry = byCompany.get(c.id) ?? { id: c.id, name: c.name, slug: c.slug, city: { id: c.id, name: c.city }, country: { id: 1, name: this.airports.get(c.airport)!.country }, aircraft: [] as J[] };
      (entry.aircraft as J[]).push({ id: ac.id, ac_type: a.aircraft_type, year_of_production: ac.year, tail_number: ac.reg, location: ac.base, images: a.images, max_passengers: ac.pax });
      byCompany.set(c.id, entry);
    }
    return { status: 200, body: { companies: [...byCompany.values()] } };
  }

  // ---------- JSON renderers (shapes per openapi.json) ----------

  private findAirport(code: string): MAirport | undefined {
    const c = code.trim().toUpperCase();
    return this.airports.get(c) ?? [...this.airports.values()].find((a) => a.iata === c);
  }

  private findType(name: string): MType | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    return [...this.types.values()].find((t) => t.name.toLowerCase() === n || (t.icao ?? '').toLowerCase() === n);
  }

  private airportRef(ref: J | undefined): J | null {
    if (!ref) return null;
    const a = this.findAirport(String(ref.icao ?? ref.iata ?? ref.lid ?? ''));
    if (!a) return null;
    return { id: a.id, icao: a.icao, iata: a.iata, lid: null, name: a.name, slug: a.icao.toLowerCase(), city: { id: a.id, name: a.city } };
  }

  private emptyLegAirportJson(a: MAirport): J {
    return {
      id: a.id, name: a.name, iata: a.iata, icao: a.icao, lid: null, slug: a.icao.toLowerCase(), latitude: a.lat, longitude: a.lon,
      city: { id: a.id, name: a.city, latitude: a.lat, longitude: a.lon, country: { id: a.id, name: a.country, iso_alpha2: a.iso2, iso_alpha3: a.iso3 } },
    };
  }

  private extensionJson(ac: MAircraft): J {
    const t = this.types.get(ac.typeId)!;
    return {
      id: ac.id, refurbishment: ac.year + 5 <= 2025 ? ac.year + 5 : null, cabin_crew: t.classId >= 5, divan_seats: t.classId >= 4 ? 1 : 0, lavatory: ac.lav, beds: 0,
      hot_meal: t.classId >= 5, wireless_internet: ac.wifi, entertainment_system: t.classId >= 4, medical_ramp: false, smoking: false,
      description: null, owners_approval_required: false, pets_allowed: true, domestic_flights_only: false, cabin_height: '1.80', cabin_length: '6.50',
      cabin_width: '1.80', adult_critical_care: false, pediatric_critical_care: false, shower: false, luggage_volume: '2.10', satellite_phone: false,
      sleeping_places: t.classId >= 6 ? 4 : 0,
    };
  }

  private image(ac: MAircraft, kind: string, position: number): J {
    return { position, media: { id: ac.id * 10 + position, path: `${this.baseUrl}/media/aircraft/${ac.id}/${kind}.jpg` }, tag: { value: kind, description: kind } };
  }

  emptyLegJson(l: MLeg): J {
    const ac = this.aircraft.get(l.aircraftId)!;
    const type = this.types.get(ac.typeId)!;
    const c = this.companies.get(ac.companyId)!;
    const cls = CLASSES.find(([id]) => id === type.classId)!;
    const eur = l.price === null ? null : l.currency === 'USD' ? Math.round(l.price / 1.09) : l.currency === 'GBP' ? Math.round(l.price / 0.85) : l.price;
    const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
    return {
      id: l.id, registration_number: ac.reg, aircraft_type: type.name, company: c.name,
      from_date_utc: iso(l.from), to_date_utc: iso(l.to), comment: l.comment, price: l.price, currency_code: l.currency,
      dep_airport: this.emptyLegAirportJson(this.airports.get(l.dep)!), arr_airport: l.arr ? this.emptyLegAirportJson(this.airports.get(l.arr)!) : null,
      created_at: iso(l.created), updated_at: iso(l.updated),
      aircraft: {
        id: ac.id, passengers_max: ac.pax, registration_number: ac.reg, year_of_production: ac.year, slug: `${ac.reg.toLowerCase()}-${ac.id}`, serial_number: `SN${ac.id}`,
        company: { id: c.id, name: c.name, phone: c.phone, fax: null, website: c.website, address: `${c.city} airport`, slug: c.slug, contact_email: c.email },
        aircraft_extension: this.extensionJson(ac), images: [this.image(ac, 'exterior', 0), this.image(ac, 'cabin', 1)],
      },
      aircraft_type_details: { id: type.id, name: type.name, icao: type.icao, aircraft_class: { id: cls[0], name: cls[1] }, images: [] },
      converted_prices: { eur, usd: eur === null ? null : Math.round(eur * 1.09) },
    };
  }

  private companyExt(c: MCompany): J {
    return { avg_response_rate: c.responseRate, avg_response_time: c.responseTime, aviapages_validation: c.responseRate > 0.7 };
  }

  private quoteRequestJson(qr: MQuoteRequest): J {
    const age = this.clock.now() - qr.created;
    const state = age < MINUTE ? 'Sent' : age < 5 * MINUTE ? 'Delivered' : 'Open';
    return {
      id: qr.id, created_at: new Date(qr.created).toISOString().slice(0, 16), state: qr.state, comment: qr.comment, legs: qr.legs,
      quote_messages: qr.messages.map((m) => {
        const c = this.companies.get(m.companyId)!;
        return { id: m.id, state, channels: 'Email', company: { id: c.id, name: c.name, slug: c.slug, company_extension: this.companyExt(c) } };
      }),
      quote_extension: null, aircraft: qr.aircraft, post_to_trip_board: qr.postToTripBoard, channels: qr.channels, send_to_self: qr.sendToSelf,
    };
  }

  private replyJson(r: MReply): J {
    const c = this.companies.get(r.companyId)!;
    const ac = this.aircraft.get(r.aircraftId)!;
    const t = this.types.get(ac.typeId)!;
    const ext = this.extensionJson(ac);
    return {
      id: r.id, created_at: new Date(r.created).toISOString().replace('.000Z', 'Z'), price: r.price, state: r.state, comment: r.comment,
      manager_name: `${c.name} Sales`, reaction: r.reaction, external_reply_id: null, quote_request_id: r.requestId, quote_message_id: r.messageId,
      currency_code: r.price === null ? null : r.currency,
      aircraft: {
        tail_number: ac.reg, max_passengers: ac.pax, home_base: ac.base, images: [{ position: 0, url: `${this.baseUrl}/media/aircraft/${ac.id}/exterior.jpg`, image_type: 'exterior' }],
        aircraft_type: t.name, aircraft_class: CLASSES.find(([id]) => id === t.classId)![1], manufacturer_name: t.name.split(' ')[0], refurbishment_year: ext.refurbishment,
        id: ac.id, serial_number: `SN${ac.id}`, year_of_production: ac.year, is_for_charter: true, is_for_sale: false, slug: `${ac.reg.toLowerCase()}-${ac.id}`,
        cabin_crew: ext.cabin_crew, lavatory: ext.lavatory, hot_meal: ext.hot_meal, wireless_internet: ext.wireless_internet, entertainment_system: ext.entertainment_system,
        medical_ramp: false, adult_critical_care: false, pediatric_critical_care: false, smoking: false, pets_allowed: true, shower: false, satellite_phone: false,
        owners_approval_required: false, divan_seats: ext.divan_seats, beds: 0, sleeping_places: ext.sleeping_places, cabin_height: 1.8, cabin_length: 6.5, cabin_width: 1.8, luggage_volume: 2.1,
      },
      company: { id: c.id, name: c.name, slug: c.slug, company_extension: this.companyExt(c) },
      manager_account: { id: c.id * 10, given_name: 'Alex', family_name: 'Morgan', email: c.email, phone: c.phone },
    };
  }

  private companyJson(c: MCompany): J {
    const a = this.airports.get(c.airport)!;
    return {
      id: c.id, name: c.name, phone: c.phone, fax: null, website: c.website, address: `${c.city} airport`,
      city: { id: a.id, name: a.city, country: { id: a.id, name: a.country, iso_alpha3: a.iso3, iso_alpha2: a.iso2 } }, contact_email: c.email,
      company_extension: {
        id: c.id, description: `${c.name} operates business jets from ${c.city}.`, established_at: 2005, facebook: null, twitter: null, linkedin: null,
        whatsapp: null, telegram: null, instagram: null, avg_response_rate: c.responseRate, avg_response_time: c.responseTime, is_pro: c.responseRate > 0.8, logo_media: null,
      },
      is_operator: true, is_broker: false, is_fbo: false, is_mro: false, is_catering: false, is_handling: false, is_fuel_supply: false,
      is_aircraft_dealer: false, is_manufacturer: false, is_flight_support: false, slug: c.slug,
    };
  }

  private charterAircraftJson(ac: MAircraft): J {
    const t = this.types.get(ac.typeId)!;
    const c = this.companies.get(ac.companyId)!;
    const base = this.airports.get(ac.base)!;
    const cls = CLASSES.find(([id]) => id === t.classId)!;
    const company = this.companyJson(c);
    return {
      id: ac.id, passengers_max: ac.pax, registration_number: ac.reg, year_of_production: ac.year, slug: `${ac.reg.toLowerCase()}-${ac.id}`, serial_number: `SN${ac.id}`,
      is_for_charter: true, is_for_sale: false, comment: null, tech_operator: null, is_ambulance: false, is_cargo: false,
      aircraft_type: { id: t.id, name: t.name, icao: t.icao, aircraft_class: { id: cls[0], name: cls[1] } },
      company: { ...company, company_extension: undefined },
      base_airport: { id: base.id, name: base.name, latitude: base.lat, longitude: base.lon, iata: base.iata, icao: base.icao, lid: null, city: { id: base.id, name: base.city }, country: { id: base.id, name: base.country, iso_alpha3: base.iso3, iso_alpha2: base.iso2 } },
      aircraft_extension: { ...this.extensionJson(ac), view_360: null, selling_price: null, selling_comment: null, selling_currency: null },
      images: [this.image(ac, 'exterior', 0), this.image(ac, 'cabin', 1)], attachments: [],
    };
  }

  private airportJson(a: MAirport): J {
    return {
      id: a.id, pcn: null, name: a.name, time_zone: null, lid: null, email: null, latitude: a.lat, longitude: a.lon, tower_hours: null, phone: null, fax: null,
      website: null, icao: a.icao, iata: a.iata, slug: a.icao.toLowerCase(), country: { id: a.id, name: a.country, iso_alpha2: a.iso2, iso_alpha3: a.iso3 },
      airport_id: a.id, city_name: a.city, sunset: null, time_shift: `${a.tz >= 0 ? '+' : '-'}${String(Math.abs(a.tz)).padStart(2, '0')}:00`,
      city: { id: a.id, name: a.city }, sunrise: null, country_name: a.country, runways: [],
    };
  }

  private aircraftTypeJson(t: MType): J {
    const cls = CLASSES.find(([id]) => id === t.classId)!;
    return {
      id: t.id, aircraft_type_id: t.id, name: t.name, icao: t.icao, class_name: cls[1], manufacturer_name: t.name.split(' ')[0],
      aircraft_class: { id: cls[0], name: cls[1] }, range_maximum: t.rangeKm, altitude: 13000, pax_maximum: t.pax, cabin_height: 1.8, cabin_length: 6,
      cabin_width: 1.8, slug: t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), luggage_volume: 2, aircraft_type_global_family: null, images: [], attachments: [],
      aircraft_type_extension: { description: '', range_ferry: null, range_typical_payload: t.rangeKm, range_max_payload: null }, engine_type: null, engine_count: 2, speed_typical: t.speedKmh,
    };
  }
}

export function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
