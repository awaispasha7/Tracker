import type { Airport, AircraftType } from './types.ts';

const EARTH_RADIUS_NM = 3440.065;

export function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

export interface FlightEstimate {
  distanceNm: number;
  fuelStops: number;
  blockHours: number;
}

/**
 * Block time: great-circle distance at ~88% of cruise speed (routing, climb, descent) plus
 * 0.3h for taxi; each technical fuel stop adds 0.75h. Range is derated 10% for reserves/winds.
 */
export function estimateFlight(from: Airport, to: Airport, type: AircraftType): FlightEstimate {
  const d = distanceNm(from, to);
  const usableRange = type.rangeNm * 0.9;
  const fuelStops = Math.max(0, Math.ceil(d / usableRange) - 1);
  const blockHours = d / (type.cruiseKts * 0.88) + 0.3 + fuelStops * 0.75;
  return { distanceNm: Math.round(d), fuelStops, blockHours: Math.round(blockHours * 100) / 100 };
}
