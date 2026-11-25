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
  model?: 'sedan' | 'bus';  // body from VehicleModels (default sedan)
  accent?: number;          // livery band colour (bus)
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
};
