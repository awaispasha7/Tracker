// Payment provider boundary. Production would implement this against Stripe (PaymentIntents with
// capture_method=manual) or an equivalent; the interface is the auth -> capture/void -> refund
// lifecycle that empty-leg booking needs, with idempotency keys on every mutating call so retries
// after a timeout never double-charge.

import { newId } from '../domain/ids.ts';

export type PaymentResult =
  | { ok: true; intentId: string }
  | { ok: false; code: string; message: string };

export interface PaymentProvider {
  authorize(input: { amountCents: number; currency: string; token: string; description: string; idempotencyKey: string }): Promise<PaymentResult>;
  capture(intentId: string, idempotencyKey: string): Promise<PaymentResult>;
  void(intentId: string, idempotencyKey: string): Promise<PaymentResult>;
  refund(intentId: string, amountCents: number, idempotencyKey: string): Promise<PaymentResult>;
}

type IntentState = 'authorized' | 'captured' | 'voided' | 'refunded';

/**
 * In-memory provider for development and tests. Test tokens:
 *   tok_visa            approves
 *   tok_decline         declined at authorization
 *   tok_capture_fail    authorizes, then capture fails (auth expired)
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly intents = new Map<string, { amountCents: number; currency: string; token: string; state: IntentState; refundedCents: number }>();
  private seen = new Map<string, PaymentResult>();

  private once(key: string, fn: () => PaymentResult): Promise<PaymentResult> {
    const prior = this.seen.get(key);
    if (prior) return Promise.resolve(prior);
    const r = fn();
    this.seen.set(key, r);
    return Promise.resolve(r);
  }

  authorize(input: { amountCents: number; currency: string; token: string; description: string; idempotencyKey: string }) {
    return this.once(`auth:${input.idempotencyKey}`, () => {
      if (input.token === 'tok_decline') return { ok: false, code: 'card_declined', message: 'Your card was declined.' };
      if (!input.token.startsWith('tok_')) return { ok: false, code: 'invalid_token', message: 'Invalid payment token.' };
      const id = newId('pi');
      this.intents.set(id, { amountCents: input.amountCents, currency: input.currency, token: input.token, state: 'authorized', refundedCents: 0 });
      return { ok: true, intentId: id };
    });
  }

  capture(intentId: string, idempotencyKey: string) {
    return this.once(`capture:${idempotencyKey}`, () => {
      const i = this.intents.get(intentId);
      if (!i || i.state !== 'authorized') return { ok: false, code: 'invalid_state', message: 'Intent is not capturable.' };
      if (i.token === 'tok_capture_fail') return { ok: false, code: 'authorization_expired', message: 'Authorization expired.' };
      i.state = 'captured';
      return { ok: true, intentId };
    });
  }

  void(intentId: string, idempotencyKey: string) {
    return this.once(`void:${idempotencyKey}`, () => {
      const i = this.intents.get(intentId);
      if (!i || i.state !== 'authorized') return { ok: false, code: 'invalid_state', message: 'Intent is not voidable.' };
      i.state = 'voided';
      return { ok: true, intentId };
    });
  }

  refund(intentId: string, amountCents: number, idempotencyKey: string) {
    return this.once(`refund:${idempotencyKey}`, () => {
      const i = this.intents.get(intentId);
      if (!i || (i.state !== 'captured' && i.state !== 'refunded')) return { ok: false, code: 'invalid_state', message: 'Intent is not refundable.' };
      if (i.refundedCents + amountCents > i.amountCents) return { ok: false, code: 'over_refund', message: 'Refund exceeds captured amount.' };
      i.refundedCents += amountCents;
      i.state = 'refunded';
      return { ok: true, intentId };
    });
  }
}
