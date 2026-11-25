import type { DriveInput } from '../input/InputManager';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehicleConfig } from './VehicleConfig';
import { groundAt } from '../map/Terrain';

const G = 9.81;
const SUBSTEPS = 4;

/**
 * Planar rigid-body vehicle: bicycle model with load transfer, slip-angle tyres, friction circle,
 * engine torque curve + automatic gearbox, brakes/handbrake, drag, and impulse collisions vs. walls.
 * Yaw convention: forward = (-sin ψ, -cos ψ) in XZ (PlayCanvas -Z forward); +ψ / +ω = turning left.
 */
export class VehiclePhysics {
  x = 0; z = 0; yaw = 0;
  y = 0;             // world height (terrain + deck)
  deck = 0;          // height above the terrain (on a flyover deck / airborne)
  private vy = 0;
  slope = 0;         // visual pitch from road grade (rad, + = nose up)
  /** Deck lookup (RoadNetwork.surface); null = flat ground everywhere. */
  surfaceAt: ((x: number, z: number, prevY: number, heading?: [number, number]) => { y: number; grade: number; ux: number; uz: number; lat: number; hw: number; px: number; pz: number } | null) | null = null;
  vx = 0; vz = 0; omega = 0;
  steer = 0;
  gear = 1;          // -1 = reverse, 1..n forward
  rpm = 0;
  wheelSpin = 0;     // rad, for visuals
  pitch = 0; roll = 0;
  private pitchVel = 0; private rollVel = 0;
  private accelU = 0; accelW = 0;
  private shiftTimer = 0;
  manual = false;    // manual gearbox: shift() only, W always drives, S always brakes
  grip = 1;          // road grip multiplier (wet road < 1)
  impact = 0;        // last collision closing speed (m/s), decays

  constructor(readonly cfg: VehicleConfig) {}

  /** Signed forward speed (m/s). */
  get forwardSpeed() { return this.vx * -Math.sin(this.yaw) + this.vz * -Math.cos(this.yaw); }
  get gearLabel() { return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : (this.manual ? 'M' : '') + this.gear; }

  /** Manual shift: +1 up / -1 down. 1 -> N -> R only below walking pace (no crunching into reverse). */
  shift(dir: 1 | -1) {
    if (this.shiftTimer > 0.25) return;
    const slow = Math.abs(this.forwardSpeed) < 1;
    const next = this.gear + dir;
    if (next > this.cfg.gears.length) return;
    if (next < 0 ? !slow || next < -1 : this.gear < 0 && !slow) return;
    this.gear = next;
    this.shiftTimer = 0.3; // clutch: no drive while shifting
  }

  reset(x: number, z: number, yaw: number) {
    Object.assign(this, { x, z, yaw, vx: 0, vz: 0, omega: 0, steer: 0, gear: 1, pitch: 0, roll: 0, y: groundAt(x, z), vy: 0, slope: 0, deck: 0 });
    this.pitchVel = this.rollVel = 0;
  }

