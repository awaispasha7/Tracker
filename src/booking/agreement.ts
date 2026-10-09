import { createHash } from 'node:crypto';

export const AGREEMENT_VERSION = 'ELA-2026-10';
export const INVOICE_AGREEMENT_VERSION = 'ELA-2026-10-INV';

// The key terms of the per-trip charter agreement. Legal review required before production use.
const TEMPLATE = `EMPTY-LEG CHARTER AGREEMENT (__VERSION__)

1. You are chartering the entire aircraft for the route and departure window shown. The flight is
   operated by the named certificated air carrier, which retains operational control.
2. This flight is a repositioning ("empty leg") flight. Its schedule depends on the operator's
   primary charter. The operator may change the departure time within the stated window, or cancel
   the flight, if the primary charter changes.
3. If the operator cancels, or changes the route, you receive a full refund. No other compensation
   is owed. We strongly recommend holding a refundable backup (commercial ticket or award seat).
__PAYMENT_CLAUSE__
5. Once confirmed, the booking is non-refundable if you cancel.
6. The price shown is all-in: operator rate, fees, applicable taxes and our service fee.
7. Passengers must carry valid travel documents; the operator may refuse boarding to anyone who
   does not, or who poses a safety risk, without refund.`;

const CLAUSE_4 = {
  card: `4. Your card is authorized when you request the flight and charged only when the operator confirms.
   If the operator does not confirm in time, the authorization is released.`,
  invoice: `4. No payment is taken when you request the flight. Once the operator confirms, you receive an
   invoice; the flight is secured when payment is received, which must be before departure. If the
   operator does not confirm in time, the request lapses at no cost to you.`,
};

export interface Agreement { version: string; text: string; hash: string }

function build(kind: 'card' | 'invoice'): Agreement {
  const version = kind === 'card' ? AGREEMENT_VERSION : INVOICE_AGREEMENT_VERSION;
  const text = TEMPLATE.replace('__VERSION__', version).replace('__PAYMENT_CLAUSE__', CLAUSE_4[kind]);
  return { version, text, hash: createHash('sha256').update(text).digest('hex') };
}

const AGREEMENTS = { card: build('card'), invoice: build('invoice') };

/** The agreement travelers sign depends on how they pay (card authorization vs invoice). */
export function agreementFor(kind: 'card' | 'invoice'): Agreement {
  return AGREEMENTS[kind];
}

export const AGREEMENT_TEXT = AGREEMENTS.card.text;
export const AGREEMENT_HASH = AGREEMENTS.card.hash;
