import type { Database } from './database.ts';
import type { Aircraft, AdapterName, AircraftType, Airport, FeedSource, Leg, Observation, Operator, SourceKind } from '../domain/types.ts';
import { hashKey } from '../domain/ids.ts';

// ---------- fleet: operators, aircraft registry, feed sources ----------

interface OperatorRow {
  id: string; name: string; certificate: string; status: 'active' | 'suspended'; source: 'direct' | 'aviapages';
  external_id: string | null; contact: string;
}
interface AircraftRow {
  tail: string; operator_id: string; type_code: string; seats: number; home_base: string; year: number;
  source: 'direct' | 'aviapages'; external_id: string | null; images: string; amenities: string;
}
interface SourceRow {
  id: string; name: string; kind: SourceKind; operator_id: string | null; trust: number; ttl_ms: number; adapter: AdapterName;
  prices_are_net: number; listing_max_age_ms: number | null;
}

const toOperator = (r: OperatorRow): Operator => ({
  id: r.id, name: r.name, certificate: r.certificate, status: r.status, source: r.source ?? 'direct',
  externalId: r.external_id, contact: JSON.parse(r.contact ?? '{}'),
});
const toAircraft = (r: AircraftRow): Aircraft => ({
  tail: r.tail, operatorId: r.operator_id, typeCode: r.type_code, seats: r.seats, homeBase: r.home_base, year: r.year,
  source: r.source ?? 'direct', externalId: r.external_id, images: JSON.parse(r.images ?? '[]'), amenities: JSON.parse(r.amenities ?? '{}'),
});
const toSource = (r: SourceRow): FeedSource => ({
  id: r.id, name: r.name, kind: r.kind, operatorId: r.operator_id, trust: r.trust, ttlMs: r.ttl_ms, adapter: r.adapter,
  pricesAreNet: !!r.prices_are_net, listingMaxAgeMs: r.listing_max_age_ms,
});

export class FleetRepo {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  upsertOperator(op: Operator, apiKey?: string): void {
    this.db.run(
      `INSERT INTO operators (id, name, certificate, status, api_key_hash, source, external_id, contact) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, certificate=excluded.certificate, status=excluded.status,
         api_key_hash=COALESCE(excluded.api_key_hash, operators.api_key_hash), source=excluded.source,
         external_id=COALESCE(excluded.external_id, operators.external_id), contact=excluded.contact`,
      op.id, op.name, op.certificate, op.status, apiKey ? hashKey(apiKey) : null, op.source ?? 'direct',
      op.externalId ?? null, JSON.stringify(op.contact ?? {}),
    );
  }

  operatorByExternalId(externalId: string): Operator | undefined {
    const r = this.db.get<OperatorRow>('SELECT * FROM operators WHERE external_id = ?', externalId);
    return r && toOperator(r);
  }

  getOperator(id: string): Operator | undefined {
    const r = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', id);
    return r && toOperator(r);
  }

  operatorByApiKey(key: string): Operator | undefined {
    const r = this.db.get<OperatorRow>('SELECT * FROM operators WHERE api_key_hash = ?', hashKey(key));
    return r && toOperator(r);
  }

  listOperators(): Operator[] {
    return this.db.all<OperatorRow>('SELECT * FROM operators ORDER BY name').map(toOperator);
  }

  upsertAircraft(a: Aircraft): void {
    this.db.run(
      `INSERT INTO aircraft (tail, operator_id, type_code, seats, home_base, year, source, external_id, images, amenities)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tail) DO UPDATE SET operator_id=excluded.operator_id, type_code=excluded.type_code,
         seats=excluded.seats, home_base=excluded.home_base, year=excluded.year, source=excluded.source,
         external_id=COALESCE(excluded.external_id, aircraft.external_id), images=excluded.images, amenities=excluded.amenities`,
      a.tail, a.operatorId, a.typeCode, a.seats, a.homeBase, a.year, a.source ?? 'direct', a.externalId ?? null,
      JSON.stringify(a.images ?? []), JSON.stringify(a.amenities ?? {}),
    );
  }

  getAircraft(tail: string): Aircraft | undefined {
    const r = this.db.get<AircraftRow>('SELECT * FROM aircraft WHERE tail = ?', tail);
    return r && toAircraft(r);
  }