  step(dt: number, input: DriveInput, walls: CollisionWorld | null) {
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.substep(h, input);
    this.elevation(dt);
    if (walls && this.deck < 2) this.collide(walls); // building walls are at street level
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
    if (!this.manual) {
      if (this.gear === 0) this.gear = 1;
      if (input.brake && !input.throttle && this.gear > 0 && Math.abs(u) < 0.4) this.gear = -1;
      if (input.throttle && !input.brake && this.gear < 0 && Math.abs(u) < 0.4) this.gear = 1;
    }
    const shifting = this.manual && this.shiftTimer > 0;
    const drivePedal = this.gear === 0 || shifting ? 0 : this.manual || this.gear > 0 ? input.throttle : input.brake;
    const brakePedal = this.manual || this.gear >= 0 ? input.brake : input.throttle;

    // --- Engine + automatic gearbox.
    const ratio = (this.gear < 0 ? c.reverseRatio : this.gear === 0 ? 0 : c.gears[this.gear - 1]) * c.finalDrive;
    const wheelRpm = (Math.abs(u) / c.wheelRadius) * 60 / (2 * Math.PI);
    this.rpm = this.gear === 0 ? c.idleRpm + (c.redline * 0.9 - c.idleRpm) * input.throttle : Math.max(c.idleRpm, wheelRpm * ratio); // neutral: free rev
    this.shiftTimer -= dt;
    if (!this.manual && this.gear > 0 && this.shiftTimer <= 0) {
      if (this.rpm > c.shiftUpRpm && this.gear < c.gears.length) { this.gear++; this.shiftTimer = 0.5; }
      else if (this.rpm < c.shiftDownRpm && this.gear > 1) { this.gear--; this.shiftTimer = 0.5; }
    }
    if (drivePedal && wheelRpm * ratio < c.idleRpm) this.rpm = c.idleRpm + (2500 - c.idleRpm) * drivePedal; // clutch slip off the line
    const torque = this.rpm >= c.redline ? 0 : torqueAt(c.torqueCurve, this.rpm) * drivePedal;
    let driveForce = (torque * ratio * 0.85) / c.wheelRadius * Math.sign(this.gear);
    if (!drivePedal && this.gear > 0 && !shifting) driveForce -= Math.sign(u) * Math.min(1, Math.abs(u)) * 250; // engine braking

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
    let flF = tyreLateral(wlF, urF, fzF, c.corneringStiffness * fzF / (c.mass * G / 2), c.mu * this.grip);
    [fxF, flF] = frictionCircle(fxF, flF, c.mu * this.grip * fzF);
    const fuF = fxF * cd - flF * sd;
    const fwF = fxF * sd + flF * cd;

    // --- Rear axle.
    const wr = w - this.omega * c.cgToRear;
    let fxR = brake(0.38, u) + (c.driveFront ? 0 : driveForce);
    let muR = c.mu * this.grip;
    if (input.handbrake) {
      fxR = -Math.sign(u) * Math.min(1, Math.abs(u) / 0.4) * muR * fzR * 0.8;
      muR *= 0.5;
    }
    // Rear tyres ~30% stiffer than the front: mild understeer, so the car is stable without assists.
    let flR = tyreLateral(wr, u, fzR, 1.3 * c.corneringStiffness * fzR / (c.mass * G / 2), muR);
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

    // Stability control (ESC): pull the yaw rate towards what the steering asks for (bicycle model) and bleed off
    // sideways slide, so a twitch of the keyboard doesn't become a spin. Handbrake turns it off for drifts.
    if (!input.handbrake && speed > 1.5) {
      const want = (u * Math.tan(d)) / L, k = Math.min(1, (c.stability ?? 8) * dt);
      this.omega += (want - this.omega) * k;
      const slide = (this.vx * lx + this.vz * lz) * k;
      this.vx -= lx * slide; this.vz -= lz * slide;
    }

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
        // Crumple zone: soft taps bounce a little, hard hits absorb nearly everything.
        const e = 0.3 / (1 + -vn / 4);
        const rn = rz * nx - rx * nz;
        const j = (-(1 + e) * vn) / (1 / c.mass + (rn * rn) / c.inertia);
        this.applyImpulse(j * nx, j * nz, rx, rz);
        // Coulomb scrape friction along the wall (spins the car on glancing hits).
        const tx = -nz, tz = nx;
        const vt = (this.vx + this.omega * rz) * tx + (this.vz - this.omega * rx) * tz;
        const rt = rz * tx - rx * tz;
        const jt = Math.max(-0.5 * j, Math.min(0.5 * j, -vt / (1 / c.mass + (rt * rt) / c.inertia)));
        this.applyImpulse(jt * tx, jt * tz, rx, rz);
        this.impact = Math.max(this.impact, -vn);
      });
    }
  }

  /** Follow flyover decks: snap up onto ramps, keep inside the parapets, fall (never through) when off a deck. */
  private elevation(dt: number) {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), G = groundAt(this.x, this.z);
    const rel = this.y - G;                           // height above the terrain (deck / airborne)
    const s = this.surfaceAt?.(this.x, this.z, rel, [fx, fz]);
    let g: number;                                    // rise per metre in the car's heading
    if (s) {
      // Parapet: keep the car body inside the deck edge.
      const limit = s.hw - this.cfg.width / 2 - 0.1;
      if (s.y > 1.5 && s.lat > limit) {
        const nx = (this.x - s.px) / (s.lat || 1), nz = (this.z - s.pz) / (s.lat || 1), push = s.lat - limit;
        this.x -= nx * push; this.z -= nz * push;
        const vn = this.vx * nx + this.vz * nz;
        if (vn > 0) { this.vx -= nx * vn * 1.25; this.vz -= nz * vn * 1.25; this.impact = Math.max(this.impact, vn); this.vx *= 0.97; this.vz *= 0.97; }
      }
      this.y = G + s.y; this.vy = 0; this.deck = s.y;
      g = s.grade * (s.ux * fx + s.uz * fz) + (groundAt(this.x + fx, this.z + fz) - groundAt(this.x - fx, this.z - fz)) / 2;
    } else if (rel > 0.3) {                           // airborne / off a deck end
      this.vy -= 9.81 * dt; this.y = Math.max(G, this.y + this.vy * dt);
      if (this.y === G) { this.impact = Math.max(this.impact, -this.vy * 0.5); this.vy = 0; }
      this.deck = this.y - G;
      this.slope *= 0.9;
      return;
    } else {                                          // on the ground: follow the terrain
      this.y = G; this.vy = 0; this.deck = 0;
      g = (groundAt(this.x + fx * 2, this.z + fz * 2) - groundAt(this.x - fx * 2, this.z - fz * 2)) / 4;
    }
    this.vx -= fx * 9.81 * g * dt; this.vz -= fz * 9.81 * g * dt; // gravity along the slope
    this.slope = Math.atan(g);
  }

  /** Impulse (N·s) applied at offset (rx,rz) from the CG. Yaw sign matches omega convention. */
  applyImpulse(jx: number, jz: number, rx: number, rz: number) {
    const c = this.cfg;
    this.vx += jx / c.mass;
    this.vz += jz / c.mass;
    this.omega += (rz * jx - rx * jz) / c.inertia;
    // Hard hits jolt the body.
    const kick = Math.hypot(jx, jz) / c.mass;
    this.pitchVel += -(jx * -Math.sin(this.yaw) + jz * -Math.cos(this.yaw)) / c.mass * 0.6;
    this.rollVel += kick * 0.3 * Math.sign(rx * Math.cos(this.yaw) - rz * Math.sin(this.yaw) || 1);
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

/**
 * Pacejka magic-formula lateral force: grip peaks around 6-8° of slip then falls to ~80% when sliding,
 * so once the rear lets go it stays loose (drift) until the driver counter-steers / lifts.
 */
const PACEJKA_C = 1.45;
function tyreLateral(lateralVel: number, rollVel: number, fz: number, stiffness: number, mu: number): number {
  const slip = Math.atan2(lateralVel, Math.max(Math.abs(rollVel), 1.5));
  const D = mu * fz;
  if (D <= 0) return 0;
  const B = stiffness / (PACEJKA_C * D);   // keeps initial cornering stiffness unchanged
  return -D * Math.sin(PACEJKA_C * Math.atan(B * slip));
}

function frictionCircle(fx: number, fy: number, max: number): [number, number] {
  const m = Math.hypot(fx, fy);
  return m > max && m > 0 ? [(fx * max) / m, (fy * max) / m] : [fx, fy];
}
