import * as pc from 'playcanvas';
import type { MapChunkManager } from '../map/MapChunkManager';
import type { RoadData } from '../map/MapTypes';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { CATALOG, PROFILES, pickProfile, pickSpec, type Category, type ProfileName, type VehicleSpec } from './VehicleCatalog';
import { ModelCache, randomLook } from './VehicleModels';

// Local, deterministic traffic AI. Kinematic vehicles follow OSM road centrelines on the LEFT (Sri Lanka),
// IDM car-following, signal compliance with amber dilemma-zone logic, breakdowns, and player collisions.
// ponytail: vehicles turn only where OSM ways end (not at mid-way junction nodes) and don't check junction
// occupancy before entering; build a lane graph when turning lanes / box-junction rules are needed.

const SPAWN_MIN = 70, SPAWN_MAX = 260, DESPAWN = 330;

export interface TrafficVehicle {
  id: number; spec: VehicleSpec; profile: ProfileName;
  v0: number; a: number; b: number; T: number; s0: number;
  road: RoadData; path: number[]; cum: number[]; seg: number; s: number;
  lane: number; shift: number;           // lateral offset left of centreline, + current passing shift (to the right)
  v: number; x: number; z: number; ux: number; uz: number; yaw: number; roll: number;
  broken: number;                        // seconds left disabled (0 = driving)
  stuckBehindBroken: number; passing?: TrafficVehicle;
  entity: pc.Entity; hazard: pc.Entity;
  amberGo?: boolean;                      // committed through current amber
  stopped: number;                        // seconds at standstill
}

export class TrafficManager {
  readonly vehicles: TrafficVehicle[] = [];
  target = 45;              // vehicles around the player (debug panel / AI density scale)
  densityScale = 1;
  speedScale = 1;           // AI 'reduceSpeed'
  headwayScale = 1;         // AI 'increaseFollowingDistance'
  incidentsPerMinute = 0.4; // background breakdown rate
  lastCollision = '';
  perf = '';               // last slow-frame report (Game)
  private models: ModelCache;
  private root = new pc.Entity('traffic');
  private nextId = 1;
  private incidentTimer = 20;
  private blink = 0;
  private rnd = Math.random;
  private roadCache: RoadData[] = [];
  private roadCacheAge = 0;

  constructor(app: pc.AppBase, private map: MapChunkManager, private player: VehiclePhysics) {
    this.models = new ModelCache(app.graphicsDevice);
    app.root.addChild(this.root);
  }

  get incidents() { return this.vehicles.filter(v => v.broken > 0); }

  update(dt: number) {
    const want = Math.round(this.target * this.densityScale);
    this.roadCacheAge -= dt;
    if (this.roadCacheAge <= 0) { this.roadCacheAge = 1; this.roadCache = [...this.map.roads.roads()].filter(r => r.w >= 5 && r.h !== 'service'); }
    if (this.vehicles.length < want) this.spawn();
    while (this.vehicles.length > want + 5) this.remove(this.vehicles[0]);

    const P = this.player;
    for (const v of [...this.vehicles]) {
      const dp = Math.hypot(v.x - P.x, v.z - P.z);
      if (dp > DESPAWN || !Number.isFinite(dp)) { this.remove(v); continue; }
      // ponytail: gridlock valve. Signals cycle in 54 s, so >75 s stationary means a deadlock; recycle it if not right next to the player.
      v.stopped = v.v < 0.2 && !v.broken ? v.stopped + dt : 0;
      if (v.stopped > 75 && dp > 40) { this.remove(v); continue; }
      this.drive(v, dt);
    }
    this.collidePlayer();
    this.incidentTick(dt);
    this.blink += dt;
    const on = Math.sin(this.blink * 9) > 0 ? 3 : 0;
    if (this.models.hazardMat.emissiveIntensity !== on) { this.models.hazardMat.emissiveIntensity = on; this.models.hazardMat.update(); }
  }