  listAircraft(operatorId?: string): Aircraft[] {
    const rows = operatorId
      ? this.db.all<AircraftRow>('SELECT * FROM aircraft WHERE operator_id = ? ORDER BY tail', operatorId)
      : this.db.all<AircraftRow>('SELECT * FROM aircraft ORDER BY tail');
    return rows.map(toAircraft);
  }

  upsertSource(s: FeedSource, apiKey?: string): void {
    this.db.run(
      `INSERT INTO feed_sources (id, name, kind, operator_id, trust, ttl_ms, adapter, api_key_hash, prices_are_net, listing_max_age_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, operator_id=excluded.operator_id,
         trust=excluded.trust, ttl_ms=excluded.ttl_ms, adapter=excluded.adapter,
         api_key_hash=COALESCE(excluded.api_key_hash, feed_sources.api_key_hash), prices_are_net=excluded.prices_are_net,
         listing_max_age_ms=excluded.listing_max_age_ms`,
      s.id, s.name, s.kind, s.operatorId, s.trust, s.ttlMs, s.adapter, apiKey ? hashKey(apiKey) : null, s.pricesAreNet ? 1 : 0, s.listingMaxAgeMs ?? null,
    );
  }

  getSource(id: string): FeedSource | undefined {
    const r = this.db.get<SourceRow>('SELECT * FROM feed_sources WHERE id = ?', id);
    return r && toSource(r);
  }

  sourceByApiKey(key: string): FeedSource | undefined {
    const r = this.db.get<SourceRow>('SELECT * FROM feed_sources WHERE api_key_hash = ?', hashKey(key));
    return r && toSource(r);
  }

  listSources(): FeedSource[] {
    return this.db.all<SourceRow>('SELECT * FROM feed_sources ORDER BY id').map(toSource);
  }
}

// ---------- observations & legs ----------

interface ObservationRow {
  source_id: string; external_id: string; received_at: number; tail: string; from_icao: string; to_icao: string;
  depart_earliest: number; depart_latest: number; ask_cents: number | null; currency: string; status: 'available' | 'unavailable';
  type_hint: string | null; note: string | null;
}

interface LegRow {
  id: string; tail: string; operator_id: string | null; type_code: string | null; from_icao: string; to_icao: string;
  depart_earliest: number; depart_latest: number; ask_cents: number | null; currency: string;
  supply_status: Leg['supplyStatus']; commerce_status: Leg['commerceStatus']; confidence: number; conflicts: string;
  provenance: string; version: number; first_seen_at: number; last_seen_at: number; last_published_price_cents: number | null;
  updated_at: number; kind: 'empty_leg' | 'charter_offer'; visibility: 'public' | 'private'; note: string | null;
  freshness_ms: number | null;
}

const toObservation = (r: ObservationRow): Observation => ({
  sourceId: r.source_id, externalId: r.external_id, receivedAt: r.received_at, tail: r.tail, fromIcao: r.from_icao,
  toIcao: r.to_icao, departEarliest: r.depart_earliest, departLatest: r.depart_latest, askCents: r.ask_cents,
  currency: r.currency, status: r.status, typeHint: r.type_hint, note: r.note,
});

const toLeg = (r: LegRow): Leg => ({
  id: r.id, tail: r.tail, operatorId: r.operator_id, typeCode: r.type_code, fromIcao: r.from_icao, toIcao: r.to_icao,
  departEarliest: r.depart_earliest, departLatest: r.depart_latest, askCents: r.ask_cents, currency: r.currency,
  supplyStatus: r.supply_status, commerceStatus: r.commerce_status, confidence: r.confidence,
  conflicts: JSON.parse(r.conflicts), provenance: JSON.parse(r.provenance), version: r.version,
  firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastPublishedPriceCents: r.last_published_price_cents,
  updatedAt: r.updated_at, kind: r.kind ?? 'empty_leg', visibility: r.visibility ?? 'public', note: r.note ?? null,
  freshnessMs: r.freshness_ms ?? null,
});

