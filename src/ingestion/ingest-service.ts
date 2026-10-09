// Ingestion pipeline: raw feed payload -> adapter -> observations (append-only) -> identity
// matching -> reconciliation -> canonical legs -> downstream effects (search index, bookings
// whose flight changed or vanished, route alerts).

import type { Database } from '../db/database.ts';
import type { FleetRepo, LegRepo } from '../db/repos.ts';
import type { Clock, FeedSource, Leg, Observation } from '../domain/types.ts';
import { AppError, DAY, HOUR } from '../domain/types.ts';
import { runAdapter } from './adapters.ts';
import { applyTailOverlap, diffLegs, reconcile } from './reconcile.ts';
import { getAirport } from '../reference/airports.ts';
import { distanceNm } from '../domain/geo.ts';
import { newId } from '../domain/ids.ts';
import { isListable, type SearchIndex } from '../inventory/search.ts';
import type { BookingService } from '../booking/booking-service.ts';
import type { AlertService } from '../alerts/alerts.ts';

/** Two reports describe the same flight if same tail, airports within this distance, departures within this time. */
const MATCH_AIRPORT_NM = 30;
const MATCH_DEPARTURE_MS = 6 * HOUR;

export interface IngestReport {
  sourceId: string;
  received: number;
  accepted: number;
  rejected: number;
  legsCreated: number;
  legsUpdated: number;
  issues: Array<{ externalId: string | null; code: string; message: string }>;
}

export class IngestService {
  private db: Database;
  private fleet: FleetRepo;
  private legs: LegRepo;
  private search: SearchIndex;
  private bookings: BookingService;
  private alerts: AlertService;
  private clock: Clock;
  private minConfidence: number;

  constructor(deps: {
    db: Database; fleet: FleetRepo; legs: LegRepo; search: SearchIndex; bookings: BookingService; alerts: AlertService;
    clock: Clock; minConfidence: number;
  }) {
    this.db = deps.db;
    this.fleet = deps.fleet;
    this.legs = deps.legs;
    this.search = deps.search;
    this.bookings = deps.bookings;
    this.alerts = deps.alerts;
    this.clock = deps.clock;
    this.minConfidence = deps.minConfidence;
  }

  /** `format: 'csv'` lets operator-owned sources upload a spreadsheet instead of their usual format. */
  async ingest(sourceId: string, payload: unknown, format?: 'csv'): Promise<IngestReport> {
    const source = this.fleet.getSource(sourceId);
    if (!source) throw new AppError(404, 'unknown_source', `Unknown feed source ${sourceId}`);
    if (format === 'csv' && !source.operatorId) throw new AppError(400, 'csv_not_allowed', 'CSV upload is only available to operator sources');
    const now = this.clock.now();
    const { observations, issues } = runAdapter(format ?? source.adapter, payload, source.id, now);
    const report: IngestReport = {
      sourceId, received: observations.length + issues.length, accepted: 0, rejected: issues.length,
      legsCreated: 0, legsUpdated: 0, issues: issues.map(({ externalId, code, message }) => ({ externalId, code, message })),
    };

    const touched = new Set<string>();
    this.db.tx(() => {
      for (const issue of issues) this.legs.recordIngestError(source.id, issue.externalId, now, issue.code, issue.message, issue.raw);
      for (const { obs, raw } of observations) {
        if (obs.departLatest < now) {
          report.rejected++;
          report.issues.push({ externalId: obs.externalId, code: 'departed', message: 'departure is in the past' });
          continue;
        }
        this.legs.insertObservation(obs, raw);
        touched.add(this.resolveLegId(source, obs));
        report.accepted++;
      }
    });

    const effects = this.reconcileLegs(touched, now);
    report.legsCreated = effects.created;
    report.legsUpdated = effects.updated;
    await this.applyEffects(effects);
    return report;
  }

  /** Periodic pass: re-evaluate every live leg so confidence decays and silent legs expire. */
  async refresh(): Promise<{ updated: number }> {
    const now = this.clock.now();
    const ids = this.legs.listActive(now).map((l) => l.id);
    const effects = this.reconcileLegs(new Set(ids), now);
    await this.applyEffects(effects);
    return { updated: effects.updated };
  }

  /**
   * The operator says everything they have listed is still on ("still available" in the portal):
   * their latest report for each live leg is repeated as a fresh one, so listings posted once,
   * weeks ahead, stay sellable without retyping them.
   */
  async reconfirm(operatorId: string): Promise<{ reconfirmed: number }> {
    const now = this.clock.now();
    const touched = new Set<string>();
    const sources = this.fleet.listSources().filter((s) => s.operatorId === operatorId);
    this.db.tx(() => {
      for (const source of sources) {
        for (const { externalId, legId } of this.legs.linksForSource(source.id)) {
          const last = this.legs.latestObservation(source.id, externalId);
          if (!last || last.status !== 'available' || last.departLatest <= now) continue;
          this.legs.insertObservation({ ...last, receivedAt: now }, { reconfirmed: true });
          touched.add(legId);
        }
      }
    });
    const effects = this.reconcileLegs(touched, now);
    await this.applyEffects(effects);
    return { reconfirmed: touched.size };
  }

