import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, bookingInput, T0 } from './helpers.ts';
import { DAY, HOUR, MINUTE } from '../src/domain/types.ts';
import { MockPaymentProvider } from '../src/booking/payments.ts';

const date = new Date(T0 + 5 * DAY).toISOString().slice(0, 10);
const traveler = { name: 'Ada Lovelace', email: 'ada@example.com', from: 'TEB', to: 'PBI', date, time: '15:00', pax: 4 };

function setup() {
  const payments = new MockPaymentProvider();
  const h = testApp({ aviapages: { mode: 'mock' }, payments });
  return { ...h, payments, mock: h.app.aviapages!.mock! };
}

test('a charter request finds suitable aircraft near the departure, with market estimates', async () => {
  const { app } = setup();
  const r = await app.charters.create(traveler);
  assert.equal(r.status, 'options_ready');
  assert.ok(r.options.length >= 3);
  assert.ok(r.options.every((o) => (o.seats ?? 0) >= 4), 'only aircraft that seat the party');
  assert.ok(r.options.every((o) => o.images.length > 0 && o.operator.name));
  assert.ok(r.options.some((o) => o.estimateCents !== null), 'market estimates for known types');
  assert.equal(r.departAt, `${date}T15:00:00.000Z`);
});

test('sending to chosen aircraft creates one RFQ and one conversation per operator', async () => {
  const { app, mock } = setup();
  const r = await app.charters.create(traveler);
  const picks = [...new Map(r.options.map((o) => [o.operator.companyId, o])).values()].slice(0, 2);
  const sent = await app.charters.send(r.id, traveler.email, picks.map((p) => p.aircraftId));
  assert.equal(sent.status, 'sent');
  assert.equal(sent.operators.length, 2);
  const [qr] = [...mock.quoteRequests.values()];
  assert.equal(qr.messages.length, 2);
  assert.equal(qr.aircraft.length, 2);
  await assert.rejects(app.charters.send(r.id, traveler.email, [picks[0].aircraftId]), /already been sent/);
});

test('operator offers become private, all-in priced, bookable legs that never show in search', async () => {
  const { app, clock } = setup();
  const r = await app.charters.create(traveler);
  const pick = r.options[0];
  await app.charters.send(r.id, traveler.email, [pick.aircraftId]);
  clock.advance(10 * MINUTE);
  const poll = await app.comms.poll();
  assert.equal(poll.newReplies, 1);
  const v = app.charters.view(r.id, traveler.email);
  assert.equal(v.status, 'offers');
  const offer = v.offers[0];
  assert.equal(offer.state, 'offered');
  assert.ok(offer.bookable, JSON.stringify(offer.unavailableReason));
  assert.ok(offer.price!.lines.some((l) => l.code === 'platform_fee'));
  const leg = app.legs.get(offer.legId!)!;
  assert.equal(leg.visibility, 'private');
  assert.equal(app.search.search({ from: 'TEB', radiusNm: 300 }, clock.now()).results.filter((h) => h.legId === leg.id).length, 0);
  assert.ok((app.outbox.list(traveler.email) as Array<{ subject: string }>).some((m) => m.subject.startsWith('New offer')));
});

test('booking an offer accepts it with the operator, and ops confirm to charge', async () => {
  const { app, clock, mock, payments } = setup();
  const r = await app.charters.create(traveler);
  await app.charters.send(r.id, traveler.email, [r.options[0].aircraftId]);
  clock.advance(10 * MINUTE);
  await app.comms.poll();
  const offer = app.charters.view(r.id, traveler.email).offers[0];
  const quote = app.bookings.createQuote(offer.legId!, 4);
  const b = await app.bookings.createBooking(bookingInput(quote.quoteId, 4), 'idem-charter');
  assert.equal(b.status, 'authorized');
  assert.equal([...mock.replies.values()][0].reaction, 'Accept');
  const t = app.comms.threadForBooking(b.id)!;
  assert.equal(t.kind, 'charter_request');
  assert.ok(app.comms.messages(t.id).some((m) => m.channel === 'email' && /We accept your offer/.test(m.body)));
  assert.equal(app.charters.view(r.id, traveler.email).offers[0].state, 'reserved');

  await app.bookings.operatorConfirm(b.id, app.bookings.operatorOf(b.id));
  await app.comms.afterDecision(b.id, 'confirmed');
  assert.equal(app.bookings.view(b.id).status, 'confirmed');
  assert.equal([...payments.intents.values()][0].state, 'captured');
});

test('declining operators are recorded but create nothing bookable', async () => {
  const { app, clock, mock } = setup();
  const r = await app.charters.create(traveler);
  mock.replyPolicy.set(r.options[0].operator.companyId, () => ({ state: 'Not available' }));
  await app.charters.send(r.id, traveler.email, [r.options[0].aircraftId]);
  clock.advance(10 * MINUTE);
  await app.comms.poll();
  const v = app.charters.view(r.id, traveler.email);
  assert.equal(v.offers[0].state, 'declined');
  assert.equal(v.offers[0].legId, null);
  assert.equal(v.status, 'sent');
});

test('validation and privacy', async () => {
  const { app } = setup();
  await assert.rejects(app.charters.create({ ...traveler, email: 'bad' }), /valid email/);
  await assert.rejects(app.charters.create({ ...traveler, from: 'ZZZZ' }), /Unknown airport/);
  await assert.rejects(app.charters.create({ ...traveler, date: new Date(T0).toISOString().slice(0, 10), time: '00:00' }), /at least 6 hours/);
  const r = await app.charters.create(traveler);
  assert.throws(() => app.charters.view(r.id, 'someone@else.example'), /not found/);
  await assert.rejects(app.charters.send(r.id, traveler.email, r.options.slice(0, 6).map((o) => o.aircraftId)), /at most 5/);
});

test('offers expire after 72 hours', async () => {
  const { app, clock } = setup();
  const r = await app.charters.create(traveler);
  await app.charters.send(r.id, traveler.email, [r.options[0].aircraftId]);
  clock.advance(10 * MINUTE);
  await app.comms.poll();
  clock.advance(73 * HOUR);
  const o = app.charters.view(r.id, traveler.email).offers[0];
  assert.equal(o.state, 'expired');
  assert.equal(o.bookable, false);
});

test('charter quotes are unavailable without the integration', async () => {
  const { app } = testApp();
  await assert.rejects(app.charters.create(traveler), /not available/);
});
