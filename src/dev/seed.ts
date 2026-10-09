// Demo marketplace: operators, verified fleet, feed sources, market data, and empty legs published
// through several channels that (deliberately) disagree with each other the way real feeds do.

import type { App } from '../app.ts';
import type { AdapterName, Aircraft, FeedSource, SourceKind } from '../domain/types.ts';
import { HOUR, MINUTE, DAY } from '../domain/types.ts';
import { getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { estimateFlight } from '../domain/geo.ts';

export const DEV_ADMIN_KEY = 'dev_admin_key';

interface OperatorSeed {
  id: string;
  name: string;
  certificate: string;
  status: 'active' | 'suspended';
  fleet: Array<[tail: string, type: string, seats: number, base: string, year: number]>;
  airports: string[];
  currency: string;
}

const OPERATORS: OperatorSeed[] = [
  { id: 'op_skyline', name: 'Skyline Charter', certificate: 'FAA Part 135', status: 'active', currency: 'USD',
    fleet: [['N512SK', 'C56X', 8, 'KTEB', 2018], ['N88SKY', 'CL35', 9, 'KTEB', 2021], ['N301SK', 'E55P', 7, 'KHPN', 2020], ['N650SK', 'GLF6', 14, 'KTEB', 2019]],
    airports: ['KTEB', 'KHPN', 'KBOS', 'KACK', 'KMVY', 'KPBI', 'KIAD', 'KASE', 'KVNY', 'KMDW', 'MYNN', 'TNCM', 'EGLF', 'LFPB'] },
  { id: 'op_coastal', name: 'Coastal Jet Partners', certificate: 'FAA Part 135', status: 'active', currency: 'USD',
    fleet: [['N44CJ', 'C25B', 7, 'KFLL', 2017], ['N730CJ', 'C68A', 9, 'KPBI', 2022], ['N19CJ', 'LJ75', 8, 'KOPF', 2016], ['N250CJ', 'PC12', 8, 'KAPF', 2019]],
    airports: ['KPBI', 'KFLL', 'KOPF', 'KMIA', 'KAPF', 'MYNN', 'TJSJ', 'TNCM', 'KTEB', 'KHPN', 'KPDK', 'KBNA', 'KMSY', 'MMUN'] },
  { id: 'op_summit', name: 'Summit Aviation Group', certificate: 'FAA Part 135', status: 'active', currency: 'USD',
    fleet: [['N21SU', 'C700', 9, 'KAPA', 2021], ['N77SU', 'E55P', 7, 'KAPA', 2019], ['N505SU', 'H25B', 8, 'KSDL', 2012]],
    airports: ['KAPA', 'KASE', 'KEGE', 'KSUN', 'KJAC', 'KBZN', 'KSDL', 'KLAS', 'KVNY', 'KDAL', 'KAUS', 'KTRK'] },
  { id: 'op_pacific', name: 'Pacific Executive Air', certificate: 'FAA Part 135', status: 'active', currency: 'USD',
    fleet: [['N600PX', 'CL60', 12, 'KVNY', 2018], ['N312PX', 'C56X', 8, 'KSNA', 2016], ['N88PX', 'F2TH', 10, 'KOAK', 2020], ['N41PX', 'PC12', 8, 'KCRQ', 2021]],
    airports: ['KVNY', 'KLAX', 'KBUR', 'KSNA', 'KCRQ', 'KPSP', 'KSFO', 'KOAK', 'KSJC', 'KTRK', 'KLAS', 'KSDL', 'MMSD', 'KBFI', 'KSUN', 'KASE'] },
  { id: 'op_lonestar', name: 'Lone Star Jets', certificate: 'FAA Part 135', status: 'active', currency: 'USD',
    fleet: [['N10LS', 'LJ75', 8, 'KDAL', 2015], ['N450LS', 'GLF4', 14, 'KHOU', 2014], ['N35LS', 'CL35', 9, 'KAUS', 2020]],
    airports: ['KDAL', 'KHOU', 'KAUS', 'KMSY', 'KAPA', 'KASE', 'KSDL', 'KLAS', 'KPBI', 'KTEB', 'MMSD', 'MMUN'] },
  { id: 'op_alpine', name: 'Alpine Aviation SA', certificate: 'EASA AOC (CH)', status: 'active', currency: 'EUR',
    fleet: [['HBJSA', 'CL35', 9, 'LSGG', 2019], ['HBVPX', 'C56X', 8, 'LSZH', 2017], ['HBFAL', 'F2TH', 10, 'LSGG', 2018]],
    airports: ['LSGG', 'LSZH', 'LFMN', 'LFMD', 'LFPB', 'EGLF', 'LIML', 'LIRA', 'LEIB', 'LEPA', 'EDDM', 'LOWW', 'LGMK'] },
  { id: 'op_riviera', name: 'Riviera Air Charter', certificate: 'EASA AOC (FR)', status: 'active', currency: 'EUR',
    fleet: [['FHRAC', 'E55P', 7, 'LFMN', 2021], ['FGLXR', 'GL7T', 17, 'LFPB', 2022]],
    airports: ['LFMN', 'LFMD', 'LFPB', 'EGLF', 'EGGW', 'LEIB', 'LEMD', 'LGAV', 'LGMK', 'LSGG', 'OMDW', 'KTEB'] },
  { id: 'op_grounded', name: 'Grounded Air', certificate: 'FAA Part 135', status: 'suspended', currency: 'USD',
    fleet: [['N13GR', 'C56X', 8, 'KTEB', 2009]],
    airports: ['KTEB', 'KPBI', 'KBOS'] },
];

function source(id: string, name: string, kind: SourceKind, operatorId: string | null, adapter: AdapterName): FeedSource {
  const presets: Record<SourceKind, { trust: number; ttlMs: number }> = {
    operator_api: { trust: 0.95, ttlMs: 24 * HOUR },
    operator_portal: { trust: 0.9, ttlMs: 72 * HOUR },
    aggregator: { trust: 0.7, ttlMs: 6 * HOUR },
    broker_network: { trust: 0.5, ttlMs: 3 * HOUR },
  };
  return { id, name, kind, operatorId, adapter, ...presets[kind] };
}

export { rng } from './rng.ts';
import { rng } from './rng.ts';

export interface LegSpec {
  key: string;
  tail: string;
  operatorId: string;
  from: string;
  to: string;
  departEarliest: number;
  flexHours: number;
  askMajor: number | null;
  currency: string;
  status: 'available' | 'sold' | 'cancelled';
  channels: {
    operatorApi: boolean;
    aerofeed: null | { minuteShift: number; altFrom?: string; typeName: string; avail: 'Y' | 'N'; priceUsd: string | null };
    broker: null | { from?: string; to?: string };
  };
}

export interface SeedResult {
  operatorKeys: Record<string, string>;
  feedKeys: Record<string, string>;
  specs: LegSpec[];
}

export function seedReference(app: App, now: number): Pick<SeedResult, 'operatorKeys' | 'feedKeys'> {
  const operatorKeys: Record<string, string> = {};
  const feedKeys: Record<string, string> = {};
  app.db.tx(() => {
    for (const op of OPERATORS) {
      const key = `dev_${op.id}`;
      operatorKeys[op.id] = key;
      app.fleet.upsertOperator({ id: op.id, name: op.name, certificate: op.certificate, status: op.status }, key);
      for (const [tail, typeCode, seats, homeBase, year] of op.fleet) {
        const a: Aircraft = { tail, operatorId: op.id, typeCode, seats, homeBase, year };
        app.fleet.upsertAircraft(a);
      }
      app.fleet.upsertSource(source(`api:${op.id}`, `${op.name} API`, 'operator_api', op.id, 'native'), `dev_feed_api_${op.id}`);
      feedKeys[`api:${op.id}`] = `dev_feed_api_${op.id}`;
      app.fleet.upsertSource(source(`portal:${op.id}`, `${op.name} portal`, 'operator_portal', op.id, 'native'));
    }
    app.fleet.upsertSource(source('aerofeed', 'AeroFeed aggregator', 'aggregator', null, 'aerofeed'), 'dev_feed_aerofeed');
    app.fleet.upsertSource(source('brokernet', 'BrokerNet partner feed', 'broker_network', null, 'native'), 'dev_feed_brokernet');
    feedKeys.aerofeed = 'dev_feed_aerofeed';
    feedKeys.brokernet = 'dev_feed_brokernet';
    seedMarketDefaults(app, now);
  });
  return { operatorKeys, feedKeys };
}

/**
 * Fuel and FX inputs the pricing engine needs; production sets only these, never demo data.
 * Keeps whatever ops last set (via /api/admin/market) and re-stamps it as current, so prices don't
 * fail the MARKET_FRESH guardrail when no market feed is connected. Run at startup and periodically.
 */
export function seedMarketDefaults(app: App, now: number): void {
  const set = (k: string, v: number) => app.market.set(k, app.market.get(k)?.value ?? v, now);
  set('fuel_cents_per_gal', 640);
  set('fx_usd_per_EUR', 1.09);
  set('fx_usd_per_GBP', 1.28);
  set('fx_usd_per_CHF', 1.14);
}

const NEARBY: Record<string, string> = { KTEB: 'KJFK', KVNY: 'KBUR', KPBI: 'KFLL', KOPF: 'KMIA', LFMN: 'LFMD', KDAL: 'KDAL' };

export function generateSpecs(now: number, seed = 42): LegSpec[] {
  const r = rng(seed);
  const specs: LegSpec[] = [];
  const start = Math.ceil(now / (15 * MINUTE)) * 15 * MINUTE;
  for (const op of OPERATORS) {
    for (const [tail, typeCode] of op.fleet) {
      const type = getAircraftType(typeCode);
      let t = start + r.int(5, 30) * HOUR;
      const legs = r.int(2, 4);
      for (let i = 0; i < legs; i++) {
        let from = r.pick(op.airports);
        let to = r.pick(op.airports);
        for (let tries = 0; tries < 20 && (from === to || estimateFlight(getAirport(from), getAirport(to), type).fuelStops > 0); tries++) {
          from = r.pick(op.airports);
          to = r.pick(op.airports);
        }
        if (from === to) continue;
        const est = estimateFlight(getAirport(from), getAirport(to), type);
        const hasAsk = r.chance(0.6);
        const fx = op.currency === 'EUR' ? 1.09 : 1;
        const askMajor = hasAsk ? Math.round((type.hourlyRateCents / 100) * est.blockHours * (0.32 + r.next() * 0.25) / fx / 100) * 100 : null;
        const roll = r.next();
        const operatorApi = roll < 0.55;
        const aerofeedOnly = roll >= 0.55 && roll < 0.85;
        const onAerofeed = aerofeedOnly || (operatorApi && r.chance(0.5));
        const typeName = r.chance(0.15) ? r.pick(type.aliases) : type.name;
        specs.push({
          key: `${tail}-${i}`,
          tail, operatorId: op.id, from, to,
          departEarliest: t,
          flexHours: r.pick([0, 0, 1, 2, 4]),
          askMajor, currency: op.currency, status: 'available',
          channels: {
            operatorApi,
            aerofeed: onAerofeed ? {
              minuteShift: r.chance(0.3) ? r.pick([-45, -30, 30, 60]) : 0,
              altFrom: operatorApi && r.chance(0.15) && NEARBY[from] && NEARBY[from] !== from ? NEARBY[from] : undefined,
              typeName,
              avail: 'Y',
              priceUsd: askMajor ? (askMajor * fx * 1.18).toLocaleString('en-US', { minimumFractionDigits: 2 }) : r.chance(0.5) ? 'POA' : null,
            } : null,
            broker: !operatorApi && !aerofeedOnly ? {} : aerofeedOnly && r.chance(0.3) ? {} : null,
          },
        });
        t += Math.max(est.blockHours * HOUR + r.int(6, 60) * HOUR, 8 * HOUR);
        if (t > now + 21 * DAY) break;
      }
    }
  }

  // ---- hand-made scenarios that exercise reconciliation and guardrails ----
  const at = (h: number) => start + h * HOUR;
  // 1. Aggregator says sold, operator API still lists it: operator wins.
  specs.push({ key: 'scenario-status', tail: 'N512SK', operatorId: 'op_skyline', from: 'KHPN', to: 'KACK', departEarliest: at(30 * 24 + 11), flexHours: 0,
    askMajor: 5200, currency: 'USD', status: 'available',
    channels: { operatorApi: true, aerofeed: { minuteShift: 0, typeName: 'Citation XLS', avail: 'N', priceUsd: '8,400.00' }, broker: null } });
  // 2. Aggregator lists a tail that isn't in our verified registry: quarantined.
  specs.push({ key: 'scenario-unknown-tail', tail: 'N999ZZ', operatorId: 'unknown', from: 'KTEB', to: 'KPBI', departEarliest: at(52), flexHours: 2,
    askMajor: null, currency: 'USD', status: 'available',
    channels: { operatorApi: false, aerofeed: { minuteShift: 0, typeName: 'Challenger 350', avail: 'Y', priceUsd: '11,900.00' }, broker: null } });
  // 3. Operator fat-fingers a price ($45 instead of $4,500): PRICE_SANITY blocks it.
  specs.push({ key: 'scenario-unit-error', tail: 'N44CJ', operatorId: 'op_coastal', from: 'KPBI', to: 'MYNN', departEarliest: at(26 * 24 + 9), flexHours: 0,
    askMajor: 45, currency: 'USD', status: 'available', channels: { operatorApi: true, aerofeed: null, broker: null } });
  // 4. Aggregator shows the same tail flying somewhere else at the same time as an operator leg: overlap.
  specs.push({ key: 'scenario-overlap-a', tail: 'N600PX', operatorId: 'op_pacific', from: 'KVNY', to: 'KSUN', departEarliest: at(28 * 24 + 8), flexHours: 0,
    askMajor: 9900, currency: 'USD', status: 'available', channels: { operatorApi: true, aerofeed: null, broker: null } });
  specs.push({ key: 'scenario-overlap-b', tail: 'N600PX', operatorId: 'op_pacific', from: 'KSNA', to: 'KASE', departEarliest: at(28 * 24 + 9), flexHours: 0,
    askMajor: null, currency: 'USD', status: 'available',
    channels: { operatorApi: false, aerofeed: { minuteShift: 0, typeName: 'Challenger 650', avail: 'Y', priceUsd: null }, broker: null } });
  // 5. Suspended operator: never listed.
  specs.push({ key: 'scenario-suspended', tail: 'N13GR', operatorId: 'op_grounded', from: 'KTEB', to: 'KPBI', departEarliest: at(60), flexHours: 0,
    askMajor: 5200, currency: 'USD', status: 'available', channels: { operatorApi: true, aerofeed: null, broker: null } });
  // 6. Two third-party feeds disagree on the destination (ASE vs SDL). They can't be the same leg, and
  //    one aircraft can't fly both, so the less-corroborated report is quarantined as an overlap.
  specs.push({ key: 'scenario-route', tail: 'N10LS', operatorId: 'op_lonestar', from: 'KDAL', to: 'KASE', departEarliest: at(27 * 24 + 14), flexHours: 1,
    askMajor: null, currency: 'USD', status: 'available',
    channels: { operatorApi: false, aerofeed: { minuteShift: 0, typeName: 'Learjet 75', avail: 'Y', priceUsd: null }, broker: { to: 'KSDL' } } });
  return specs;
}

/** Push every spec through the channels it's published on, as each channel would format it. */
export async function publishSpecs(app: App, specs: LegSpec[]): Promise<void> {
  const byApi = new Map<string, unknown[]>();
  const aerofeed: unknown[] = [];
  const broker: unknown[] = [];
  for (const s of specs) {
    const iso = (t: number) => new Date(t).toISOString();
    const latest = s.departEarliest + s.flexHours * HOUR;
    if (s.channels.operatorApi) {
      const list = byApi.get(s.operatorId) ?? [];
      list.push({
        externalId: `${s.operatorId}-${s.key}`, tailNumber: s.tail, from: s.from, to: s.to,
        departureEarliest: iso(s.departEarliest), departureLatest: iso(latest),
        price: s.askMajor === null ? null : { amount: s.askMajor * 100, currency: s.currency }, status: s.status,
      });
      byApi.set(s.operatorId, list);
    }
    const af = s.channels.aerofeed;
    if (af) {
      const centre = (s.departEarliest + latest) / 2 + af.minuteShift * MINUTE;
      // AeroFeed reports local time with an offset; use the departure airport's rough offset.
      const offsetH = Math.round(getAirport(af.altFrom ?? s.from).lon / 15);
      const local = new Date(centre + offsetH * HOUR);
      const sign = offsetH < 0 ? '-' : '+';
      aerofeed.push({
        id: 9_000_000 + hash(s.key), reg: s.tail.startsWith('N') ? `N-${s.tail.slice(1)}` : `${s.tail.slice(0, 2)}-${s.tail.slice(2)}`,
        dep_iata: getAirport(af.altFrom ?? s.from).iata, arr_iata: getAirport(s.to).iata,
        dep_date: local.toISOString().slice(0, 10), dep_time_local: local.toISOString().slice(11, 16),
        tz_offset: `${sign}${String(Math.abs(offsetH)).padStart(2, '0')}:00`, flex_hours: s.flexHours / 2,
        price_usd: af.priceUsd, avail: s.status === 'available' ? af.avail : 'N', aircraft: af.typeName,
      });
    }
    const br = s.channels.broker;
    if (br) {
      broker.push({
        externalId: `bn-${s.key}`, tailNumber: s.tail, from: br.from ?? s.from, to: br.to ?? s.to,
        departureEarliest: iso(s.departEarliest), departureLatest: iso(latest), price: null,
        status: s.status === 'available' ? 'available' : 'sold',
      });
    }
  }
  for (const [operatorId, legs] of byApi) await app.ingest.ingest(`api:${operatorId}`, { legs });
  if (aerofeed.length) await app.ingest.ingest('aerofeed', { flights: aerofeed });
  if (broker.length) await app.ingest.ingest('brokernet', { legs: broker });
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 1_000_000;
}

export async function seedDemo(app: App, now = app.clock.now()): Promise<SeedResult> {
  const keys = seedReference(app, now);
  const specs = generateSpecs(now);
  await publishSpecs(app, specs);
  return { ...keys, specs };
}

/**
 * Keeps the demo alive: feeds re-confirm their listings (so third-party legs don't expire), and
 * every tick something happens: an operator posts a new leg, a price drops, a leg sells elsewhere.
 */
export function startSimulator(app: App, specs: LegSpec[], intervalMs: number): () => void {
  const r = rng(7);
  let n = 0;
  const tick = async () => {
    const now = app.clock.now();
    app.market.set('fuel_cents_per_gal', 640 + r.int(-10, 10), now);
    for (const k of ['EUR', 'GBP', 'CHF']) {
      const v = app.market.get(`fx_usd_per_${k}`);
      if (v) app.market.set(`fx_usd_per_${k}`, v.value, now);
    }
    const live = specs.filter((s) => s.status === 'available' && s.departEarliest > now + 6 * HOUR && !s.key.startsWith('scenario'));
    const event = r.int(0, 2);
    if (event === 0 && live.length) {
      const s = r.pick(live.filter((x) => x.askMajor !== null && x.channels.operatorApi));
      if (s) s.askMajor = Math.round((s.askMajor! * 0.9) / 100) * 100;
    } else if (event === 1 && live.length > 40) {
      const s = r.pick(live);
      s.status = 'sold';
    } else {
      const fresh = generateSpecs(now, 1000 + n++).filter((s) => !s.key.startsWith('scenario'));
      const s = r.pick(fresh);
      const clash = specs.some((x) => x.tail === s.tail && Math.abs(x.departEarliest - s.departEarliest) < 2 * DAY);
      if (!clash) specs.push({ ...s, key: `${s.key}-sim${n}` });
    }
    try {
      await publishSpecs(app, specs.filter((s) => s.departEarliest > now));
      await app.ingest.refresh();
    } catch (e) {
      console.error('[simulator]', e);
    }
  };
  const h = setInterval(tick, intervalMs);
  return () => clearInterval(h);
}
