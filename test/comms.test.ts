import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg, bookingInput, T0 } from './helpers.ts';
import { HOUR, MINUTE } from '../src/domain/types.ts';
import { MockPaymentProvider } from '../src/booking/payments.ts';

async function aviapagesBooking(opts: { policy?: 'decline' | 'expensive' } = {}) {
  const payments = new MockPaymentProvider();
  const h = testApp({ aviapages: { mode: 'mock' }, payments });
  const { app, clock } = h;
  app.market.set('fx_usd_per_GBP', 1.27, T0);
  await app.aviapages!.sync.full();
  const mock = app.aviapages!.mock!;
  const entry = app.search.allIndexed(clock.now()).find((e) => e.operator.source === 'aviapages' && e.leg.askCents !== null
    && app.pricing.price({ leg: e.leg, pax: 1, seats: e.seats, now: clock.now() }).ok)!;
  assert.ok(entry, 'a bookable Aviapages leg exists');
  const companyId = Number(entry.operator.externalId);
  if (opts.policy === 'decline') mock.replyPolicy.set(companyId, () => ({ state: 'Not available' }));
  if (opts.policy === 'expensive') mock.replyPolicy.set(companyId, () => ({ state: 'OK', price: (entry.leg.askCents! / 100) * 1.5, currency: entry.leg.currency }));
  const quote = app.bookings.createQuote(entry.leg.id, 1);
  const booking = await app.bookings.createBooking(bookingInput(quote.quoteId), `idem-avp-${opts.policy ?? 'ok'}`);
  return { ...h, mock, entry, booking, payments, companyId };
}

test('booking an Aviapages leg sends an RFQ to that operator for that tail, with a longer hold', async () => {
  const { app, mock, entry, booking, companyId, clock } = await aviapagesBooking();
  assert.equal(booking.status, 'authorized');
  assert.equal(new Date(booking.holdExpiresAt!).getTime() - clock.now() <= 6 * HOUR, true);
  assert.ok(new Date(booking.holdExpiresAt!).getTime() - clock.now() > 2 * HOUR, 'network operators get longer than the 2h portal SLA');
  const [qr] = [...mock.quoteRequests.values()];
  assert.equal(qr.messages[0].companyId, companyId);
  assert.equal(String(qr.aircraft[0].tail_number), entry.leg.tail);
  assert.match(String(qr.comment), new RegExp(booking.id));
  const t = app.comms.threadForBooking(booking.id)!;
  assert.equal(t.status, 'awaiting_reply');
  assert.equal(t.external_ref, `qr:${qr.id}`);
  const out = app.comms.messages(t.id).find((m) => m.channel === 'aviapages')!;
  assert.equal(out.delivery_status, 'Sent');
});

test('polling tracks delivery, then the operator offer auto-confirms and charges the booking', async () => {
  const { app, booking, clock, payments, mock } = await aviapagesBooking();
  clock.advance(MINUTE + 1);
  let r = await app.comms.poll();
  assert.equal(r.newReplies, 0);
  const t = app.comms.threadForBooking(booking.id)!;
  assert.equal(app.comms.messages(t.id).find((m) => m.channel === 'aviapages')!.delivery_status, 'Delivered');
  assert.deepEqual(app.comms.travelerTimeline(booking.id).map((x) => x.text), ['Request sent to the operator', 'Request delivered to the operator']);

  clock.advance(5 * MINUTE);
  r = await app.comms.poll();
  assert.equal(r.newReplies, 1);
  assert.equal(app.bookings.view(booking.id).status, 'confirmed');
  assert.equal([...payments.intents.values()][0].state, 'captured');
  assert.equal([...mock.replies.values()][0].reaction, 'Accept', 'our acceptance is sent back to the operator');
  assert.equal(app.comms.thread(t.id).status, 'closed');
  assert.ok(app.comms.travelerTimeline(booking.id).some((x) => x.text === 'Operator replied: available'));

  // Re-polling is idempotent.
  r = await app.comms.poll();
  assert.equal(r.newReplies, 0);
});

test('operator replies "Not available" -> booking declined, card released, traveler told', async () => {
  const { app, booking, clock, payments } = await aviapagesBooking({ policy: 'decline' });
  clock.advance(10 * MINUTE);
  await app.comms.poll();
  assert.equal(app.bookings.view(booking.id).status, 'declined');
  assert.equal([...payments.intents.values()][0].state, 'voided');
  const mail = app.outbox.list('grace@example.com') as Array<{ subject: string }>;
  assert.ok(mail.some((m) => /could not confirm/.test(m.subject)));
});

