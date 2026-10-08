// Deciding what is true when feeds disagree.
//
// Inputs: the latest report from every source that has ever described this leg, our verified fleet
// registry, and the clock. Output: one canonical Leg, a confidence score, and an explicit list of
// the disagreements we saw and how we resolved them.
//
// Rules, in order of precedence:
//   1. The fleet registry is authoritative for who operates a tail and what type it is. Feeds that
//      say otherwise are recorded as conflicts, never believed.
//   2. A fresh report from the operator's own channel (API or portal) is authoritative for route,
//      departure window, price and availability. The operator is the one who will fly it.
//   3. Without an operator report, fields are decided by a trust-and-freshness-weighted vote across
//      third-party sources, and confidence reflects both corroboration and agreement.
//   4. Reports older than their source's TTL are ignored. If nothing fresh remains, the leg expires.
//      Third-party-only legs therefore drop out of search unless they keep being re-confirmed.

import type { Aircraft, Conflict, FeedSource, Leg, Observation, Operator, SupplyStatus } from '../domain/types.ts';
import { HOUR } from '../domain/types.ts';
import { getAirport } from '../reference/airports.ts';
import { getAircraftType, matchTypeHint } from '../reference/aircraft-types.ts';
import { distanceNm, estimateFlight } from '../domain/geo.ts';

export const DEPARTURE_TOLERANCE_MS = 2 * HOUR;
const TURNAROUND_MS = HOUR / 2;

export interface ReconcileInput {
  legId: string;
  existing: Leg | null;
  observations: Observation[];
  sources: Map<string, FeedSource>;
  aircraft: Aircraft | undefined;
  operator: Operator | undefined;
  now: number;
}

export interface ReconcileOutput {
  leg: Leg;
  /** Material changes vs. the previous canonical version (empty for a brand new leg). */
  changes: string[];
}

interface Weighted {
  obs: Observation;
  source: FeedSource;
  weight: number;
  authoritative: boolean;
}

/** Linear decay to half weight at the source's TTL; beyond TTL the report is dropped. */
export function freshnessWeight(source: FeedSource, receivedAt: number, now: number): number {
  const age = Math.max(0, now - receivedAt);
  if (age > source.ttlMs) return 0;
  return source.trust * (1 - 0.5 * (age / source.ttlMs));
}

/** Probability that at least one of several independent sources is right. */
function noisyOr(weights: number[]): number {
  return 1 - weights.reduce((p, w) => p * (1 - w), 1);
}

function vote<T>(items: Weighted[], key: (w: Weighted) => T): { value: T; share: number; supporters: Weighted[] } {
  const buckets = new Map<string, { value: T; weight: number; supporters: Weighted[] }>();
  let total = 0;
  for (const w of items) {
    const v = key(w);
    const k = JSON.stringify(v);
    const b = buckets.get(k) ?? { value: v, weight: 0, supporters: [] };
    b.weight += w.weight;
    b.supporters.push(w);
    buckets.set(k, b);
    total += w.weight;
  }
  const best = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  return { value: best.value, share: total > 0 ? best.weight / total : 0, supporters: best.supporters };
}

