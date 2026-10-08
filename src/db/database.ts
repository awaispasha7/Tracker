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
