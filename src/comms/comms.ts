// Operator communications hub: every exchange with an operator, on any channel, in one place.
//
//   threads   one per subject per operator (a booking, a custom charter request, a general topic)
//   messages  in/out/internal, on channel aviapages (RFQs and offers), email, portal or system
//
// Outbound:  booking confirmation requests (portal notice for signed operators, Aviapages RFQ for
//            network operators), free-text replies (email; also visible in the portal), reactions
//            on Aviapages offers (Accept/Reject/Seen).
// Inbound:   Aviapages offers and per-recipient delivery status (polled), operator portal replies,
//            emails posted to the inbound webhook (threaded by a [ref:...] tag).
// Effects:   an operator's offer can confirm or decline the booking it answers, automatically when
//            it is unambiguous, otherwise it is flagged for a human.

import type { Database } from '../db/database.ts';
import type { FleetRepo, KvRepo, LegRepo, MarketRepo } from '../db/repos.ts';
import type { BookingService } from '../booking/booking-service.ts';
import type { Outbox } from '../alerts/outbox.ts';
import type { Clock, Operator } from '../domain/types.ts';
import { AppError, MINUTE } from '../domain/types.ts';
import { newId } from '../domain/ids.ts';
import { getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { avpMinute, AviapagesError, type AviapagesClient } from '../integrations/aviapages/client.ts';
import type { QuoteReply, Reaction } from '../integrations/aviapages/types.ts';

export type ThreadKind = 'booking' | 'charter_request' | 'general';
export type ThreadStatus = 'awaiting_reply' | 'needs_decision' | 'offer_received' | 'open' | 'closed';
export type Channel = 'aviapages' | 'email' | 'portal' | 'system';

export interface ThreadRow {
  id: string; kind: ThreadKind; operator_id: string | null; booking_id: string | null; charter_request_id: string | null;
  external_ref: string | null; subject: string; status: ThreadStatus; needs_attention: number; created_at: number; updated_at: number;
}
export interface MessageRow {
  id: number; thread_id: string; direction: 'in' | 'out' | 'internal'; channel: Channel; author: string; body: string;
  price_cents: number | null; currency: string | null; external_id: string | null; delivery_status: string | null; meta: string; created_at: number;
}

export interface CommsConfig {
  /** Confirm a booking automatically when the operator's offer is at or below the expected payout (+tolerance). */
  autoConfirm: boolean;
  autoConfirmTolerance: number;
  /** Address operators reply to; threads are matched by the [ref:...] tag in the subject. */
  replyToAddress: string;
  pollEveryMs: number;
}

export const DEFAULT_COMMS: CommsConfig = {
  autoConfirm: true,
  autoConfirmTolerance: 0.02,
  replyToAddress: 'ops@emptylegtracker.example',
  pollEveryMs: 3 * MINUTE,
};

const POLL_KEY = 'comms:aviapages';

export class CommsService {
  readonly config: CommsConfig;
  private db: Database;
  private fleet: FleetRepo;
  private legs: LegRepo;
  private market: MarketRepo;
  private bookings: BookingService;
  private outbox: Outbox;
  private kv: KvRepo;
  private clock: Clock;
  private client: AviapagesClient | null;
  /** Set by the charter-request module: turns an operator offer into a bookable charter offer. */
  onCharterReply?: (threadId: string, reply: QuoteReply) => void;

  constructor(deps: {
    db: Database; fleet: FleetRepo; legs: LegRepo; market: MarketRepo; bookings: BookingService; outbox: Outbox; kv: KvRepo; clock: Clock;
    client: AviapagesClient | null; config?: Partial<CommsConfig>;
  }) {
    this.db = deps.db;
    this.fleet = deps.fleet;
    this.legs = deps.legs;
    this.market = deps.market;
    this.bookings = deps.bookings;
    this.outbox = deps.outbox;
    this.kv = deps.kv;
    this.clock = deps.clock;
    this.client = deps.client;
    this.config = { ...DEFAULT_COMMS, ...deps.config };
    this.bookings.hooks.onAuthorized = async (id) => {
      await this.requestBookingConfirmation(id);
    };
  }

  // ---------- threads & messages ----------

  openThread(t: { kind: ThreadKind; operatorId: string | null; subject: string; bookingId?: string; charterRequestId?: string; externalRef?: string; status?: ThreadStatus }): string {
    const now = this.clock.now();
    const id = newId('t');
    this.db.run(
      `INSERT INTO threads (id, kind, operator_id, booking_id, charter_request_id, external_ref, subject, status, needs_attention, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id, t.kind, t.operatorId, t.bookingId ?? null, t.charterRequestId ?? null, t.externalRef ?? null, t.subject, t.status ?? 'open', now, now,
    );
    return id;
  }

  thread(id: string): ThreadRow {
    const t = this.db.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id);
    if (!t) throw new AppError(404, 'thread_not_found', 'Conversation not found');
    return t;
  }

  threadForBooking(bookingId: string): ThreadRow | undefined {
    return this.db.get<ThreadRow>('SELECT * FROM threads WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', bookingId);
  }

  update(id: string, patch: { status?: ThreadStatus; needsAttention?: boolean; externalRef?: string }): void {
    const t = this.thread(id);
    this.db.run('UPDATE threads SET status = ?, needs_attention = ?, external_ref = ?, updated_at = ? WHERE id = ?',
      patch.status ?? t.status, patch.needsAttention === undefined ? t.needs_attention : patch.needsAttention ? 1 : 0,
      patch.externalRef ?? t.external_ref, this.clock.now(), id);
  }

  /** Adds a message; returns false if a message with this external id already exists (idempotent ingestion). */
  addMessage(threadId: string, m: {
    direction: MessageRow['direction']; channel: Channel; author: string; body: string; priceCents?: number | null; currency?: string | null;
    externalId?: string | null; deliveryStatus?: string | null; meta?: Record<string, unknown>;
  }): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `INSERT OR IGNORE INTO messages (thread_id, direction, channel, author, body, price_cents, currency, external_id, delivery_status, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      threadId, m.direction, m.channel, m.author, m.body, m.priceCents ?? null, m.currency ?? null, m.externalId ?? null,
      m.deliveryStatus ?? null, JSON.stringify(m.meta ?? {}), now,
    );
    if (r.changes === 1) {
      this.db.run('UPDATE threads SET updated_at = ?, needs_attention = CASE WHEN ? = \'in\' THEN 1 ELSE needs_attention END WHERE id = ?', now, m.direction, threadId);
    }
    return r.changes === 1;
  }

  messages(threadId: string): MessageRow[] {
    return this.db.all<MessageRow>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id', threadId);
  }

  list(filter: { operatorId?: string; attention?: boolean; status?: string; limit?: number } = {}) {
    this.closeResolvedBookingThreads();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.operatorId) { where.push('t.operator_id = ?'); params.push(filter.operatorId); }
    if (filter.attention) where.push('t.needs_attention = 1');
    if (filter.status) { where.push('t.status = ?'); params.push(filter.status); }
    const rows = this.db.all<ThreadRow & { message_count: number; last_body: string | null; last_at: number | null }>(
      `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
         (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
         (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_at
       FROM threads t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC LIMIT ?`,
      ...params, filter.limit ?? 100,
    );
    return rows.map((r) => this.threadView(r, false));
  }

  threadView(t: ThreadRow & { message_count?: number; last_body?: string | null; last_at?: number | null }, withMessages = true) {
    const op = t.operator_id ? this.fleet.getOperator(t.operator_id) : undefined;
    return {
      id: t.id, kind: t.kind, subject: t.subject, status: t.status, needsAttention: !!t.needs_attention,
      bookingId: t.booking_id, charterRequestId: t.charter_request_id, externalRef: t.external_ref,
      operator: op ? { id: op.id, name: op.name, source: op.source ?? 'direct', email: op.contact?.email ?? null, phone: op.contact?.phone ?? null } : null,
      createdAt: new Date(t.created_at).toISOString(), updatedAt: new Date(t.updated_at).toISOString(),
      messageCount: t.message_count, lastMessage: t.last_body ?? null,
      messages: withMessages ? this.messages(t.id).map((m) => ({
        id: m.id, direction: m.direction, channel: m.channel, author: m.author, body: m.body, priceCents: m.price_cents, currency: m.currency,
        deliveryStatus: m.delivery_status, at: new Date(m.created_at).toISOString(),
      })) : undefined,
    };
  }

  // ---------- booking confirmation requests ----------

  async requestBookingConfirmation(bookingId: string): Promise<string> {
    const operatorId = this.bookings.operatorOf(bookingId);
    const op = this.fleet.getOperator(operatorId);
    const e = this.bookings.economics(bookingId);
    const leg = this.legs.get(e.legId)!;
    const from = getAirport(leg.fromIcao);
    const to = getAirport(leg.toIcao);
    if (leg.kind === 'charter_offer') return this.acceptCharterOffer(bookingId, leg.id);
    const subject = `Booking ${bookingId}: ${from.iata || from.icao} → ${to.iata || to.icao} ${new Date(leg.departEarliest).toISOString().slice(0, 16).replace('T', ' ')}Z`;
    const threadId = this.threadForBooking(bookingId)?.id
      ?? this.openThread({ kind: 'booking', operatorId, bookingId, subject, status: 'awaiting_reply' });
    if (!op || op.source !== 'aviapages') {
      this.addMessage(threadId, {
        direction: 'out', channel: 'portal', author: 'system',
        body: `Confirmation requested in the operator portal for ${e.pax} passenger(s), payout ${usd(e.operatorPayoutCents)}.`,
      });
      return threadId;
    }
    await this.sendRfq(threadId, bookingId, op);
    return threadId;
  }

  /**
   * The traveler booked an operator's charter offer: accept that offer on Aviapages, tell the
   * operator by email, and wait for ops to confirm once the operator has committed.
   */
  private async acceptCharterOffer(bookingId: string, legId: string): Promise<string> {
    const offer = this.db.get<{ external_id: string | null; request_id: string; operator_id: string }>('SELECT external_id, request_id, operator_id FROM charter_offers WHERE leg_id = ?', legId);
    const thread = offer && this.db.get<ThreadRow>('SELECT * FROM threads WHERE charter_request_id = ? AND operator_id = ?', offer.request_id, offer.operator_id);
    const threadId = thread?.id ?? this.openThread({ kind: 'booking', operatorId: offer?.operator_id ?? this.bookings.operatorOf(bookingId), bookingId, subject: `Booking ${bookingId}` });
    this.db.run("UPDATE threads SET booking_id = ?, status = 'awaiting_reply', needs_attention = 1, updated_at = ? WHERE id = ?", bookingId, this.clock.now(), threadId);
    const replyId = offer?.external_id?.startsWith('reply:') ? Number(offer.external_id.slice(6)) : null;
    if (replyId) await this.react(replyId, 'Accept');
    const op = this.fleet.getOperator(offer?.operator_id ?? this.bookings.operatorOf(bookingId));
    const e = this.bookings.economics(bookingId);
    if (op) {
      this.sendEmail(threadId, op, `We accept your offer for ${e.pax} passenger(s) (our booking ${bookingId}). Please send the charter agreement and confirm the aircraft is held.`, 'system');
    }
    this.addMessage(threadId, { direction: 'internal', channel: 'system', author: 'system', body: `Traveler booked this offer (${bookingId}); card authorized. Confirm in Bookings once the operator has committed.` });
    return threadId;
  }

  /** (Re)sends the Aviapages quote request for a booking thread; falls back to email if the API can't be used. */
  async sendRfq(threadId: string, bookingId: string, op: Operator): Promise<void> {
    const e = this.bookings.economics(bookingId);
    const leg = this.legs.get(e.legId)!;
    const type = leg.typeCode ? getAircraftType(leg.typeCode) : null;
    const from = getAirport(leg.fromIcao);
    const to = getAirport(leg.toIcao);
    const listed = leg.askCents !== null ? `${(leg.askCents / 100).toLocaleString('en-US')} ${leg.currency}` : 'not listed';
    const comment = [
      `Booking request for your empty leg ${from.icao} → ${to.icao}, ${type?.name ?? ''} ${leg.tail}, departing ${new Date(leg.departEarliest).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      `${e.pax} passenger(s). Listed price: ${listed}. Please confirm availability and price.`,
      `Our reference: ${bookingId} [ref:${threadId}]`,
    ].join('\n');
    const companyId = Number(op.externalId);
    if (!this.client || !Number.isInteger(companyId)) {
      this.emailFallback(threadId, op, comment, !this.client ? 'Aviapages integration is off' : 'operator has no Aviapages company id');
      return;
    }
    try {
      const qr = await this.client.createQuoteRequest({
        legs: [{ departure_airport: avpAirport(from.icao, from.iata), arrival_airport: avpAirport(to.icao, to.iata), pax: e.pax, departure_datetime: avpMinute(leg.departEarliest) }],
        quote_messages: [{ company: { id: companyId } }],
        aircraft: [{ tail_number: leg.tail, ac_type: type?.name ?? null }],
        channels: ['Email'],
        comment,
        post_to_trip_board: false,
        send_to_self: false,
      });
      const qm = qr.quote_messages[0];
      this.update(threadId, { externalRef: `qr:${qr.id}`, status: 'awaiting_reply', needsAttention: false });
      this.addMessage(threadId, {
        direction: 'out', channel: 'aviapages', author: 'system', body: comment,
        externalId: qm ? `qm:${qm.id}` : `qr:${qr.id}`, deliveryStatus: qm?.state ?? 'Created', meta: { quoteRequestId: qr.id },
      });
    } catch (err) {
      const msg = err instanceof AviapagesError ? err.message : String(err);
      this.addMessage(threadId, { direction: 'internal', channel: 'system', author: 'system', body: `Aviapages RFQ failed: ${msg}` });
      this.emailFallback(threadId, op, comment, 'RFQ failed');
    }
  }

  private emailFallback(threadId: string, op: Operator, body: string, why: string): void {
    const email = op.contact?.email;
    if (!email) {
      this.addMessage(threadId, { direction: 'internal', channel: 'system', author: 'system', body: `Could not reach ${op.name}: ${why} and no contact email. Call ${op.contact?.phone ?? 'the operator'}.` });
      this.update(threadId, { needsAttention: true });
      return;
    }
    this.sendEmail(threadId, op, body, 'system');
    this.addMessage(threadId, { direction: 'internal', channel: 'system', author: 'system', body: `Sent by email instead (${why}).` });
  }

  async retry(threadId: string): Promise<void> {
    const t = this.thread(threadId);
    if (t.kind !== 'booking' || !t.booking_id || !t.operator_id) throw new AppError(409, 'not_retryable', 'Only booking requests can be re-sent');
    if (this.bookings.statusOf(t.booking_id) !== 'authorized') throw new AppError(409, 'not_retryable', 'Booking is no longer awaiting the operator');
    const op = this.fleet.getOperator(t.operator_id)!;
    if (op.source === 'aviapages') await this.sendRfq(threadId, t.booking_id, op);
    else await this.requestBookingConfirmation(t.booking_id);
  }

  // ---------- free-text messages ----------

  /** Ops writes to the operator. Email for everyone; signed operators also see it in the portal. */
  send(threadId: string, body: string, author = 'ops'): void {
    if (!body.trim()) throw new AppError(400, 'empty_message', 'Message is empty');
    const t = this.thread(threadId);
    const op = t.operator_id ? this.fleet.getOperator(t.operator_id) : undefined;
    if (!op) throw new AppError(409, 'no_operator', 'This conversation has no operator');
    this.sendEmail(threadId, op, body, author);
    this.update(threadId, { needsAttention: false, status: t.status === 'closed' ? 'open' : t.status });
  }

  private sendEmail(threadId: string, op: Operator, body: string, author: string): void {
    const t = this.thread(threadId);
    const n = (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', threadId)?.n ?? 0) + 1;
    const recipient = op.source === 'aviapages' ? op.contact?.email ?? `operator:${op.id}` : op.contact?.email ?? `operator:${op.id}`;
    this.outbox.enqueue({
      dedupeKey: `thread:${threadId}:${n}`, recipient,
      subject: `[ref:${threadId}] ${t.subject}`,
      body: `${body}\n\n—\nReply to ${this.config.replyToAddress} keeping [ref:${threadId}] in the subject.`,
    }, this.clock.now());
    this.addMessage(threadId, { direction: 'out', channel: 'email', author, body, deliveryStatus: 'queued', meta: { to: recipient } });
  }

  /** A signed operator replies from the portal. */
  portalReply(operatorId: string, threadId: string, body: string): void {
    const t = this.thread(threadId);
    if (t.operator_id !== operatorId) throw new AppError(404, 'thread_not_found', 'Conversation not found');
    if (!body.trim()) throw new AppError(400, 'empty_message', 'Message is empty');
    const op = this.fleet.getOperator(operatorId)!;
    this.addMessage(threadId, { direction: 'in', channel: 'portal', author: op.name, body: body.trim() });
  }

  /**
   * Inbound email webhook (Postmark/SendGrid/Mailgun can all be mapped to this shape). Threads by
   * the [ref:t_...] tag; otherwise by the sender's address; otherwise opens an unassigned thread.
   */
  inboundEmail(mail: { from: string; to?: string; subject?: string; text: string; messageId?: string }): { threadId: string; matched: 'ref' | 'sender' | 'none' } {
    const ref = /\[ref:(t_[0-9a-f]+)\]/.exec(`${mail.subject ?? ''} ${mail.to ?? ''} ${mail.text}`)?.[1];
    const sender = (/<([^>]+)>/.exec(mail.from)?.[1] ?? mail.from).trim().toLowerCase();
    let threadId = ref && this.db.get<{ id: string }>('SELECT id FROM threads WHERE id = ?', ref)?.id;
    let matched: 'ref' | 'sender' | 'none' = threadId ? 'ref' : 'none';
    if (!threadId) {
      const op = this.fleet.listOperators().find((o) => o.contact?.email?.toLowerCase() === sender);
      if (op) {
        threadId = this.db.get<{ id: string }>("SELECT id FROM threads WHERE operator_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1", op.id)?.id
          ?? this.openThread({ kind: 'general', operatorId: op.id, subject: mail.subject || `Message from ${op.name}` });
        matched = 'sender';
      } else {
        threadId = this.openThread({ kind: 'general', operatorId: null, subject: mail.subject || `Email from ${sender}` });
      }
    }
    this.addMessage(threadId, {
      direction: 'in', channel: 'email', author: mail.from, body: stripQuoted(mail.text),
      externalId: mail.messageId ? `email:${mail.messageId}` : null, meta: { subject: mail.subject ?? null },
    });
    return { threadId, matched };
  }

  // ---------- Aviapages polling ----------

  pollState(): { lastPollAt: number | null; lastResult: unknown } {
    return this.kv.get(POLL_KEY) ?? { lastPollAt: null, lastResult: null };
  }

  /** True when there are RFQs out that we are waiting on (polling costs API calls). */
  hasOpenRfqs(): boolean {
    return !!this.db.get("SELECT 1 FROM threads WHERE external_ref LIKE 'qr:%' AND status IN ('awaiting_reply', 'offer_received')");
  }

  async tick(): Promise<unknown> {
    const s = this.pollState();
    if (!this.hasOpenRfqs()) return null;
    if (s.lastPollAt && this.clock.now() - s.lastPollAt < this.config.pollEveryMs) return null;
    return this.poll();
  }

  /** Pulls delivery status and operator replies for every open RFQ. */
  async poll(): Promise<{ requests: number; replies: number; newReplies: number; error: string | null }> {
    const result = { requests: 0, replies: 0, newReplies: 0, error: null as string | null };
    if (!this.client) return { ...result, error: 'Aviapages integration is off' };
    this.closeResolvedBookingThreads();
    const open = this.db.all<ThreadRow>("SELECT * FROM threads WHERE external_ref LIKE 'qr:%' AND status IN ('awaiting_reply', 'offer_received')");
    const ids = [...new Set(open.map((t) => Number(t.external_ref!.split(':')[1])))];
    try {
      if (ids.length) {
        // Delivery status for each recipient (Sent → Delivered → Open, or Error/Blocked).
        const list = await this.client.listQuoteRequests({ ordering: ['-id'] });
        const byId = new Map(list.results.map((q) => [q.id, q]));
        for (const id of ids.filter((x) => !byId.has(x)).slice(0, 5)) byId.set(id, await this.client.getQuoteRequest(id));
        for (const id of ids) {
          const qr = byId.get(id);
          if (!qr) continue;
          result.requests++;
          for (const qm of qr.quote_messages) {
            this.db.run('UPDATE messages SET delivery_status = ? WHERE external_id = ?', qm.state, `qm:${qm.id}`);
            if (['Error', 'Blocked', 'Spam', 'Unsubscribe'].includes(qm.state)) {
              const t = open.find((x) => x.external_ref === `qr:${id}` || x.external_ref === `qr:${id}:${qm.company.id}`);
              if (t) {
                this.addMessage(t.id, { direction: 'internal', channel: 'system', author: 'system', body: `Delivery to ${qm.company.name ?? 'operator'} failed (${qm.state}). Contact them directly.`, externalId: `qm-fail:${qm.id}` });
                this.update(t.id, { needsAttention: true });
              }
            }
          }
        }
        for await (const { page } of this.client.paginate<QuoteReply>('/v3/charter_quote_replies/', { quote_request_id_in: ids }, { maxPages: 5 })) {
          for (const reply of page.results) {
            result.replies++;
            if (await this.handleReply(reply)) result.newReplies++;
          }
        }
      }
    } catch (e) {
      result.error = (e as Error).message;
    }
    this.kv.set(POLL_KEY, { lastPollAt: this.clock.now(), lastResult: result }, this.clock.now());
    return result;
  }

  /** Records an operator's offer and acts on it. Returns true if it was new. */
  async handleReply(reply: QuoteReply): Promise<boolean> {
    const t = this.db.get<ThreadRow>('SELECT * FROM threads WHERE external_ref = ? OR external_ref = ?',
      `qr:${reply.quote_request_id}`, `qr:${reply.quote_request_id}:${reply.company.id}`);
    if (!t) return false;
    const priceCents = typeof reply.price === 'number' ? Math.round(reply.price * 100) : null;
    const author = `${reply.manager_name ?? reply.manager_account?.given_name ?? 'Operator'} (${reply.company.name})`;
    const fresh = this.addMessage(t.id, {
      direction: 'in', channel: 'aviapages', author,
      body: `${reply.state === 'OK' ? 'Offer' : reply.state}: ${reply.comment ?? ''}`.trim(),
      priceCents, currency: reply.currency_code, externalId: `reply:${reply.id}`,
      meta: { replyId: reply.id, state: reply.state, tail: reply.aircraft?.tail_number ?? null, managerEmail: reply.manager_account?.email ?? null },
    });
    if (!fresh) return false;
    if (t.kind === 'charter_request') {
      this.onCharterReply?.(t.id, reply);
      this.update(t.id, { status: 'offer_received' });
      return true;
    }
    if (t.kind === 'booking' && t.booking_id) await this.actOnBookingReply(t, reply, priceCents);
    return true;
  }

  private async actOnBookingReply(t: ThreadRow, reply: QuoteReply, priceCents: number | null): Promise<void> {
    const bookingId = t.booking_id!;
    if (this.bookings.statusOf(bookingId) !== 'authorized') {
      this.update(t.id, { status: 'closed' });
      return;
    }
    const operatorId = this.bookings.operatorOf(bookingId);
    if (reply.state !== 'OK') {
      await this.bookings.operatorDecline(bookingId, operatorId, `operator replied "${reply.state}" via Aviapages`);
      await this.react(reply.id, 'Seen');
      this.addMessage(t.id, { direction: 'internal', channel: 'system', author: 'system', body: 'Operator declined; card authorization released and traveler notified.' });
      this.update(t.id, { status: 'closed', needsAttention: false });
      return;
    }
    const expected = this.bookings.economics(bookingId).operatorPayoutCents;
    const offeredUsd = priceCents === null ? null : this.toUsd(priceCents, reply.currency_code ?? 'USD');
    const within = offeredUsd !== null && offeredUsd <= expected * (1 + this.config.autoConfirmTolerance);
    if (this.config.autoConfirm && (within || offeredUsd === null)) {
      try {
        await this.bookings.operatorConfirm(bookingId, operatorId);
        await this.react(reply.id, 'Accept');
        this.addMessage(t.id, {
          direction: 'internal', channel: 'system', author: 'system',
          body: offeredUsd === null ? 'Operator confirmed availability; booking confirmed and card charged.'
            : `Operator offer ${usd(offeredUsd)} is within the expected payout ${usd(expected)}; booking confirmed and card charged.`,
        });
        this.update(t.id, { status: 'closed', needsAttention: false });
      } catch (e) {
        this.addMessage(t.id, { direction: 'internal', channel: 'system', author: 'system', body: `Auto-confirm failed: ${(e as Error).message}` });
        this.update(t.id, { status: 'needs_decision', needsAttention: true });
      }
      return;
    }
    this.addMessage(t.id, {
      direction: 'internal', channel: 'system', author: 'system',
      body: `Operator offered ${offeredUsd === null ? 'no price' : usd(offeredUsd)}; the traveler's price assumed a payout of ${usd(expected)}. Confirm (absorbing the difference) or decline in Bookings.`,
    });
    this.update(t.id, { status: 'needs_decision', needsAttention: true });
  }

  async react(replyId: number, reaction: Reaction): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.reactToReply(replyId, reaction);
    } catch (e) {
      console.error(`[comms] reaction ${reaction} on reply ${replyId} failed:`, (e as Error).message);
    }
  }

  /** Ops confirmed or declined a booking: mirror the decision back to the operator's offer. */
  async afterDecision(bookingId: string, decision: 'confirmed' | 'declined'): Promise<void> {
    const t = this.threadForBooking(bookingId);
    if (!t) return;
    const lastReply = this.db.get<{ meta: string }>("SELECT meta FROM messages WHERE thread_id = ? AND external_id LIKE 'reply:%' ORDER BY id DESC LIMIT 1", t.id);
    const replyId = lastReply ? (JSON.parse(lastReply.meta).replyId as number | undefined) : undefined;
    if (replyId) await this.react(replyId, decision === 'confirmed' ? 'Accept' : 'Reject');
    this.addMessage(t.id, { direction: 'internal', channel: 'system', author: 'ops', body: `Booking ${decision} by ops.` });
    this.update(t.id, { status: 'closed', needsAttention: false });
  }

  /** Threads for bookings that are no longer waiting on the operator are closed. */
  private closeResolvedBookingThreads(): void {
    const open = this.db.all<ThreadRow>("SELECT * FROM threads WHERE status IN ('awaiting_reply', 'needs_decision') AND booking_id IS NOT NULL");
    for (const t of open) {
      const status = this.bookings.statusOf(t.booking_id!);
      if (status !== 'authorized' && status !== 'pending') {
        this.addMessage(t.id, { direction: 'internal', channel: 'system', author: 'system', body: `Booking is now ${status.replace(/_/g, ' ')}.`, externalId: `closed:${t.id}:${status}` });
        this.update(t.id, { status: 'closed', needsAttention: false });
      }
    }
  }

  /** What the traveler may see about the operator conversation (no internal notes or prices). */
  travelerTimeline(bookingId: string): Array<{ at: string; text: string }> {
    const t = this.threadForBooking(bookingId);
    if (!t) return [];
    const out: Array<{ at: string; text: string }> = [];
    for (const m of this.messages(t.id)) {
      const at = new Date(m.created_at).toISOString();
      if (m.direction === 'out' && m.channel === 'aviapages') {
        out.push({ at, text: 'Request sent to the operator' });
        if (m.delivery_status && ['Delivered', 'Open'].includes(m.delivery_status)) out.push({ at, text: m.delivery_status === 'Open' ? 'Operator has opened your request' : 'Request delivered to the operator' });
      } else if (m.direction === 'out' && m.channel === 'portal') out.push({ at, text: 'Operator notified' });
      else if (m.direction === 'in' && m.channel === 'aviapages') out.push({ at, text: m.body.startsWith('Offer') ? 'Operator replied: available' : 'Operator replied: not available' });
    }
    return out;
  }

  private toUsd(cents: number, currency: string): number {
    if (currency.toUpperCase() === 'USD') return cents;
    const fx = this.market.get(`fx_usd_per_${currency.toUpperCase()}`);
    return Math.round(cents * (fx?.value ?? 1));
  }
}

function avpAirport(icao: string, iata: string) {
  return { icao: icao.length === 4 ? icao : null, iata: iata || null, lid: icao.length !== 4 ? icao : null };
}

/** Drops the quoted history below a reply ("On ... wrote:" / ">" lines). */
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith('>')).join('\n').trim();
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