  /**
   * A source stopped listing these records (e.g. they vanished from a complete full sync). Recorded
   * as fresh "unavailable" reports from that source, so reconciliation decides what it means.
   */
  async markUnavailable(sourceId: string, externalIds: string[]): Promise<{ updated: number }> {
    const now = this.clock.now();
    const touched = new Set<string>();
    this.db.tx(() => {
      for (const externalId of externalIds) {
        const last = this.legs.latestObservation(sourceId, externalId);
        const legId = this.legs.linkedLegId(sourceId, externalId);
        if (!last || !legId || last.status === 'unavailable') continue;
        this.legs.insertObservation({ ...last, receivedAt: now, status: 'unavailable' }, { removedFromSource: true });
        touched.add(legId);
      }
    });
    const effects = this.reconcileLegs(touched, now);
    await this.applyEffects(effects);
    return { updated: effects.updated };
  }

  /** Operator cancels one of its legs from the portal: recorded as an authoritative observation. */
  async operatorWithdraw(operatorId: string, legId: string): Promise<Leg> {
    const leg = this.legs.get(legId);
    if (!leg || leg.operatorId !== operatorId) throw new AppError(404, 'leg_not_found', 'Leg not found');
    const portal = this.fleet.listSources().find((s) => s.kind === 'operator_portal' && s.operatorId === operatorId);
    if (!portal) throw new AppError(409, 'no_portal_source', 'Operator has no portal source configured');
    await this.ingest(portal.id, [{
      externalId: `withdraw-${leg.id}`,
      tailNumber: leg.tail,
      from: leg.fromIcao,
      to: leg.toIcao,
      departureEarliest: new Date(leg.departEarliest).toISOString(),
      departureLatest: new Date(leg.departLatest).toISOString(),
      price: leg.askCents === null ? null : { amount: leg.askCents, currency: leg.currency },
      status: 'cancelled',
    }]);
    return this.legs.get(legId)!;
  }

  // ---------- internals ----------

  private resolveLegId(source: FeedSource, obs: Observation): string {
    const linked = this.legs.linkedLegId(source.id, obs.externalId);
    if (linked) return linked;
    const from = getAirport(obs.fromIcao);
    const to = getAirport(obs.toIcao);
    const candidates = this.legs.byTailNear(obs.tail, obs.departEarliest - MATCH_DEPARTURE_MS, obs.departEarliest + MATCH_DEPARTURE_MS)
      .filter((l) => distanceNm(getAirport(l.fromIcao), from) <= MATCH_AIRPORT_NM && distanceNm(getAirport(l.toIcao), to) <= MATCH_AIRPORT_NM)
      .sort((a, b) => Math.abs(a.departEarliest - obs.departEarliest) - Math.abs(b.departEarliest - obs.departEarliest));
    const legId = candidates[0]?.id ?? newId('leg');
    this.legs.link(source.id, obs.externalId, legId);
    return legId;
  }

  private reconcileLegs(ids: Set<string>, now: number): Effects {
    const effects: Effects = { created: 0, updated: 0, withdrawnWithBookings: [], changed: [], alertCandidates: [] };
    if (ids.size === 0) return effects;
    const sources = new Map(this.fleet.listSources().map((s) => [s.id, s]));
    this.db.tx(() => {
      for (const id of ids) {
        const stored = this.legs.get(id) ?? null;
        const observations = this.legs.latestObservationsForLeg(id);
        if (observations.length === 0) continue;
        const tail = observations[0].tail;
        const aircraft = this.fleet.getAircraft(tail);
        const operator = aircraft ? this.fleet.getOperator(aircraft.operatorId) : undefined;
        const { leg } = reconcile({ legId: id, existing: stored, observations, sources, aircraft, operator, now });

        // Re-check the whole tail's schedule around this leg; another leg may now lose (or win) an overlap.
        const neighbours = this.legs.byTailNear(leg.tail, leg.departEarliest - 3 * DAY, leg.departEarliest + 3 * DAY).filter((l) => l.id !== id);
        const group = [leg, ...neighbours];
        applyTailOverlap(group);

        for (const l of group) {
          const before = l.id === id ? stored : this.legs.get(l.id)!;
          const changes = before ? diffLegs(before, l) : [];
          if (before) l.version = before.version + (changes.length > 0 ? 1 : 0);
          if (before && JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...l, updatedAt: 0 })) continue;
          this.legs.save(l);
          if (!before) effects.created++;
          else effects.updated++;

          const wasListable = !!before && isListable(before, this.minConfidence);
          const nowListable = isListable(l, this.minConfidence);
          if (nowListable && (!wasListable || changes.includes('price') || changes.includes('departure'))) effects.alertCandidates.push(l.id);
          if (before && before.commerceStatus !== 'open' && before.supplyStatus === 'available' && l.supplyStatus !== 'available') {
            effects.withdrawnWithBookings.push(l.id);
          } else if (before && before.commerceStatus !== 'open' && changes.length > 0) {
            effects.changed.push({ leg: l, changes });
          }
        }
      }
    });
    return effects;
  }

  private async applyEffects(effects: Effects): Promise<void> {
    if (effects.created + effects.updated > 0) this.search.invalidate();
    for (const { leg, changes } of effects.changed) this.bookings.handleLegChanged(leg, changes);
    for (const legId of effects.withdrawnWithBookings) await this.bookings.handleLegWithdrawn(legId);
    if (effects.alertCandidates.length > 0) this.alerts.onLegsChanged(effects.alertCandidates);
  }
}

interface Effects {
  created: number;
  updated: number;
  withdrawnWithBookings: string[];
  changed: Array<{ leg: Leg; changes: string[] }>;
  alertCandidates: string[];
}
