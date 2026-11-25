import * as pc from 'playcanvas';
import type { MapChunkManager } from '../map/MapChunkManager';
import type { RoadData } from '../map/MapTypes';
import { isElevated } from '../map/RoadNetwork';
import { groundAt } from '../map/Terrain';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { CATALOG, PROFILES, pickProfile, pickSpec, type Category, type ProfileName, type VehicleSpec } from './VehicleCatalog';
import { ModelCache, randomLook } from './VehicleModels';

// Local, deterministic traffic AI. Kinematic vehicles follow OSM road centrelines on the LEFT (Sri Lanka),
// IDM car-following, signal compliance with amber dilemma-zone logic, breakdowns, and player collisions.
// ponytail: vehicles turn only where OSM ways end (not at mid-way junction nodes) and don't check junction
// occupancy before entering; build a lane graph when turning lanes / box-junction rules are needed.

const POLICE_SPEC: VehicleSpec = { ...CATALOG.find(c => c.id === 'sedan')!, label: 'Police patrol car', weight: 0 };
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
  police?: pc.Entity;                     // light bar (patrol car)
  y?: number;                             // deck height when on a flyover
}

export class TrafficManager {
  readonly vehicles: TrafficVehicle[] = [];
  target = 45;              // vehicles around the player (debug panel / AI density scale)
  densityScale = 1;
  /** People in the carriageway (set by Pedestrians); vehicles yield to them. */
  pedestrians: () => { x: number; z: number }[] = () => [];
  enabled = true;
  policeEnabled = true;
  rain = false;             // wet roads: everyone drives slower with longer gaps
  rush = 0;                 // 0..1 rush hour: ~2.3x vehicles, crawling speeds, short gaps
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
  private peds: { x: number; z: number }[] = [];
  private siren = [new pc.Color(1, 0.1, 0.1), new pc.Color(0.15, 0.3, 1)].map(c => {
    const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(0, 0, 0); m.emissive = c; m.useLighting = false; m.update(); return m;
  });

  constructor(app: pc.AppBase, private map: MapChunkManager, private player: VehiclePhysics) {
    this.models = new ModelCache(app.graphicsDevice);
    app.root.addChild(this.root);
  }

  get incidents() { return this.vehicles.filter(v => v.broken > 0); }

  update(dt: number) {
    const want = !this.enabled ? 0 : Math.round(this.target * this.densityScale * (1 + 2.6 * this.rush));
    this.roadCacheAge -= dt;
    if (this.roadCacheAge <= 0) { this.roadCacheAge = 1; this.roadCache = [...this.map.roads.roads()].filter(r => r.w >= 5 && r.h !== 'service'); }
    this.peds = this.pedestrians();
    if (this.vehicles.length < want) {
      const head = this.spawn();
      // Rush hour: spawn whole queues (5-10 vehicles nose-to-tail in one lane) instead of lone cars.
      // Colombo rush hour fills the full road width: each row behind gets 1-3 vehicles abreast (overlap-checked).
      if (head && this.rush) for (let k = 0, q: TrafficVehicle | null = head; k < 5 + this.rnd() * 7 && q && this.vehicles.length < want; k++) {
        const next: TrafficVehicle | null = this.spawn(this.rushCategory(), false, q);
        for (let m = 0; m < 3 && next; m++) this.spawn(this.rushCategory(), false, next, true);
        q = next ?? q;
        if (!next) break;
      }
    }
    while (this.vehicles.length > (want ? want + 5 : 0)) this.remove(this.vehicles[0]);
    if (!this.policeEnabled) for (const v of this.vehicles.filter(v => v.police)) this.remove(v);

    const P = this.player;
    for (const v of [...this.vehicles]) {
      const dp = Math.hypot(v.x - P.x, v.z - P.z);
      if (dp > DESPAWN || !Number.isFinite(dp)) { this.remove(v); continue; }
      // ponytail: gridlock valve. Signals cycle in 54 s, so >75 s stationary means a deadlock; recycle it if not right next to the player.
      v.stopped = v.v < 0.2 && !v.broken ? v.stopped + dt : 0;
      if (v.stopped > (this.rush ? 150 : 75) && dp > 40) { this.remove(v); continue; }
      this.drive(v, dt);
    }
    this.collidePlayer();
    this.incidentTick(dt);
    this.blink += dt;
    const phase = Math.sin(this.blink * 12) > 0;
    if ((this.siren[0].emissiveIntensity > 1) !== phase) {
      this.siren[0].emissiveIntensity = phase ? 4 : 0.3; this.siren[1].emissiveIntensity = phase ? 0.3 : 4;
      this.siren.forEach(m => m.update());
    }
    const on = Math.sin(this.blink * 9) > 0 ? 3 : 0;
    if (this.models.hazardMat.emissiveIntensity !== on) { this.models.hazardMat.emissiveIntensity = on; this.models.hazardMat.update(); }
  }