const fmtTime = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const { existing, observations, sources, aircraft, operator, now } = input;
  const conflicts: Conflict[] = [];
  const provenance: Record<string, string> = {};

  // One vote per source: if a source reported the same flight under two ids, use its latest report.
  const latestBySource = new Map<string, Observation>();
  for (const o of observations) {
    const prev = latestBySource.get(o.sourceId);
    if (!prev || o.receivedAt > prev.receivedAt) latestBySource.set(o.sourceId, o);
  }

  const weighted: Weighted[] = [];
  for (const obs of latestBySource.values()) {
    const source = sources.get(obs.sourceId);
    if (!source) continue;
    let weight = freshnessWeight(source, obs.receivedAt, now);
    if (weight <= 0) continue;
    let authoritative = false;
    if (source.operatorId) {
      if (aircraft && source.operatorId === aircraft.operatorId) authoritative = true;
      else {
        // An operator listing a tail it doesn't operate (wet-lease, typo, resale). Count it as a weak witness.
        weight *= 0.5;
        conflicts.push({
          code: 'source_not_owner',
          blocking: false,
          detail: `${source.name} reported this tail but the registry lists it under another operator`,
        });
      }
    }
    weighted.push({ obs, source, weight, authoritative });
  }

  const latestObs = [...observations].sort((a, b) => b.receivedAt - a.receivedAt)[0];
  const base: Leg = existing ?? {
    id: input.legId,
    tail: latestObs.tail,
    operatorId: null,
    typeCode: null,
    fromIcao: latestObs.fromIcao,
    toIcao: latestObs.toIcao,
    departEarliest: latestObs.departEarliest,
    departLatest: latestObs.departLatest,
    askCents: latestObs.askCents,
    currency: latestObs.currency,
    supplyStatus: 'available',
    commerceStatus: 'open',
    confidence: 0,
    conflicts: [],
    provenance: {},
    version: 1,
    firstSeenAt: now,
    lastSeenAt: latestObs.receivedAt,
    lastPublishedPriceCents: null,
    updatedAt: now,
  };

  // Registry facts first: they hold regardless of what any feed says.
  const operatorId = aircraft?.operatorId ?? null;
  const typeCode = aircraft?.typeCode ?? null;
  provenance.operator = 'registry';
  provenance.aircraftType = 'registry';
  if (!aircraft) {
    conflicts.push({ code: 'unknown_tail', blocking: true, detail: `${base.tail} is not in the verified fleet registry` });
  } else if (!operator || operator.status !== 'active') {
    conflicts.push({ code: 'operator_inactive', blocking: true, detail: `operator ${aircraft.operatorId} is not active` });
  }

  if (weighted.length === 0) {
    const leg: Leg = {
      ...base,
      operatorId,
      typeCode,
      supplyStatus: 'expired',
      confidence: 0,
      conflicts,
      provenance: { ...base.provenance, status: 'no fresh reports' },
      updatedAt: now,
    };
    return finish(existing, leg, now);
  }

  if (typeCode) {
    const mismatched = new Map<string, string>();
    for (const w of weighted) {
      const hinted = matchTypeHint(w.obs.typeHint);
      if (hinted && hinted !== typeCode) mismatched.set(w.source.id, w.obs.typeHint ?? '');
    }
    if (mismatched.size > 0) {
      conflicts.push({
        code: 'aircraft_type_mismatch',
        blocking: false,
        field: 'aircraftType',
        detail: `feed type differs from registry (${getAircraftType(typeCode).name}); registry wins`,
        values: [...mismatched].map(([sourceId, value]) => ({ sourceId, value })),
      });
    }
  }

  const authority = weighted
    .filter((w) => w.authoritative)
    .sort((a, b) => b.obs.receivedAt - a.obs.receivedAt)[0];

  // ---- route ----
  let fromIcao: string;
  let toIcao: string;
  if (authority) {
    fromIcao = authority.obs.fromIcao;
    toIcao = authority.obs.toIcao;
    provenance.route = authority.source.id;
  } else {
    const v = vote(weighted, (w) => [w.obs.fromIcao, w.obs.toIcao]);
    [fromIcao, toIcao] = v.value;
    provenance.route = v.supporters.map((s) => s.source.id).join('+');
    if (v.share < 0.67) {
      conflicts.push({
        code: 'route_disagreement',
        blocking: true,
        field: 'route',
        detail: 'third-party sources disagree on the airports and no operator report breaks the tie',
        values: weighted.map((w) => ({ sourceId: w.source.id, value: `${w.obs.fromIcao}-${w.obs.toIcao}` })),
      });
    }
  }
  const routeDisagrees = weighted.filter((w) => w.obs.fromIcao !== fromIcao || w.obs.toIcao !== toIcao);
  if (authority && routeDisagrees.length > 0) {
    conflicts.push({
      code: 'route_disagreement',
      blocking: false,
      field: 'route',
      detail: 'third-party airports differ from the operator; operator wins',
      values: routeDisagrees.map((w) => ({ sourceId: w.source.id, value: `${w.obs.fromIcao}-${w.obs.toIcao}` })),
    });
  }

  // ---- departure window ----
  let timeSource: Weighted;
  if (authority) {
    timeSource = authority;
  } else {
    // Cluster reports whose earliest departure is within tolerance of each other; take the heaviest
    // cluster and, within it, the heaviest single report.
    const clusters = weighted.map((w) => {
      const members = weighted.filter((x) => Math.abs(x.obs.departEarliest - w.obs.departEarliest) <= DEPARTURE_TOLERANCE_MS);
      return { anchor: w, weight: members.reduce((s, m) => s + m.weight, 0) };
    });
    clusters.sort((a, b) => b.weight - a.weight || b.anchor.weight - a.anchor.weight);
    timeSource = clusters[0].anchor;
  }
  const departEarliest = timeSource.obs.departEarliest;
  const departLatest = timeSource.obs.departLatest;
  provenance.departure = timeSource.source.id;
  const offTime = weighted.filter((w) => Math.abs(w.obs.departEarliest - departEarliest) > DEPARTURE_TOLERANCE_MS);
  if (offTime.length > 0) {
    const spread = Math.max(...offTime.map((w) => Math.abs(w.obs.departEarliest - departEarliest)));
    conflicts.push({
      code: 'departure_disagreement',
      blocking: !authority && spread > 6 * HOUR,
      field: 'departure',
      detail: authority
        ? 'third-party departure times differ from the operator; operator wins'
        : `sources disagree on departure by up to ${Math.round(spread / HOUR)}h`,
      values: weighted.map((w) => ({ sourceId: w.source.id, value: fmtTime(w.obs.departEarliest) })),
    });
  }

  // ---- availability ----
  let supplyStatus: SupplyStatus;
  if (authority) {
    supplyStatus = authority.obs.status === 'available' ? 'available' : 'withdrawn';
    provenance.status = authority.source.id;
    const dissent = weighted.filter((w) => !w.authoritative && w.obs.status !== authority.obs.status);
    if (dissent.length > 0) {
      conflicts.push({
        code: 'status_disagreement',
        blocking: false,
        field: 'status',
        detail: `third-party sources report ${dissent[0].obs.status}; operator reports ${authority.obs.status}; operator wins`,
        values: dissent.map((w) => ({ sourceId: w.source.id, value: w.obs.status })),
      });
    }
  } else {
    const v = vote(weighted, (w) => w.obs.status);
    // Ties go to "unavailable": selling a seat that doesn't exist is worse than missing a sale.
    const unavailableWeight = weighted.filter((w) => w.obs.status === 'unavailable').reduce((s, w) => s + w.weight, 0);
    const availableWeight = weighted.filter((w) => w.obs.status === 'available').reduce((s, w) => s + w.weight, 0);
    supplyStatus = unavailableWeight >= availableWeight ? 'withdrawn' : 'available';
    provenance.status = v.supporters.map((s) => s.source.id).join('+');
  }

  // ---- price ----
  // Only the operator's own channel gives us their net ask. Aggregator prices are someone else's
  // retail price (their margin baked in), so they are kept as reference, not used as cost.
  let askCents: number | null = null;
  let currency = 'USD';
  if (authority && authority.obs.askCents !== null) {
    askCents = authority.obs.askCents;
    currency = authority.obs.currency;
    provenance.price = authority.source.id;
    const thirdParty = weighted.filter((w) => !w.authoritative && w.obs.askCents !== null && w.obs.currency === currency);
    const far = thirdParty.filter((w) => Math.abs((w.obs.askCents as number) - askCents!) / askCents! > 0.5);
    if (far.length > 0) {
      conflicts.push({
        code: 'price_disagreement',
        blocking: false,
        field: 'price',
        detail: 'third-party prices differ from the operator ask by more than 50%',
        values: far.map((w) => ({ sourceId: w.source.id, value: String(w.obs.askCents) })),
      });
    }
  } else {
    provenance.price = 'rate-model';
  }

  // ---- physical sanity ----
  if (typeCode) {
    const type = getAircraftType(typeCode);
    const est = estimateFlight(getAirport(fromIcao), getAirport(toIcao), type);
    if (est.fuelStops > 0) {
      conflicts.push({
        code: 'fuel_stop_required',
        blocking: false,
        detail: `${Math.round(distanceNm(getAirport(fromIcao), getAirport(toIcao)))}nm exceeds ${type.name} range; ${est.fuelStops} fuel stop(s) assumed`,
      });
    }
  }

  // ---- confidence ----
  const agrees = (w: Weighted) =>
    w.obs.fromIcao === fromIcao && w.obs.toIcao === toIcao &&
    Math.abs(w.obs.departEarliest - departEarliest) <= DEPARTURE_TOLERANCE_MS &&
    (w.obs.status === 'available') === (supplyStatus === 'available');
  const supporters = weighted.filter(agrees);
  const total = weighted.reduce((s, w) => s + w.weight, 0);
  const support = supporters.reduce((s, w) => s + w.weight, 0);
  let confidence = noisyOr(supporters.map((w) => w.weight)) * (total > 0 ? support / total : 0);
  if (authority) confidence = Math.max(confidence, authority.weight);
  confidence = Math.round(confidence * 1000) / 1000;

  const leg: Leg = {
    ...base,
    operatorId,
    typeCode,
    fromIcao,
    toIcao,
    departEarliest,
    departLatest,
    askCents,
    currency,
    supplyStatus,
    confidence,
    conflicts,
    provenance,
    lastSeenAt: Math.max(...weighted.map((w) => w.obs.receivedAt)),
    updatedAt: now,
  };
  return finish(existing, leg, now);
}

