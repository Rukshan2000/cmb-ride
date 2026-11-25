import * as pc from 'playcanvas';
import type { MapChunkManager } from '../map/MapChunkManager';
import type { RoadData } from '../map/MapTypes';
import { isElevated } from '../map/RoadNetwork';
import type { TrafficManager } from '../traffic/TrafficManager';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { animate, face, makeHuman, type Human } from './Human';

// Pedestrians walk along the pavements of nearby roads and cross: at zebra crossings (look, wait for a gap,
// then cross) and sometimes mid-block (jaywalking, very Colombo). Traffic AI yields to anyone on the road.
// ponytail: walkers follow one road polyline and turn back at its end; a footpath graph for routing.
const COUNT = 28, SPAWN_MIN = 25, SPAWN_MAX = 160, DESPAWN = 210;

type Mode = { kind: 'walk' } | { kind: 'wait'; t: number; tx: number; tz: number; zebra: boolean }
  | { kind: 'cross'; tx: number; tz: number } | { kind: 'down'; t: number };

interface Walker {
  h: Human; road: RoadData; cum: number[]; s: number; dir: 1 | -1; side: 1 | -1;
  speed: number; x: number; z: number; fx: number; fz: number; mode: Mode; crossCool: number;
}

export class Pedestrians {
  private list: Walker[] = [];
  private roads: RoadData[] = [];
  private roadsAge = 0;
  enabled = true;

  constructor(private app: pc.AppBase, private map: MapChunkManager, private traffic: TrafficManager, private car: VehiclePhysics) {
    traffic.pedestrians = () => this.onRoad();
  }

  /** People currently in the carriageway (traffic treats them as obstacles). */
  onRoad() { return this.list.filter(w => w.mode.kind === 'cross' || w.mode.kind === 'down'); }

  update(dt: number) {
    const P = this.car;
    if ((this.roadsAge -= dt) <= 0) { this.roadsAge = 1; this.roads = [...this.map.roads.roads()].filter(r => r.w >= 5 && r.h !== 'service' && r.h !== 'motorway' && !isElevated(r)); }
    const want = !this.enabled ? 0 : Math.round(COUNT * (1 + this.traffic.rush * 0.8));
    if (this.list.length < want) this.spawn();
    while (this.list.length > want) this.list.pop()!.h.root.destroy();
    for (const w of [...this.list]) {
      if (Math.hypot(w.x - P.x, w.z - P.z) > DESPAWN) { w.h.root.destroy(); this.list.splice(this.list.indexOf(w), 1); continue; }
      this.step(w, dt);
      this.hitByPlayer(w);
    }
  }

  private spawn() {
    const P = this.car;
    for (let tries = 0; tries < 8; tries++) {
      const road = this.roads[Math.floor(Math.random() * this.roads.length)];
      if (!road) return;
      const cum = cumulative(road.p), s = Math.random() * cum[cum.length - 1];
      const side = Math.random() < 0.5 ? 1 : -1;
      const w: Walker = { h: makeHuman(this.app), road, cum, s, dir: Math.random() < 0.5 ? 1 : -1, side, speed: 1.1 + Math.random() * 0.5,
        x: 0, z: 0, fx: 0, fz: 1, mode: { kind: 'walk' }, crossCool: 5 + Math.random() * 20 };
      this.pavement(w);
      const d = Math.hypot(w.x - P.x, w.z - P.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) { w.h.root.destroy(); continue; }
      this.app.root.addChild(w.h.root);
      face(w.h, w.x, w.z, w.fx, w.fz);
      this.list.push(w);
      return;
    }
  }

  /** Position on the pavement: road edge + 1.3 m on this walker's side. */
  private pavement(w: Walker) {
    const [x, z, ux, uz] = at(w.road.p, w.cum, w.s), off = (w.road.w / 2 + 1.3) * w.side;
    w.x = x + uz * off; w.z = z - ux * off; w.fx = ux * w.dir; w.fz = uz * w.dir;
  }

