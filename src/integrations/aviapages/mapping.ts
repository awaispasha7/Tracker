// Mapping Aviapages payloads onto our model. Everything an Aviapages empty leg tells us about the
// world (airports, aircraft types, operators, tails, photos, amenities) is registered here, so a
// listing can be reconciled, priced and booked without extra API calls.

import type { Aircraft, Airport, Operator } from '../../domain/types.ts';
import type { FleetRepo, ReferenceRepo } from '../../db/repos.ts';
import { findAirport, registerAirport } from '../../reference/airports.ts';
import { categoryFromClass, findAircraftType, matchTypeHint, registerAircraftType, typeCodeFor } from '../../reference/aircraft-types.ts';
import { normalizeTail } from '../../domain/ids.ts';
import type { AvpAirportRef, AvpEmptyLeg, AvpImage, QuoteReply } from './types.ts';

export const SOURCE_ID = 'aviapages';

/** Our key for an Aviapages airport: ICAO, else local identifier, else IATA. */
export function airportCode(ref: AvpAirportRef | null | undefined): string | null {
  const c = (ref?.icao || ref?.lid || ref?.iata || '').trim().toUpperCase();
  return c || null;
}

export function operatorIdFor(companyId: number | string): string {
  return `avp_${companyId}`;
}

export interface Registrar {
  fleet: FleetRepo;
  reference: ReferenceRepo;
}

/** Registers an airport we haven't seen. Returns our airport, or null if the payload can't place it. */
export function ensureAirport(r: Registrar, ref: AvpAirportRef | null | undefined): Airport | null {
  const code = airportCode(ref);
  if (!code || !ref) return null;
  const known = findAirport(code) ?? (ref.icao ? findAirport(ref.icao) : undefined) ?? (ref.iata ? findAirport(ref.iata) : undefined);
  if (known) return known;
  if (typeof ref.latitude !== 'number' || typeof ref.longitude !== 'number') return null;
  const a = registerAirport({
    icao: code,
    iata: (ref.iata ?? '').toUpperCase(),
    name: ref.name ?? code,
    city: ref.city?.name ?? ref.name ?? code,
    country: (ref.city?.country?.iso_alpha2 ?? '').toUpperCase() || '??',
    lat: ref.latitude,
    lon: ref.longitude,
    feeTier: 'standard',
    source: 'feed',
    externalId: ref.id != null ? String(ref.id) : undefined,
  });
  r.reference.saveAirport(a);
  return a;
}

/** Maps a provider type to ours, learning it if new. Returns null for aircraft we don't sell. */
export function ensureAircraftType(r: Registrar, name: string | null, icao: string | null, className: string | null, seats: number | null): string | null {
  if (!name && !icao) return null;
  const known = (icao && findAircraftType(icao.toUpperCase()) ? icao.toUpperCase() : null) ?? matchTypeHint(name) ?? (icao ? matchTypeHint(icao) : null);
  if (known) return known;
  const category = categoryFromClass(className);
  if (!category) return null;
  const t = registerAircraftType({ code: typeCodeFor(name ?? icao!, icao), name: name ?? icao!, category, seats: seats ?? undefined });
  r.reference.saveAircraftType(t);
  return t.code;
}

