// Composition root: wires repositories and services together. Used by the server, the seed
// script and the tests (which inject a controllable clock and an in-memory database).

import { Database } from './db/database.ts';
import { CalcCache, FleetRepo, KvRepo, LegRepo, MarketRepo, ReferenceRepo } from './db/repos.ts';
import { registerAirport } from './reference/airports.ts';
import { registerAircraftType } from './reference/aircraft-types.ts';
import { PricingEngine } from './pricing/engine.ts';
import { DEFAULT_PRICING, type PricingConfig } from './pricing/config.ts';
import { SearchIndex } from './inventory/search.ts';
import { BookingService, DEFAULT_BOOKING, type BookingConfig } from './booking/booking-service.ts';
import { MockPaymentProvider, type PaymentProvider } from './booking/payments.ts';
import { Outbox } from './alerts/outbox.ts';
import { AlertService } from './alerts/alerts.ts';
import { IngestService } from './ingestion/ingest-service.ts';
import { systemClock, type Clock } from './domain/types.ts';
import { AviapagesClient, DEFAULT_CONFIG, type AviapagesConfig, type FetchLike } from './integrations/aviapages/client.ts';
import { AviapagesMock } from './integrations/aviapages/mock.ts';
import { EmptyLegSync, type SyncConfig } from './integrations/aviapages/sync.ts';
import { CommsService, type CommsConfig } from './comms/comms.ts';
import { Calculators } from './integrations/aviapages/calculators.ts';
import { CharterRequestService } from './charter/charter-requests.ts';
import { OnboardingService } from './onboarding/onboarding.ts';

export interface AviapagesOptions {
  /** 'live' calls the real API with apiKey; 'mock' uses the in-process mock; 'off' disables the integration. */
  mode: 'live' | 'mock' | 'off';
  apiKey?: string;
  baseUrl?: string;
  budgets?: AviapagesConfig['budgets'];
  defaultBudget?: number;
  sync?: Partial<SyncConfig>;
  /** Use an existing mock (tests); otherwise one is created in mock mode. */
  mock?: AviapagesMock;
  fetch?: FetchLike;
}

export interface AppOptions {
  aviapages?: AviapagesOptions;
  comms?: Partial<CommsConfig>;
  dbPath?: string;
  clock?: Clock;
  payments?: PaymentProvider;
  pricing?: Partial<PricingConfig>;
  booking?: Partial<BookingConfig>;
  /** Where operator applications are sent. */
  opsEmail?: string;
}

export function createApp(opts: AppOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const db = new Database(opts.dbPath ?? ':memory:');
  const fleet = new FleetRepo(db);
  const legs = new LegRepo(db);
  const market = new MarketRepo(db);
  const reference = new ReferenceRepo(db);
  const kv = new KvRepo(db);
  const calcCache = new CalcCache(db);
  // Airports and aircraft types learned from feeds in earlier runs.
  for (const a of reference.airports()) registerAirport(a);
  for (const t of reference.aircraftTypes()) registerAircraftType(t);
  const pricingConfig = { ...DEFAULT_PRICING, ...opts.pricing };
  const pricing = new PricingEngine(market, pricingConfig);
  const search = new SearchIndex(legs, fleet, pricing);
  const outbox = new Outbox(db);
  const payments = opts.payments ?? new MockPaymentProvider();
  const bookings = new BookingService({
    db, legs, fleet, pricing, payments, outbox, clock,
    config: { ...DEFAULT_BOOKING, ...opts.booking },
    onInventoryChange: () => search.invalidate(),
  });
  const alerts = new AlertService({ db, search, outbox, clock });
  const ingest = new IngestService({ db, fleet, legs, search, bookings, alerts, clock, minConfidence: pricingConfig.minConfidence });
  const aviapages = createAviapages(opts.aviapages, { db, clock, fleet, reference, legs, kv, ingest });
  const calculators = new Calculators({ cache: calcCache, client: aviapages?.client ?? null, clock });
  pricing.insights = calculators;
  const comms = new CommsService({ db, fleet, legs, market, bookings, outbox, kv, clock, client: aviapages?.client ?? null, config: opts.comms });
  const charters = new CharterRequestService({ db, fleet, legs, reference, outbox, pricing, comms, calculators, client: aviapages?.client ?? null, clock });
  const onboarding = new OnboardingService({ db, fleet, reference, outbox, clock, opsEmail: opts.opsEmail });
  return { db, clock, fleet, legs, market, reference, kv, calcCache, aviapages, comms, calculators, charters, onboarding, pricing, search, outbox, payments, bookings, alerts, ingest };
}

export type App = ReturnType<typeof createApp>;

function createAviapages(
  opts: AviapagesOptions | undefined,
  deps: { db: Database; clock: Clock; fleet: FleetRepo; reference: ReferenceRepo; legs: LegRepo; kv: KvRepo; ingest: IngestService },
) {
  const mode = opts?.mode ?? 'off';
  if (mode === 'off') return null;
  const mock = mode === 'mock' ? opts?.mock ?? new AviapagesMock({ clock: deps.clock }) : null;
  const config: AviapagesConfig = {
    ...DEFAULT_CONFIG,
    apiKey: mode === 'mock' ? mock!.validKey : opts?.apiKey ?? '',
    baseUrl: mode === 'mock' ? mock!.baseUrl : opts?.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    budgets: opts?.budgets ?? {},
    defaultBudget: opts?.defaultBudget ?? DEFAULT_CONFIG.defaultBudget,
  };
  const fetchImpl: FetchLike = opts?.fetch ?? (mock ? mock.fetch : (globalThis.fetch as unknown as FetchLike));
  const client = new AviapagesClient({ config, fetch: fetchImpl, db: deps.db, clock: deps.clock });
  const sync = new EmptyLegSync({ client, ingest: deps.ingest, fleet: deps.fleet, reference: deps.reference, legs: deps.legs, kv: deps.kv, clock: deps.clock, config: opts?.sync });
  return { mode, client, sync, mock };
}
