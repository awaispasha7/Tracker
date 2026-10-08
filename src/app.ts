// Composition root: wires repositories and services together. Used by the server, the seed
// script and the tests (which inject a controllable clock and an in-memory database).

import { Database } from './db/database.ts';
import { FleetRepo, LegRepo, MarketRepo } from './db/repos.ts';
import { PricingEngine } from './pricing/engine.ts';
import { DEFAULT_PRICING, type PricingConfig } from './pricing/config.ts';
import { SearchIndex } from './inventory/search.ts';
import { BookingService, DEFAULT_BOOKING, type BookingConfig } from './booking/booking-service.ts';
import { MockPaymentProvider, type PaymentProvider } from './booking/payments.ts';
import { Outbox } from './alerts/outbox.ts';
import { AlertService } from './alerts/alerts.ts';
import { IngestService } from './ingestion/ingest-service.ts';
import { systemClock, type Clock } from './domain/types.ts';

export interface AppOptions {
  dbPath?: string;
  clock?: Clock;
  payments?: PaymentProvider;
  pricing?: Partial<PricingConfig>;
  booking?: Partial<BookingConfig>;
}

export function createApp(opts: AppOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const db = new Database(opts.dbPath ?? ':memory:');
  const fleet = new FleetRepo(db);
  const legs = new LegRepo(db);
  const market = new MarketRepo(db);
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
  return { db, clock, fleet, legs, market, pricing, search, outbox, payments, bookings, alerts, ingest };
}

export type App = ReturnType<typeof createApp>;
