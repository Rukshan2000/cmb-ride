import type { EngineKind } from '../audio/EngineVoice';

export interface VehicleConfig {
  name: string;
  mass: number;            // kg
  inertia: number;         // yaw moment of inertia, kg·m²
  cgToFront: number;       // m, CG to front axle
  cgToRear: number;        // m
  cgHeight: number;        // m
  trackWidth: number;      // m
  wheelRadius: number;     // m
  length: number; width: number; height: number;
  driveFront: boolean;
  torqueCurve: [number, number][]; // [rpm, Nm]
  idleRpm: number; redline: number;
  gears: number[];         // forward ratios
  reverseRatio: number;
  finalDrive: number;
  shiftUpRpm: number; shiftDownRpm: number;
  maxSteer: number;        // rad at standstill
  steerSpeedFalloff: number; // m/s: steering limit halves at this speed
  steerRate: number;       // rad/s
  corneringStiffness: number; // N/rad per axle (scaled by load)
  mu: number;              // tyre-road friction
  brakeForce: number;      // N total
  dragCoeff: number;       // 0.5·rho·Cd·A
  rollingResistance: number; // N per m/s
  suspensionStiffness: number; // visual body pitch/roll spring
  suspensionDamping: number;
  color: [number, number, number];
  model?: 'sedan' | 'bus' | 'van' | 'tuktuk' | 'motorcycle' | 'camaro';  // body from VehicleModels (default sedan)
  engine?: EngineKind;      // engine sound (default petrol4)
  bike?: boolean;           // two-wheeler: leans into turns instead of rolling out
  accent?: number;          // livery band colour (bus)
  stability?: number;       // ESC strength, 1/s (default 8; 0 = off)
}

/** Japanese-market compact sedan typical of Colombo streets (Axio/Allion class). */
export const compactSedan: VehicleConfig = {
  name: 'Compact sedan',
  mass: 1150,
  inertia: 1700,
  cgToFront: 1.1,
  cgToRear: 1.5,
  cgHeight: 0.55,
  trackWidth: 1.48,
  wheelRadius: 0.3,
  length: 4.4, width: 1.7, height: 1.46,
  driveFront: true,
  torqueCurve: [[800, 95], [2000, 125], [4400, 138], [6000, 120], [6800, 100]],
  idleRpm: 800, redline: 6800,
  gears: [3.17, 1.9, 1.31, 1.0, 0.8],
  reverseRatio: 3.2,
  finalDrive: 4.1,
  shiftUpRpm: 5200, shiftDownRpm: 2000,
  maxSteer: 0.6,
  steerSpeedFalloff: 18,
  steerRate: 1.6,
  corneringStiffness: 70000,
  mu: 1.0,
  brakeForce: 10500,
  dragCoeff: 0.38,
  rollingResistance: 14,
  suspensionStiffness: 60,
  suspensionDamping: 9,
  color: [0.88, 0.89, 0.9],
};

/** 10.5 m single-deck city bus (Lanka Metro / Ashok Leyland Viking class), diesel, 5-speed manual. */
export const cityBus: VehicleConfig = {
  name: 'City bus',
  model: 'bus',
  mass: 11000,
  inertia: 105000,
  cgToFront: 3.25,
  cgToRear: 2.75,
  cgHeight: 1.2,
  trackWidth: 2.0,
  wheelRadius: 0.5,
  length: 10.5, width: 2.5, height: 3.1,
  driveFront: false,
  torqueCurve: [[600, 480], [1200, 760], [1800, 720], [2600, 560]],
  idleRpm: 600, redline: 2600,
  gears: [6.5, 3.8, 2.3, 1.45, 1.0],
  reverseRatio: 6.0,
  finalDrive: 5.2,
  shiftUpRpm: 2200, shiftDownRpm: 1000,
  maxSteer: 0.62,
  steerSpeedFalloff: 9,
  steerRate: 1.0,
  corneringStiffness: 650000,
  mu: 0.9,
  brakeForce: 66000,
  dragCoeff: 3.4,
  rollingResistance: 120,
  suspensionStiffness: 25,
  suspensionDamping: 6,
  color: [0.93, 0.93, 0.92],
  engine: 'diesel6',
};