function finish(existing: Leg | null, leg: Leg, now: number): ReconcileOutput {
  if (!existing) return { leg: { ...leg, firstSeenAt: now }, changes: [] };
  const changes = diffLegs(existing, leg);
  // Version only moves on material change, so confidence decay alone doesn't invalidate open quotes.
  return { leg: { ...leg, version: changes.length > 0 ? existing.version + 1 : existing.version }, changes };
}

/** Material differences between two versions of a leg (what customers and quotes care about). */
export function diffLegs(before: Leg, after: Leg): string[] {
  const changes: string[] = [];
  if (before.fromIcao !== after.fromIcao || before.toIcao !== after.toIcao) changes.push('route');
  if (before.departEarliest !== after.departEarliest || before.departLatest !== after.departLatest) changes.push('departure');
  if (before.askCents !== after.askCents || before.currency !== after.currency) changes.push('price');
  if (before.supplyStatus !== after.supplyStatus) changes.push(`status:${after.supplyStatus}`);
  if (before.operatorId !== after.operatorId || before.typeCode !== after.typeCode) changes.push('aircraft');
  const blockingKey = (l: Leg) => l.conflicts.filter((c) => c.blocking).map((c) => c.code).sort().join(',');
  if (blockingKey(before) !== blockingKey(after)) changes.push('blocking_conflicts');
  return changes;
}

