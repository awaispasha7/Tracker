// Custom charter requests: for a trip no empty leg covers.
//
//   1. create   traveler gives route, date, passengers; Aviapages charter search returns suitable
//               aircraft near the departure (photos, seats, year, operator), with market estimates.
//   2. send     traveler picks up to 5 aircraft; one Aviapages RFQ goes to their operators.
//   3. offers   operator replies arrive through the comms hub; each priced offer becomes a private,
//               bookable leg (kind=charter_offer), priced all-in by the same engine and guardrails.
//   4. book     the traveler books an offer through the normal quote -> authorize -> confirm flow.

import type { Database } from '../db/database.ts';
import type { FleetRepo, LegRepo, ReferenceRepo } from '../db/repos.ts';
import type { Outbox } from '../alerts/outbox.ts';
import type { PricingEngine } from '../pricing/engine.ts';
import type { CommsService } from '../comms/comms.ts';
import type { Calculators } from '../integrations/aviapages/calculators.ts';
import type { Clock, Leg } from '../domain/types.ts';
import { AppError, HOUR } from '../domain/types.ts';
import { newId } from '../domain/ids.ts';
import { findAirport, getAirport } from '../reference/airports.ts';
import { findAircraftType, matchTypeHint } from '../reference/aircraft-types.ts';
import { avpMinute, AviapagesError, type AviapagesClient } from '../integrations/aviapages/client.ts';
import { operatorIdFor, registerFromReply } from '../integrations/aviapages/mapping.ts';
import type { CharterSearchAircraftResult, QuoteReply } from '../integrations/aviapages/types.ts';

interface RequestRow {
  id: string; contact_name: string; contact_email: string; contact_phone: string | null; from_icao: string; to_icao: string;
  depart_at: number; pax: number; notes: string | null; status: string; options: string; external_ref: string | null;
  created_at: number; updated_at: number;
}
interface OfferRow {
  id: string; request_id: string; external_id: string | null; operator_id: string; tail: string; type_code: string; seats: number;
  operator_price_cents: number; currency: string; comment: string | null; state: string; leg_id: string | null; created_at: number;
}

export interface CharterOption {
  aircraftId: number;
  tail: string;
  type: string;
  typeCode: string | null;
  category: string | null;
  seats: number | null;
  year: number;
  images: string[];
  operator: { companyId: number; name: string };
  estimateCents: number | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OFFER_VALIDITY_MS = 72 * HOUR;
const MAX_SELECTED = 5;

export class CharterRequestService {
  private db: Database;
  private fleet: FleetRepo;
  private legs: LegRepo;
  private reference: ReferenceRepo;
  private outbox: Outbox;
  private pricing: PricingEngine;
  private comms: CommsService;
  private calculators: Calculators;
  private client: AviapagesClient | null;
  private clock: Clock;

  constructor(deps: {
    db: Database; fleet: FleetRepo; legs: LegRepo; reference: ReferenceRepo; outbox: Outbox; pricing: PricingEngine; comms: CommsService;
    calculators: Calculators; client: AviapagesClient | null; clock: Clock;
  }) {
    this.db = deps.db;
    this.fleet = deps.fleet;
    this.legs = deps.legs;
    this.reference = deps.reference;
    this.outbox = deps.outbox;
    this.pricing = deps.pricing;
    this.comms = deps.comms;
    this.calculators = deps.calculators;
    this.client = deps.client;
    this.clock = deps.clock;
    this.comms.onCharterReply = (threadId, reply) => this.onReply(threadId, reply);
  }

  get enabled(): boolean {
    return !!this.client;
  }