/** 150 cc commuter motorcycle + rider (Bajaj Pulsar / Honda CB class). Light, quick, 2 wheels, leans into turns. */
export const motorcycle: VehicleConfig = {
  name: 'Motorcycle', model: 'motorcycle', engine: 'single', bike: true,
  mass: 230, inertia: 60, cgToFront: 0.65, cgToRear: 0.65, cgHeight: 0.65, trackWidth: 0, wheelRadius: 0.3,
  length: 1.95, width: 0.75, height: 1.15, driveFront: false,
  torqueCurve: [[1400, 9], [5000, 13], [7500, 13.5], [9500, 11]], idleRpm: 1400, redline: 9500,
  gears: [2.8, 1.85, 1.4, 1.15, 0.95], reverseRatio: 2.8, finalDrive: 10, shiftUpRpm: 8200, shiftDownRpm: 3600,
  maxSteer: 0.5, steerSpeedFalloff: 10, steerRate: 2.6, corneringStiffness: 14000, mu: 1.05,
  brakeForce: 2300, dragCoeff: 0.3, rollingResistance: 4, suspensionStiffness: 55, suspensionDamping: 8,
  color: [0.69, 0.09, 0.12],
};

/** Bajaj RE-style three-wheeler (tuk-tuk): one front wheel, 200 cc, 4-speed, tops out ~70 km/h, tall and tippy. */
export const tuktuk: VehicleConfig = {
  name: 'Tuk-tuk', model: 'tuktuk', engine: 'twoStroke',
  mass: 450, inertia: 280, cgToFront: 1.05, cgToRear: 0.55, cgHeight: 0.75, trackWidth: 1.15, wheelRadius: 0.22,
  length: 2.65, width: 1.3, height: 1.75, driveFront: false,
  torqueCurve: [[1300, 10], [3500, 15], [5000, 14.5], [6000, 12]], idleRpm: 1300, redline: 6000,
  gears: [3.0, 1.9, 1.3, 0.95], reverseRatio: 3.0, finalDrive: 7.5, shiftUpRpm: 5000, shiftDownRpm: 2200,
  maxSteer: 0.55, steerSpeedFalloff: 8, steerRate: 1.6, corneringStiffness: 27000, mu: 0.9,
  brakeForce: 3000, dragCoeff: 0.55, rollingResistance: 8, suspensionStiffness: 28, suspensionDamping: 4,
  color: [0.08, 0.08, 0.08],
  accent: 0xf2c230,                // yellow upper cowl, as on the classic black-and-yellow tuk-tuk
};

/** Toyota HiAce-style diesel van: heavy, torquey, long braking distances. */
export const van: VehicleConfig = {
  name: 'Van', model: 'van', engine: 'diesel6',
  mass: 2000, inertia: 3800, cgToFront: 1.25, cgToRear: 1.4, cgHeight: 0.8, trackWidth: 1.65, wheelRadius: 0.33,
  length: 4.8, width: 1.88, height: 2.2, driveFront: false,
  torqueCurve: [[750, 200], [2000, 300], [3000, 290], [4200, 230]], idleRpm: 750, redline: 4200,
  gears: [4.3, 2.5, 1.5, 1.0, 0.8], reverseRatio: 4.0, finalDrive: 4.1, shiftUpRpm: 3300, shiftDownRpm: 1300,
  maxSteer: 0.58, steerSpeedFalloff: 15, steerRate: 1.3, corneringStiffness: 120000, mu: 0.95,
  brakeForce: 18000, dragCoeff: 0.75, rollingResistance: 25, suspensionStiffness: 40, suspensionDamping: 7,
  color: [0.95, 0.95, 0.94],
};

/** Free-mode garage, in menu order. */
/** 1960s-70s American muscle coupe (supplied model): rear-wheel drive, big V8 torque. */
export const muscleCar: VehicleConfig = {
  ...compactSedan,
  name: 'Muscle coupe', model: 'camaro', engine: 'diesel6',
  mass: 1550, inertia: 2600, cgToFront: 1.54, cgToRear: 1.23, cgHeight: 0.5, trackWidth: 1.63, wheelRadius: 0.34,
  length: 4.75, width: 1.88, height: 1.29, driveFront: false,
  torqueCurve: [[800, 300], [2500, 440], [4000, 480], [5500, 400], [6000, 340]],
  redline: 6000, shiftUpRpm: 5400, gears: [2.52, 1.88, 1.46, 1.0], finalDrive: 3.55,
  corneringStiffness: 95000, mu: 1.05, brakeForce: 15000,
  color: [0.69, 0.11, 0.13],
};

export const GARAGE = { muscle: muscleCar, car: compactSedan, motorcycle, tuktuk, van, bus: cityBus } as const;
export type GarageKey = keyof typeof GARAGE;
