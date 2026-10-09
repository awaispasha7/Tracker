// Keeps our inventory in step with Aviapages empty legs on a metered budget.
//
//   full sync         every listing in the window, page by page. Re-confirms everything (so
//                     listings stay fresh) and is the only way to notice removals.
//   incremental sync  only listings updated since the last cursor: cheap, catches new and
//                     changed legs within minutes.
//
// Full syncs are paced against the remaining monthly budget so the month can't be exhausted in a
// week; a reserve is always left for interactive features.

import type { Clock, FeedSource } from '../../domain/types.ts';
import { DAY, HOUR, MINUTE } from '../../domain/types.ts';
import type { FleetRepo, KvRepo, LegRepo, ReferenceRepo } from '../../db/repos.ts';
import type { IngestService } from '../../ingestion/ingest-service.ts';
import { avpMinute, AviapagesError, parseAvpTime, type AviapagesClient } from './client.ts';
import { registerFromEmptyLeg, SOURCE_ID } from './mapping.ts';
import type { AvpEmptyLeg, EmptyLegQuery } from './types.ts';

export interface SyncConfig {
  windowDays: number;
  /** Target interval between full syncs; stretched automatically if the budget can't sustain it. */
  fullEveryMs: number;
  incrementalEveryMs: number;
  maxPagesPerRun: number;
  /** Calls of the empty_legs budget kept back for on-demand use. */
  reserveCalls: number;
  /** Listings stay sellable this long after the last confirmation. */
  listingMaxAgeMs: number;
}

export const DEFAULT_SYNC: SyncConfig = {
  windowDays: 30,
  fullEveryMs: 4 * HOUR,
  incrementalEveryMs: 10 * MINUTE,
  maxPagesPerRun: 200,
  reserveCalls: 20,
  listingMaxAgeMs: 12 * HOUR,
};

export interface SyncReport {
  kind: 'full' | 'incremental';
  startedAt: string;
  finishedAt: string;
  pages: number;
  received: number;
  ingested: number;
  rejected: number;
  removed: number;
  skipped: Record<string, number>;
  complete: boolean;
  error: string | null;
}

interface SyncState {
  lastFullAt: number | null;
  lastIncrementalAt: number | null;
  cursor: string | null;
  pagesPerFull: number | null;
  lastReport: SyncReport | null;
  history: SyncReport[];
}

const STATE_KEY = 'aviapages:sync';

export class EmptyLegSync {
  readonly config: SyncConfig;
  private client: AviapagesClient;
  private ingest: IngestService;
  private fleet: FleetRepo;
  private reference: ReferenceRepo;
  private legs: LegRepo;
  private kv: KvRepo;
  private clock: Clock;
  private running = false;

  constructor(deps: {
    client: AviapagesClient; ingest: IngestService; fleet: FleetRepo; reference: ReferenceRepo; legs: LegRepo; kv: KvRepo;
    clock: Clock; config?: Partial<SyncConfig>;
  }) {
    this.client = deps.client;
    this.ingest = deps.ingest;
    this.fleet = deps.fleet;
    this.reference = deps.reference;
    this.legs = deps.legs;
    this.kv = deps.kv;
    this.clock = deps.clock;
    this.config = { ...DEFAULT_SYNC, ...deps.config };
    this.fleet.upsertSource(this.source());
  }

  source(): FeedSource {
    return {
      id: SOURCE_ID,
      name: 'Aviapages marketplace',
      kind: 'aggregator',
      operatorId: null,
      // Listings are posted by the operators themselves (often straight from their scheduling
      // software), so they rank above resellers but below a signed operator's own channel.
      trust: 0.8,
      ttlMs: this.config.listingMaxAgeMs,
      adapter: 'aviapages',
      pricesAreNet: true,
      listingMaxAgeMs: this.config.listingMaxAgeMs,
    };
  }

  state(): SyncState {
    return this.kv.get<SyncState>(STATE_KEY) ?? { lastFullAt: null, lastIncrementalAt: null, cursor: null, pagesPerFull: null, lastReport: null, history: [] };
  }

  private save(s: SyncState): void {
    this.kv.set(STATE_KEY, s, this.clock.now());
  }

  /** Interval between full syncs the remaining budget can sustain until month end. */
  pacedFullInterval(): number {
    const now = this.clock.now();
    const d = new Date(now);
    const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const pages = this.state().pagesPerFull ?? 5;
    // 70% of what's left goes to full syncs; incrementals and on-demand calls share the rest.
    const usable = Math.max(0, this.client.remaining('empty_legs') - this.config.reserveCalls) * 0.7;
    const runs = usable / pages;
    const sustainable = runs >= 1 ? (monthEnd - now) / runs : Infinity;
    return Math.max(this.config.fullEveryMs, sustainable);
  }

