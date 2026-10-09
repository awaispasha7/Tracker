import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, onlyLeg, bookingInput } from './helpers.ts';
import type { AppError } from '../src/domain/types.ts';
import { InvoicePaymentProvider } from '../src/booking/payments.ts';
import { agreementFor, INVOICE_AGREEMENT_VERSION } from '../src/booking/agreement.ts';
import { resendSender } from '../src/alerts/email.ts';
import { loadSiteConfig } from '../src/site/config.ts';

async function invoiceApp() {
  const h = testApp({ payments: new InvoicePaymentProvider() });
  await h.app.ingest.ingest('api:op_a', [nativeLeg()]);
  return { ...h, leg: await onlyLeg(h.app) };
}

const invoiceBooking = (quoteId: string, pax = 1) => ({
  ...bookingInput(quoteId, pax, 'invoice'),
  agreement: { accepted: true, signedName: 'Grace Hopper', version: INVOICE_AGREEMENT_VERSION },
});

test('invoice mode: request to book without a card, operator confirms, traveler is told an invoice follows', async () => {
  const { app, leg } = await invoiceApp();
  const quote = app.bookings.createQuote(leg.id, 2);
  assert.equal(quote.agreement.version, INVOICE_AGREEMENT_VERSION);
  const b = await app.bookings.createBooking(invoiceBooking(quote.quoteId, 2), 'idem-inv-1');
  assert.equal(b.status, 'authorized');
  assert.equal(app.legs.get(leg.id)!.commerceStatus, 'held');

  const c = await app.bookings.operatorConfirm(b.id, 'op_a');
  assert.equal(c.status, 'confirmed');
  const mail = app.outbox.list('grace@example.com') as Array<{ subject: string; body: string }>;
  const requested = mail.find((m) => m.subject.startsWith('Request received'))!;
  assert.match(requested.body, /No payment has been taken/);
  assert.doesNotMatch(requested.body, /card/i);
  assert.match(mail.find((m) => m.subject.startsWith('Confirmed'))!.body, /invoice/);
});

test('invoice mode: test card tokens and the card agreement are refused', async () => {
  const { app, leg } = await invoiceApp();
  const quote = app.bookings.createQuote(leg.id, 1);
  await assert.rejects(app.bookings.createBooking({ ...invoiceBooking(quote.quoteId), paymentToken: 'tok_visa' }, 'idem-inv-2'), (e: AppError) => e.code === 'invalid_token');
  const q2 = app.bookings.createQuote(leg.id, 1);
  await assert.rejects(app.bookings.createBooking(bookingInput(q2.quoteId, 1, 'invoice'), 'idem-inv-3'), (e: AppError) => e.code === 'agreement_outdated');
});

test('invoice agreement replaces the card clause', () => {
  const inv = agreementFor('invoice');
  assert.match(inv.text, /No payment is taken when you request the flight/);
  assert.doesNotMatch(inv.text, /card is authorized/);
  assert.notEqual(inv.hash, agreementFor('card').hash);
});

test('site config: production defaults to invoice payments and the Railway domain', () => {
  const c = loadSiteConfig({ APP_ENV: 'production', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', CONTACT_WHATSAPP: '+1 (212) 555-0100' });
  assert.equal(c.production, true);
  assert.equal(c.payments, 'invoice');
  assert.equal(c.url, 'https://x.up.railway.app');
  assert.equal(c.whatsapp, '12125550100');
  assert.equal(loadSiteConfig({}).payments, 'card');
});

test('Resend sender: resolves operator recipients and copies ops', async () => {
  const { app } = testApp();
  app.fleet.upsertOperator({ id: 'op_a', name: 'Alpha Jets', certificate: 'FAA Part 135', status: 'active', contact: { email: 'ops@alpha.example' } });
  const sent: Array<{ to: string[]; subject: string }> = [];
  const fetch = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { status: 200, text: async () => '{}' };
  };
  const sender = resendSender({ apiKey: 're_x', from: 'Brand <b@brand.example>', opsEmail: 'me@brand.example' }, app.fleet, fetch);
  await sender.send({ channel: 'email', recipient: 'operator:op_a', subject: 'Confirm booking', body: '…' });
  await sender.send({ channel: 'email', recipient: 'grace@example.com', subject: 'Request received', body: '…' });
  await sender.send({ channel: 'sms', recipient: '+1555', subject: 'x', body: 'x' });
  assert.deepEqual(sent.map((m) => m.to), [['ops@alpha.example', 'me@brand.example'], ['grace@example.com']]);
});
