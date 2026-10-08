import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg, bookingInput, iso, T0 } from './helpers.ts';
import { HOUR, MINUTE, type AppError } from '../src/domain/types.ts';
import { MockPaymentProvider } from '../src/booking/payments.ts';

async function setup() {
  const payments = new MockPaymentProvider();
  const h = testApp({ payments });
  await h.app.ingest.ingest('api:op_a', [nativeLeg()]);
  const leg = await onlyLeg(h.app);
  return { ...h, payments, leg };
}

const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: AppError) => {
  assert.equal(e.code, code);
  return true;
});

test('happy path: quote -> authorize & hold -> operator confirms -> captured, ledger balanced', async () => {
  const { app, payments, leg } = await setup();
  const quote = app.bookings.createQuote(leg.id, 2);
  const b = await app.bookings.createBooking(bookingInput(quote.quoteId, 2), 'idem-0001');
  assert.equal(b.status, 'authorized');
  assert.equal(b.totalCents, quote.totalCents);
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'held');
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 0, 'held legs leave search');
  assert.equal([...payments.intents.values()][0].state, 'authorized', 'not charged yet');

  const c = await app.bookings.operatorConfirm(b.id, 'op_a');
  assert.equal(c.status, 'confirmed');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'booked');
  assert.equal([...payments.intents.values()][0].state, 'captured');

  const ledger = app.bookings.ledger(b.id) as Array<{ account: string; amount_cents: number }>;
  assert.equal(ledger.reduce((s, e) => s + e.amount_cents, 0), 0);
  assert.equal(ledger.find((e) => e.account === 'cash')!.amount_cents, quote.totalCents);
  const mail = app.outbox.list('grace@example.com') as Array<{ subject: string }>;
  assert.ok(mail.some((m) => m.subject.startsWith('Confirmed')));
});

test('idempotency: retrying the same request returns the same booking and authorizes once', async () => {
  const { app, payments, leg } = await setup();
  const quote = app.bookings.createQuote(leg.id, 1);
  const a = await app.bookings.createBooking(bookingInput(quote.quoteId), 'idem-0002');
  const b = await app.bookings.createBooking(bookingInput(quote.quoteId), 'idem-0002');
  assert.equal(a.id, b.id);
  assert.equal(payments.intents.size, 1);
  await rejects(app.bookings.createBooking({ ...bookingInput('qt_other') }, 'idem-0002'), 'idempotency_key_reused');
});

test('concurrency: two travelers racing for one leg -> exactly one hold', async () => {
  const { app, leg } = await setup();
  const q1 = app.bookings.createQuote(leg.id, 1);
  const q2 = app.bookings.createQuote(leg.id, 1);
  const results = await Promise.allSettled([
    app.bookings.createBooking(bookingInput(q1.quoteId), 'idem-race-1'),
    app.bookings.createBooking(bookingInput(q2.quoteId), 'idem-race-2'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(['leg_unavailable', 'quote_stale'].includes((failed.reason as AppError).code));
});

test('declined card releases the hold immediately', async () => {
  const { app, leg } = await setup();
  const quote = app.bookings.createQuote(leg.id, 1);
  await rejects(app.bookings.createBooking(bookingInput(quote.quoteId, 1, 'tok_decline'), 'idem-0003'), 'card_declined');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'open');
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 1);
});

test('quotes expire, and go stale when the operator changes the leg', async () => {
  const { app, clock, leg } = await setup();
  const q = app.bookings.createQuote(leg.id, 1);
  clock.advance(16 * MINUTE);
  await rejects(app.bookings.createBooking(bookingInput(q.quoteId), 'idem-0004'), 'quote_expired');

  const q2 = app.bookings.createQuote(leg.id, 1);
  await app.ingest.ingest('api:op_a', [nativeLeg({ departureEarliest: iso(T0 + 52 * HOUR), departureLatest: iso(T0 + 53 * HOUR) })]);
  await rejects(app.bookings.createBooking(bookingInput(q2.quoteId), 'idem-0005'), 'quote_stale');
});

test('booking requires a signed agreement, valid contact and one name per passenger', async () => {
  const { app, leg } = await setup();
  const q = app.bookings.createQuote(leg.id, 2);
  await rejects(app.bookings.createBooking({ ...bookingInput(q.quoteId, 2), agreement: { accepted: false, signedName: '', version: 'ELA-2026-10' } }, 'idem-0006'), 'agreement_required');
  await rejects(app.bookings.createBooking({ ...bookingInput(q.quoteId, 2), agreement: { accepted: true, signedName: 'G', version: 'OLD' } }, 'idem-0007'), 'agreement_outdated');
  await rejects(app.bookings.createBooking({ ...bookingInput(q.quoteId, 2), contact: { name: 'G', email: 'nope' } }, 'idem-0008'), 'bad_contact');
  await rejects(app.bookings.createBooking(bookingInput(q.quoteId, 1), 'idem-0009'), 'passenger_count_mismatch');
  await rejects(app.bookings.createBooking(bookingInput(q.quoteId, 2), 'short'), 'idempotency_key_required');
});

test('operator declines -> authorization voided, leg back on sale; other operators cannot act on it', async () => {
  const { app, payments, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0010');
  await rejects(app.bookings.operatorConfirm(b.id, 'op_b'), 'booking_not_found');
  const d = await app.bookings.operatorDecline(b.id, 'op_a', 'crew duty limits');
  assert.equal(d.status, 'declined');
  assert.equal([...payments.intents.values()][0].state, 'voided');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'open');
});

test('unconfirmed holds expire after the operator SLA', async () => {
  const { app, clock, payments, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0011');
  clock.advance(HOUR);
  assert.deepEqual(await app.bookings.sweep(), { expired: 0, completed: 0 });
  clock.advance(HOUR + MINUTE);
  assert.deepEqual(await app.bookings.sweep(), { expired: 1, completed: 0 });
  assert.equal(app.bookings.view(b.id).status, 'expired');
  assert.equal([...payments.intents.values()][0].state, 'voided');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'open');
});

test('capture failure at confirmation fails the booking and releases the leg', async () => {
  const { app, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId, 1, 'tok_capture_fail'), 'idem-0012');
  await rejects(app.bookings.operatorConfirm(b.id, 'op_a'), 'authorization_expired');
  assert.equal(app.bookings.view(b.id).status, 'payment_failed');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'open');
});

