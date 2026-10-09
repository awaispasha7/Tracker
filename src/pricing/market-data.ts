// Market inputs for pricing, kept fresh without paid feeds.
//
//   FX     European Central Bank daily reference rates (free, no key), refreshed daily.
//   fuel   set by ops in the console (it moves slowly and only affects legs priced without an
//          operator ask); valid for PricingConfig.maxFuelAgeMs.

import type { MarketRepo } from '../db/repos.ts';
import type { Clock } from '../domain/types.ts';

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const CURRENCIES = ['EUR', 'GBP', 'CHF', 'CAD', 'AED', 'MXN'];
/** Currencies the ECB doesn't publish but that are pegged to the dollar (units per USD). */
const USD_PEGS: Record<string, number> = { AED: 3.6725 };

export type TextFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Parses the ECB daily XML (rates are units of currency per 1 EUR). */
export function parseEcb(xml: string): { date: string; perEur: Record<string, number> } | null {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const perEur: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) perEur[m[1]] = Number(m[2]);
  if (!date || !perEur.USD) return null;
  return { date, perEur };
}

export async function refreshFx(market: MarketRepo, clock: Clock, fetchText: TextFetch = globalThis.fetch as unknown as TextFetch): Promise<{ ok: boolean; updated: string[]; error?: string }> {
  try {
    const res = await fetchText(ECB_DAILY_URL);
    if (!res.ok) return { ok: false, updated: [], error: `ECB returned ${res.status}` };
    const parsed = parseEcb(await res.text());
    if (!parsed) return { ok: false, updated: [], error: 'could not parse ECB rates' };
    const now = clock.now();
    const updated: string[] = [];
    for (const [c, perUsd] of Object.entries(USD_PEGS)) parsed.perEur[c] ??= parsed.perEur.USD * perUsd;
    for (const c of CURRENCIES) {
      const perEur = parsed.perEur[c];
      if (!perEur) continue;
      // USD per unit of c = (USD per EUR) / (c per EUR)
      market.set(`fx_usd_per_${c}`, Math.round((parsed.perEur.USD / perEur) * 1e6) / 1e6, now);
      updated.push(c);
    }
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, updated: [], error: (e as Error).message };
  }
}

export function marketStatus(market: MarketRepo) {
  const fuel = market.get('fuel_cents_per_gal');
  return {
    fuelCentsPerGal: fuel?.value ?? null,
    fuelAsOf: fuel ? new Date(fuel.asOf).toISOString() : null,
    fx: Object.fromEntries(CURRENCIES.map((c) => {
      const v = market.get(`fx_usd_per_${c}`);
      return [c, v ? { usdPer: v.value, asOf: new Date(v.asOf).toISOString() } : null];
    })),
  };
}
