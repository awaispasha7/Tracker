import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  certificate TEXT NOT NULL,
  status TEXT NOT NULL,
  api_key_hash TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS aircraft (
  tail TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  type_code TEXT NOT NULL,
  seats INTEGER NOT NULL,
  home_base TEXT NOT NULL,
  year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  operator_id TEXT REFERENCES operators(id),
  trust REAL NOT NULL,
  ttl_ms INTEGER NOT NULL,
  adapter TEXT NOT NULL,
  api_key_hash TEXT UNIQUE
);

-- Append-only log of every normalized report we receive. The canonical leg is derived from this.
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  tail TEXT NOT NULL,
  from_icao TEXT NOT NULL,
  to_icao TEXT NOT NULL,
  depart_earliest INTEGER NOT NULL,
  depart_latest INTEGER NOT NULL,
  ask_cents INTEGER,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  type_hint TEXT,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_by_ext ON observations(source_id, external_id, received_at);

CREATE TABLE IF NOT EXISTS leg_links (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS leg_links_by_leg ON leg_links(leg_id);

CREATE TABLE IF NOT EXISTS legs (
  id TEXT PRIMARY KEY,
  tail TEXT NOT NULL,
  operator_id TEXT,
  type_code TEXT,
  from_icao TEXT NOT NULL,
  to_icao TEXT NOT NULL,
  depart_earliest INTEGER NOT NULL,
  depart_latest INTEGER NOT NULL,
  ask_cents INTEGER,
  currency TEXT NOT NULL,
  supply_status TEXT NOT NULL,
  commerce_status TEXT NOT NULL DEFAULT 'open',
  confidence REAL NOT NULL,
  conflicts TEXT NOT NULL DEFAULT '[]',
  provenance TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_published_price_cents INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS legs_by_tail ON legs(tail, depart_earliest);
CREATE INDEX IF NOT EXISTS legs_by_origin ON legs(from_icao, depart_earliest);

CREATE TABLE IF NOT EXISTS ingest_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT,
  received_at INTEGER NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  raw TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_data (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  as_of INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  leg_id TEXT NOT NULL,
  leg_version INTEGER NOT NULL,
  pax INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  breakdown TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pax INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  operator_payout_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  passengers TEXT NOT NULL,
  agreement TEXT NOT NULL,
  payment_intent_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  hold_expires_at INTEGER,
  history TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_by_status ON bookings(status, hold_expires_at);
CREATE INDEX IF NOT EXISTS bookings_by_leg ON bookings(leg_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  memo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  from_icao TEXT NOT NULL,
  to_icao TEXT,
  radius_nm INTEGER NOT NULL,
  pax INTEGER NOT NULL,
  max_price_cents INTEGER,
  window_start INTEGER,
  window_end INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Reference data learned at runtime (the curated lists in src/reference are only seeds).
CREATE TABLE IF NOT EXISTS ref_airports (
  icao TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ref_aircraft_types (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- Third-party API accounting: calls per endpoint per month, against a budget.
CREATE TABLE IF NOT EXISTS api_usage (
  provider TEXT NOT NULL,
  month TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_at INTEGER,
  PRIMARY KEY (provider, month, endpoint)
);

-- Every raw response we pay for is kept, so data outlives a trial and can be replayed offline.
CREATE TABLE IF NOT EXISTS api_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  request TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS api_archive_by_endpoint ON api_archive(provider, endpoint, fetched_at);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Cached third-party calculations (flight time, market price), keyed by route + aircraft.
CREATE TABLE IF NOT EXISTS calc_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Operator communications: one thread per (subject, operator); messages in both directions on any channel.
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  operator_id TEXT,
  booking_id TEXT,
  charter_request_id TEXT,
  external_ref TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_by_operator ON threads(operator_id, updated_at);
CREATE INDEX IF NOT EXISTS threads_by_booking ON threads(booking_id);
CREATE INDEX IF NOT EXISTS threads_by_ref ON threads(external_ref);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  price_cents INTEGER,
  currency TEXT,
  external_id TEXT UNIQUE,
  delivery_status TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, id);

-- Custom charter requests (a route with no matching empty leg) and the offers operators send back.
CREATE TABLE IF NOT EXISTS charter_requests (
  id TEXT PRIMARY KEY,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  from_icao TEXT NOT NULL,
  to_icao TEXT NOT NULL,
  depart_at INTEGER NOT NULL,
  pax INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  external_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS charter_offers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  external_id TEXT UNIQUE,
  operator_id TEXT NOT NULL,
  tail TEXT NOT NULL,
  type_code TEXT NOT NULL,
  seats INTEGER NOT NULL,
  operator_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  comment TEXT,
  state TEXT NOT NULL,
  leg_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS charter_offers_by_request ON charter_offers(request_id);

-- FAA Part 135 certificate holders and the aircraft on their certificates (replaced on each import).
CREATE TABLE IF NOT EXISTS faa_operators (
  designator TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  district_office TEXT,
  aircraft_count INTEGER NOT NULL,
  jet_count INTEGER NOT NULL,
  categories TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS faa_aircraft (
  tail TEXT PRIMARY KEY,
  designator TEXT NOT NULL,
  serial TEXT,
  model TEXT NOT NULL,
  category TEXT,
  suggested_type TEXT
);
CREATE INDEX IF NOT EXISTS faa_aircraft_by_designator ON faa_aircraft(designator);

-- Sales pipeline: FAA operators we may sign, and operators who applied. Survives FAA re-imports.
CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  designator TEXT,
  company TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes TEXT,
  application TEXT,
  operator_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS prospects_by_designator ON prospects(designator) WHERE designator IS NOT NULL;

-- Transactional outbox: written in the same transaction as the state change, delivered later.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
`;

export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Additive column migrations for databases created by earlier versions. */
  private migrate(): void {
    const add = (table: string, column: string, ddl: string) => {
      const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    };
    add('operators', 'source', "TEXT NOT NULL DEFAULT 'direct'");
    add('operators', 'external_id', 'TEXT');
    add('operators', 'contact', "TEXT NOT NULL DEFAULT '{}'");
    add('aircraft', 'source', "TEXT NOT NULL DEFAULT 'direct'");
    add('aircraft', 'external_id', 'TEXT');
    add('aircraft', 'images', "TEXT NOT NULL DEFAULT '[]'");
    add('aircraft', 'amenities', "TEXT NOT NULL DEFAULT '{}'");
    add('legs', 'kind', "TEXT NOT NULL DEFAULT 'empty_leg'");
    add('legs', 'visibility', "TEXT NOT NULL DEFAULT 'public'");
    add('legs', 'note', 'TEXT');
    add('legs', 'freshness_ms', 'INTEGER');
    add('observations', 'note', 'TEXT');
    add('feed_sources', 'prices_are_net', 'INTEGER NOT NULL DEFAULT 0');
    add('feed_sources', 'listing_max_age_ms', 'INTEGER');
    this.raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS operators_by_external ON operators(external_id) WHERE external_id IS NOT NULL');
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs fn in a write transaction (BEGIN IMMEDIATE). Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;