/**
 * One tail cannot fly two legs whose times overlap. When two reconciled legs for the same aircraft
 * can't both happen, the one we're less sure about is quarantined. Mutates the given legs' conflicts;
 * callers decide versioning with diffLegs().
 */
export function applyTailOverlap(legs: Leg[]): void {
  for (const l of legs) l.conflicts = l.conflicts.filter((c) => c.code !== 'tail_schedule_overlap');
  const live = legs.filter((l) => l.supplyStatus === 'available' && l.typeCode).sort((a, b) => a.departEarliest - b.departEarliest);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const type = getAircraftType(a.typeCode!);
      const block = estimateFlight(getAirport(a.fromIcao), getAirport(a.toIcao), type).blockHours * HOUR;
      // After landing, the aircraft must turn around and, if b starts elsewhere, reposition there.
      const reposition = a.toIcao === b.fromIcao ? 0 : estimateFlight(getAirport(a.toIcao), getAirport(b.fromIcao), type).blockHours * HOUR;
      // Feasible if b can depart after all that, using the most generous times for each.
      if (b.departLatest >= a.departEarliest + block + TURNAROUND_MS + reposition) continue;
      let loser = a.confidence < b.confidence || (a.confidence === b.confidence && a.firstSeenAt > b.firstSeenAt) ? a : b;
      // Never quarantine something a customer already holds; the other leg yields instead.
      if (loser.commerceStatus !== 'open') loser = loser === a ? b : a;
      if (loser.commerceStatus !== 'open') continue;
      const winner = loser === a ? b : a;
      if (!loser.conflicts.some((c) => c.code === 'tail_schedule_overlap')) {
        loser.conflicts.push({
          code: 'tail_schedule_overlap',
          blocking: true,
          detail: `${loser.tail} cannot also fly ${winner.fromIcao}-${winner.toIcao} at ${fmtTime(winner.departEarliest)}; kept the higher-confidence leg`,
        });
      }
    }
  }
}