function imageUrls(images: AvpImage[] | null | undefined): string[] {
  return (images ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((i) => i.media?.path ?? i.url ?? null)
    .filter((u): u is string => !!u && /^https?:\/\//.test(u))
    .slice(0, 6);
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
  operatorId?: string;
  tail?: string;
}

/**
 * Registers everything an empty-leg listing implies. A tail that a directly-signed operator owns is
 * never reassigned: their registry entry stays authoritative and the listing becomes one more
 * third-party report about their aircraft.
 */
export function registerFromEmptyLeg(r: Registrar, leg: AvpEmptyLeg): RegisterResult {
  const dep = ensureAirport(r, leg.dep_airport);
  if (!dep) return { ok: false, reason: 'unknown_airport' };
  if (!leg.arr_airport) return { ok: false, reason: 'no_destination' };
  const arr = ensureAirport(r, leg.arr_airport);
  if (!arr) return { ok: false, reason: 'unknown_airport' };
  const tail = normalizeTail(leg.aircraft?.registration_number ?? leg.registration_number ?? '');
  if (tail.length < 3) return { ok: false, reason: 'no_registration' };

  const details = leg.aircraft_type_details;
  const typeCode = ensureAircraftType(r, details?.name ?? leg.aircraft_type, details?.icao ?? null, details?.aircraft_class?.name ?? null, leg.aircraft?.passengers_max ?? null);
  if (!typeCode) return { ok: false, reason: 'unsupported_aircraft' };

  const existing = r.fleet.getAircraft(tail);
  if (existing && existing.source !== 'aviapages') return { ok: true, operatorId: existing.operatorId, tail };

  const company = leg.aircraft?.company;
  const companyKey = company ? String(company.id) : `name:${(leg.company ?? 'unknown').toLowerCase()}`;
  const operatorId = operatorIdFor(company ? company.id : companyKey.replace(/[^a-z0-9]+/g, '-'));
  const prior = r.fleet.getOperator(operatorId);
  const operator: Operator = {
    id: operatorId,
    name: company?.name ?? leg.company ?? 'Unknown operator',
    certificate: 'Aviapages network listing (AOC not yet verified by us)',
    status: prior?.status ?? 'active',
    source: 'aviapages',
    externalId: companyKey,
    contact: {
      ...prior?.contact,
      email: company?.contact_email ?? prior?.contact?.email ?? null,
      phone: company?.phone ?? prior?.contact?.phone ?? null,
      website: company?.website ?? prior?.contact?.website ?? null,
      city: dep.city,
    },
  };
  r.fleet.upsertOperator(operator);

  const ext = leg.aircraft?.aircraft_extension ?? null;
  const amenities: Aircraft['amenities'] = {};
  if (ext) {
    for (const k of ['wireless_internet', 'lavatory', 'cabin_crew', 'hot_meal', 'entertainment_system', 'pets_allowed', 'smoking', 'shower', 'satellite_phone'] as const) {
      if (typeof ext[k] === 'boolean') amenities[k] = ext[k] as boolean;
    }
    if (ext.sleeping_places) amenities.sleeping_places = ext.sleeping_places;
    if (ext.refurbishment) amenities.refurbished = ext.refurbishment;
  }
  r.fleet.upsertAircraft({
    tail,
    operatorId,
    typeCode,
    seats: leg.aircraft?.passengers_max ?? findAircraftType(typeCode)?.seats ?? 6,
    homeBase: existing?.homeBase ?? dep.icao,
    year: leg.aircraft?.year_of_production ?? existing?.year ?? 0,
    source: 'aviapages',
    externalId: leg.aircraft ? String(leg.aircraft.id) : null,
    images: [...imageUrls(leg.aircraft?.images), ...imageUrls(details?.images)].slice(0, 6),
    amenities,
  });
  return { ok: true, operatorId, tail };
}

/** Registers the operator and aircraft from a quote reply (used for custom charter offers). */
export function registerFromReply(r: Registrar, reply: QuoteReply, fallbackBase: string): { operatorId: string; tail: string; typeCode: string | null } {
  const operatorId = operatorIdFor(reply.company.id);
  const prior = r.fleet.getOperator(operatorId);
  r.fleet.upsertOperator({
    id: operatorId,
    name: reply.company.name,
    certificate: prior?.certificate ?? 'Aviapages network listing (AOC not yet verified by us)',
    status: prior?.status ?? 'active',
    source: prior?.source ?? 'aviapages',
    externalId: String(reply.company.id),
    contact: {
      ...prior?.contact,
      email: reply.manager_account?.email ?? prior?.contact?.email ?? null,
      phone: reply.manager_account?.phone ?? prior?.contact?.phone ?? null,
      responseRate: reply.company.company_extension?.avg_response_rate ?? prior?.contact?.responseRate ?? null,
      responseTimeMin: reply.company.company_extension?.avg_response_time ?? prior?.contact?.responseTimeMin ?? null,
    },
  });
  const tail = normalizeTail(reply.aircraft.tail_number ?? `AVP${reply.aircraft.id}`);
  const typeCode = ensureAircraftType(r, reply.aircraft.aircraft_type, null, reply.aircraft.aircraft_class, reply.aircraft.max_passengers);
  const existing = r.fleet.getAircraft(tail);
  if (typeCode && (!existing || existing.source === 'aviapages')) {
    r.fleet.upsertAircraft({
      tail, operatorId, typeCode,
      seats: reply.aircraft.max_passengers ?? findAircraftType(typeCode)?.seats ?? 6,
      homeBase: findAirport(reply.aircraft.home_base ?? '')?.icao ?? existing?.homeBase ?? fallbackBase,
      year: reply.aircraft.year_of_production ?? existing?.year ?? 0,
      source: 'aviapages', externalId: String(reply.aircraft.id),
      images: (reply.aircraft.images ?? []).map((i) => i.url).filter((u): u is string => !!u).slice(0, 6),
      amenities: Object.fromEntries((['wireless_internet', 'lavatory', 'cabin_crew', 'hot_meal'] as const)
        .filter((k) => typeof reply.aircraft[k] === 'boolean').map((k) => [k, reply.aircraft[k] as boolean])),
    });
  }
  return { operatorId: existing && existing.source !== 'aviapages' ? existing.operatorId : operatorId, tail, typeCode: existing?.typeCode ?? typeCode };
}