export class LegRepo {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  insertObservation(o: Observation, raw: unknown): void {
    this.db.run(
      `INSERT INTO observations (source_id, external_id, received_at, tail, from_icao, to_icao, depart_earliest, depart_latest,
         ask_cents, currency, status, type_hint, raw, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.sourceId, o.externalId, o.receivedAt, o.tail, o.fromIcao, o.toIcao, o.departEarliest, o.departLatest,
      o.askCents, o.currency, o.status, o.typeHint, JSON.stringify(raw), o.note ?? null,
    );
  }

  /** Latest observation per (source, external id) linked to this leg. */
  latestObservationsForLeg(legId: string): Observation[] {
    return this.db.all<ObservationRow>(
      `SELECT o.* FROM leg_links l
       JOIN observations o ON o.id = (
         SELECT id FROM observations WHERE source_id = l.source_id AND external_id = l.external_id
         ORDER BY received_at DESC, id DESC LIMIT 1)
       WHERE l.leg_id = ?`,
      legId,
    ).map(toObservation);
  }

  linkedLegId(sourceId: string, externalId: string): string | undefined {
    return this.db.get<{ leg_id: string }>('SELECT leg_id FROM leg_links WHERE source_id = ? AND external_id = ?', sourceId, externalId)?.leg_id;
  }

  link(sourceId: string, externalId: string, legId: string): void {
    this.db.run(
      `INSERT INTO leg_links (source_id, external_id, leg_id) VALUES (?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET leg_id = excluded.leg_id`,
      sourceId, externalId, legId,
    );
  }

  get(id: string): Leg | undefined {
    const r = this.db.get<LegRow>('SELECT * FROM legs WHERE id = ?', id);
    return r && toLeg(r);
  }

  byTailNear(tail: string, from: number, to: number): Leg[] {
    return this.db.all<LegRow>(
      'SELECT * FROM legs WHERE tail = ? AND depart_earliest BETWEEN ? AND ? ORDER BY depart_earliest',
      tail, from, to,
    ).map(toLeg);
  }

  /** Legs that still matter: not yet departed. */
  listActive(now: number): Leg[] {
    return this.db.all<LegRow>('SELECT * FROM legs WHERE depart_latest > ? ORDER BY depart_earliest', now).map(toLeg);
  }

  /** Legs linked to any external id of this source (used to detect listings that disappeared). */
  linksForSource(sourceId: string): Array<{ externalId: string; legId: string }> {
    return this.db.all<{ external_id: string; leg_id: string }>('SELECT external_id, leg_id FROM leg_links WHERE source_id = ?', sourceId)
      .map((r) => ({ externalId: r.external_id, legId: r.leg_id }));
  }

  latestObservation(sourceId: string, externalId: string): Observation | undefined {
    const r = this.db.get<ObservationRow>(
      'SELECT * FROM observations WHERE source_id = ? AND external_id = ? ORDER BY received_at DESC, id DESC LIMIT 1', sourceId, externalId,
    );
    return r && toObservation(r);
  }

  listByOperator(operatorId: string, now: number): Leg[] {
    return this.db.all<LegRow>(
      'SELECT * FROM legs WHERE operator_id = ? AND depart_latest > ? ORDER BY depart_earliest',
      operatorId, now,
    ).map(toLeg);
  }

  save(leg: Leg): void {
    this.db.run(
      `INSERT INTO legs (id, tail, operator_id, type_code, from_icao, to_icao, depart_earliest, depart_latest, ask_cents,
         currency, supply_status, commerce_status, confidence, conflicts, provenance, version, first_seen_at, last_seen_at,
         last_published_price_cents, updated_at, kind, visibility, note, freshness_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tail=excluded.tail, operator_id=excluded.operator_id, type_code=excluded.type_code,
         from_icao=excluded.from_icao, to_icao=excluded.to_icao, depart_earliest=excluded.depart_earliest,
         depart_latest=excluded.depart_latest, ask_cents=excluded.ask_cents, currency=excluded.currency,
         supply_status=excluded.supply_status, commerce_status=excluded.commerce_status, confidence=excluded.confidence,
         conflicts=excluded.conflicts, provenance=excluded.provenance, version=excluded.version,
         last_seen_at=excluded.last_seen_at, last_published_price_cents=excluded.last_published_price_cents,
         updated_at=excluded.updated_at, kind=excluded.kind, visibility=excluded.visibility, note=excluded.note,
         freshness_ms=excluded.freshness_ms`,
      leg.id, leg.tail, leg.operatorId, leg.typeCode, leg.fromIcao, leg.toIcao, leg.departEarliest, leg.departLatest,
      leg.askCents, leg.currency, leg.supplyStatus, leg.commerceStatus, leg.confidence, JSON.stringify(leg.conflicts),
      JSON.stringify(leg.provenance), leg.version, leg.firstSeenAt, leg.lastSeenAt, leg.lastPublishedPriceCents, leg.updatedAt,
      leg.kind ?? 'empty_leg', leg.visibility ?? 'public', leg.note ?? null, leg.freshnessMs ?? null,
    );
  }

  /**
   * Optimistic compare-and-set on commerce status. Returns false if someone else changed the leg first
   * (another booking grabbed it, or a feed update bumped the version).
   */
  casCommerceStatus(legId: string, expectedVersion: number, from: Leg['commerceStatus'], to: Leg['commerceStatus'], now: number): boolean {
    return this.db.run(
      `UPDATE legs SET commerce_status = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND commerce_status = ?`,
      to, now, legId, expectedVersion, from,
    ).changes === 1;
  }

  setCommerceStatus(legId: string, to: Leg['commerceStatus'], now: number): void {
    this.db.run('UPDATE legs SET commerce_status = ?, version = version + 1, updated_at = ? WHERE id = ?', to, now, legId);
  }

  setLastPublishedPrice(legId: string, cents: number): void {
    this.db.run('UPDATE legs SET last_published_price_cents = ? WHERE id = ?', cents, legId);
  }

  recordIngestError(sourceId: string, externalId: string | null, receivedAt: number, code: string, message: string, raw: unknown): void {
    this.db.run(
      'INSERT INTO ingest_errors (source_id, external_id, received_at, code, message, raw) VALUES (?, ?, ?, ?, ?, ?)',
      sourceId, externalId, receivedAt, code, message, JSON.stringify(raw),
    );
  }

  recentIngestErrors(limit = 50): Array<{ source_id: string; external_id: string | null; received_at: number; code: string; message: string }> {
    return this.db.all('SELECT source_id, external_id, received_at, code, message FROM ingest_errors ORDER BY id DESC LIMIT ?', limit);
  }
}

// ---------- market data (fuel index, FX) ----------

export interface MarketValue { value: number; asOf: number }

export class MarketRepo {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  set(key: string, value: number, asOf: number): void {
    this.db.run(
      'INSERT INTO market_data (key, value, as_of) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, as_of=excluded.as_of',
      key, value, asOf,
    );
  }
  get(key: string): MarketValue | undefined {
    const r = this.db.get<{ value: number; as_of: number }>('SELECT value, as_of FROM market_data WHERE key = ?', key);
    return r && { value: r.value, asOf: r.as_of };
  }
}

// ---------- runtime reference data, key/value, calculation cache ----------

export class ReferenceRepo {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  saveAirport(a: Airport): void {
    this.db.run('INSERT INTO ref_airports (icao, data) VALUES (?, ?) ON CONFLICT(icao) DO UPDATE SET data = excluded.data', a.icao, JSON.stringify(a));
  }
  saveAircraftType(t: AircraftType): void {
    this.db.run('INSERT INTO ref_aircraft_types (code, data) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data', t.code, JSON.stringify(t));
  }
  airports(): Airport[] {
    return this.db.all<{ data: string }>('SELECT data FROM ref_airports').map((r) => JSON.parse(r.data));
  }
  aircraftTypes(): AircraftType[] {
    return this.db.all<{ data: string }>('SELECT data FROM ref_aircraft_types').map((r) => JSON.parse(r.data));
  }
}

export class KvRepo {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  get<T>(key: string): T | undefined {
    const r = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : undefined;
  }
  set(key: string, value: unknown, now: number): void {
    this.db.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, JSON.stringify(value), now);
  }
}

export class CalcCache {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  get<T>(key: string): { data: T; fetchedAt: number } | undefined {
    const r = this.db.get<{ data: string; fetched_at: number }>('SELECT data, fetched_at FROM calc_cache WHERE key = ?', key);
    return r ? { data: JSON.parse(r.data) as T, fetchedAt: r.fetched_at } : undefined;
  }
  set(key: string, kind: string, data: unknown, now: number): void {
    this.db.run('INSERT INTO calc_cache (key, kind, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
      key, kind, JSON.stringify(data), now);
  }
  count(kind: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calc_cache WHERE kind = ?', kind)?.n ?? 0;
  }
}
