import { createApp, type AppOptions } from '../src/app.ts';
import type { FeedSource } from '../src/domain/types.ts';
import { HOUR } from '../src/domain/types.ts';

export const T0 = Date.parse('2026-10-01T12:00:00Z');

export class FakeClock {
  t: number;
  constructor(t = T0) {
    this.t = t;
  }
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

/** Minimal marketplace: two operators, a few tails, the three kinds of sources. */
export function testApp(opts: AppOptions = {}) {
  const clock = new FakeClock();
  const app = createApp({ clock, ...opts });
  app.fleet.upsertOperator({ id: 'op_a', name: 'Alpha Jets', certificate: 'FAA Part 135', status: 'active' }, 'key_a');
  app.fleet.upsertOperator({ id: 'op_b', name: 'Bravo Air', certificate: 'FAA Part 135', status: 'active' }, 'key_b');
  app.fleet.upsertOperator({ id: 'op_x', name: 'Suspended Co', certificate: 'FAA Part 135', status: 'suspended' }, 'key_x');
  app.fleet.upsertAircraft({ tail: 'N100A', operatorId: 'op_a', typeCode: 'CL35', seats: 9, homeBase: 'KTEB', year: 2020 });
  app.fleet.upsertAircraft({ tail: 'N200A', operatorId: 'op_a', typeCode: 'E55P', seats: 7, homeBase: 'KTEB', year: 2020 });
  app.fleet.upsertAircraft({ tail: 'N300B', operatorId: 'op_b', typeCode: 'C56X', seats: 8, homeBase: 'KVNY', year: 2018 });
  app.fleet.upsertAircraft({ tail: 'N400X', operatorId: 'op_x', typeCode: 'C56X', seats: 8, homeBase: 'KTEB', year: 2010 });
  const src = (s: Partial<FeedSource> & Pick<FeedSource, 'id' | 'kind' | 'adapter'>): FeedSource => ({
    name: s.id, operatorId: null, trust: 0.5, ttlMs: 6 * HOUR, ...s,
  });
  app.fleet.upsertSource(src({ id: 'api:op_a', kind: 'operator_api', adapter: 'native', operatorId: 'op_a', trust: 0.95, ttlMs: 24 * HOUR }), 'feed_a');
  app.fleet.upsertSource(src({ id: 'portal:op_a', kind: 'operator_portal', adapter: 'native', operatorId: 'op_a', trust: 0.9, ttlMs: 72 * HOUR }));
  app.fleet.upsertSource(src({ id: 'api:op_b', kind: 'operator_api', adapter: 'native', operatorId: 'op_b', trust: 0.95, ttlMs: 24 * HOUR }));
  app.fleet.upsertSource(src({ id: 'api:op_x', kind: 'operator_api', adapter: 'native', operatorId: 'op_x', trust: 0.95, ttlMs: 24 * HOUR }));
  app.fleet.upsertSource(src({ id: 'aerofeed', kind: 'aggregator', adapter: 'aerofeed', trust: 0.7, ttlMs: 6 * HOUR }));
  app.fleet.upsertSource(src({ id: 'agg2', kind: 'aggregator', adapter: 'native', trust: 0.7, ttlMs: 6 * HOUR }));
  app.fleet.upsertSource(src({ id: 'broker', kind: 'broker_network', adapter: 'native', trust: 0.5, ttlMs: 3 * HOUR }));
  app.market.set('fuel_cents_per_gal', 600, T0);
  app.market.set('fx_usd_per_EUR', 1.1, T0);
  return { app, clock };
}

export interface NativeLeg {
  externalId: string;
  tailNumber: string;
  from: string;
  to: string;
  departureEarliest: string;
  departureLatest?: string;
  price?: { amount: number; currency: string } | null;
  status?: 'available' | 'sold' | 'cancelled';
  aircraftType?: string;
}

export const iso = (t: number) => new Date(t).toISOString();

export function nativeLeg(over: Partial<NativeLeg> = {}): NativeLeg {
  return {
    externalId: 'ext-1',
    tailNumber: 'N100A',
    from: 'KTEB',
    to: 'KPBI',
    departureEarliest: iso(T0 + 48 * HOUR),
    departureLatest: iso(T0 + 50 * HOUR),
    price: { amount: 9_000_00, currency: 'USD' },
    status: 'available',
    ...over,
  };
}

export async function onlyLeg(app: ReturnType<typeof testApp>['app']) {
  const legs = app.legs.listActive(app.clock.now());
  if (legs.length !== 1) throw new Error(`expected exactly one leg, got ${legs.length}`);
  return legs[0];
}

export function bookingInput(quoteId: string, pax = 1, token = 'tok_visa') {
  return {
    quoteId,
    contact: { name: 'Grace Hopper', email: 'grace@example.com' },
    passengers: Array.from({ length: pax }, (_, i) => ({ name: `Passenger ${i + 1}` })),
    paymentToken: token,
    agreement: { accepted: true, signedName: 'Grace Hopper', version: 'ELA-2026-10' },
  };
}
