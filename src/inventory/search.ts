// Matching live empty-leg supply to what a traveler wants.
//
// Empty legs are rigid (fixed aircraft, fixed airports, narrow window), so a literal search finds
// almost nothing. Matching is deliberately loose on the dimensions travelers are flexible on:
//   - airports: any airport within a radius of the requested origin/destination (HPN matches TEB)
//   - dates: +/- flex days around the requested date, or "any time" if no date
//   - destination: optional ("anywhere from Teterboro this weekend")
// and strict on the ones that can't bend: seats, lead time, and a price that passed guardrails.
//
// Latency: the sellable inventory is held in memory, bucketed by origin airport, and rebuilt only
// when ingestion or bookings change it. A query touches only the buckets within its radius.

import type { Airport, AircraftCategory, AircraftType, Leg, Operator } from '../domain/types.ts';
import { DAY } from '../domain/types.ts';
import type { FleetRepo, LegRepo } from '../db/repos.ts';
import type { PricingEngine, PriceResult } from '../pricing/engine.ts';
import { AIRPORTS, findAirport, getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { distanceNm } from '../domain/geo.ts';
import { AppError } from '../domain/types.ts';

export interface SearchQuery {
  from: string;
  to?: string | null;
  date?: string | null;
  flexDays?: number;
  pax?: number;
  categories?: AircraftCategory[];
  maxPriceCents?: number | null;
  radiusNm?: number;
  sort?: 'best' | 'price' | 'departure';
  limit?: number;
}

export interface IndexedLeg {
  leg: Leg;
  type: AircraftType;
  seats: number;
  operator: Operator;
  from: Airport;
  to: Airport;
}

export interface SearchHit {
  legId: string;
  version: number;
  from: Pick<Airport, 'icao' | 'iata' | 'name' | 'city'>;
  to: Pick<Airport, 'icao' | 'iata' | 'name' | 'city'>;
  departEarliest: string;
  departLatest: string;
  aircraft: { type: string; category: AircraftCategory; seats: number; tail: string };
  operator: { id: string; name: string; certificate: string };
  price: { totalCents: number; currency: 'USD'; fullCharterEstimateCents: number; savingsPct: number };
  blockHours: number;
  distanceNm: number;
  confidence: number;
  originOffsetNm: number;
  destinationOffsetNm: number | null;
  matchNotes: string[];
  score: number;
}

export interface SearchResult {
  results: SearchHit[];
  meta: { tookMs: number; scanned: number; priceBlocked: number; indexSize: number; indexBuiltAt: string };
}

export function isListable(leg: Leg, minConfidence: number): boolean {
  return leg.supplyStatus === 'available' && leg.commerceStatus === 'open' && (leg.visibility ?? 'public') === 'public' &&
    leg.confidence >= minConfidence && !leg.conflicts.some((c) => c.blocking);
}

const airportSummary = (a: Airport) => ({ icao: a.icao, iata: a.iata, name: a.name, city: a.city });

export class SearchIndex {
  private legs: LegRepo;
  private fleet: FleetRepo;
  private pricing: PricingEngine;
  private byOrigin = new Map<string, IndexedLeg[]>();
  private size = 0;
  private builtAt = 0;
  private dirty = true;
  private listeners: Array<() => void> = [];

  constructor(legs: LegRepo, fleet: FleetRepo, pricing: PricingEngine) {
    this.legs = legs;
    this.fleet = fleet;
    this.pricing = pricing;
  }

  invalidate(): void {
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  onInvalidate(fn: () => void): void {
    this.listeners.push(fn);
  }

  stats() {
    return { size: this.size, builtAt: this.builtAt };
  }

  private ensure(now: number): void {
    // Rebuild on change, and at least once a minute so lead-time cutoffs and freshness apply.
    if (!this.dirty && now - this.builtAt < 60_000) return;
    const operators = new Map(this.fleet.listOperators().map((o) => [o.id, o]));
    const aircraft = new Map(this.fleet.listAircraft().map((a) => [a.tail, a]));
    const byOrigin = new Map<string, IndexedLeg[]>();
    let size = 0;
    for (const leg of this.legs.listActive(now)) {
      if (!isListable(leg, this.pricing.config.minConfidence) || !leg.typeCode || !leg.operatorId) continue;
      const ac = aircraft.get(leg.tail);
      const op = operators.get(leg.operatorId);
      if (!ac || !op) continue;
      const entry: IndexedLeg = {
        leg, type: getAircraftType(leg.typeCode), seats: ac.seats, operator: op,
        from: getAirport(leg.fromIcao), to: getAirport(leg.toIcao),
      };
      const bucket = byOrigin.get(leg.fromIcao) ?? [];
      bucket.push(entry);
      byOrigin.set(leg.fromIcao, bucket);
      size++;
    }
    this.byOrigin = byOrigin;
    this.size = size;
    this.builtAt = now;
    this.dirty = false;
  }

  /** Price a single leg for display, recording the published price when it passes. */
  priceForDisplay(entry: IndexedLeg, pax: number, now: number): PriceResult {
    const result = this.pricing.price({ leg: entry.leg, pax, seats: entry.seats, now });
    if (result.ok && entry.leg.lastPublishedPriceCents !== result.totalCents && pax === 1) {
      // Price-jump guardrail compares against what we last showed for the 1-pax reference price.
      this.legs.setLastPublishedPrice(entry.leg.id, result.totalCents);
      entry.leg.lastPublishedPriceCents = result.totalCents;
    }
    return result;
  }

  search(q: SearchQuery, now: number): SearchResult {
    const started = performance.now();
    this.ensure(now);
    const origin = findAirport(q.from);
    if (!origin) throw new AppError(400, 'unknown_origin', `Unknown origin airport ${q.from}`);
    const dest = q.to ? findAirport(q.to) : undefined;
    if (q.to && !dest) throw new AppError(400, 'unknown_destination', `Unknown destination airport ${q.to}`);
    const radius = clamp(q.radiusNm ?? 75, 0, 300);
    const pax = clamp(Math.floor(q.pax ?? 1), 1, 19);
    const flex = clamp(Math.floor(q.flexDays ?? 2), 0, 14);
    let windowStart = now;
    let windowEnd = now + 60 * DAY;
    let target: number | null = null;
    if (q.date) {
      const d = Date.parse(`${q.date}T00:00:00Z`);
      if (Number.isNaN(d)) throw new AppError(400, 'bad_date', 'date must be YYYY-MM-DD');
      target = d + DAY / 2;
      windowStart = Math.max(now, d - flex * DAY);
      windowEnd = d + (flex + 1) * DAY;
    }

    const originAirports = AIRPORTS
      .map((a) => ({ a, d: distanceNm(origin, a) }))
      .filter((x) => x.d <= radius);

    let scanned = 0;
    let priceBlocked = 0;
    const hits: SearchHit[] = [];
    for (const { a: originAirport, d: originOffset } of originAirports) {
      for (const entry of this.byOrigin.get(originAirport.icao) ?? []) {
        scanned++;
        const { leg } = entry;
        if (leg.departLatest < windowStart || leg.departEarliest >= windowEnd) continue;
        if (entry.seats < pax) continue;
        if (q.categories && q.categories.length > 0 && !q.categories.includes(entry.type.category)) continue;
        let destOffset: number | null = null;
        if (dest) {
          destOffset = distanceNm(dest, entry.to);
          if (destOffset > radius) continue;
        }
        const price = this.priceForDisplay(entry, pax, now);
        if (!price.ok) {
          priceBlocked++;
          continue;
        }
        if (q.maxPriceCents && price.totalCents > q.maxPriceCents) continue;

        const notes: string[] = [];
        if (originOffset > 1) notes.push(`Departs ${entry.from.iata}, ${Math.round(originOffset)}nm from ${origin.iata}`);
        if (destOffset !== null && destOffset > 1) notes.push(`Arrives ${entry.to.iata}, ${Math.round(destOffset)}nm from ${dest!.iata}`);
        const daysOff = target === null ? 0 : Math.abs(leg.departEarliest - target) / DAY;
        if (target !== null && daysOff >= 1) notes.push(`${Math.round(daysOff)} day(s) from your date`);
        if (price.flight && price.flight.fuelStops > 0) notes.push(`Includes ${price.flight.fuelStops} fuel stop(s)`);
        if (leg.departLatest - leg.departEarliest >= 2 * 3_600_000) notes.push('Flexible departure window');

        const score =
          price.savingsPct * 0.6 +
          leg.confidence * 20 -
          daysOff * 6 -
          (originOffset + (destOffset ?? 0)) / 10 -
          (entry.seats - pax > 6 ? 3 : 0);

        hits.push({
          legId: leg.id,
          version: leg.version,
          from: airportSummary(entry.from),
          to: airportSummary(entry.to),
          departEarliest: new Date(leg.departEarliest).toISOString(),
          departLatest: new Date(leg.departLatest).toISOString(),
          aircraft: { type: entry.type.name, category: entry.type.category, seats: entry.seats, tail: leg.tail },
          operator: { id: entry.operator.id, name: entry.operator.name, certificate: entry.operator.certificate },
          price: { totalCents: price.totalCents, currency: 'USD', fullCharterEstimateCents: price.fullCharterEstimateCents, savingsPct: price.savingsPct },
          blockHours: price.flight?.blockHours ?? 0,
          distanceNm: price.flight?.distanceNm ?? 0,
          confidence: leg.confidence,
          originOffsetNm: Math.round(originOffset),
          destinationOffsetNm: destOffset === null ? null : Math.round(destOffset),
          matchNotes: notes,
          score: Math.round(score * 10) / 10,
        });
      }
    }

    const sort = q.sort ?? 'best';
    hits.sort((a, b) =>
      sort === 'price' ? a.price.totalCents - b.price.totalCents
        : sort === 'departure' ? a.departEarliest.localeCompare(b.departEarliest)
          : b.score - a.score);

    return {
      results: hits.slice(0, clamp(q.limit ?? 50, 1, 200)),
      meta: {
        tookMs: Math.round((performance.now() - started) * 100) / 100,
        scanned,
        priceBlocked,
        indexSize: this.size,
        indexBuiltAt: new Date(this.builtAt).toISOString(),
      },
    };
  }

  /** All currently listable legs, used to match route alerts. */
  allIndexed(now: number): IndexedLeg[] {
    this.ensure(now);
    return [...this.byOrigin.values()].flat();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