  // --- spawning --------------------------------------------------------------------------------------
  spawn(category?: Category, near = false): TrafficVehicle | null {
    const P = this.player, roads = this.roadCache;
    for (let attempt = 0; attempt < 12 && roads.length; attempt++) {
      const road = roads[Math.floor(this.rnd() * roads.length)];
      const dir = road.o || this.rnd() < 0.5 ? 1 : -1;
      const path = dir > 0 ? road.p.slice() : reversePts(road.p);
      const cum = cumulative(path), len = cum[cum.length - 1];
      if (len < 15) continue;
      const s = 5 + this.rnd() * (len - 10);
      const [x, z] = pointAt(path, cum, s);
      const d = Math.hypot(x - P.x, z - P.z);
      if (near ? d > 120 || d < 25 : d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (this.vehicles.some(o => Math.hypot(o.x - x, o.z - z) < 14)) continue;
      const spec = pickSpec(this.rnd, category), profile = pickProfile(this.rnd, spec), pr = PROFILES[profile];
      const { root, hazard } = this.models.entity(spec, randomLook(spec, this.rnd));
      this.root.addChild(root);
      const v: TrafficVehicle = {
        id: this.nextId++, spec, profile, v0: spec.v0 * pr.v0 * (0.92 + this.rnd() * 0.16), a: spec.a * pr.a, b: spec.b, T: spec.T * pr.T, s0: spec.s0,
        road, path, cum, seg: 0, s, lane: laneOffset(road, spec), shift: 0, v: spec.v0 * 0.6, x, z, ux: 0, uz: -1, yaw: 0, roll: 0,
        broken: 0, stuckBehindBroken: 0, stopped: 0, entity: root, hazard,
      };
      this.place(v);
      this.vehicles.push(v);
      return v;
    }
    return null;
  }

  private remove(v: TrafficVehicle) {
    v.entity.destroy();
    this.vehicles.splice(this.vehicles.indexOf(v), 1);
  }

  // --- driving ---------------------------------------------------------------------------------------
  private drive(v: TrafficVehicle, dt: number) {
    if (v.broken > 0) {
      v.broken -= dt;
      v.v = Math.max(0, v.v - 4 * dt);
      v.shift = Math.max(v.shift - dt * 0.6, -0.9); // ease towards the kerb (negative shift = further left)
      v.hazard.enabled = v.broken > 0;
      if (v.broken <= 0) { v.broken = 0; v.shift = 0; }
      this.advance(v, v.v * dt);
      return;
    }
    const { gap, leadV, leader } = this.leader(v);
    const v0 = v.v0 * this.speedScale, T = v.T * this.headwayScale;
    // IDM: acc = a[1 - (v/v0)^4 - (s*/s)^2], s* = s0 + vT + v·Δv / (2√(ab))
    let acc = v.a * (1 - (v.v / v0) ** 4);
    if (gap < Infinity) {
      const sStar = v.s0 + Math.max(0, v.v * T + (v.v * (v.v - leadV)) / (2 * Math.sqrt(v.a * v.b)));
      acc -= v.a * (sStar / Math.max(gap, 0.1)) ** 2;
    }
    v.v = Math.max(0, v.v + Math.max(acc, -8) * dt); // -8 m/s²: emergency-brake ceiling, no instant stops

    // Safe passing of a disabled vehicle: wait, check for oncoming traffic, swing right, return left.
    if (leader?.broken && gap < 14 && v.v < 1) v.stuckBehindBroken += dt; else if (!v.passing) v.stuckBehindBroken = 0;
    if (!v.passing && leader?.broken && v.stuckBehindBroken > 2.5 && this.clearToPass(v)) v.passing = leader;
    const need = v.passing ? (v.passing.spec.width + v.spec.width) / 2 + 0.7 : 0;
    if (v.passing) {
      const behind = (v.passing.x - v.x) * v.ux + (v.passing.z - v.z) * v.uz;
      if (behind < -(v.passing.spec.length / 2 + v.spec.length / 2 + 4) || !this.vehicles.includes(v.passing)) v.passing = undefined;
    }
    v.shift += Math.max(-1.5 * dt, Math.min(1.5 * dt, need - v.shift));
    this.advance(v, v.v * dt);
  }

  /** Nearest obstacle ahead in the same lane: vehicles, the player, or a stop line that applies. */
  private leader(v: TrafficVehicle): { gap: number; leadV: number; leader?: TrafficVehicle } {
    let gap = Infinity, leadV = 0, leader: TrafficVehicle | undefined;
    const lx = v.uz, lz = -v.ux; // left
    const consider = (x: number, z: number, len: number, w: number, speed: number, o?: TrafficVehicle) => {
      const dx = x - v.x, dz = z - v.z, along = dx * v.ux + dz * v.uz;
      if (along <= 0 || along > 70) return;
      if (Math.abs(dx * lx + dz * lz) > (w + v.spec.width) / 2 + 0.25) return;
      const g = along - (len + v.spec.length) / 2;
      if (g < gap) { gap = g; leadV = speed; leader = o; }
    };
    for (const o of this.vehicles) {
      if (o === v || o.ux * v.ux + o.uz * v.uz < 0.2 && o.broken === 0) continue; // ignore crossing/oncoming movers
      if (v.passing === o) continue;
      // Converging/crossing paths: only one of the pair yields (older id has priority), otherwise both wait forever.
      if (!o.broken && o.ux * v.ux + o.uz * v.uz < 0.9 && o.id > v.id) continue;
      consider(o.x, o.z, o.spec.length, o.spec.width, o.v * Math.max(0, o.ux * v.ux + o.uz * v.uz), o);
    }
    const P = this.player;
    consider(P.x, P.z, 4.4, 1.8, Math.max(0, P.forwardSpeed * (-Math.sin(P.yaw) * v.ux - Math.cos(P.yaw) * v.uz)));

    // Signals: red -> stop at the line; amber -> stop only if the line is beyond comfortable braking distance.
    for (const list of this.map.stops.values()) for (const st of list) {
      if (st.ux * v.ux + st.uz * v.uz < 0.85) continue;
      const dx = st.x - v.x, dz = st.z - v.z, along = dx * v.ux + dz * v.uz;
      if (along < -1 || along > 80 || Math.abs(dx * lx + dz * lz) > st.hw + 1) continue;
      const aspect = this.map.signals.aspect(st.group);
      if (aspect === 'green') { v.amberGo = false; continue; }
      const stopDist = (v.v * v.v) / (2 * v.b);
      if (aspect === 'amber' && (v.amberGo || along - v.spec.length / 2 < stopDist * 0.8)) { v.amberGo = true; continue; }
      if (aspect === 'red' && along - v.spec.length / 2 < (v.v * v.v) / (2 * 8)) continue; // physically can't stop: clear the junction
      const g = along - v.spec.length / 2 - 0.5;
      if (g < gap) { gap = Math.max(g, 0.05); leadV = 0; leader = undefined; }
    }
    return { gap, leadV, leader };
  }

  private clearToPass(v: TrafficVehicle) {
    if (v.road.o) return v.road.w > 6;
    return !this.vehicles.some(o => o !== v && o.ux * v.ux + o.uz * v.uz < -0.5 && Math.hypot(o.x - v.x, o.z - v.z) < 45);
  }

  private advance(v: TrafficVehicle, ds: number) {
    v.s += ds;
    const len = v.cum[v.cum.length - 1];
    if (v.s >= len && !this.nextRoad(v, v.s - len)) { this.remove(v); return; }
    this.place(v, ds);
  }

  /** Continue onto a connected road at the path end (respects one-ways; avoids U-turns). */
  private nextRoad(v: TrafficVehicle, carry: number): boolean {
    const n = v.path.length, ex = v.path[n - 2], ez = v.path[n - 1];
    const options: { road: RoadData; dir: number; turn: number }[] = [];
    for (const r of this.map.roads.roads()) {
      if (r === v.road || r.w < 4) continue;
      const m = r.p.length;
      const dot = (dx: number, dz: number) => { const l = Math.hypot(dx, dz) || 1; return (dx * v.ux + dz * v.uz) / l; };
      if (Math.hypot(r.p[0] - ex, r.p[1] - ez) < 3) options.push({ road: r, dir: 1, turn: dot(r.p[2] - r.p[0], r.p[3] - r.p[1]) });
      else if (!r.o && Math.hypot(r.p[m - 2] - ex, r.p[m - 1] - ez) < 3) options.push({ road: r, dir: -1, turn: dot(r.p[m - 4] - r.p[m - 2], r.p[m - 3] - r.p[m - 1]) });
    }
    const ok = options.filter(o => o.turn > -0.6);
    if (!ok.length) return false;
    // Prefer continuing the same OSM way / straight-ish (dominant flow), otherwise random turn.
    const same = ok.find(o => o.road.id === v.road.id);
    const o = same && this.rnd() < 0.85 ? same : ok[Math.floor(this.rnd() * ok.length)];
    v.road = o.road;
    v.path = o.dir > 0 ? o.road.p.slice() : reversePts(o.road.p);
    v.cum = cumulative(v.path);
    v.seg = 0;
    v.s = Math.min(carry, v.cum[v.cum.length - 1]);
    v.lane = laneOffset(o.road, v.spec);
    return true;
  }

  private place(v: TrafficVehicle, ds = 0) {
    const { path, cum } = v;
    while (v.seg < cum.length - 2 && cum[v.seg + 1] < v.s) v.seg++;
    const i = v.seg, segLen = cum[i + 1] - cum[i] || 1, t = Math.min(1, Math.max(0, (v.s - cum[i]) / segLen));
    const ux = (path[i * 2 + 2] - path[i * 2]) / segLen, uz = (path[i * 2 + 3] - path[i * 2 + 1]) / segLen;
    // Smooth the heading so polyline corners read as a curve.
    const k = Math.min(1, 6 * Math.abs(ds) / 4 + (v.ux === 0 && v.uz === -1 ? 1 : 0));
    v.ux += (ux - v.ux) * k; v.uz += (uz - v.uz) * k;
    const l = Math.hypot(v.ux, v.uz) || 1; v.ux /= l; v.uz /= l;
    const off = v.lane - v.shift; // left of centreline
    v.x = path[i * 2] + (path[i * 2 + 2] - path[i * 2]) * t + uz * off;
    v.z = path[i * 2 + 1] + (path[i * 2 + 3] - path[i * 2 + 1]) * t - ux * off;
    const yaw = Math.atan2(-v.ux, -v.uz), dyaw = wrap(yaw - v.yaw);
    v.yaw = yaw;
    if (v.spec.category === 'motorcycle') v.roll += (Math.max(-0.4, Math.min(0.4, (dyaw / Math.max(ds, 0.01)) * v.v * 0.25)) - v.roll) * 0.1;
    v.entity.setPosition(v.x, 0.1, v.z);
    v.entity.setEulerAngles(0, (yaw * 180) / Math.PI, (v.roll * 180) / Math.PI);
  }

  // --- player collisions (real contact, not scripted): OBB vs player circle ------------------------------
  private collidePlayer() {
    const P = this.player, R = 1.3;
    for (const v of this.vehicles) {
      const dx = P.x - v.x, dz = P.z - v.z;
      const lx = v.uz, lz = -v.ux;
      const la = dx * v.ux + dz * v.uz, ll = dx * lx + dz * lz;
      const ca = Math.max(-v.spec.length / 2, Math.min(v.spec.length / 2, la)), cl = Math.max(-v.spec.width / 2, Math.min(v.spec.width / 2, ll));
      const ox = dx - (v.ux * ca + lx * cl), oz = dz - (v.uz * ca + lz * cl), d = Math.hypot(ox, oz);
      if (d >= R) continue;
      const nx = d > 1e-3 ? ox / d : -v.ux, nz = d > 1e-3 ? oz / d : -v.uz;
      P.x += nx * (R - d); P.z += nz * (R - d);
      const rel = (P.vx - v.ux * v.v) * nx + (P.vz - v.uz * v.v) * nz;
      if (rel < 0) {
        const mRatio = Math.min(0.9, v.spec.mass / (v.spec.mass + 1200)); // heavier AI vehicle -> player bounces more
        P.vx -= nx * rel * (1 + mRatio * 0.4); P.vz -= nz * rel * (1 + mRatio * 0.4);
        v.v = Math.max(0, v.v + rel * (1 - mRatio) * 0.5);
        if (-rel > 4 && !v.broken) { // a real impact disables the AI vehicle: hazards on, traffic queues/passes
          v.broken = 40 + -rel * 4;
          this.lastCollision = `Collision with ${v.spec.label} at ${Math.round(-rel * 3.6)} km/h`;
        }
      }
    }
  }

  // --- incidents ----------------------------------------------------------------------------------------
  private incidentTick(dt: number) {
    this.incidentTimer -= dt;
    if (this.incidentTimer > 0) return;
    this.incidentTimer = 15;
    // Rate scales with traffic density; never more than 2 at once.
    if (this.incidents.length < 2 && this.rnd() < (this.incidentsPerMinute / 4) * this.densityScale) this.breakdown();
  }

  /** Disable a vehicle ahead-ish of the player (60-220 m) so the player can see the response. */
  breakdown(category?: Category, seconds = 60): TrafficVehicle | null {
    const P = this.player;
    const pool = this.vehicles.filter(v => !v.broken && (!category || v.spec.category === category) && Math.hypot(v.x - P.x, v.z - P.z) > 40 && Math.hypot(v.x - P.x, v.z - P.z) < 220);
    const v = pool[Math.floor(this.rnd() * pool.length)];
    if (v) v.broken = seconds;
    return v ?? null;
  }

  counts(): Record<Category, number> {
    const c = Object.fromEntries(CATALOG.map(s => [s.category, 0])) as Record<Category, number>;
    for (const v of this.vehicles) c[v.spec.category]++;
    return c;
  }

  avgSpeed() { return this.vehicles.reduce((s, v) => s + v.v, 0) / (this.vehicles.length || 1); }
}

/** Left-of-centre lane offset. Two-wheelers/tuk-tuks keep closer to the kerb (Colombo practice). */
function laneOffset(r: RoadData, spec: VehicleSpec) {
  const kerbside = spec.category === 'motorcycle' || spec.category === 'tuktuk';
  if (r.o) return kerbside ? r.w / 2 - 1.0 : Math.max(0, r.w / 2 - 1.9);
  return kerbside ? Math.max(1.1, r.w / 2 - 1.0) : Math.max(1.3, Math.min(r.w / 4, r.w / 2 - spec.width / 2 - 0.4));
}

function reversePts(p: number[]) { const o: number[] = []; for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]); return o; }
function cumulative(p: number[]) { const c = [0]; for (let i = 2; i < p.length; i += 2) c.push(c[c.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])); return c; }
function pointAt(p: number[], cum: number[], s: number): [number, number] {
  let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t];
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

