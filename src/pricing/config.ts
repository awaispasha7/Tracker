import type { AircraftCategory } from '../domain/types.ts';
import { HOUR, MINUTE } from '../domain/types.ts';

export interface PricingConfig {
  /** Operators bill a minimum per flight; short hops are priced as if they took this long. */
  minBillableHours: number;
  /** Fuel price the per-hour rates assume. Above it we add a surcharge on modelled prices. */
  baselineFuelCentsPerGal: number;
  /** Repositioning economics when an operator gives no ask: fraction of full hourly rate by lead time. */
  repositioningFactor: Array<{ minHoursOut: number; factor: number }>;
  /** Platform margin target by category, in basis points of the operator payout. */
  marginBps: Record<AircraftCategory, number>;
  /** Lead-time margin adjustment: thinner margin when inventory is about to perish. */
  urgencyMarginAdjBps: Array<{ minHoursOut: number; adjBps: number }>;
  minMarginCents: number;
  maxMarginBps: number;
  /** After card processing; anything lower is a sale we'd lose money on. */
  minNetMarginCents: number;
  cardFeeBps: number;
  cardFeeFixedCents: number;
  /** Handling + landing per airport (rate-model prices only; operator asks are all-in). */
  handlingCents: { standard: number; premium: number };
  /** US Federal Excise Tax on domestic air transportation, + per-passenger segment fee. */
  fetBps: number;
  segmentFeeCents: number;
  /** US international arrival/departure tax, per passenger. */
  intlHeadTaxCents: number;
  /** An empty leg must be at most this fraction of the equivalent one-way full charter. */
  fullCharterCeilingRatio: number;
  /** All-in price per billable hour must sit inside [min, max] x the type's hourly rate. Catches 10x/100x unit errors. */
  perHourSanity: { min: number; max: number };
  /** A move larger than this vs. the last price shown needs a human to approve it. */
  priceJumpRatio: number;
  maxLegAgeMs: number;
  maxMarketAgeMs: number;
  minConfidence: number;
  minLeadTimeMs: number;
  quoteTtlMs: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  minBillableHours: 1,
  baselineFuelCentsPerGal: 600,
  repositioningFactor: [
    { minHoursOut: 168, factor: 0.55 },
    { minHoursOut: 72, factor: 0.48 },
    { minHoursOut: 24, factor: 0.4 },
    { minHoursOut: 0, factor: 0.33 },
  ],
  marginBps: {
    turboprop: 1300,
    light: 1200,
    midsize: 1100,
    'super-midsize': 1000,
    heavy: 900,
    'ultra-long': 800,
  },
  urgencyMarginAdjBps: [
    { minHoursOut: 336, adjBps: 100 },
    { minHoursOut: 24, adjBps: 0 },
    { minHoursOut: 0, adjBps: -300 },
  ],
  minMarginCents: 300_00,
  maxMarginBps: 2000,
  minNetMarginCents: 150_00,
  cardFeeBps: 290,
  cardFeeFixedCents: 30,
  handlingCents: { standard: 450_00, premium: 1_100_00 },
  fetBps: 750,
  segmentFeeCents: 5_30,
  intlHeadTaxCents: 23_00,
  fullCharterCeilingRatio: 0.85,
  perHourSanity: { min: 0.12, max: 1.5 },
  priceJumpRatio: 0.35,
  maxLegAgeMs: 6 * HOUR,
  maxMarketAgeMs: 48 * HOUR,
  minConfidence: 0.5,
  minLeadTimeMs: 3 * HOUR,
  quoteTtlMs: 15 * MINUTE,
};