  async create(input: { name: string; email: string; phone?: string; from: string; to: string; date: string; time?: string; pax: number; notes?: string }) {
    if (!this.client) throw new AppError(503, 'charter_unavailable', 'Custom charter quotes are not available right now');
    if (!input?.name?.trim() || !EMAIL_RE.test(input.email ?? '')) throw new AppError(400, 'bad_contact', 'Name and a valid email are required');
    const from = findAirport(input.from);
    const to = findAirport(input.to);
    if (!from || !to) throw new AppError(400, 'unknown_airport', `Unknown airport ${!from ? input.from : input.to}`);
    if (from.icao === to.icao) throw new AppError(400, 'same_airport', 'Origin and destination must differ');
    const departAt = Date.parse(`${input.date}T${/^\d\d:\d\d$/.test(input.time ?? '') ? input.time : '12:00'}:00Z`);
    const now = this.clock.now();
    if (Number.isNaN(departAt) || departAt < now + 6 * HOUR) throw new AppError(400, 'bad_date', 'Departure must be at least 6 hours from now');
    const pax = Math.floor(Number(input.pax));
    if (!(pax >= 1 && pax <= 19)) throw new AppError(400, 'bad_pax', 'Passengers must be between 1 and 19');

    let options: CharterOption[] = [];
    let searchError: string | null = null;
    try {
      const r = await this.client.charterSearchAircraft({
        legs: [{ departure_airport: { icao: from.icao, iata: from.iata || null }, arrival_airport: { icao: to.icao, iata: to.iata || null }, pax, departure_datetime: avpMinute(departAt) }],
        allow_techstop: true,
      });
      options = (r.aircraft ?? []).filter((a) => a.company).slice(0, 12).map((a) => this.toOption(a));
    } catch (e) {
      searchError = e instanceof AviapagesError ? e.message : String(e);
    }
    // Market estimates for the distinct types offered (each type costs one call, once per route).
    const types = [...new Set(options.map((o) => o.typeCode).filter((t): t is string => !!t))].slice(0, 4);
    for (const t of types) await this.calculators.warm(from.icao, to.icao, t, { pax });
    for (const o of options) {
      const m = o.typeCode ? this.calculators.marketPrice(from.icao, to.icao, o.typeCode) : undefined;
      o.estimateCents = m ? m.priceCents : null;
    }

    const id = newId('cr');
    this.db.run(
      `INSERT INTO charter_requests (id, contact_name, contact_email, contact_phone, from_icao, to_icao, depart_at, pax, notes, status, options, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.name.trim(), input.email.trim().toLowerCase(), input.phone?.trim() || null, from.icao, to.icao, departAt, pax,
      input.notes?.trim() || null, options.length ? 'options_ready' : 'no_options', JSON.stringify(options), now, now,
    );
    return { ...this.view(id, input.email), searchError };
  }

  private toOption(a: CharterSearchAircraftResult): CharterOption {
    const typeCode = matchTypeHint(a.aircraft_type);
    const t = typeCode ? findAircraftType(typeCode) : undefined;
    return {
      aircraftId: a.id, tail: a.registration_number, type: a.aircraft_type, typeCode, category: t?.category ?? null,
      seats: a.passengers_max, year: a.year_of_production, images: (a.images ?? []).map((i) => i.url).filter(Boolean).slice(0, 4),
      operator: { companyId: a.company!.id, name: a.company!.name }, estimateCents: null,
    };
  }

  /** Sends one RFQ covering the selected aircraft; one conversation thread per operator. */
  async send(id: string, email: string, aircraftIds: number[]) {
    const req = this.row(id, email);
    if (!this.client) throw new AppError(503, 'charter_unavailable', 'Custom charter quotes are not available right now');
    if (req.status !== 'options_ready') throw new AppError(409, 'already_sent', 'This request has already been sent to operators');
    const options = (JSON.parse(req.options) as CharterOption[]).filter((o) => aircraftIds.includes(o.aircraftId));
    if (options.length === 0) throw new AppError(400, 'nothing_selected', 'Choose at least one aircraft');
    if (options.length > MAX_SELECTED) throw new AppError(400, 'too_many', `Choose at most ${MAX_SELECTED} aircraft`);
    const from = getAirport(req.from_icao);
    const to = getAirport(req.to_icao);
    const companies = [...new Map(options.map((o) => [o.operator.companyId, o.operator])).values()];
    const comment = [
      `Charter request ${from.icao} → ${to.icao}, ${new Date(req.depart_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${req.pax} passenger(s).`,
      req.notes ? `Notes: ${req.notes}` : '',
      `Please quote the aircraft listed. Reference ${id}.`,
    ].filter(Boolean).join('\n');
    const qr = await this.client.createQuoteRequest({
      legs: [{ departure_airport: { icao: from.icao, iata: from.iata || null }, arrival_airport: { icao: to.icao, iata: to.iata || null }, pax: req.pax, departure_datetime: avpMinute(req.depart_at) }],
      quote_messages: companies.map((c) => ({ company: { id: c.companyId } })),
      aircraft: options.map((o) => ({ id: o.aircraftId, tail_number: o.tail, ac_type: o.type })),
      channels: ['Email'],
      comment,
      post_to_trip_board: false,
      send_to_self: false,
    });
    for (const c of companies) {
      const operatorId = this.fleet.getOperator(operatorIdFor(c.companyId))?.id ?? operatorIdFor(c.companyId);
      if (!this.fleet.getOperator(operatorId)) {
        this.fleet.upsertOperator({ id: operatorId, name: c.name, certificate: 'Aviapages network listing (AOC not yet verified by us)', status: 'active', source: 'aviapages', externalId: String(c.companyId), contact: {} });
      }
      const threadId = this.comms.openThread({
        kind: 'charter_request', operatorId, charterRequestId: id, externalRef: `qr:${qr.id}:${c.companyId}`, status: 'awaiting_reply',
        subject: `Charter ${from.iata || from.icao} → ${to.iata || to.icao} ${new Date(req.depart_at).toISOString().slice(0, 10)} (${req.pax} pax)`,
      });
      const qm = qr.quote_messages.find((m) => m.company.id === c.companyId);
      this.comms.addMessage(threadId, { direction: 'out', channel: 'aviapages', author: 'system', body: comment, externalId: qm ? `qm:${qm.id}` : null, deliveryStatus: qm?.state ?? 'Created', meta: { quoteRequestId: qr.id } });
    }
    this.db.run('UPDATE charter_requests SET status = ?, external_ref = ?, updated_at = ? WHERE id = ?', 'sent', `qr:${qr.id}`, this.clock.now(), id);
    return this.view(id, email);
  }

  /** An operator answered: a priced "OK" becomes a private, bookable leg. */
  onReply(threadId: string, reply: QuoteReply): void {
    const t = this.comms.thread(threadId);
    const req = this.db.get<RequestRow>('SELECT * FROM charter_requests WHERE id = ?', t.charter_request_id);
    if (!req) return;
    const now = this.clock.now();
    const ok = reply.state === 'OK' && typeof reply.price === 'number' && reply.price > 0;
    const reg = registerFromReply({ fleet: this.fleet, reference: this.reference }, reply, req.from_icao);
    let legId: string | null = null;
    if (ok && reg.typeCode) {
      const leg: Leg = {
        id: newId('leg'), tail: reg.tail, operatorId: reg.operatorId, typeCode: reg.typeCode, fromIcao: req.from_icao, toIcao: req.to_icao,
        departEarliest: req.depart_at, departLatest: req.depart_at, askCents: Math.round(reply.price! * 100), currency: (reply.currency_code ?? 'USD').toUpperCase(),
        supplyStatus: 'available', commerceStatus: 'open', confidence: 1, conflicts: [], provenance: { price: 'aviapages-offer', status: 'aviapages-offer' },
        version: 1, firstSeenAt: now, lastSeenAt: now, lastPublishedPriceCents: null, updatedAt: now,
        kind: 'charter_offer', visibility: 'private', note: reply.comment, freshnessMs: OFFER_VALIDITY_MS,
      };
      this.legs.save(leg);
      legId = leg.id;
    }
    this.db.run(
      `INSERT OR IGNORE INTO charter_offers (id, request_id, external_id, operator_id, tail, type_code, seats, operator_price_cents, currency, comment, state, leg_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('of'), req.id, `reply:${reply.id}`, reg.operatorId, reg.tail, reg.typeCode ?? 'unknown', reply.aircraft.max_passengers ?? 0,
      ok ? Math.round(reply.price! * 100) : 0, (reply.currency_code ?? 'USD').toUpperCase(), reply.comment, ok ? (legId ? 'offered' : 'unsupported') : 'declined', legId, now,
    );
    if (ok && legId) {
      this.db.run("UPDATE charter_requests SET status = 'offers', updated_at = ? WHERE id = ?", now, req.id);
      this.outbox.enqueue({
        dedupeKey: `charter:${req.id}:offer:${reply.id}`, recipient: req.contact_email,
        subject: `New offer for your charter ${getAirport(req.from_icao).iata || req.from_icao} → ${getAirport(req.to_icao).iata || req.to_icao}`,
        body: `${reply.company.name} has quoted a ${reply.aircraft.aircraft_type ?? 'jet'} for your trip. View and book it on your request page. Offers are valid for 72 hours.`,
      }, now);
    }
  }

  view(id: string, email: string) {
    const req = this.row(id, email);
    const now = this.clock.now();
    const offers = this.db.all<OfferRow>('SELECT * FROM charter_offers WHERE request_id = ? ORDER BY created_at', id).map((o) => {
      const leg = o.leg_id ? this.legs.get(o.leg_id) : undefined;
      const ac = this.fleet.getAircraft(o.tail);
      const op = this.fleet.getOperator(o.operator_id);
      const price = leg && ac ? this.pricing.price({ leg, pax: req.pax, seats: ac.seats, now }) : null;
      const expired = !!leg && now - leg.lastSeenAt > OFFER_VALIDITY_MS;
      return {
        id: o.id, state: expired ? 'expired' : leg && leg.commerceStatus !== 'open' ? 'reserved' : o.state, legId: o.leg_id,
        operator: op ? { name: op.name, responseRate: op.contact?.responseRate ?? null } : null,
        aircraft: { tail: o.tail, type: findAircraftType(o.type_code)?.name ?? o.type_code, seats: o.seats || ac?.seats || null, year: ac?.year ?? null, images: ac?.images ?? [], amenities: ac?.amenities ?? {} },
        comment: o.comment,
        bookable: !!price?.ok && !expired && leg?.commerceStatus === 'open',
        price: price?.ok ? { totalCents: price.totalCents, lines: price.lines } : null,
        unavailableReason: price && !price.ok ? price.failures.map((f) => f.code) : null,
        receivedAt: new Date(o.created_at).toISOString(),
      };
    });
    const threads = this.db.all<{ id: string }>('SELECT id FROM threads WHERE charter_request_id = ?', id).map((t) => this.comms.threadView(this.comms.thread(t.id)));
    return {
      id: req.id, status: req.status, pax: req.pax, notes: req.notes,
      from: getAirport(req.from_icao), to: getAirport(req.to_icao), departAt: new Date(req.depart_at).toISOString(),
      contact: { name: req.contact_name, email: req.contact_email },
      options: JSON.parse(req.options) as CharterOption[],
      operators: threads.map((t) => ({
        name: t.operator?.name ?? 'Operator',
        status: t.messages!.some((m) => m.direction === 'in') ? 'replied' : (t.messages!.find((m) => m.channel === 'aviapages')?.deliveryStatus ?? 'sending'),
      })),
      offers,
    };
  }

  list(limit = 100) {
    return this.db.all<RequestRow>('SELECT * FROM charter_requests ORDER BY created_at DESC LIMIT ?', limit).map((r) => ({
      id: r.id, status: r.status, from: r.from_icao, to: r.to_icao, departAt: new Date(r.depart_at).toISOString(), pax: r.pax,
      contact: { name: r.contact_name, email: r.contact_email },
      offers: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM charter_offers WHERE request_id = ? AND state = 'offered'", r.id)?.n ?? 0,
    }));
  }

  private row(id: string, email: string): RequestRow {
    const r = this.db.get<RequestRow>('SELECT * FROM charter_requests WHERE id = ?', id);
    if (!r || r.contact_email !== (email ?? '').trim().toLowerCase()) throw new AppError(404, 'request_not_found', 'Charter request not found');
    return r;
  }
}