  status() {
    const s = this.state();
    const interval = this.pacedFullInterval();
    return {
      ...s,
      history: s.history.slice(0, 10),
      fullIntervalMs: Number.isFinite(interval) ? interval : null,
      nextFullAt: s.lastFullAt && Number.isFinite(interval) ? new Date(s.lastFullAt + interval).toISOString() : null,
      freshnessAtRisk: Number.isFinite(interval) ? interval > this.config.listingMaxAgeMs : true,
      remainingCalls: this.client.remaining('empty_legs'),
      budget: this.client.budget('empty_legs'),
    };
  }

  /** Background scheduler entry point: decides whether a full or incremental sync is due. */
  async tick(): Promise<SyncReport | null> {
    const s = this.state();
    const now = this.clock.now();
    if (!s.lastFullAt || now - s.lastFullAt >= this.pacedFullInterval()) return this.full();
    if (!s.lastIncrementalAt || now - s.lastIncrementalAt >= this.config.incrementalEveryMs) return this.incremental();
    return null;
  }

  async full(): Promise<SyncReport> {
    const now = this.clock.now();
    return this.run('full', {
      from_date_utc: avpMinute(now),
      to_date_utc: avpMinute(now + this.config.windowDays * DAY),
      has_arrival_airport: true,
    });
  }

  async incremental(): Promise<SyncReport> {
    const s = this.state();
    if (!s.cursor) return this.full();
    const now = this.clock.now();
    return this.run('incremental', {
      // One minute of overlap so a listing updated at the cursor boundary isn't missed.
      updated_at_gt: new Date(parseAvpTime(s.cursor) - MINUTE).toISOString(),
      from_date_utc: avpMinute(now),
      to_date_utc: avpMinute(now + this.config.windowDays * DAY),
      has_arrival_airport: true,
    });
  }

  private async run(kind: 'full' | 'incremental', query: EmptyLegQuery): Promise<SyncReport> {
    if (this.running) throw new AviapagesError('http', 'empty_legs', 'A sync is already running');
    this.running = true;
    const started = this.clock.now();
    const report: SyncReport = {
      kind, startedAt: new Date(started).toISOString(), finishedAt: '', pages: 0, received: 0, ingested: 0, rejected: 0, removed: 0,
      skipped: {}, complete: false, error: null,
    };
    const seen = new Set<string>();
    let maxUpdated = this.state().cursor ? parseAvpTime(this.state().cursor) : 0;
    try {
      for await (const { page, pageNo } of this.client.paginate<AvpEmptyLeg>('/v3/empty_legs/', query as Record<string, unknown>, {
        maxPages: this.config.maxPagesPerRun, reserve: this.config.reserveCalls,
      })) {
        report.pages = pageNo;
        report.received += page.results.length;
        const accepted: AvpEmptyLeg[] = [];
        for (const leg of page.results) {
          seen.add(String(leg.id));
          maxUpdated = Math.max(maxUpdated, parseAvpTime(leg.updated_at) || 0);
          const reg = registerFromEmptyLeg({ fleet: this.fleet, reference: this.reference }, leg);
          if (reg.ok) accepted.push(leg);
          else report.skipped[reg.reason!] = (report.skipped[reg.reason!] ?? 0) + 1;
        }
        if (accepted.length) {
          const r = await this.ingest.ingest(SOURCE_ID, accepted);
          report.ingested += r.accepted;
          report.rejected += r.rejected;
        }
        if (!page.next) report.complete = true;
      }
      if (kind === 'full' && report.complete) report.removed = await this.detectRemovals(seen);
    } catch (e) {
      report.error = (e as Error).message;
    } finally {
      this.running = false;
    }
    report.finishedAt = new Date(this.clock.now()).toISOString();
    const s = this.state();
    if (kind === 'full') {
      if (report.complete) {
        s.lastFullAt = started;
        s.pagesPerFull = Math.max(1, report.pages);
      }
    }
    if (report.complete || report.pages > 0) s.lastIncrementalAt = started;
    if (maxUpdated > 0) s.cursor = new Date(maxUpdated).toISOString();
    s.lastReport = report;
    s.history = [report, ...s.history].slice(0, 50);
    this.save(s);
    return report;
  }

  /** Listings we hold that a complete full sync no longer returns have been withdrawn. */
  private async detectRemovals(seen: Set<string>): Promise<number> {
    const now = this.clock.now();
    const windowEnd = now + this.config.windowDays * DAY;
    const gone: string[] = [];
    for (const { externalId } of this.legs.linksForSource(SOURCE_ID)) {
      if (seen.has(externalId)) continue;
      const last = this.legs.latestObservation(SOURCE_ID, externalId);
      if (!last || last.status !== 'available') continue;
      // Only listings inside the window we asked about can be judged missing.
      if (last.departLatest < now || last.departEarliest > windowEnd) continue;
      gone.push(externalId);
    }
    if (gone.length) await this.ingest.markUnavailable(SOURCE_ID, gone);
    return gone.length;
  }
}
