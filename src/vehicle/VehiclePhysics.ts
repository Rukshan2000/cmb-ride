import type { DriveInput } from '../input/InputManager';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehicleConfig } from './VehicleConfig';

const G = 9.81;
const SUBSTEPS = 4;

/**
 * Planar rigid-body vehicle: bicycle model with load transfer, slip-angle tyres, friction circle,
 * engine torque curve + automatic gearbox, brakes/handbrake, drag, and impulse collisions vs. walls.
 * Yaw convention: forward = (-sin ψ, -cos ψ) in XZ (PlayCanvas -Z forward); +ψ / +ω = turning left.
 */
export class VehiclePhysics {
  x = 0; z = 0; yaw = 0;
  vx = 0; vz = 0; omega = 0;
  steer = 0;
  gear = 1;          // -1 = reverse, 1..n forward
  rpm = 0;
  wheelSpin = 0;     // rad, for visuals
  pitch = 0; roll = 0;
  private pitchVel = 0; private rollVel = 0;
  private accelU = 0; private accelW = 0;
  private shiftTimer = 0;
  impact = 0;        // last collision closing speed (m/s), decays

  constructor(readonly cfg: VehicleConfig) {}

  /** Signed forward speed (m/s). */
  get forwardSpeed() { return this.vx * -Math.sin(this.yaw) + this.vz * -Math.cos(this.yaw); }
  get gearLabel() { return this.gear < 0 ? 'R' : String(this.gear); }

  reset(x: number, z: number, yaw: number) {
    Object.assign(this, { x, z, yaw, vx: 0, vz: 0, omega: 0, steer: 0, gear: 1, pitch: 0, roll: 0 });
    this.pitchVel = this.rollVel = 0;
  }

  step(dt: number, input: DriveInput, walls: CollisionWorld | null) {
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.substep(h, input);
    if (walls) this.collide(walls);
    this.impact = Math.max(0, this.impact - dt * 4);
    this.suspension(dt);
  }

