import * as pc from 'playcanvas';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';

export const CAMERA_MODES = ['CHASE', 'HOOD', 'COCKPIT', 'FREE'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

/** Chase / hood / cockpit cameras plus a mouse-orbit free camera for debugging. */
export class CameraController {
  mode: CameraMode = 'CHASE';
  private pos = new pc.Vec3();
  private orbitYaw = 0; private orbitPitch = 25; private orbitDist = 25;
  private dragging = false;

  constructor(readonly camera: pc.Entity, canvas: HTMLCanvasElement) {
    canvas.addEventListener('mousedown', () => (this.dragging = true));
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', e => {
      if (!this.dragging || this.mode !== 'FREE') return;
      this.orbitYaw -= e.movementX * 0.3;
      this.orbitPitch = Math.max(5, Math.min(85, this.orbitPitch + e.movementY * 0.3));
    });
    canvas.addEventListener('wheel', e => {
      if (this.mode === 'FREE') this.orbitDist = Math.max(5, Math.min(600, this.orbitDist * (1 + e.deltaY * 0.001)));
    }, { passive: true });
  }

  cycle() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.snap = true;
  }

  private snap = true;
  /** Vehicle length (m): chase distance/height and driver's seat scale with it. */
  vehicleLength = 4.4;

  update(dt: number, car: VehiclePhysics, walls: CollisionWorld | null) {
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const yawDeg = (car.yaw * 180) / Math.PI;

    if (this.mode === 'HOOD' || this.mode === 'COCKPIT') {
      const big = this.vehicleLength > 7, L = this.vehicleLength;
      const [fwd, up, side] = this.mode === 'HOOD'
        ? (big ? [-(L / 2 - 0.3), 2.7, 0] : [-0.6, 1.25, 0])
        : (big ? [-(L / 2 - 1.1), 2.35, -0.7] : [0.2, 1.12, -0.36]); // right-hand drive seat
      const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
      this.camera.setPosition(car.x + fx * -fwd + rx * -side, up, car.z + fz * -fwd + rz * -side);
      this.camera.setEulerAngles(-4 + car.pitch * 57, yawDeg, 0);
      return;
    }

    if (this.mode === 'FREE') {
      const a = ((this.orbitYaw + yawDeg) * Math.PI) / 180, p = (this.orbitPitch * Math.PI) / 180;
      this.camera.setPosition(car.x + Math.sin(a) * Math.cos(p) * this.orbitDist, Math.sin(p) * this.orbitDist, car.z + Math.cos(a) * Math.cos(p) * this.orbitDist);
      this.camera.lookAt(car.x, 1, car.z);
      return;
    }

    // CHASE: spring towards a point behind the car, look slightly ahead of it.
    const speed = Math.abs(car.forwardSpeed);
    const k = Math.max(1, this.vehicleLength / 4.4);
    const dist = 6.5 * k + Math.min(speed * 0.06, 2.5);
    const target = new pc.Vec3(car.x - fx * dist, 2.4 * Math.sqrt(k) * 1.15 ** (k - 1), car.z - fz * dist);
    if (this.snap) { this.pos.copy(target); this.snap = false; }
    this.pos.lerp(this.pos, target, 1 - Math.exp(-dt * 6));

    // Camera collision: pull in front of the first wall between car and camera; never below ground.
    if (walls) {
      const t = walls.raycast(car.x, car.z, this.pos.x, this.pos.z);
      if (t < 1) {
        const k = Math.max(0.15, t - 0.08);
        this.pos.x = car.x + (this.pos.x - car.x) * k;
        this.pos.z = car.z + (this.pos.z - car.z) * k;
      }
    }
    this.pos.y = Math.max(this.pos.y, 0.6);
    this.camera.setPosition(this.pos);
    this.camera.lookAt(car.x + fx * 4, 1.1 * Math.max(1, this.vehicleLength / 6), car.z + fz * 4);
  }
}