test('confirming twice is harmless (double-click / webhook retry)', async () => {
  const { app, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0013');
  const [x, y] = await Promise.all([app.bookings.operatorConfirm(b.id, 'op_a'), app.bookings.operatorConfirm(b.id, 'op_a')]);
  assert.equal(x.status, 'confirmed');
  assert.equal(y.status, 'confirmed');
  const ledger = app.bookings.ledger(b.id) as unknown[];
  assert.equal(ledger.length, 4, 'posted exactly once');
});

test('operator cancels a confirmed flight via its feed -> full refund, ledger reversed, traveler told to use backup', async () => {
  const { app, payments, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0014');
  await app.bookings.operatorConfirm(b.id, 'op_a');
  await app.ingest.ingest('api:op_a', [nativeLeg({ status: 'cancelled' })]);
  assert.equal(app.bookings.view(b.id).status, 'cancelled_by_operator');
  assert.equal([...payments.intents.values()][0].state, 'refunded');
  const ledger = app.bookings.ledger(b.id) as Array<{ amount_cents: number }>;
  assert.equal(ledger.length, 8);
  assert.equal(ledger.reduce((s, e) => s + e.amount_cents, 0), 0);
  const mail = app.outbox.list('grace@example.com') as Array<{ subject: string; body: string }>;
  assert.ok(mail.some((m) => m.subject.includes('cancelled by the operator') && m.body.includes('backup')));
});

test('an aggregator claiming "sold" does not cancel a booking the operator still flies', async () => {
  const { app, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0015');
  await app.bookings.operatorConfirm(b.id, 'op_a');
  await app.ingest.ingest('agg2', [nativeLeg({ externalId: 'agg', status: 'sold', price: null })]);
  assert.equal(app.bookings.view(b.id).status, 'confirmed');
});

test('schedule change on a booked leg notifies the traveler', async () => {
  const { app, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0016');
  await app.bookings.operatorConfirm(b.id, 'op_a');
  await app.ingest.ingest('api:op_a', [nativeLeg({ departureEarliest: iso(T0 + 49 * HOUR), departureLatest: iso(T0 + 50 * HOUR) })]);
  const mail = app.outbox.list('grace@example.com') as Array<{ subject: string }>;
  assert.ok(mail.some((m) => m.subject.startsWith('Schedule change')));
});

test('traveler can cancel before confirmation for free, not after', async () => {
  const { app, leg } = await setup();
  const b = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0017');
  await rejects(app.bookings.customerCancel(b.id, 'someone@else.com'), 'booking_not_found');
  assert.equal((await app.bookings.customerCancel(b.id, 'GRACE@example.com')).status, 'cancelled_by_customer');

  const b2 = await app.bookings.createBooking(bookingInput(app.bookings.createQuote(leg.id, 1).quoteId), 'idem-0018');
  await app.bookings.operatorConfirm(b2.id, 'op_a');
  await rejects(app.bookings.customerCancel(b2.id, 'grace@example.com'), 'non_refundable');
});

test('route alerts fire once per leg and price, when matching supply appears', async () => {
  const { app } = testApp();
  const a = app.alerts.create({ email: 'fan@example.com', from: 'HPN', to: 'FLL', radiusNm: 60, pax: 2 });
  assert.equal(a.matchedNow, 0);
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  await app.ingest.ingest('api:op_a', [nativeLeg()]); // re-send: no duplicate alert
  await app.ingest.ingest('api:op_a', [nativeLeg({ externalId: 'other', tailNumber: 'N200A', to: 'KASE' })]); // wrong destination
  const mail = app.outbox.list('fan@example.com') as Array<{ subject: string }>;
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /TEB → PBI/);
});