  private substep(dt: number, input: DriveInput) {
    const c = this.cfg;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = -sin, fz = -cos;   // forward
    const lx = -cos, lz = sin;    // left
    const u = this.vx * fx + this.vz * fz;
    const w = this.vx * lx + this.vz * lz;
    const speed = Math.hypot(u, w);

    // --- Gear selection: S at standstill engages reverse, W at standstill engages drive.
    if (input.brake && !input.throttle && this.gear > 0 && Math.abs(u) < 0.4) this.gear = -1;
    if (input.throttle && !input.brake && this.gear < 0 && Math.abs(u) < 0.4) this.gear = 1;
    const drivePedal = this.gear > 0 ? input.throttle : input.brake;
    const brakePedal = this.gear > 0 ? input.brake : input.throttle;

    // --- Engine + automatic gearbox.
    const ratio = (this.gear < 0 ? c.reverseRatio : c.gears[this.gear - 1]) * c.finalDrive;
    const wheelRpm = (Math.abs(u) / c.wheelRadius) * 60 / (2 * Math.PI);
    this.rpm = Math.max(c.idleRpm, wheelRpm * ratio);
    this.shiftTimer -= dt;
    if (this.gear > 0 && this.shiftTimer <= 0) {
      if (this.rpm > c.shiftUpRpm && this.gear < c.gears.length) { this.gear++; this.shiftTimer = 0.5; }
      else if (this.rpm < c.shiftDownRpm && this.gear > 1) { this.gear--; this.shiftTimer = 0.5; }
    }
    if (drivePedal && wheelRpm * ratio < c.idleRpm) this.rpm = c.idleRpm + (2500 - c.idleRpm) * drivePedal; // clutch slip off the line
    const torque = this.rpm >= c.redline ? 0 : torqueAt(c.torqueCurve, this.rpm) * drivePedal;
    let driveForce = (torque * ratio * 0.85) / c.wheelRadius * Math.sign(this.gear);
    if (!drivePedal && this.gear > 0) driveForce -= Math.sign(u) * Math.min(1, Math.abs(u)) * 250; // engine braking

    // --- Steering: rate-limited, max angle shrinks with speed.
    const maxSteer = c.maxSteer / (1 + Math.abs(u) / c.steerSpeedFalloff);
    const target = input.steer * maxSteer;
    const rate = c.steerRate * (Math.sign(target - this.steer) !== Math.sign(this.steer) ? 1.8 : 1);
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));
    const d = this.steer;

    // --- Axle loads with longitudinal weight transfer.
    const L = c.cgToFront + c.cgToRear;
    const transfer = (c.mass * this.accelU * c.cgHeight) / L;
    const fzF = Math.max(0, (c.mass * G * c.cgToRear) / L - transfer);
    const fzR = Math.max(0, (c.mass * G * c.cgToFront) / L + transfer);

    const brake = (share: number, rollSpeed: number) =>
      -Math.sign(rollSpeed) * Math.min(1, Math.abs(rollSpeed) / 0.4) * c.brakeForce * share * brakePedal;

    // --- Front axle (in wheel frame, then back to car frame).
    const wf = w + this.omega * c.cgToFront;
    const cd = Math.cos(d), sd = Math.sin(d);
    const urF = u * cd + wf * sd;
    const wlF = -u * sd + wf * cd;
    let fxF = brake(0.62, urF) + (c.driveFront ? driveForce : 0);
    let flF = tyreLateral(wlF, urF, fzF, c.corneringStiffness * fzF / (c.mass * G / 2), c.mu);
    [fxF, flF] = frictionCircle(fxF, flF, c.mu * fzF);
    const fuF = fxF * cd - flF * sd;
    const fwF = fxF * sd + flF * cd;

    // --- Rear axle.
    const wr = w - this.omega * c.cgToRear;
    let fxR = brake(0.38, u) + (c.driveFront ? 0 : driveForce);
    let muR = c.mu;
    if (input.handbrake) {
      fxR = -Math.sign(u) * Math.min(1, Math.abs(u) / 0.4) * c.mu * fzR * 0.8;
      muR *= 0.5;
    }
    let flR = tyreLateral(wr, u, fzR, c.corneringStiffness * fzR / (c.mass * G / 2), muR);
    [fxR, flR] = frictionCircle(fxR, flR, muR * fzR);

    // --- Resistances.
    const fu = fuF + fxR - c.dragCoeff * u * speed - c.rollingResistance * u;
    const fw = fwF + flR - c.dragCoeff * w * speed;
    const yawTorque = c.cgToFront * fwF - c.cgToRear * flR;

    this.accelU = fu / c.mass;
    this.accelW = fw / c.mass;
    this.vx += (this.accelU * fx + this.accelW * lx) * dt;
    this.vz += (this.accelU * fz + this.accelW * lz) * dt;
    this.omega += (yawTorque / c.inertia) * dt;

    // Settle to a full stop instead of creeping.
    if (!drivePedal && speed < 0.15) { this.vx *= 0.8; this.vz *= 0.8; this.omega *= 0.8; }

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.yaw += this.omega * dt;
    this.wheelSpin += (u / c.wheelRadius) * dt;
  }

  /** Car body as three circles along its length, pushed out of building walls with an impulse. */
  private collide(walls: CollisionWorld) {
    const c = this.cfg;
    const r = c.width / 2 + 0.05;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const span = c.length / 2 - r;
    for (const o of [-span, 0, span]) {
      walls.forEachNear(this.x + fx * o, this.z + fz * o, r + 1, (x0, z0, x1, z1) => {
        const cx = this.x + fx * o, cz = this.z + fz * o;
        const ex = x1 - x0, ez = z1 - z0;
        const t = Math.max(0, Math.min(1, ((cx - x0) * ex + (cz - z0) * ez) / (ex * ex + ez * ez || 1)));
        const qx = x0 + ex * t, qz = z0 + ez * t;
        let nx = cx - qx, nz = cz - qz;
        const dist = Math.hypot(nx, nz);
        if (dist >= r || dist < 1e-6) return;
        nx /= dist; nz /= dist;
        this.x += nx * (r - dist);
        this.z += nz * (r - dist);
        // Impulse at contact point (restitution 0.2).
        const rx = qx - this.x, rz = qz - this.z;
        const vcx = this.vx + this.omega * rz, vcz = this.vz - this.omega * rx;
        const vn = vcx * nx + vcz * nz;
        if (vn >= 0) return;
        const rn = rz * nx - rx * nz;
        const j = (-1.2 * vn) / (1 / c.mass + (rn * rn) / c.inertia);
        this.vx += (j * nx) / c.mass;
        this.vz += (j * nz) / c.mass;
        this.omega += (rn * j) / c.inertia;
        this.vx *= 0.97; this.vz *= 0.97; // scrape friction
        this.impact = Math.max(this.impact, -vn);
      });
    }
  }

  /** Spring-damper body pitch/roll driven by acceleration (visual only). */
  private suspension(dt: number) {
    const { suspensionStiffness: k, suspensionDamping: b } = this.cfg;
    const pitchTarget = this.accelU * 0.006;
    const rollTarget = -this.accelW * 0.008;
    this.pitchVel += (-k * (this.pitch - pitchTarget) - b * this.pitchVel) * dt;
    this.rollVel += (-k * (this.roll - rollTarget) - b * this.rollVel) * dt;
    this.pitch += this.pitchVel * dt;
    this.roll += this.rollVel * dt;
  }
}

function torqueAt(curve: [number, number][], rpm: number): number {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

/** Linear-then-saturating lateral tyre force from slip angle. */
function tyreLateral(lateralVel: number, rollVel: number, fz: number, stiffness: number, mu: number): number {
  const slip = Math.atan2(lateralVel, Math.max(Math.abs(rollVel), 1.5));
  const f = -stiffness * slip;
  const max = mu * fz;
  return Math.max(-max, Math.min(max, f));
}

function frictionCircle(fx: number, fy: number, max: number): [number, number] {
  const m = Math.hypot(fx, fy);
  return m > max && m > 0 ? [(fx * max) / m, (fy * max) / m] : [fx, fy];
}
