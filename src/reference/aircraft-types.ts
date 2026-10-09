import type { AircraftCategory, AircraftType } from '../domain/types.ts';

// Typical published figures, rounded. hourlyRateCents is the retail full-charter rate the
// "you save X%" comparison and the full-charter ceiling guardrail are measured against.
export const AIRCRAFT_TYPES: AircraftType[] = [
  { code: 'PC12', name: 'Pilatus PC-12', category: 'turboprop', seats: 8, cruiseKts: 270, rangeNm: 1560, hourlyRateCents: 2_900_00, fuelBurnGph: 66, aliases: ['pc-12', 'pc12', 'pilatus'] },
  { code: 'C25B', name: 'Citation CJ3+', category: 'light', seats: 7, cruiseKts: 405, rangeNm: 2000, hourlyRateCents: 4_600_00, fuelBurnGph: 190, aliases: ['cj3', 'citation cj3', 'cj3+'] },
  { code: 'E55P', name: 'Phenom 300E', category: 'light', seats: 7, cruiseKts: 450, rangeNm: 1970, hourlyRateCents: 5_200_00, fuelBurnGph: 180, aliases: ['phenom 300', 'phenom300', 'p300'] },
  { code: 'LJ75', name: 'Learjet 75', category: 'light', seats: 8, cruiseKts: 465, rangeNm: 2040, hourlyRateCents: 5_400_00, fuelBurnGph: 210, aliases: ['learjet 75', 'lear 75', 'lj75'] },
  { code: 'C56X', name: 'Citation XLS+', category: 'midsize', seats: 8, cruiseKts: 430, rangeNm: 2100, hourlyRateCents: 6_200_00, fuelBurnGph: 230, aliases: ['citation xls', 'xls+', 'citation excel', 'xls'] },
  { code: 'H25B', name: 'Hawker 900XP', category: 'midsize', seats: 8, cruiseKts: 448, rangeNm: 2700, hourlyRateCents: 6_000_00, fuelBurnGph: 260, aliases: ['hawker 900', 'hawker 900xp', 'hawker 800'] },
  { code: 'C68A', name: 'Citation Latitude', category: 'midsize', seats: 9, cruiseKts: 446, rangeNm: 2700, hourlyRateCents: 6_800_00, fuelBurnGph: 240, aliases: ['latitude', 'citation latitude'] },
  { code: 'CL35', name: 'Challenger 350', category: 'super-midsize', seats: 9, cruiseKts: 470, rangeNm: 3200, hourlyRateCents: 8_800_00, fuelBurnGph: 290, aliases: ['challenger 350', 'challenger 300', 'cl350', 'cl300'] },
  { code: 'C700', name: 'Citation Longitude', category: 'super-midsize', seats: 9, cruiseKts: 476, rangeNm: 3500, hourlyRateCents: 9_200_00, fuelBurnGph: 300, aliases: ['longitude', 'citation longitude'] },
  { code: 'F2TH', name: 'Falcon 2000LXS', category: 'heavy', seats: 10, cruiseKts: 470, rangeNm: 4000, hourlyRateCents: 10_500_00, fuelBurnGph: 330, aliases: ['falcon 2000', 'falcon 2000lx', 'f2000'] },
  { code: 'CL60', name: 'Challenger 650', category: 'heavy', seats: 12, cruiseKts: 459, rangeNm: 4000, hourlyRateCents: 10_800_00, fuelBurnGph: 400, aliases: ['challenger 650', 'challenger 605', 'cl650', 'cl605'] },
  { code: 'GLF4', name: 'Gulfstream G450', category: 'heavy', seats: 14, cruiseKts: 476, rangeNm: 4300, hourlyRateCents: 11_500_00, fuelBurnGph: 450, aliases: ['g450', 'gulfstream g450', 'giv-sp', 'g-iv'] },
  { code: 'GLF6', name: 'Gulfstream G650ER', category: 'ultra-long', seats: 16, cruiseKts: 488, rangeNm: 7500, hourlyRateCents: 16_500_00, fuelBurnGph: 480, aliases: ['g650', 'g650er', 'gulfstream g650'] },
  { code: 'GL7T', name: 'Global 7500', category: 'ultra-long', seats: 17, cruiseKts: 488, rangeNm: 7700, hourlyRateCents: 17_500_00, fuelBurnGph: 520, aliases: ['global 7500', 'g7500', 'bombardier global 7500'] },
];

const byCode = new Map(AIRCRAFT_TYPES.map((t) => [t.code, t]));

