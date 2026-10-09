// From a selected flight to a confirmed, paid trip.
//
//   quote ──► pending ──auth ok──► authorized ──operator confirms + capture──► confirmed ──► completed
//               │                     │  │  │                                    │
//               └─auth fails──► payment_failed  ├─operator declines ─► declined        └─operator cancels ─► cancelled_by_operator (refund)
//                                     │  └─hold expires ─► expired
//                                     └─customer cancels ─► cancelled_by_customer
//
// Invariants:
//   - A leg is held by at most one booking (compare-and-set on the leg's version + commerce status).
//   - A quote is only honoured if the leg hasn't materially changed since it was priced, the quote
//     hasn't expired, and the price still passes guardrails at booking time.
//   - Money moves only on operator confirmation (auth at request, capture at confirm), so we never
//     hold a customer's money for a flight the operator hasn't committed to.
//   - Every payment call carries an idempotency key derived from the booking id and step.
//   - Every state transition is a compare-and-set on the current status, so concurrent or repeated
//     calls (double-clicks, webhook retries, sweeper races) apply at most once.

import type { Database } from '../db/database.ts';
import type { FleetRepo, LegRepo } from '../db/repos.ts';
import type { PricingEngine, PriceLine } from '../pricing/engine.ts';
import type { PaymentProvider } from './payments.ts';
import type { Outbox } from '../alerts/outbox.ts';
import type { Clock, Leg } from '../domain/types.ts';
import { AppError, HOUR } from '../domain/types.ts';
import { newId } from '../domain/ids.ts';
import { getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { AGREEMENT_HASH, AGREEMENT_VERSION } from './agreement.ts';

export type BookingStatus =
  | 'pending' | 'authorized' | 'confirmed' | 'completed'
  | 'payment_failed' | 'declined' | 'expired' | 'cancelled_by_customer' | 'cancelled_by_operator';

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['authorized', 'payment_failed'],
  authorized: ['confirmed', 'declined', 'expired', 'cancelled_by_customer', 'cancelled_by_operator', 'payment_failed'],
  confirmed: ['cancelled_by_operator', 'completed'],
  completed: [],
  payment_failed: [],
  declined: [],
  expired: [],
  cancelled_by_customer: [],
  cancelled_by_operator: [],
};

export interface BookingConfig {
  /** How long an operator has to confirm before the hold lapses. */
  operatorConfirmSlaMs: number;
  /** Network operators answer RFQs by email, so they get longer to confirm than signed operators. */
  externalOperatorSlaMs: number;
  /** Holds also lapse this long before departure, so the operator isn't asked too late. */
  holdCutoffBeforeDepartureMs: number;
}

export const DEFAULT_BOOKING: BookingConfig = {
  operatorConfirmSlaMs: 2 * HOUR,
  externalOperatorSlaMs: 6 * HOUR,
  holdCutoffBeforeDepartureMs: 2 * HOUR,
};

interface QuoteRow {
  id: string; leg_id: string; leg_version: number; pax: number; total_cents: number; currency: string;
  breakdown: string; created_at: number; expires_at: number;
}

interface BookingRow {
  id: string; quote_id: string; leg_id: string; operator_id: string; status: BookingStatus; pax: number;
  total_cents: number; operator_payout_cents: number; platform_fee_cents: number; tax_cents: number; currency: string;
  contact_name: string; contact_email: string; passengers: string; agreement: string; payment_intent_id: string | null;
  idempotency_key: string; hold_expires_at: number | null; history: string; created_at: number; updated_at: number;
}

export interface QuoteView {
  quoteId: string;
  legId: string;
  pax: number;
  totalCents: number;
  currency: string;
  lines: PriceLine[];
  savingsPct: number;
  fullCharterEstimateCents: number;
  expiresAt: string;
  agreement: { version: string; hash: string };
}