test('an offer above the expected payout is flagged for a human, then ops confirm and the operator is told', async () => {
  const { app, booking, clock, mock } = await aviapagesBooking({ policy: 'expensive' });
  clock.advance(10 * MINUTE);
  await app.comms.poll();
  assert.equal(app.bookings.view(booking.id).status, 'authorized');
  const t = app.comms.threadForBooking(booking.id)!;
  assert.equal(t.status, 'needs_decision');
  assert.equal(t.needs_attention, 1);
  assert.ok(app.comms.list({ attention: true }).some((x) => x.id === t.id));
  await app.bookings.operatorConfirm(booking.id, app.bookings.operatorOf(booking.id));
  await app.comms.afterDecision(booking.id, 'confirmed');
  assert.equal([...mock.replies.values()][0].reaction, 'Accept');
  assert.equal(app.comms.thread(t.id).status, 'closed');
});

test('if the RFQ cannot be sent, the operator is emailed instead and ops are told', async () => {
  const payments = new MockPaymentProvider();
  const { app, clock } = testApp({ aviapages: { mode: 'mock' }, payments });
  await app.aviapages!.sync.full();
  const entry = app.search.allIndexed(clock.now()).find((e) => e.operator.source === 'aviapages'
    && app.pricing.price({ leg: e.leg, pax: 1, seats: e.seats, now: clock.now() }).ok)!;
  app.aviapages!.mock!.failNext(500, 10, { detail: 'boom' }, /charter_quote_requests/);
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(entry.leg.id, 1).quoteId), 'idem-fallback');
  assert.equal(b.status, 'authorized', 'the booking itself is unaffected');
  const t = app.comms.threadForBooking(b.id)!;
  const msgs = app.comms.messages(t.id);
  assert.ok(msgs.some((m) => m.body.startsWith('Aviapages RFQ failed')));
  assert.ok(msgs.some((m) => m.channel === 'email' && m.direction === 'out'));
  const email = entry.operator.contact!.email!;
  assert.ok((app.outbox.list(email) as Array<{ subject: string }>).some((m) => m.subject.includes(`[ref:${t.id}]`)));
});

test('signed operators: portal notice, portal replies, ops replies by email with a thread reference', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  const leg = await onlyLeg(app);
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-direct');
  const t = app.comms.threadForBooking(b.id)!;
  assert.equal(app.comms.messages(t.id)[0].channel, 'portal');
  assert.equal(app.comms.list({ operatorId: 'op_a' }).length, 1);

  app.comms.portalReply('op_a', t.id, 'Crew confirmed, will confirm in the portal shortly.');
  assert.throws(() => app.comms.portalReply('op_b', t.id, 'not mine'), /not found/);
  assert.equal(app.comms.thread(t.id).needs_attention, 1);

  app.comms.send(t.id, 'Thanks — the traveler has 2 golf bags.');
  assert.equal(app.comms.thread(t.id).needs_attention, 0);
  const sent = app.outbox.list('operator:op_a') as Array<{ subject: string; body: string }>;
  assert.ok(sent.some((m) => m.subject.startsWith(`[ref:${t.id}]`) && m.body.includes('golf bags')));
});

test('inbound email is threaded by reference, then by sender, else lands unassigned', async () => {
  const { app } = testApp();
  app.fleet.upsertOperator({ id: 'op_a', name: 'Alpha Jets', certificate: 'FAA Part 135', status: 'active', contact: { email: 'ops@alpha.example' } });
  const t = app.comms.openThread({ kind: 'general', operatorId: 'op_a', subject: 'Fuel stop question' });

  const byRef = app.comms.inboundEmail({ from: 'Someone <x@y.example>', subject: `Re: [ref:${t}] Fuel stop question`, text: 'Yes, KBGR works.\n\nOn Mon, ops wrote:\n> old text', messageId: 'm1' });
  assert.deepEqual(byRef, { threadId: t, matched: 'ref' });
  assert.equal(app.comms.messages(t).at(-1)!.body, 'Yes, KBGR works.', 'quoted history stripped');
  app.comms.inboundEmail({ from: 'x@y.example', subject: `[ref:${t}]`, text: 'dup', messageId: 'm1' });
  assert.equal(app.comms.messages(t).length, 1, 'same Message-ID is ingested once');

  const bySender = app.comms.inboundEmail({ from: 'Alpha Ops <ops@alpha.example>', subject: 'New availability', text: 'We have a CL350 free Friday.' });
  assert.equal(bySender.matched, 'sender');
  const unknown = app.comms.inboundEmail({ from: 'stranger@nowhere.example', subject: 'Hello', text: 'hi' });
  assert.equal(unknown.matched, 'none');
  assert.equal(app.comms.thread(unknown.threadId).operator_id, null);
});

test('polling costs nothing when no RFQs are open', async () => {
  const { app } = testApp({ aviapages: { mode: 'mock' } });
  assert.equal(await app.comms.tick(), null);
  assert.equal(app.aviapages!.mock!.calls.length, 0);
});
