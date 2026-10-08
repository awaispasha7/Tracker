// All-in pricing for one empty leg.
//
//   operator payout   operator's net ask (converted to USD), or a modelled repositioning price
//                     (+ fuel surcharge + handling) when the operator only told us the flight exists
// + platform fee      category margin, adjusted for lead time, clamped to [min, max]
// = transportation    the amount US excise tax is assessed on
// + taxes             FET 7.5% + segment fees (US domestic) or international head tax
// = all-in total      what the traveler pays; nothing is added at checkout
//
// Every price passes a set of guardrails before it can be shown or quoted. A failed guardrail
// means the leg is not sold at that price: it is hidden from search and surfaced for review.

import type { Leg } from '../domain/types.ts';
import { HOUR } from '../domain/types.ts';
import type { MarketRepo } from '../db/repos.ts';
import type { PricingConfig } from './config.ts';
import { getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { estimateFlight, type FlightEstimate } from '../domain/geo.ts';

export interface PriceLine {
  code: 'operator_rate' | 'fuel_surcharge' | 'handling' | 'platform_fee' | 'fet' | 'segment_fees' | 'intl_taxes';
  label: string;
  amountCents: number;
  /** Who the money is ultimately for. */
  payee: 'operator' | 'platform' | 'government';
}

export interface GuardrailResult {
  code: string;
  ok: boolean;
  severity: 'block' | 'review';
  message: string;
}

export interface PriceResult {
  ok: boolean;
  currency: 'USD';
  totalCents: number;
  lines: PriceLine[];
  operatorPayoutCents: number;
  platformFeeCents: number;
  taxCents: number;
  netMarginCents: number;
  fullCharterEstimateCents: number;
  savingsPct: number;
  basis: 'operator_ask' | 'rate_model';
  flight: FlightEstimate | null;
  guardrails: GuardrailResult[];
  failures: GuardrailResult[];
  notes: string[];
}

export interface PriceInput {
  leg: Leg;
  pax: number;
  seats: number;
  now: number;
}

const round = (n: number) => Math.round(n);

export class PricingEngine {
  private market: MarketRepo;
  readonly config: PricingConfig;

  constructor(market: MarketRepo, config: PricingConfig) {
    this.market = market;
    this.config = config;
  }

  price({ leg, pax, seats, now }: PriceInput): PriceResult {
    const cfg = this.config;
    const checks: GuardrailResult[] = [];
    const notes: string[] = [];
    const check = (code: string, ok: boolean, message: string, severity: 'block' | 'review' = 'block') =>
      checks.push({ code, ok, severity, message });

    // ---- sellability of the underlying supply ----
    const blocking = leg.conflicts.filter((c) => c.blocking);
    check('LEG_AVAILABLE', leg.supplyStatus === 'available', `supply status is ${leg.supplyStatus}`);
    check('LEG_UNCONFLICTED', blocking.length === 0, `unresolved conflicts: ${blocking.map((c) => c.code).join(', ') || 'none'}`);
    check('LEG_CONFIDENCE', leg.confidence >= cfg.minConfidence, `confidence ${leg.confidence} (min ${cfg.minConfidence})`);
    check('LEG_FRESH', now - leg.lastSeenAt <= cfg.maxLegAgeMs, `last confirmed ${Math.round((now - leg.lastSeenAt) / 60000)} min ago`);
    check('LEAD_TIME', leg.departLatest - now >= cfg.minLeadTimeMs, 'departs too soon to confirm with the operator');
    check('CAPACITY', pax >= 1 && pax <= seats, `${pax} passengers, ${seats} seats`);

    if (!leg.typeCode) {
      check('AIRCRAFT_KNOWN', false, 'aircraft type unknown');
      return this.fail(checks, notes);
    }
    const type = getAircraftType(leg.typeCode);
    const from = getAirport(leg.fromIcao);
    const to = getAirport(leg.toIcao);
    const flight = estimateFlight(from, to, type);
    const hoursOut = Math.max(0, (leg.departEarliest - now) / HOUR);
    const billableHours = Math.max(flight.blockHours, cfg.minBillableHours);

    const fuel = this.market.get('fuel_cents_per_gal');
    check('MARKET_FRESH', !!fuel && now - fuel.asOf <= cfg.maxMarketAgeMs, 'fuel index missing or stale');
    const fuelCents = fuel?.value ?? cfg.baselineFuelCentsPerGal;
    const fuelSurcharge = round(Math.max(0, fuelCents - cfg.baselineFuelCentsPerGal) * type.fuelBurnGph * flight.blockHours);
    const handling = cfg.handlingCents[from.feeTier] + cfg.handlingCents[to.feeTier];

    // ---- operator side ----
    const lines: PriceLine[] = [];
    let basis: PriceResult['basis'];
    let operatorPayout: number;
    let operatorFloor = 0;
    if (leg.askCents !== null) {
      basis = 'operator_ask';
      let ask = leg.askCents;
      if (leg.currency !== 'USD') {
        const fx = this.market.get(`fx_usd_per_${leg.currency}`);
        check('FX_AVAILABLE', !!fx && now - fx.asOf <= cfg.maxMarketAgeMs, `no fresh FX rate for ${leg.currency}`);
        ask = round(ask * (fx?.value ?? 1));
        notes.push(`operator ask converted from ${leg.currency}`);
      }
      operatorPayout = ask;
      operatorFloor = ask;
      lines.push({ code: 'operator_rate', label: `${type.name} empty leg (operator rate)`, amountCents: ask, payee: 'operator' });
    } else {
      basis = 'rate_model';
      const factor = cfg.repositioningFactor.find((f) => hoursOut >= f.minHoursOut)?.factor ?? 0.33;
      const rate = round(type.hourlyRateCents * billableHours * factor);
      lines.push({ code: 'operator_rate', label: `${type.name} repositioning rate (${billableHours}h billable)`, amountCents: rate, payee: 'operator' });
      if (fuelSurcharge > 0) lines.push({ code: 'fuel_surcharge', label: 'Fuel surcharge', amountCents: fuelSurcharge, payee: 'operator' });
      lines.push({ code: 'handling', label: 'Landing & handling', amountCents: handling, payee: 'operator' });
      operatorPayout = rate + (fuelSurcharge > 0 ? fuelSurcharge : 0) + handling;
    }

    // ---- what the same trip costs as a regular one-way charter ----
    const fullCharter = round(type.hourlyRateCents * billableHours) + fuelSurcharge + handling;

    const usDomestic = from.country === 'US' && to.country === 'US';
    const touchesUs = from.country === 'US' || to.country === 'US';
    const segments = 1 + flight.fuelStops;
    const headTax = usDomestic ? cfg.segmentFeeCents * pax * segments : touchesUs ? cfg.intlHeadTaxCents * pax : 0;
    const fetRate = usDomestic ? cfg.fetBps / 10_000 : 0;

    // ---- margin ----
    const adj = cfg.urgencyMarginAdjBps.find((u) => hoursOut >= u.minHoursOut)?.adjBps ?? 0;
    const bps = cfg.marginBps[type.category] + adj;
    const cap = round((operatorPayout * cfg.maxMarginBps) / 10_000);
    // Break-even fee: the smallest fee that still leaves minNetMargin after card processing, which is
    // charged on the whole total (fee and taxes included). Solved in closed form for fee.
    const r = cfg.cardFeeBps / 10_000;
    const k = 1 + fetRate;
    const breakEven = Math.ceil((cfg.minNetMarginCents + cfg.cardFeeFixedCents + r * (operatorPayout * k + headTax)) / (1 - r * k));
    const minFee = Math.max(cfg.minMarginCents, breakEven);
    let platformFee = Math.max(minFee, Math.min(round((operatorPayout * bps) / 10_000), cap));

    // Margin compression: rather than lose the "well below full charter" promise, give up margin,
    // but never below break-even. If that still isn't enough the leg simply isn't a deal.
    const ceiling = round(fullCharter * cfg.fullCharterCeilingRatio);
    if (operatorPayout + platformFee > ceiling) {
      const room = ceiling - operatorPayout;
      if (room >= minFee) {
        notes.push(`margin compressed from ${platformFee} to ${room} to stay under full-charter ceiling`);
        platformFee = room;
      }
    }
    const transport = operatorPayout + platformFee;
    check('FULL_CHARTER_CEILING', transport <= ceiling,
      `pre-tax ${transport} vs ceiling ${ceiling} (${Math.round(cfg.fullCharterCeilingRatio * 100)}% of full charter ${fullCharter})`);
    lines.push({ code: 'platform_fee', label: 'Booking & service fee', amountCents: platformFee, payee: 'platform' });

    // ---- taxes ----
    let tax = 0;
    if (usDomestic) {
      const fet = round((transport * cfg.fetBps) / 10_000);
      const seg = headTax;
      lines.push({ code: 'fet', label: 'US Federal Excise Tax (7.5%)', amountCents: fet, payee: 'government' });
      lines.push({ code: 'segment_fees', label: `US segment fees (${pax} pax x ${segments})`, amountCents: seg, payee: 'government' });
      tax = fet + seg;
    } else if (touchesUs) {
      const intl = headTax;
      lines.push({ code: 'intl_taxes', label: `US international transportation tax (${pax} pax)`, amountCents: intl, payee: 'government' });
      tax = intl;
    }
    const total = transport + tax;

    // ---- economics & sanity ----
    const cardFee = round((total * cfg.cardFeeBps) / 10_000) + cfg.cardFeeFixedCents;
    const netMargin = platformFee - cardFee;
    check('MIN_NET_MARGIN', netMargin >= cfg.minNetMarginCents, `net margin ${netMargin} after card fees (min ${cfg.minNetMarginCents})`);
    check('OPERATOR_FLOOR', operatorPayout >= operatorFloor, 'operator payout below operator ask');
    const perHourRatio = total / billableHours / type.hourlyRateCents;
    check('PRICE_SANITY', perHourRatio >= cfg.perHourSanity.min && perHourRatio <= cfg.perHourSanity.max,
      `all-in is ${(perHourRatio * 100).toFixed(0)}% of the ${type.name} hourly rate per billable hour; possible unit or data error`);
    if (leg.lastPublishedPriceCents !== null) {
      const move = Math.abs(total - leg.lastPublishedPriceCents) / leg.lastPublishedPriceCents;
      check('PRICE_JUMP', move <= cfg.priceJumpRatio,
        `price moved ${(move * 100).toFixed(0)}% since last shown (${leg.lastPublishedPriceCents} -> ${total}); needs review`, 'review');
    }

    const failures = checks.filter((c) => !c.ok);
    return {
      ok: failures.length === 0,
      currency: 'USD',
      totalCents: total,
      lines,
      operatorPayoutCents: operatorPayout,
      platformFeeCents: platformFee,
      taxCents: tax,
      netMarginCents: netMargin,
      fullCharterEstimateCents: fullCharter + (usDomestic ? round((fullCharter * cfg.fetBps) / 10_000) : 0),
      savingsPct: Math.max(0, Math.round((1 - transport / fullCharter) * 100)),
      basis,
      flight,
      guardrails: checks,
      failures,
      notes,
    };
  }

  private fail(checks: GuardrailResult[], notes: string[]): PriceResult {
    return {
      ok: false, currency: 'USD', totalCents: 0, lines: [], operatorPayoutCents: 0, platformFeeCents: 0, taxCents: 0,
      netMarginCents: 0, fullCharterEstimateCents: 0, savingsPct: 0, basis: 'rate_model', flight: null,
      guardrails: checks, failures: checks.filter((c) => !c.ok), notes,
    };
  }
}
