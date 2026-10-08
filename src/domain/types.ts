// Core domain model. All money is integer minor units (cents); all times are epoch milliseconds (UTC).

export type AircraftCategory = 'turboprop' | 'light' | 'midsize' | 'super-midsize' | 'heavy' | 'ultra-long';

export const CATEGORIES: readonly AircraftCategory[] = ['turboprop', 'light', 'midsize', 'super-midsize', 'heavy', 'ultra-long'];

export interface Airport {
  icao: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** Drives landing/handling fees. Premium = busy business-aviation FBOs (TEB, VNY, LBG...). */
  feeTier: 'standard' | 'premium';
}

export interface AircraftType {
  code: string;
  name: string;
  category: AircraftCategory;
  seats: number;
  cruiseKts: number;
  rangeNm: number;
  /** Typical retail full-charter rate per block hour, fuel included at the baseline fuel price. */
  hourlyRateCents: number;
  fuelBurnGph: number;
  /** Alternate names third-party feeds use for this type; used to detect type mismatches. */
  aliases: string[];
}

export interface Operator {
  id: string;
  name: string;
  /** e.g. "FAA Part 135", "EASA AOC". Only certificated operators may list legs. */
  certificate: string;
  status: 'active' | 'suspended';
}

export interface Aircraft {
  tail: string;
  operatorId: string;
  typeCode: string;
  seats: number;
  homeBase: string;
  year: number;
}

export type SourceKind = 'operator_api' | 'operator_portal' | 'aggregator' | 'broker_network';

export interface FeedSource {
  id: string;
  name: string;
  kind: SourceKind;
  /** Set when the source is owned by an operator; that source is authoritative for that operator's legs. */
  operatorId: string | null;
  /** Prior belief (0..1) that a fresh report from this source is correct. */
  trust: number;
  /** After this long without a refresh, a report from this source is no longer counted. */
  ttlMs: number;
  adapter: AdapterName;
}

export type AdapterName = 'native' | 'aerofeed' | 'csv';

export type ObservedStatus = 'available' | 'unavailable';

/** One normalized report of one leg from one source at one point in time. Append-only. */
export interface Observation {
  sourceId: string;
  externalId: string;
  receivedAt: number;
  tail: string;
  fromIcao: string;
  toIcao: string;
  departEarliest: number;
  departLatest: number;
  askCents: number | null;
  currency: string;
  status: ObservedStatus;
  typeHint: string | null;
}

export type SupplyStatus = 'available' | 'withdrawn' | 'expired';
export type CommerceStatus = 'open' | 'held' | 'booked';

export interface Conflict {
  code: string;
  blocking: boolean;
  detail: string;
  field?: string;
  values?: Array<{ sourceId: string; value: string }>;
}

/** The canonical, reconciled view of a single empty leg. */
export interface Leg {
  id: string;
  tail: string;
  operatorId: string | null;
  typeCode: string | null;
  fromIcao: string;
  toIcao: string;
  departEarliest: number;
  departLatest: number;
  askCents: number | null;
  currency: string;
  supplyStatus: SupplyStatus;
  commerceStatus: CommerceStatus;
  confidence: number;
  conflicts: Conflict[];
  /** field -> source id (or "registry"/"operator") that decided it. */
  provenance: Record<string, string>;
  version: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastPublishedPriceCents: number | null;
  updatedAt: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
