// Route alerts: travelers register what they want; the moment matching supply appears (or gets
// cheaper), they hear about it. Empty legs often sell within hours, so alerts are evaluated on
// every inventory change rather than on a schedule.

import type { Database } from '../db/database.ts';
import type { Clock } from '../domain/types.ts';
import { AppError, DAY } from '../domain/types.ts';
import type { SearchIndex, IndexedLeg } from '../inventory/search.ts';
import type { Outbox } from './outbox.ts';
import { findAirport } from '../reference/airports.ts';
import { distanceNm } from '../domain/geo.ts';
import { newId } from '../domain/ids.ts';

interface AlertRow {
  id: string; email: string; from_icao: string; to_icao: string | null; radius_nm: number; pax: number;
  max_price_cents: number | null; window_start: number | null; window_end: number | null; active: number; created_at: number;
}

export interface CreateAlertInput {
  email: string;
  from: string;
  to?: string | null;
  radiusNm?: number;
  pax?: number;
  maxPriceCents?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export class AlertService {
  private db: Database;
  private search: SearchIndex;
  private outbox: Outbox;
  private clock: Clock;

  constructor(deps: { db: Database; search: SearchIndex; outbox: Outbox; clock: Clock }) {
    this.db = deps.db;
    this.search = deps.search;
    this.outbox = deps.outbox;
    this.clock = deps.clock;
  }

  create(input: CreateAlertInput) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? '')) throw new AppError(400, 'bad_email', 'A valid email is required');
    const from = findAirport(input.from);
    if (!from) throw new AppError(400, 'unknown_origin', `Unknown origin airport ${input.from}`);
    const to = input.to ? findAirport(input.to) : undefined;
    if (input.to && !to) throw new AppError(400, 'unknown_destination', `Unknown destination airport ${input.to}`);
    const now = this.clock.now();
    const id = newId('al');
    const ws = input.dateFrom ? Date.parse(`${input.dateFrom}T00:00:00Z`) : null;
    const we = input.dateTo ? Date.parse(`${input.dateTo}T00:00:00Z`) + DAY : null;
    this.db.run(
      `INSERT INTO alerts (id, email, from_icao, to_icao, radius_nm, pax, max_price_cents, window_start, window_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.email.trim().toLowerCase(), from.icao, to?.icao ?? null, Math.min(300, Math.max(0, input.radiusNm ?? 75)),
      Math.max(1, input.pax ?? 1), input.maxPriceCents ?? null, ws, we, now,
    );
    const matched = this.evaluate(this.search.allIndexed(now), [this.get(id)!]);
    return { id, matchedNow: matched };
  }

  deactivate(id: string, email: string): void {
    const r = this.db.run('UPDATE alerts SET active = 0 WHERE id = ? AND email = ?', id, (email ?? '').trim().toLowerCase());
    if (r.changes === 0) throw new AppError(404, 'alert_not_found', 'Alert not found');
  }

  list(email: string) {
    return this.db.all<AlertRow>('SELECT * FROM alerts WHERE email = ? AND active = 1 ORDER BY created_at DESC', (email ?? '').trim().toLowerCase());
  }

  /** Called after inventory changes with the legs that became listable or changed. */
  onLegsChanged(legIds: Iterable<string>): number {
    const ids = new Set(legIds);
    if (ids.size === 0) return 0;
    const now = this.clock.now();
    const legs = this.search.allIndexed(now).filter((e) => ids.has(e.leg.id));
    if (legs.length === 0) return 0;
    return this.evaluate(legs, this.db.all<AlertRow>('SELECT * FROM alerts WHERE active = 1'));
  }

  private get(id: string): AlertRow | undefined {
    return this.db.get<AlertRow>('SELECT * FROM alerts WHERE id = ?', id);
  }

  private evaluate(legs: IndexedLeg[], alerts: AlertRow[]): number {
    const now = this.clock.now();
    let sent = 0;
    for (const alert of alerts) {
      const from = findAirport(alert.from_icao)!;
      const to = alert.to_icao ? findAirport(alert.to_icao)! : null;
      for (const entry of legs) {
        const { leg } = entry;
        if (distanceNm(from, entry.from) > alert.radius_nm) continue;
        if (to && distanceNm(to, entry.to) > alert.radius_nm) continue;
        if (entry.seats < alert.pax) continue;
        if (alert.window_start !== null && leg.departLatest < alert.window_start) continue;
        if (alert.window_end !== null && leg.departEarliest >= alert.window_end) continue;
        const price = this.search.priceForDisplay(entry, alert.pax, now);
        if (!price.ok) continue;
        if (alert.max_price_cents !== null && price.totalCents > alert.max_price_cents) continue;
        // One alert per leg per price point: a later price drop is news, a re-ingest isn't.
        const fresh = this.outbox.enqueue({
          dedupeKey: `alert:${alert.id}:${leg.id}:${price.totalCents}`,
          recipient: alert.email,
          subject: `Empty leg: ${entry.from.iata} → ${entry.to.iata} ${new Date(leg.departEarliest).toISOString().slice(0, 10)} — $${Math.round(price.totalCents / 100).toLocaleString('en-US')}`,
          body: `${entry.type.name} (${entry.seats} seats) operated by ${entry.operator.name}. ${price.savingsPct}% below a regular one-way charter. Empty legs go fast: book at /#leg=${leg.id}`,
        }, now);
        if (fresh) sent++;
      }
    }
    return sent;
  }
}
