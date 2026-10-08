import { createHash } from 'node:crypto';

export const AGREEMENT_VERSION = 'ELA-2026-10';

// The key terms of the per-trip charter agreement. Legal review required before production use.
export const AGREEMENT_TEXT = `EMPTY-LEG CHARTER AGREEMENT (${AGREEMENT_VERSION})

1. You are chartering the entire aircraft for the route and departure window shown. The flight is
   operated by the named certificated air carrier, which retains operational control.
2. This flight is a repositioning ("empty leg") flight. Its schedule depends on the operator's
   primary charter. The operator may change the departure time within the stated window, or cancel
   the flight, if the primary charter changes.
3. If the operator cancels, or changes the route, you receive a full refund. No other compensation
   is owed. We strongly recommend holding a refundable backup (commercial ticket or award seat).
4. Your card is authorized when you request the flight and charged only when the operator confirms.
   If the operator does not confirm in time, the authorization is released.
5. Once confirmed, the booking is non-refundable if you cancel.
6. The price shown is all-in: operator rate, fees, applicable taxes and our service fee.
7. Passengers must carry valid travel documents; the operator may refuse boarding to anyone who
   does not, or who poses a safety risk, without refund.`;

export const AGREEMENT_HASH = createHash('sha256').update(AGREEMENT_TEXT).digest('hex');
