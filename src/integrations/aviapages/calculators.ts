// Aviapages calculators as pricing inputs, paid for once per route + aircraft type.
//
//   flight time   airway route with historical winds, tech stops, fuel: replaces our great-circle
//                 estimate for block time (and therefore modelled prices and sanity checks).
//   market price  what a regular one-way charter costs on that route in that class: the yardstick
//                 for "X% below charter" and the full-charter ceiling guardrail.
//
// Pricing reads only the cache (synchronous, never blocks search). Remote calls happen where a
// traveler has shown intent (viewing a flight, asking for a quote) and in the harvest script.

import type { CalcCache } from '../../db/repos.ts';
import type { Clock } from '../../domain/types.ts';
import { DAY } from '../../domain/types.ts';
import type { FlightEstimate } from '../../domain/geo.ts';
import { getAirport } from '../../reference/airports.ts';
import { findAircraftType } from '../../reference/aircraft-types.ts';
import { avpMinute, type AviapagesClient } from './client.ts';

export interface FlightInsight {
  minutes: number;
  distanceKm: number;
  techstops: string[];
  fuelKg: number | null;
  profile: string;
}

export interface MarketPrice {
  priceCents: number;
  minCents: number | null;
  maxCents: number | null;
}

const FLIGHT_TTL = 90 * DAY;
const PRICE_TTL = 7 * DAY;
const TAXI_HOURS = 0.3;

export class Calculators {
  private cache: CalcCache;
  private client: AviapagesClient | null;
  private clock: Clock;
  /** Calls of each calculator's monthly budget kept back (harvest and admin tools share the rest). */
  reserve = 5;

  constructor(deps: { cache: CalcCache; client: AviapagesClient | null; clock: Clock }) {
    this.cache = deps.cache;
    this.client = deps.client;
    this.clock = deps.clock;
  }

  private fresh<T>(key: string, ttl: number): T | undefined {
    const hit = this.cache.get<T>(key);
    return hit && this.clock.now() - hit.fetchedAt < ttl ? hit.data : undefined;
  }

  flight(fromIcao: string, toIcao: string, typeCode: string): FlightInsight | undefined {
    return this.fresh<FlightInsight>(`ft:${fromIcao}:${toIcao}:${typeCode}`, FLIGHT_TTL);
  }

  marketPrice(fromIcao: string, toIcao: string, typeCode: string): MarketPrice | undefined {
    return this.fresh<MarketPrice>(`cp:${fromIcao}:${toIcao}:${typeCode}`, PRICE_TTL);
  }

  /** The pricing engine's view: our FlightEstimate shape, from cache only. */
  flightEstimate(fromIcao: string, toIcao: string, typeCode: string): FlightEstimate | undefined {
    const f = this.flight(fromIcao, toIcao, typeCode);
    if (!f) return undefined;
    return {
      distanceNm: Math.round(f.distanceKm / 1.852),
      fuelStops: f.techstops.length,
      blockHours: Math.round((f.minutes / 60 + TAXI_HOURS) * 100) / 100,
      source: 'aviapages',
    };
  }

  /** Fetches whatever isn't cached yet for this route + type. Never throws: pricing falls back to estimates. */
  async warm(fromIcao: string, toIcao: string, typeCode: string, opts: { tail?: string; pax?: number } = {}): Promise<{ flight: boolean; price: boolean; errors: string[] }> {
    const out = { flight: !!this.flight(fromIcao, toIcao, typeCode), price: !!this.marketPrice(fromIcao, toIcao, typeCode), errors: [] as string[] };
    if (!this.client) return out;
    const type = findAircraftType(typeCode);
    const aircraft = type ? (/^[A-Z0-9]{2,4}$/.test(type.code) ? type.code : type.name) : typeCode;
    if (!out.flight && this.client.remaining('flight_calculator') > this.reserve) {
      try {
        const r = await this.client.flightCalculator({
          departure_airport: fromIcao, arrival_airport: toIcao, aircraft, aircraft_tail_number: opts.tail, pax: opts.pax,
          airway_time_weather_impacted: true, airway_time: true, great_circle_time: true, great_circle_distance: true,
          airway_fuel_weather_impacted: true, advise_techstops: true,
        });
        const minutes = r.time?.airway_weather_impacted || r.time?.airway || r.time?.great_circle || r.time?.average_speed;
        if (minutes && r.distance?.great_circle) {
          this.cache.set(`ft:${fromIcao}:${toIcao}:${typeCode}`, 'flight', {
            minutes, distanceKm: r.distance.great_circle, techstops: r.airport?.techstops ?? [],
            fuelKg: r.fuel?.airway_weather_impacted ?? r.fuel?.airway ?? null, profile: r.aircraft,
          } satisfies FlightInsight, this.clock.now());
          out.flight = true;
        } else if (r.errors?.length) out.errors.push(r.errors.map((e) => e.message).join('; '));
      } catch (e) {
        out.errors.push(`flight_calculator: ${(e as Error).message}`);
      }
    }
    if (!out.price && this.client.remaining('charter_prices') > this.reserve) {
      try {
        const from = getAirport(fromIcao);
        const to = getAirport(toIcao);
        const r = await this.client.charterPrice({
          legs: [{
            departure_airport: { icao: from.icao, iata: from.iata || null }, arrival_airport: { icao: to.icao, iata: to.iata || null },
            pax: opts.pax ?? 1, departure_datetime: avpMinute(this.clock.now() + 7 * DAY),
          }],
          aircraft: [type ? { ac_type: type.name } : { ac_type: typeCode }],
          currency_code: 'USD',
          range: true,
        });
        if (typeof r.price === 'number' && r.price > 0) {
          this.cache.set(`cp:${fromIcao}:${toIcao}:${typeCode}`, 'charter_price', {
            priceCents: Math.round(r.price * 100),
            minCents: typeof r.price_min === 'number' ? Math.round(r.price_min * 100) : null,
            maxCents: typeof r.price_max === 'number' ? Math.round(r.price_max * 100) : null,
          } satisfies MarketPrice, this.clock.now());
          out.price = true;
        }
      } catch (e) {
        out.errors.push(`charter_prices: ${(e as Error).message}`);
      }
    }
    return out;
  }

  stats() {
    return { flightTimes: this.cache.count('flight'), marketPrices: this.cache.count('charter_price') };
  }
}