  private step(w: Walker, dt: number) {
    const m = w.mode;
    w.crossCool -= dt;
    if (m.kind === 'walk') {
      const len = w.cum[w.cum.length - 1], ns = w.s + w.dir * w.speed * dt;
      if (ns < 1 || ns > len - 1) w.dir = (w.dir * -1) as 1 | -1; else w.s = ns;
      const px = w.x, pz = w.z;
      this.pavement(w);
      if (this.map.collision.raycast(px, pz, w.x, w.z) < 1) { w.dir = (w.dir * -1) as 1 | -1; w.x = px; w.z = pz; } // building in the way
      animate(w.h, dt, w.speed);
      face(w.h, w.x, w.z, w.fx, w.fz);
      if (w.crossCool <= 0) this.maybeCross(w);
    } else if (m.kind === 'wait') {
      // Kerbside: look both ways (turn head-ish by turning body) until no vehicle is close.
      m.t += dt;
      animate(w.h, dt, 0);
      const look = Math.sin(m.t * 1.6) * 0.6;
      face(w.h, w.x, w.z, (m.tx - w.x) * Math.cos(look) - (m.tz - w.z) * Math.sin(look), (m.tz - w.z) * Math.cos(look) + (m.tx - w.x) * Math.sin(look));
      if (this.clear(w, m.zebra ? 14 : 30) || m.t > (m.zebra ? 6 : 25)) w.mode = { kind: 'cross', tx: m.tx, tz: m.tz };
    } else if (m.kind === 'cross') {
      const dx = m.tx - w.x, dz = m.tz - w.z, d = Math.hypot(dx, dz), v = w.speed * 1.15;
      if (d < 0.2) { // reached the far pavement: re-attach to the road there
        w.side = (w.side * -1) as 1 | -1; w.mode = { kind: 'walk' }; w.crossCool = 20 + Math.random() * 40;
        return;
      }
      w.x += (dx / d) * Math.min(d, v * dt); w.z += (dz / d) * Math.min(d, v * dt);
      animate(w.h, dt, v);
      face(w.h, w.x, w.z, dx, dz);
    } else if ((m.t -= dt) <= 0) { // knocked down: get back up and carry on
      const x = w.x, z = w.z;
      this.pavement(w);                           // where they belong...
      w.mode = { kind: 'cross', tx: w.x, tz: w.z }; // ...walk back there (cross mode flips side on arrival, so pre-flip)
      w.side = (w.side * -1) as 1 | -1;
      w.x = x; w.z = z;
      face(w.h, x, z, w.fx, w.fz);
    }
  }

  /** Near a zebra on this road? Cross there. Otherwise, sometimes jaywalk. */
  private maybeCross(w: Walker) {
    const [rx, rz, ux, uz] = at(w.road.p, w.cum, w.s), far = (w.road.w / 2 + 1.3) * -w.side;
    let zebra = false;
    for (const list of this.map.crossings.values()) for (let i = 0; i < list.length; i += 5) {
      if (Math.hypot(list[i] - rx, list[i + 1] - rz) < 3) zebra = true;
    }
    if (!zebra && Math.random() > (0.004 + this.traffic.rush * 0.004)) return;
    w.mode = { kind: 'wait', t: 0, tx: rx + uz * far, tz: rz - ux * far, zebra };
  }

  /** No vehicle (AI or player) within `dist` metres of the crossing line and approaching. */
  private clear(w: Walker, dist: number) {
    const near = (x: number, z: number) => Math.hypot(x - w.x, z - w.z) < dist;
    if (near(this.car.x, this.car.z) && Math.abs(this.car.forwardSpeed) > 1) return false;
    return !this.traffic.vehicles.some(v => v.v > 1 && near(v.x, v.z));
  }

  /** Player car contact: the person is knocked over (no gore), and police treat it as reckless driving. */
  private hitByPlayer(w: Walker) {
    const P = this.car, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const dx = w.x - P.x, dz = w.z - P.z, along = dx * fx + dz * fz, lat = dx * -fz + dz * fx;
    if (P.deck > 2 || Math.abs(along) > P.cfg.length / 2 + 0.3 || Math.abs(lat) > P.cfg.width / 2 + 0.3 || w.mode.kind === 'down') return;
    const speed = Math.hypot(P.vx, P.vz);
    if (speed < 1.2) { w.x += Math.sign(lat || 1) * -fz * 0.5; w.z += Math.sign(lat || 1) * fx * 0.5; return; } // nudged aside
    const push = Math.min(4, speed * 0.25);
    w.x += P.vx / speed * push; w.z += P.vz / speed * push;
    face(w.h, w.x, w.z, w.fx, w.fz);
    w.h.root.setLocalEulerAngles(90, (Math.atan2(-P.vx, -P.vz) * 180) / Math.PI, 0); // falls over
    w.mode = { kind: 'down', t: 6 };
    P.vx *= 0.92; P.vz *= 0.92; P.impact = Math.max(P.impact, speed * 0.3);
    this.traffic.lastCollision = `Hit a pedestrian at ${Math.round(speed * 3.6)} km/h`;
  }
}

function cumulative(p: number[]) { const c = [0]; for (let i = 2; i < p.length; i += 2) c.push(c[c.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])); return c; }
function at(p: number[], cum: number[], s: number): [number, number, number, number] {
  let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const l = cum[i + 1] - cum[i] || 1, t = (s - cum[i]) / l;
  const ux = (p[i * 2 + 2] - p[i * 2]) / l, uz = (p[i * 2 + 3] - p[i * 2 + 1]) / l;
  return [p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t, ux, uz];
}