  // --- spawning --------------------------------------------------------------------------------------
  /** Rush-hour mix: buses and three-wheelers dominate, motorbikes everywhere. */
  private rushCategory(): Category | undefined {
    const r = this.rnd();
    return r < 0.16 ? 'bus' : r < 0.46 ? 'tuktuk' : r < 0.62 ? 'motorcycle' : undefined;
  }

  /** Free lateral slot? Same path, overlapping along-road and across-road footprints (+ jam margins). */
  private free(path: number[], s: number, lane: number, spec: VehicleSpec, ignore?: TrafficVehicle) {
    return !this.vehicles.some(o => o !== ignore && o.path === path && Math.abs(o.s - s) < (o.spec.length + spec.length) / 2 + 0.6
      && Math.abs(o.lane - o.shift - lane) < (o.spec.width + spec.width) / 2 + 0.25);
  }

  spawn(category?: Category, near = false, behind?: TrafficVehicle, beside = false): TrafficVehicle | null {
    const P = this.player, roads = this.roadCache;
    // Rush hour packs traffic closer to the player so the jam is around you, not spread over 260 m.
    const [minD, maxD] = near ? [25, 120] : this.rush ? [30, 170] : [SPAWN_MIN, SPAWN_MAX];
    for (let attempt = 0; attempt < (behind ? 1 : 12) && roads.length; attempt++) {
      const road = behind?.road ?? roads[Math.floor(this.rnd() * roads.length)];
      const dir = road.o || this.rnd() < 0.5 ? 1 : -1;
      const path = behind?.path ?? (dir > 0 ? road.p.slice() : reversePts(road.p));
      const cum = behind?.cum ?? cumulative(path), len = cum[cum.length - 1];
      if (len < 15) continue;
      const isPolice = this.policeEnabled && !category && !behind && this.rnd() < 0.05;
      const spec = isPolice ? POLICE_SPEC : pickSpec(this.rnd, category);
      // Queue member: bumper-to-bumper behind the previous one (jam gap ~1.5-2.5 m).
      const s = beside ? behind!.s + (this.rnd() - 0.5) * 1.5
        : behind ? behind.s - (behind.spec.length + spec.length) / 2 - (this.rush ? 0.7 : 1.5) - this.rnd() * (this.rush ? 0.8 : 1) : 5 + this.rnd() * (len - 10);
      if (s < 2 || s > len - 2) return null;
      const lane = this.rush ? rushLane(road, spec, this.rnd) : laneOffset(road, spec);
      if (behind && !this.free(path, s, lane, spec)) { if (beside) return null; continue; }
      const [x, z] = pointAt(path, cum, s);
      const d = Math.hypot(x - P.x, z - P.z);
      if (!behind && (d < minD || d > maxD)) continue;
      if (behind ? d < 8 : this.vehicles.some(o => Math.hypot(o.x - x, o.z - z) < (this.rush ? 5 : 14))) continue;
      const profile = isPolice ? 'normal' : pickProfile(this.rnd, spec), pr = PROFILES[profile];
      const { root, hazard } = this.models.entity(spec, isPolice ? { color: 0xf2f2f0, accent: 0x1b3f8a } : randomLook(spec, this.rnd));
      this.root.addChild(root);
      const v: TrafficVehicle = {
        id: this.nextId++, spec, profile, v0: spec.v0 * pr.v0 * (0.92 + this.rnd() * 0.16), a: spec.a * pr.a, b: spec.b, T: spec.T * pr.T, s0: spec.s0,
        road, path, cum, seg: 0, s, lane, shift: 0, v: spec.v0 * (behind ? 0.1 : this.rush ? 0.3 : 0.6), x, z, ux: 0, uz: -1, yaw: 0, roll: 0,
        broken: 0, stuckBehindBroken: 0, stopped: 0, entity: root, hazard,
      };
      if (isPolice) {
        v.police = new pc.Entity('lightbar');
        for (const [i, mat] of [this.siren[0], this.siren[1]].entries()) {
          const l = new pc.Entity();
          l.addComponent('render', { type: 'box', material: mat, castShadows: false });
          l.setLocalScale(0.55, 0.14, 0.25);
          l.setLocalPosition(i ? 0.3 : -0.3, spec.height + 0.07, 0.2);
          v.police.addChild(l);
        }
        root.addChild(v.police);
      }
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
    // Rush hour: crawl (~25-40% of free speed) with slow stop-and-go waves; tight jam gaps; sluggish pull-away.
    const wave = this.rush ? 0.55 + 0.45 * Math.sin(this.blink * 0.25 + v.x * 0.02 + v.z * 0.013) : 1;
    const wet = this.rain ? 0.8 : 1;
    const v0 = Math.max(0.8, v.v0 * this.speedScale * (1 - 0.65 * this.rush) * wave * wet), T = (v.T * this.headwayScale * (1 - 0.35 * this.rush)) / wet;
    const s0 = v.s0 * (1 - 0.6 * this.rush), aMax = v.a * (1 - 0.35 * this.rush);
    // IDM: acc = a[1 - (v/v0)^4 - (s*/s)^2], s* = s0 + vT + v·Δv / (2√(ab))
    let acc = aMax * (1 - (v.v / v0) ** 4);
    if (gap < Infinity) {
      const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - leadV)) / (2 * Math.sqrt(aMax * v.b)));
      acc -= aMax * (sStar / Math.max(gap, 0.1)) ** 2;
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