/**
 * Performance and cost defaults per category, used for aircraft types we learn from a feed and
 * have no curated figures for. Deliberately middle-of-the-class: the pricing guardrails assume
 * these are approximate.
 */
export const CATEGORY_DEFAULTS: Record<AircraftCategory, Omit<AircraftType, 'code' | 'name' | 'category' | 'aliases'>> = {
  turboprop: { seats: 8, cruiseKts: 280, rangeNm: 1500, hourlyRateCents: 2_800_00, fuelBurnGph: 70 },
  light: { seats: 7, cruiseKts: 420, rangeNm: 1800, hourlyRateCents: 4_800_00, fuelBurnGph: 180 },
  midsize: { seats: 8, cruiseKts: 440, rangeNm: 2400, hourlyRateCents: 6_300_00, fuelBurnGph: 240 },
  'super-midsize': { seats: 9, cruiseKts: 470, rangeNm: 3200, hourlyRateCents: 8_800_00, fuelBurnGph: 290 },
  heavy: { seats: 13, cruiseKts: 475, rangeNm: 4000, hourlyRateCents: 11_000_00, fuelBurnGph: 400 },
  'ultra-long': { seats: 15, cruiseKts: 490, rangeNm: 6500, hourlyRateCents: 16_000_00, fuelBurnGph: 480 },
};

/**
 * Maps a provider's aircraft class name ("Light jet", "Super midsize jet", "Turbo prop"...) to our
 * category. Returns null for classes we don't sell (helicopters, pistons, airliners, cargo).
 */
export function categoryFromClass(className: string | null | undefined): AircraftCategory | null {
  const c = (className ?? '').toLowerCase();
  if (!c) return null;
  if (/heli|piston|cargo|airliner/.test(c) && !/vip/.test(c)) return null;
  if (/turbo ?prop/.test(c)) return 'turboprop';
  if (/super.?mid/.test(c)) return 'super-midsize';
  if (/mid/.test(c)) return 'midsize';
  if (/very light|entry|light/.test(c)) return 'light';
  if (/ultra|long range|bbj|vip/.test(c)) return 'ultra-long';
  if (/heavy|large/.test(c)) return 'heavy';
  return null;
}

/** Stable code for a feed-learned type: its ICAO designator, or a slug of its name. */
export function typeCodeFor(name: string, icao: string | null | undefined): string {
  const i = (icao ?? '').trim().toUpperCase();
  if (/^[A-Z0-9]{2,4}$/.test(i)) return i;
  return 'X-' + name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

/**
 * Adds a type learned from a feed. If a curated type already has this code, the curated one wins
 * (and the feed name becomes an alias so future matching succeeds).
 */
export function registerAircraftType(t: Partial<AircraftType> & Pick<AircraftType, 'code' | 'name' | 'category'>): AircraftType {
  const existing = byCode.get(t.code);
  if (existing) {
    const alias = t.name.trim().toLowerCase();
    if (alias && existing.name.toLowerCase() !== alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
    return existing;
  }
  const d = CATEGORY_DEFAULTS[t.category];
  const type: AircraftType = {
    seats: t.seats ?? d.seats,
    cruiseKts: t.cruiseKts ?? d.cruiseKts,
    rangeNm: t.rangeNm ?? d.rangeNm,
    hourlyRateCents: t.hourlyRateCents ?? d.hourlyRateCents,
    fuelBurnGph: t.fuelBurnGph ?? d.fuelBurnGph,
    aliases: t.aliases ?? [],
    source: 'feed',
    code: t.code,
    name: t.name,
    category: t.category,
  };
  AIRCRAFT_TYPES.push(type);
  byCode.set(type.code, type);
  return type;
}

export function findAircraftType(code: string): AircraftType | undefined {
  return byCode.get(code);
}

export function getAircraftType(code: string): AircraftType {
  const t = byCode.get(code);
  if (!t) throw new Error(`Unknown aircraft type ${code}`);
  return t;
}

/** Best-effort mapping of a free-text type name from a third-party feed to a type code. */
export function matchTypeHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const h = hint.trim().toLowerCase();
  if (byCode.has(hint.trim().toUpperCase())) return hint.trim().toUpperCase();
  for (const t of AIRCRAFT_TYPES) {
    if (t.name.toLowerCase() === h || t.aliases.includes(h)) return t.code;
  }
  for (const t of AIRCRAFT_TYPES) {
    if (t.aliases.some((a) => a.length >= 4 && h.includes(a))) return t.code;
  }
  return null;
}
