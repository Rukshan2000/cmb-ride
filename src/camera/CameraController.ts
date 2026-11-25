import * as pc from 'playcanvas';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';

export const CAMERA_MODES = ['CHASE', 'FAR', 'BUMPER', 'HOOD', 'COCKPIT', 'TOP', 'CINEMA', 'FREE'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

/** Chase / hood / cockpit cameras plus a mouse-orbit free camera for debugging. */
export class CameraController {
  mode: CameraMode = 'CHASE';
  private pos = new pc.Vec3();
  private orbitYaw = 0; private orbitPitch = 25; private orbitDist = 25;
  private dragging = false;
  // Chase-camera mouse look (GTA-style): drag to orbit, wheel to zoom; eases back behind the car after release.
  private lookYaw = 0; private lookPitch = 0; private zoom = 1; private idle = 0;

  constructor(readonly camera: pc.Entity, canvas: HTMLCanvasElement) {
    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', e => { if (e.button === 0) { this.dragging = true; canvas.style.cursor = 'grabbing'; } });
    window.addEventListener('mouseup', () => { this.dragging = false; canvas.style.cursor = 'grab'; });
    window.addEventListener('mousemove', e => {
      if (!this.dragging) return;
      if (this.mode === 'FREE') {
        this.orbitYaw -= e.movementX * 0.3;
        this.orbitPitch = Math.max(5, Math.min(85, this.orbitPitch + e.movementY * 0.3));
      } else if (this.mode === 'CHASE' || this.mode === 'FAR') {
        this.lookYaw -= e.movementX * 0.3;
        this.lookPitch = Math.max(-15, Math.min(70, this.lookPitch + e.movementY * 0.25));
        this.idle = 0;
      }
    });
    canvas.addEventListener('wheel', e => {
      if (this.mode === 'FREE') this.orbitDist = Math.max(5, Math.min(600, this.orbitDist * (1 + e.deltaY * 0.001)));
      else if (this.mode === 'CHASE' || this.mode === 'FAR') this.zoom = Math.max(0.5, Math.min(4, this.zoom * (1 + e.deltaY * 0.001)));
    }, { passive: true });
  }

  private cinema = new pc.Vec3(); private cinemaT = 0;

  select(i: number) { if (CAMERA_MODES[i]) { this.mode = CAMERA_MODES[i]; this.snap = true; } }

  cycle() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.snap = true;
  }

  private snap = true;
  cinematic: { px: number; py: number; pz: number; lx: number; ly: number; lz: number } | null = null;
  private cine = new pc.Vec3(); private cineSnap = true;
  /** Vehicle length (m): chase distance/height and driver's seat scale with it. */
  vehicleLength = 4.4;

  update(dt: number, car: VehiclePhysics, walls: CollisionWorld | null) {
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const yawDeg = (car.yaw * 180) / Math.PI;
    const shake = Math.min(car.impact, 15) * 0.02, jit = () => (Math.random() - 0.5) * shake;
    if (this.cinematic) { // scripted scene (police stop): smooth dolly to the director's shot
      const c = this.cinematic;
      this.cine.lerp(this.cine, new pc.Vec3(c.px, c.py, c.pz), this.cineSnap ? 1 : 1 - Math.exp(-dt * 3));
      this.cineSnap = false;
      this.camera.setPosition(this.cine);
      this.camera.lookAt(c.lx, c.ly, c.lz);
      this.snap = true;
      return;
    }
    this.cineSnap = true;

    if (this.mode === 'BUMPER') { // low, in front of the grille
      const L = this.vehicleLength;
      this.camera.setPosition(car.x + fx * (L / 2 + 0.1) + jit(), 0.55 * Math.max(1, L / 6) + jit(), car.z + fz * (L / 2 + 0.1) + jit());
      this.camera.translate(0, car.y, 0);
      this.camera.setEulerAngles((car.pitch + car.slope) * 57, yawDeg, 0);
      return;
    }

    if (this.mode === 'TOP') { // overhead, heading-up
      const h = 22 + Math.min(Math.abs(car.forwardSpeed) * 0.8, 25);
      this.camera.setPosition(car.x + fx * 4, h + car.y, car.z + fz * 4);
      this.camera.setEulerAngles(-90, yawDeg, 0);
      return;
    }

    if (this.mode === 'CINEMA') { // TV-style: parked roadside, pans as the car passes, re-places ahead
      this.cinemaT -= dt;
      const d = Math.hypot(this.cinema.x - car.x, this.cinema.z - car.z);
      if (this.snap || this.cinemaT <= 0 || d > 45) {
        const ahead = 15 + Math.abs(car.forwardSpeed) * 1.5, side = (Math.random() < 0.5 ? -1 : 1) * 6;
        let cx = car.x + fx * ahead - fz * side, cz = car.z + fz * ahead + fx * side;
        if (walls) { const t = walls.raycast(car.x, car.z, cx, cz); if (t < 1) { cx = car.x + (cx - car.x) * t * 0.85; cz = car.z + (cz - car.z) * t * 0.85; } }
        this.cinema.set(cx, 1.4 + Math.random() * 2 + car.y, cz);
        this.cinemaT = 6; this.snap = false;
      }
      this.camera.setPosition(this.cinema.x + jit(), this.cinema.y, this.cinema.z + jit());
      this.camera.lookAt(car.x, 1 + car.y, car.z);
      return;
    }

    if (this.mode === 'HOOD' || this.mode === 'COCKPIT') {
      const big = this.vehicleLength > 7, L = this.vehicleLength;
      const [fwd, up, side] = this.mode === 'HOOD'
        ? (big ? [-(L / 2 - 0.3), 2.7, 0] : [-0.6, 1.25, 0])
        : (big ? [-(L / 2 - 1.1), 2.35, -0.7] : [0.2, 1.12, -0.36]); // right-hand drive seat
      const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
      this.camera.setPosition(car.x + fx * -fwd + rx * -side + jit(), up + car.y + jit(), car.z + fz * -fwd + rz * -side + jit());
      this.camera.setEulerAngles(-4 + (car.pitch + car.slope) * 57, yawDeg, 0);
      return;
    }

    if (this.mode === 'FREE') {
      const a = ((this.orbitYaw + yawDeg) * Math.PI) / 180, p = (this.orbitPitch * Math.PI) / 180;
      this.camera.setPosition(car.x + Math.sin(a) * Math.cos(p) * this.orbitDist, Math.sin(p) * this.orbitDist + car.y, car.z + Math.cos(a) * Math.cos(p) * this.orbitDist);
      this.camera.lookAt(car.x, 1 + car.y, car.z);
      return;
    }

    // CHASE: spring towards a point behind the car, look slightly ahead of it.
    const speed = Math.abs(car.forwardSpeed);
    const k = Math.max(1, this.vehicleLength / 4.4);
    const far = this.mode === 'FAR' ? 1.9 : 1;
    const dist = (6.5 * k + Math.min(speed * 0.06, 2.5)) * far * this.zoom;
    // Mouse look: after 1.5 s without dragging, swing back behind the car (faster when moving).
    if (!this.dragging && (this.idle += dt) > 1.5) {
      const back = 1 - Math.exp(-dt * (1.5 + speed * 0.15));
      this.lookYaw -= (((this.lookYaw + 180) % 360 + 360) % 360 - 180) * back;
      this.lookPitch -= this.lookPitch * back;
    }
    const ly = (this.lookYaw * Math.PI) / 180, lp = (this.lookPitch * Math.PI) / 180;
    const bx = -fx * Math.cos(ly) + fz * Math.sin(ly), bz = -fz * Math.cos(ly) - fx * Math.sin(ly); // "behind", rotated
    const h0 = 2.4 * Math.sqrt(k) * 1.15 ** (k - 1) * far * this.zoom;
    const target = new pc.Vec3(car.x + bx * dist * Math.cos(lp), h0 + Math.sin(lp) * dist + car.y, car.z + bz * dist * Math.cos(lp));
    if (this.snap) { this.pos.copy(target); this.snap = false; }
    // While orbiting, follow tightly so the drag feels direct; otherwise the usual soft spring.
    this.pos.lerp(this.pos, target, 1 - Math.exp(-dt * (this.idle < 1.5 ? 20 : 6)));

    // Camera collision: pull in front of the first wall between car and camera; never below ground.
    if (walls && car.y < 2) {
      const t = walls.raycast(car.x, car.z, this.pos.x, this.pos.z);
      if (t < 1) {
        const k = Math.max(0.15, t - 0.08);
        this.pos.x = car.x + (this.pos.x - car.x) * k;
        this.pos.z = car.z + (this.pos.z - car.z) * k;
      }
    }
    this.pos.y = Math.max(this.pos.y, car.y + 0.6);
    this.camera.setPosition(this.pos.x + jit(), this.pos.y + jit(), this.pos.z + jit());
    const ahead = Math.abs(this.lookYaw) > 20 || this.idle < 1.5 ? 0 : 4; // orbiting: look at the car itself
    this.camera.lookAt(car.x + fx * ahead, 1.1 * Math.max(1, this.vehicleLength / 6) + car.y, car.z + fz * ahead);
  }
}
