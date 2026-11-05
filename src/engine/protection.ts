/**
 * NERC PRC-024-3 generator frequency and voltage protective-relay boundaries (Eastern Interconnection).
 * The standard defines the region in which generators must NOT trip. The game assumes a unit trips
 * as soon as its operating point has spent the boundary duration outside that region.
 * Source: https://www.nerc.com/globalassets/standards/reliability-standards/prc/prc-024-3.pdf
 */

/** Seconds a unit may ride through at frequency f (Hz); Infinity inside the no-trip zone, 0 for an instant trip. */
export function frequencyRideThrough(f: number): number {
  if (f >= 59.5 && f <= 60.5) return Infinity;
  if (f <= 57.8 || f >= 61.8) return 0;
  if (f < 59.5) return Math.pow(10, 1.7373 * f - 100.116);
  return Math.pow(10, 90.935 - 1.45713 * f);
}

/** Seconds a unit may ride through at voltage v (pu); Infinity inside the no-trip zone, 0 for an instant trip. */
export function voltageRideThrough(v: number): number {
  if (v >= 0.9 && v < 1.1) return Infinity;
  if (v >= 1.2 || v < 0.45) return 0;
  if (v >= 1.175) return 0.2;
  if (v >= 1.15) return 0.5;
  if (v >= 1.1) return 1.0;
  if (v < 0.65) return 0.3;
  if (v < 0.75) return 2.0;
  return 3.0;
}

/** Operating bands used during restoration (PJM Manual 36). */
export const BANDS = {
  fLow: 59.75, fHigh: 61.0, fShed: 59.5, fUFLS: 59.3,
  vLow: 0.9, vHigh: 1.05,
  syncDf: 0.1, syncDv: 0.05, loopAngleDeg: 20,
};