export interface CreateBookingInput {
  quoteId: string;
  contact: { name: string; email: string; phone?: string };
  passengers: Array<{ name: string }>;
  paymentToken: string;
  agreement: { accepted: boolean; signedName: string; version: string };
  meta?: { ip?: string; userAgent?: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BookingService {
  private db: Database;
  private legs: LegRepo;
  private fleet: FleetRepo;
  private pricing: PricingEngine;
  private payments: PaymentProvider;
  private outbox: Outbox;
  private clock: Clock;
  private config: BookingConfig;
  private onInventoryChange: () => void;
  /** Set by the communications hub: asks the operator to confirm once the card is authorized. */
  hooks: { onAuthorized?: (bookingId: string) => Promise<void> | void } = {};

  constructor(deps: {
    db: Database; legs: LegRepo; fleet: FleetRepo; pricing: PricingEngine; payments: PaymentProvider;
    outbox: Outbox; clock: Clock; config?: BookingConfig; onInventoryChange?: () => void;
  }) {
    this.db = deps.db;
    this.legs = deps.legs;
    this.fleet = deps.fleet;
    this.pricing = deps.pricing;
    this.payments = deps.payments;
    this.outbox = deps.outbox;
    this.clock = deps.clock;
    this.config = deps.config ?? DEFAULT_BOOKING;
    this.onInventoryChange = deps.onInventoryChange ?? (() => {});
  }

  // ---------- quotes ----------

  createQuote(legId: string, pax: number): QuoteView {
    const now = this.clock.now();
    const leg = this.legs.get(legId);
    if (!leg) throw new AppError(404, 'leg_not_found', 'Flight not found');
    if (leg.commerceStatus !== 'open') throw new AppError(409, 'leg_unavailable', 'This flight has just been reserved by someone else');
    const seats = this.fleet.getAircraft(leg.tail)?.seats ?? 0;
    const price = this.pricing.price({ leg, pax, seats, now });
    if (!price.ok) {
      throw new AppError(409, 'not_bookable', 'This flight cannot be booked right now', price.failures.map((f) => f.code));
    }
    const id = newId('qt');
    const expiresAt = now + this.pricing.config.quoteTtlMs;
    const breakdown = { lines: price.lines, operatorPayoutCents: price.operatorPayoutCents, platformFeeCents: price.platformFeeCents,
      taxCents: price.taxCents, savingsPct: price.savingsPct, fullCharterEstimateCents: price.fullCharterEstimateCents };
    this.db.run(
      `INSERT INTO quotes (id, leg_id, leg_version, pax, total_cents, currency, breakdown, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, leg.id, leg.version, pax, price.totalCents, price.currency, JSON.stringify(breakdown), now, expiresAt,
    );
    return {
      quoteId: id, legId: leg.id, pax, totalCents: price.totalCents, currency: price.currency, lines: price.lines,
      savingsPct: price.savingsPct, fullCharterEstimateCents: price.fullCharterEstimateCents,
      expiresAt: new Date(expiresAt).toISOString(), agreement: { version: AGREEMENT_VERSION, hash: AGREEMENT_HASH },
    };
  }

  // ---------- booking ----------

  async createBooking(input: CreateBookingInput, idempotencyKey: string): Promise<ReturnType<BookingService['view']>> {
    if (!idempotencyKey || idempotencyKey.length < 8) throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8+ chars) is required');
    const prior = this.db.get<BookingRow>('SELECT * FROM bookings WHERE idempotency_key = ?', idempotencyKey);
    if (prior) {
      if (prior.quote_id !== input.quoteId) throw new AppError(409, 'idempotency_key_reused', 'Idempotency key was used for a different request');
      return this.view(prior.id);
    }
    this.validate(input);
    const now = this.clock.now();

    // Step 1: atomically validate the quote and put a hold on the leg.
    const bookingId = this.db.tx(() => {
      const quote = this.db.get<QuoteRow>('SELECT * FROM quotes WHERE id = ?', input.quoteId);
      if (!quote) throw new AppError(404, 'quote_not_found', 'Quote not found');
      if (quote.expires_at < now) throw new AppError(409, 'quote_expired', 'This price has expired; please refresh to get a new quote');
      if (input.passengers.length !== quote.pax) throw new AppError(400, 'passenger_count_mismatch', `Quote is for ${quote.pax} passenger(s)`);
      const leg = this.legs.get(quote.leg_id);
      if (!leg) throw new AppError(404, 'leg_not_found', 'Flight not found');
      if (leg.commerceStatus !== 'open') throw new AppError(409, 'leg_unavailable', 'This flight has just been reserved by someone else');
      if (leg.version !== quote.leg_version) throw new AppError(409, 'quote_stale', 'Flight details changed since you were quoted; please review the new price');
      // Re-check guardrails at the moment of sale: lead time and freshness are time-dependent.
      const seats = this.fleet.getAircraft(leg.tail)?.seats ?? 0;
      const reprice = this.pricing.price({ leg, pax: quote.pax, seats, now });
      if (!reprice.ok) throw new AppError(409, 'not_bookable', 'This flight cannot be booked right now', reprice.failures.map((f) => f.code));
      if (reprice.totalCents !== quote.total_cents) throw new AppError(409, 'quote_stale', 'Price changed since you were quoted; please review the new price');
      if (!this.legs.casCommerceStatus(leg.id, leg.version, 'open', 'held', now)) {
        throw new AppError(409, 'leg_unavailable', 'This flight has just been reserved by someone else');
      }
      const breakdown = JSON.parse(quote.breakdown) as { operatorPayoutCents: number; platformFeeCents: number; taxCents: number };
      const id = newId('bk');
      const external = this.fleet.getOperator(leg.operatorId!)?.source === 'aviapages';
      const sla = external ? this.config.externalOperatorSlaMs : this.config.operatorConfirmSlaMs;
      const holdExpiresAt = Math.min(now + sla, leg.departEarliest - this.config.holdCutoffBeforeDepartureMs);
      const agreement = {
        version: AGREEMENT_VERSION, hash: AGREEMENT_HASH, signedName: input.agreement.signedName.trim(),
        acceptedAt: new Date(now).toISOString(), ip: input.meta?.ip ?? null, userAgent: input.meta?.userAgent ?? null,
      };
      this.db.run(
        `INSERT INTO bookings (id, quote_id, leg_id, operator_id, status, pax, total_cents, operator_payout_cents, platform_fee_cents,
           tax_cents, currency, contact_name, contact_email, passengers, agreement, idempotency_key, hold_expires_at, history,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, quote.id, leg.id, leg.operatorId!, quote.pax, quote.total_cents, breakdown.operatorPayoutCents, breakdown.platformFeeCents,
        breakdown.taxCents, quote.currency, input.contact.name.trim(), input.contact.email.trim().toLowerCase(),
        JSON.stringify(input.passengers.map((p) => ({ name: p.name.trim() }))), JSON.stringify(agreement), idempotencyKey,
        holdExpiresAt, JSON.stringify([{ at: new Date(now).toISOString(), status: 'pending', note: 'flight held' }]), now, now,
      );
      return id;
    });
    this.onInventoryChange();

    // Step 2: authorize the card (outside the transaction: never hold a DB lock across a network call).
    const b = this.row(bookingId);
    const auth = await this.payments.authorize({
      amountCents: b.total_cents, currency: b.currency, token: input.paymentToken,
      description: `Empty leg ${bookingId}`, idempotencyKey: `${bookingId}:auth`,
    });

    // Step 3: record the outcome.
    const later = this.clock.now();
    this.db.tx(() => {
      if (!auth.ok) {
        this.transition(bookingId, 'pending', 'payment_failed', later, `${auth.code}: ${auth.message}`);
        this.releaseLeg(b.leg_id, later);
        return;
      }
      this.db.run('UPDATE bookings SET payment_intent_id = ? WHERE id = ?', auth.intentId, bookingId);
      this.transition(bookingId, 'pending', 'authorized', later, 'card authorized; awaiting operator confirmation');
      const leg = this.legs.get(b.leg_id)!;
      const summary = legSummary(leg);
      this.outbox.enqueue({
        dedupeKey: `booking:${bookingId}:requested`, recipient: b.contact_email,
        subject: `Request received: ${summary}`,
        body: `We've asked the operator to confirm ${summary} for ${b.pax} passenger(s). Your card is authorized for ${usd(b.total_cents)} and will only be charged once the operator confirms.`,
      }, later);
      if (this.fleet.getOperator(b.operator_id)?.source !== 'aviapages') {
        this.outbox.enqueue({
          dedupeKey: `booking:${bookingId}:operator_request`, recipient: `operator:${b.operator_id}`,
          subject: `Confirm booking ${bookingId}: ${summary}`,
          body: `A traveler has requested your empty leg ${summary} (${leg.tail}). Payout ${usd(b.operator_payout_cents)}. Confirm or decline before ${new Date(b.hold_expires_at!).toISOString()}.`,
        }, later);
      }
    });
    if (!auth.ok) {
      this.onInventoryChange();
      throw new AppError(402, auth.code, auth.message, { bookingId });
    }
    // Ask the operator to confirm (portal notice, or an RFQ through the operator's network). A
    // failure here must not undo a valid booking: the hold stands and ops can retry.
    try {
      await this.hooks.onAuthorized?.(bookingId);
    } catch (e) {
      console.error(`[booking] operator request for ${bookingId} failed:`, e);
    }
    return this.view(bookingId);
  }

  async operatorConfirm(bookingId: string, operatorId: string) {
    const b = this.ownedBy(bookingId, operatorId);
    if (b.status === 'confirmed') return this.view(bookingId);
    if (b.status !== 'authorized') throw new AppError(409, 'invalid_state', `Booking is ${b.status}`);
    const capture = await this.payments.capture(b.payment_intent_id!, `${bookingId}:capture`);
    const now = this.clock.now();
    this.db.tx(() => {
      if (!capture.ok) {
        if (this.transition(bookingId, 'authorized', 'payment_failed', now, `capture failed: ${capture.code}`)) {
          this.releaseLeg(b.leg_id, now);
          this.outbox.enqueue({
            dedupeKey: `booking:${bookingId}:capture_failed`, recipient: b.contact_email,
            subject: 'Payment problem with your empty-leg booking',
            body: `The operator confirmed, but we couldn't charge your card (${capture.message}). The flight has been released. Please book again with another card.`,
          }, now);
        }
        return;
      }
      if (!this.transition(bookingId, 'authorized', 'confirmed', now, 'operator confirmed; payment captured')) return;
      this.legs.setCommerceStatus(b.leg_id, 'booked', now);
      this.post(bookingId, now, 1, 'capture');
      const leg = this.legs.get(b.leg_id)!;
      this.outbox.enqueue({
        dedupeKey: `booking:${bookingId}:confirmed`, recipient: b.contact_email,
        subject: `Confirmed: ${legSummary(leg)}`,
        body: `Your flight is confirmed and ${usd(b.total_cents)} has been charged. Reminder: empty legs can move or cancel if the operator's primary trip changes; keep a refundable backup until departure.`,
      }, now);
    });
    this.onInventoryChange();
    if (!capture.ok) throw new AppError(402, capture.code, capture.message);
    return this.view(bookingId);
  }

  async operatorDecline(bookingId: string, operatorId: string, reason: string) {
    const b = this.ownedBy(bookingId, operatorId);
    if (b.status !== 'authorized') throw new AppError(409, 'invalid_state', `Booking is ${b.status}`);
    await this.voidAndClose(b, 'declined', `operator declined: ${reason || 'no reason given'}`,
      'The operator could not confirm your empty leg', 'Your card authorization has been released and you have not been charged.');
    return this.view(bookingId);
  }

  async customerCancel(bookingId: string, email: string) {
    const b = this.forCustomer(bookingId, email);
    if (b.status === 'confirmed') throw new AppError(409, 'non_refundable', 'Confirmed bookings are non-refundable when cancelled by the traveler (agreement clause 5)');
    if (b.status !== 'authorized') throw new AppError(409, 'invalid_state', `Booking is ${b.status}`);
    await this.voidAndClose(b, 'cancelled_by_customer', 'cancelled by traveler before confirmation',
      'Your request has been cancelled', 'Your card authorization has been released; you have not been charged.');
    return this.view(bookingId);
  }

  /**
   * The flight behind a held/booked leg went away (operator feed says sold/cancelled, or the
   * operator cancelled from the portal). Release money and tell the traveler, with backup advice.
   */
  async handleLegWithdrawn(legId: string): Promise<void> {
    const active = this.db.all<BookingRow>(`SELECT * FROM bookings WHERE leg_id = ? AND status IN ('authorized', 'confirmed')`, legId);
    for (const b of active) {
      if (b.status === 'authorized') {
        await this.voidAndClose(b, 'cancelled_by_operator', 'operator withdrew the flight before confirming',
          'Your empty leg is no longer available', 'The operator withdrew this flight. Your card authorization has been released; you have not been charged.');
      } else {
        const refund = await this.payments.refund(b.payment_intent_id!, b.total_cents, `${b.id}:refund`);
        const now = this.clock.now();
        this.db.tx(() => {
          if (!this.transition(b.id, 'confirmed', 'cancelled_by_operator', now,
            refund.ok ? 'operator cancelled; full refund issued' : `operator cancelled; REFUND FAILED (${refund.code}) - needs manual action`)) return;
          if (refund.ok) this.post(b.id, now, -1, 'refund');
          this.legs.setCommerceStatus(b.leg_id, 'open', now);
          this.outbox.enqueue({
            dedupeKey: `booking:${b.id}:operator_cancelled`, recipient: b.contact_email,
            subject: 'Your empty-leg flight was cancelled by the operator',
            body: `The operator's primary trip changed and this repositioning flight will no longer operate. ${refund.ok ? `A full refund of ${usd(b.total_cents)} has been issued.` : 'Our team is processing your full refund.'} If you held a backup ticket, now is the time to use it; we'll alert you to alternative empty legs on this route.`,
          }, now);
        });
      }
    }
    if (active.length > 0) this.onInventoryChange();
  }

  /** Tell travelers with an active booking when the operator moves the flight. */
  handleLegChanged(leg: Leg, changes: string[]): void {
    if (!changes.includes('departure') && !changes.includes('route')) return;
    const now = this.clock.now();
    const active = this.db.all<BookingRow>(`SELECT * FROM bookings WHERE leg_id = ? AND status IN ('authorized', 'confirmed')`, leg.id);
    for (const b of active) {
      this.outbox.enqueue({
        dedupeKey: `booking:${b.id}:changed:v${leg.version}`, recipient: b.contact_email,
        subject: `Schedule change: ${legSummary(leg)}`,
        body: `The operator updated your flight. It now departs ${new Date(leg.departEarliest).toISOString()} (window to ${new Date(leg.departLatest).toISOString()}), ${getAirport(leg.fromIcao).iata} to ${getAirport(leg.toIcao).iata}. If this no longer works for you, reply to this email.`,
      }, now);
    }
  }

  /** Sweeper: release holds the operator didn't act on, and close out flown trips. */
  async sweep(): Promise<{ expired: number; completed: number }> {
    const now = this.clock.now();
    const stale = this.db.all<BookingRow>(`SELECT * FROM bookings WHERE status = 'authorized' AND hold_expires_at <= ?`, now);
    for (const b of stale) {
      await this.voidAndClose(b, 'expired', 'operator did not confirm in time',
        'Your empty-leg request expired', "The operator didn't confirm in time. Your card authorization has been released; you have not been charged.");
    }
    const flown = this.db.all<{ id: string }>(
      `SELECT b.id FROM bookings b JOIN legs l ON l.id = b.leg_id WHERE b.status = 'confirmed' AND l.depart_latest + ? < ?`, 12 * HOUR, now,
    );
    this.db.tx(() => flown.forEach((f) => this.transition(f.id, 'confirmed', 'completed', now, 'flight completed')));
    return { expired: stale.length, completed: flown.length };
  }

  // ---------- reads ----------

  view(bookingId: string) {
    const b = this.row(bookingId);
    const leg = this.legs.get(b.leg_id);
    const quote = this.db.get<QuoteRow>('SELECT * FROM quotes WHERE id = ?', b.quote_id);
    const lines = quote ? (JSON.parse(quote.breakdown).lines as PriceLine[]) : [];
    return {
      id: b.id,
      status: b.status,
      pax: b.pax,
      totalCents: b.total_cents,
      currency: b.currency,
      lines,
      contact: { name: b.contact_name, email: b.contact_email },
      passengers: JSON.parse(b.passengers) as Array<{ name: string }>,
      agreement: JSON.parse(b.agreement),
      holdExpiresAt: b.hold_expires_at ? new Date(b.hold_expires_at).toISOString() : null,
      history: JSON.parse(b.history) as Array<{ at: string; status: string; note: string }>,
      createdAt: new Date(b.created_at).toISOString(),
      flight: leg && {
        legId: leg.id,
        from: getAirport(leg.fromIcao),
        to: getAirport(leg.toIcao),
        departEarliest: new Date(leg.departEarliest).toISOString(),
        departLatest: new Date(leg.departLatest).toISOString(),
        aircraft: leg.typeCode ? getAircraftType(leg.typeCode).name : null,
        tail: leg.tail,
        operator: this.fleet.getOperator(b.operator_id)?.name ?? b.operator_id,
      },
    };
  }

  viewForCustomer(bookingId: string, email: string) {
    this.forCustomer(bookingId, email);
    return this.view(bookingId);
  }

  /** Ops view: every booking, newest first, optionally filtered by status. */
  listAll(status?: string) {
    const rows = status
      ? this.db.all<{ id: string }>('SELECT id FROM bookings WHERE status = ? ORDER BY created_at DESC LIMIT 200', status)
      : this.db.all<{ id: string }>('SELECT id FROM bookings ORDER BY created_at DESC LIMIT 200');
    return rows.map((r) => {
      const b = this.row(r.id);
      return { ...this.view(r.id), operatorId: b.operator_id, operatorPayoutCents: b.operator_payout_cents, platformFeeCents: b.platform_fee_cents };
    });
  }

  operatorOf(bookingId: string): string {
    return this.row(bookingId).operator_id;
  }

  statusOf(bookingId: string): BookingStatus {
    return this.row(bookingId).status;
  }

  economics(bookingId: string) {
    const b = this.row(bookingId);
    return { operatorPayoutCents: b.operator_payout_cents, totalCents: b.total_cents, pax: b.pax, legId: b.leg_id, contactEmail: b.contact_email };
  }

  listForOperator(operatorId: string) {
    return this.db.all<{ id: string }>('SELECT id FROM bookings WHERE operator_id = ? ORDER BY created_at DESC LIMIT 100', operatorId)
      .map((r) => ({ ...this.view(r.id), operatorPayoutCents: this.row(r.id).operator_payout_cents }));
  }

  ledger(bookingId?: string) {
    return bookingId
      ? this.db.all('SELECT * FROM ledger WHERE booking_id = ? ORDER BY id', bookingId)
      : this.db.all('SELECT account, SUM(amount_cents) AS balance_cents FROM ledger GROUP BY account ORDER BY account');
  }

  // ---------- internals ----------

  private validate(input: CreateBookingInput): void {
    if (!input || typeof input.quoteId !== 'string') throw new AppError(400, 'bad_request', 'quoteId is required');
    if (!input.contact?.name?.trim() || !EMAIL_RE.test(input.contact?.email ?? '')) throw new AppError(400, 'bad_contact', 'Contact name and a valid email are required');
    if (!Array.isArray(input.passengers) || input.passengers.length === 0 || input.passengers.some((p) => !p?.name?.trim())) {
      throw new AppError(400, 'bad_passengers', 'Every passenger needs a full name as on their travel document');
    }
    if (!input.agreement?.accepted || !input.agreement.signedName?.trim()) throw new AppError(400, 'agreement_required', 'You must accept and sign the charter agreement');
    if (input.agreement.version !== AGREEMENT_VERSION) throw new AppError(409, 'agreement_outdated', 'The charter agreement has been updated; please review it again');
    if (typeof input.paymentToken !== 'string' || !input.paymentToken) throw new AppError(400, 'payment_required', 'A payment method is required');
  }

  private async voidAndClose(b: BookingRow, to: BookingStatus, note: string, subject: string, body: string): Promise<void> {
    if (b.payment_intent_id) await this.payments.void(b.payment_intent_id, `${b.id}:void`);
    const now = this.clock.now();
    const changed = this.db.tx(() => {
      if (!this.transition(b.id, 'authorized', to, now, note)) return false;
      this.releaseLeg(b.leg_id, now);
      this.outbox.enqueue({ dedupeKey: `booking:${b.id}:${to}`, recipient: b.contact_email, subject, body }, now);
      return true;
    });
    if (changed) this.onInventoryChange();
  }

  private releaseLeg(legId: string, now: number): void {
    const leg = this.legs.get(legId);
    if (leg && leg.commerceStatus === 'held') this.legs.setCommerceStatus(legId, 'open', now);
  }

  /** Compare-and-set status transition. Returns false if the booking had already moved on. */
  private transition(id: string, from: BookingStatus, to: BookingStatus, now: number, note: string): boolean {
    if (!TRANSITIONS[from].includes(to)) throw new Error(`illegal transition ${from} -> ${to}`);
    const b = this.row(id);
    const history = JSON.parse(b.history);
    history.push({ at: new Date(now).toISOString(), status: to, note });
    return this.db.run(
      'UPDATE bookings SET status = ?, history = ?, updated_at = ? WHERE id = ? AND status = ?',
      to, JSON.stringify(history), now, id, from,
    ).changes === 1;
  }

  /** Balanced ledger postings (sum to zero). sign = -1 reverses for a refund. */
  private post(bookingId: string, now: number, sign: 1 | -1, memo: string): void {
    const b = this.row(bookingId);
    const entries: Array<[string, number]> = [
      ['cash', b.total_cents],
      ['operator_payable', -b.operator_payout_cents],
      ['tax_payable', -b.tax_cents],
      ['platform_revenue', -(b.total_cents - b.operator_payout_cents - b.tax_cents)],
    ];
    for (const [account, amount] of entries) {
      this.db.run('INSERT INTO ledger (booking_id, account, amount_cents, memo, created_at) VALUES (?, ?, ?, ?, ?)', bookingId, account, sign * amount, memo, now);
    }
  }

  private row(id: string): BookingRow {
    const b = this.db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', id);
    if (!b) throw new AppError(404, 'booking_not_found', 'Booking not found');
    return b;
  }

  private ownedBy(id: string, operatorId: string): BookingRow {
    const b = this.row(id);
    if (b.operator_id !== operatorId) throw new AppError(404, 'booking_not_found', 'Booking not found');
    return b;
  }

  private forCustomer(id: string, email: string): BookingRow {
    const b = this.row(id);
    if (b.contact_email !== (email ?? '').trim().toLowerCase()) throw new AppError(404, 'booking_not_found', 'Booking not found');
    return b;
  }
}

function legSummary(leg: Leg): string {
  const d = new Date(leg.departEarliest).toISOString().slice(0, 16).replace('T', ' ');
  return `${getAirport(leg.fromIcao).iata} → ${getAirport(leg.toIcao).iata} ${d}Z`;
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
