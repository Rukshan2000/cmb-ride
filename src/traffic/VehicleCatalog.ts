// Sri Lankan traffic mix. Generic "-style" types: proportions from typical Bajaj RE / Axio / HiAce / Lanka Ashok Leyland etc.
// Driving params feed the IDM car-following model (TrafficManager): v0 desired speed, a accel, b comfortable decel,
// T time headway, s0 jam gap. Heavier vehicles: lower a/b, longer T => longer stopping distances.

export type VehicleKind = 'tuktuk' | 'motorcycle' | 'hatch' | 'sedan' | 'van' | 'bus' | 'lorry';
export type Category = 'tuktuk' | 'motorcycle' | 'car' | 'van' | 'bus' | 'lorry';

export interface VehicleSpec {
  id: VehicleKind; category: Category; label: string;
  length: number; width: number; height: number; mass: number; powertrain: 'petrol' | 'hybrid' | 'diesel';
  v0: number; a: number; b: number; T: number; s0: number; // m/s, m/s², m/s², s, m
  colors: number[]; weight: number;                         // spawn share
  // Per-vehicle look, filled in at spawn (VehicleModels.randomLook)
  color?: number; accent?: number; cargo?: number; rider?: number; helmet?: number;
}

export const CATALOG: VehicleSpec[] = [
  { id: 'tuktuk', category: 'tuktuk', label: 'Bajaj RE-style three-wheeler', length: 2.65, width: 1.3, height: 1.75, mass: 350, powertrain: 'petrol',
    v0: 11, a: 1.4, b: 2.8, T: 1.0, s0: 1.2, colors: [0x7a1424, 0xb0181f, 0x1d5e2a, 0x1b3f8a, 0x151515, 0xd6a417], weight: 0.27 },
  { id: 'motorcycle', category: 'motorcycle', label: 'Commuter motorcycle / scooter', length: 1.95, width: 0.75, height: 1.15, mass: 130, powertrain: 'petrol',
    v0: 14, a: 2.4, b: 4.0, T: 0.9, s0: 1.0, colors: [0x151515, 0xb0181f, 0x1b3f8a, 0xdedede, 0x5a5a5a], weight: 0.22 },
  { id: 'hatch', category: 'car', label: 'Wagon R / Alto / Aqua-style hatchback', length: 3.7, width: 1.65, height: 1.6, mass: 900, powertrain: 'hybrid',
    v0: 13.5, a: 1.8, b: 3.5, T: 1.4, s0: 2, colors: [0xf0f0ee, 0xb8bcc2, 0x7d8288, 0x1a1a1a, 0x8a1a22, 0x2a4a8a], weight: 0.17 },
  { id: 'sedan', category: 'car', label: 'Axio / Prius / Corolla-style sedan', length: 4.4, width: 1.7, height: 1.47, mass: 1200, powertrain: 'hybrid',
    v0: 14, a: 1.9, b: 3.5, T: 1.4, s0: 2, colors: [0xf0f0ee, 0xb8bcc2, 0x7d8288, 0x1a1a1a, 0x5a1a22], weight: 0.12 },
  { id: 'van', category: 'van', label: 'HiAce / Caravan-style van', length: 4.8, width: 1.88, height: 2.2, mass: 2000, powertrain: 'diesel',
    v0: 12.5, a: 1.3, b: 3.0, T: 1.6, s0: 2.5, colors: [0xf2f2f0, 0xf2f2f0, 0xb8bcc2, 0xe8c21a /* school van */], weight: 0.09 },
  { id: 'bus', category: 'bus', label: 'Private / SLTB bus', length: 10.5, width: 2.5, height: 3.1, mass: 11000, powertrain: 'diesel',
    v0: 11, a: 0.8, b: 2.4, T: 2.0, s0: 3, colors: [0x9a1b1b /* SLTB maroon */, 0x2a63c8, 0xe0e0e0, 0xd65a1a, 0x1f8a4a], weight: 0.07 },
  { id: 'lorry', category: 'lorry', label: 'Lorry / delivery truck', length: 7, width: 2.3, height: 3.0, mass: 8000, powertrain: 'diesel',
    v0: 10, a: 0.7, b: 2.3, T: 2.2, s0: 3, colors: [0x2a5aa8, 0xd8b21a, 0xe8e8e8, 0x2f7a3a], weight: 0.06 },
];

/** Driver profiles scale a spec's IDM params. */
export const PROFILES = {
  calm:       { v0: 0.9, a: 0.85, T: 1.25, lane: 0.0 },
  normal:     { v0: 1.0, a: 1.0, T: 1.0, lane: 0.1 },
  cautious:   { v0: 0.85, a: 0.8, T: 1.4, lane: 0.0 },
  aggressive: { v0: 1.15, a: 1.25, T: 0.75, lane: 0.3 },
};
export type ProfileName = keyof typeof PROFILES;

export function pickSpec(rnd: () => number, filter?: Category): VehicleSpec {
  const list = filter ? CATALOG.filter(c => c.category === filter) : CATALOG;
  let r = rnd() * list.reduce((s, c) => s + c.weight, 0);
  for (const c of list) if ((r -= c.weight) <= 0) return c;
  return list[0];
}

export function pickProfile(rnd: () => number, spec: VehicleSpec): ProfileName {
  if (spec.category === 'bus' || spec.category === 'lorry') return rnd() < 0.5 ? 'normal' : 'cautious';
  const r = rnd();
  return r < 0.25 ? 'calm' : r < 0.7 ? 'normal' : r < 0.85 ? 'cautious' : 'aggressive';
}