    // Filtering (very Colombo): blocked bikes / tuk-tuks look for a gap to the side and slip into it.
    const small = v.spec.category === 'motorcycle' || v.spec.category === 'tuktuk';
    if (small && !v.passing && gap < 3 && (this.rush || v.spec.category === 'motorcycle')) {
      const half = v.road.w / 2 - v.spec.width / 2 - 0.15, lo = v.road.o ? -half : v.spec.width / 2 + 0.15;
      for (const d of this.rnd() < 0.5 ? [0.9, -0.9] : [-0.9, 0.9]) {
        const target = v.lane + d;
        if (target < lo || target > half) continue;
        if (this.free(v.path, v.s + 1.5, target - v.shift, v.spec, v)) { v.lane += Math.sign(d) * Math.min(Math.abs(d), 1.8 * dt); break; }
      }
    }
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
      if (Math.abs((o.y ?? 0) - (v.y ?? 0)) > 2.5) continue; // different level (flyover vs. road below)
      if (o === v || o.ux * v.ux + o.uz * v.uz < 0.2 && o.broken === 0) continue; // ignore crossing/oncoming movers
      if (v.passing === o) continue;
      // Converging/crossing paths: only one of the pair yields (older id has priority), otherwise both wait forever.
      if (!o.broken && o.ux * v.ux + o.uz * v.uz < 0.9 && o.id > v.id) continue;
      consider(o.x, o.z, o.spec.length, o.spec.width, o.v * Math.max(0, o.ux * v.ux + o.uz * v.uz), o);
    }
    for (const p of this.peds) consider(p.x, p.z, 0.5, 1.2, 0);
    const P = this.player;
    if (Math.abs(P.y - (v.y ?? 0)) < 2.5) consider(P.x, P.z, 4.4, 1.8, Math.max(0, P.forwardSpeed * (-Math.sin(P.yaw) * v.ux - Math.cos(P.yaw) * v.uz)));

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
    v.lane = this.rush ? rushLane(o.road, v.spec, this.rnd) : laneOffset(o.road, v.spec);
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
    // Height comes only from the road this vehicle is driving on — never from a deck it happens to be near.
    const ys = v.road.y;
    if (ys && isElevated(v.road)) {
      const fwd = path[0] === v.road.p[0] && path[1] === v.road.p[1], n = ys.length;
      const y0 = ys[fwd ? i : n - 1 - i], y1 = ys[fwd ? i + 1 : n - 2 - i] ?? y0;
      v.y = y0 + (y1 - y0) * t;
    } else v.y = 0;
    v.y += groundAt(v.x, v.z); // world height: terrain + deck
    v.entity.setPosition(v.x, 0.1 + v.y, v.z);
    v.entity.setEulerAngles(0, (yaw * 180) / Math.PI, (v.roll * 180) / Math.PI);
  }

  // --- player collisions (real contact, not scripted): OBB vs player circle ------------------------------
  private collidePlayer() {
    const P = this.player, c = P.cfg, R = c.width / 2;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), span = c.length / 2 - R;
    for (const v of this.vehicles) {
      if (Math.abs(P.y - (v.y ?? 0)) > 2.5) continue; // one of us is on the flyover above
      if (Math.abs(P.x - v.x) > c.length + v.spec.length || Math.abs(P.z - v.z) > c.length + v.spec.length) continue;
      for (const o of [-span, 0, span]) { // player body as three circles along its length
        const px = P.x + fx * o, pz = P.z + fz * o, dx = px - v.x, dz = pz - v.z;
        const lx = v.uz, lz = -v.ux;
        const la = dx * v.ux + dz * v.uz, ll = dx * lx + dz * lz;
        const ca = Math.max(-v.spec.length / 2, Math.min(v.spec.length / 2, la)), cl = Math.max(-v.spec.width / 2, Math.min(v.spec.width / 2, ll));
        const ox = dx - (v.ux * ca + lx * cl), oz = dz - (v.uz * ca + lz * cl), d = Math.hypot(ox, oz);
        if (d >= R) continue;
        const nx = d > 1e-3 ? ox / d : -v.ux, nz = d > 1e-3 ? oz / d : -v.uz;
        // Split penetration by mass so a bus shoves a tuk-tuk, not the other way round.
        const share = v.spec.mass / (v.spec.mass + c.mass);
        P.x += nx * (R - d) * share; P.z += nz * (R - d) * share;
        const rx = px - nx * R - P.x, rz = pz - nz * R - P.z; // contact point rel. player CG
        const rel = (P.vx + P.omega * rz - v.ux * v.v) * nx + (P.vz - P.omega * rx - v.uz * v.v) * nz;
        if (rel >= 0) continue;
        // Two-body impulse, crumple restitution; AI vehicle treated as a point mass on its path.
        const e = 0.3 / (1 + -rel / 4), rn = rz * nx - rx * nz;
        const j = (-(1 + e) * rel) / (1 / c.mass + 1 / v.spec.mass + (rn * rn) / c.inertia);
        P.applyImpulse(j * nx, j * nz, rx, rz);
        v.v = Math.max(0, v.v - (j * (v.ux * nx + v.uz * nz)) / v.spec.mass);
        P.impact = Math.max(P.impact, -rel);
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

/** Rush hour: anywhere across the usable width (left half, or the full width on one-ways) — no lane discipline. */
function rushLane(r: RoadData, spec: VehicleSpec, rnd: () => number) {
  const half = r.w / 2 - spec.width / 2 - 0.15, lo = r.o ? -half : spec.width / 2 + 0.15;
  return half > lo ? lo + rnd() * (half - lo) : laneOffset(r, spec);
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

