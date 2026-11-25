import { GeometryBuffer, vertexColorMaterial } from '../../map/MeshUtil';
import { project, unproject as unprojectLocal } from '../../map/MapProjection';
import type { NavigationManager } from '../../nav/NavigationManager';
import { box } from '../../roads/StreetFurniture';
import type { VehiclePhysics } from '../../vehicle/VehiclePhysics';
import type { ModeHUD } from './ModeHUD';
import { PassengerFactory } from './Passengers';
import * as pc from 'playcanvas';

// Lanka Metro Transit bus driver: serve each real stop of a CM route in order (stop at the stop, doors open,
// passengers alight/board, fares collected), then continue. Routes and stops: public/data/metro.json
// (slrailwayforum.com + srilankatrip.com.lk, Nov 2026; positions geocoded and snapped to OSM bus stops).

export interface MetroStop { name: string; lat: number | null; lon: number | null; inMap: boolean; source: string }
export interface MetroRoute { code: string; colour: string; name: string; fare: [number, number]; loop?: boolean; stops: MetroStop[] }

interface PlayStop { name: string; x: number; z: number; waiting: pc.Entity[] }

const SERVE_RADIUS = 22, DWELL = 3, CAPACITY = 55;

/** In-map stops a player can drive: whole loop (CM06) or the longest consecutive in-map run; near-duplicates merged. */
export function playableStops(r: MetroRoute): { name: string; x: number; z: number }[] {
  let best: MetroStop[] = [], run: MetroStop[] = [];
  for (const s of r.stops) {
    if (s.lat === null || s.lon === null) continue;          // not geocoded: skip, don't break the run
    if (r.loop) { if (s.inMap) best.push(s); continue; }      // circular route: every in-map stop
    if (s.inMap && s.lat !== null && s.lon !== null) { run.push(s); if (run.length > best.length) best = [...run]; } else run = [];
  }
  const out: { name: string; x: number; z: number }[] = [];
  for (const s of best) {
    const [x, z] = project(s.lat!, s.lon!);
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - x, prev.z - z) < 60) { prev.name += ' / ' + s.name; continue; }
    out.push({ name: s.name, x, z });
  }
  if (r.loop && out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < 60) out.pop();
  return out;
}

export class MetroBusMode {
  private stops: PlayStop[];
  private next = 1;
  private dir = 1;
  private onboard = 0;
  private revenue = 0;
  private served = 0;
  private missed = 0;
  private still = 0;
  private dwell = 0;
  private wasNear = false;
  private people: PassengerFactory;

  constructor(private app: pc.AppBase, private route: MetroRoute, private nav: NavigationManager, private car: VehiclePhysics, private hud: ModeHUD) {
    this.people = new PassengerFactory(app);
    const mat = vertexColorMaterial();
    const colour = parseInt(route.colour.slice(1), 16);
    this.stops = playableStops(route).map(s => {
      // Stop pole with the route-colour flag, plus a few waiting passengers.
      const g = new GeometryBuffer();
      box(g, s.x, 0, s.z, 0, -1, 0.1, 2.8, 0.1, 0x8a8d90);
      box(g, s.x, 2.4, s.z, 0, -1, 0.6, 0.5, 0.05, colour);
      box(g, s.x, 2.45, s.z + 0.03, 0, -1, 0.35, 0.18, 0.02, 0xffffff);
      const pole = new pc.Entity('metro stop ' + s.name);
      pole.addComponent('render', { meshInstances: [new pc.MeshInstance(g.toMesh(app.graphicsDevice, true)!, mat)] });
      app.root.addChild(pole);
      const waiting = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, (_, k) =>
        this.people.person(s.x + Math.cos(k * 2.1) * 1.4, s.z + Math.sin(k * 2.1) * 1.4, 1, 0, false));
      return { ...s, waiting };
    });
    hud.show(`${route.code} · ${route.name}`, route.colour);
    if (this.stops.length < 2) { hud.set('This route has fewer than 2 stops inside the 3D map', 'Pick CM06 (Kollupitiya Circular)', ''); return; }
    hud.toast(`${route.code}: ${this.stops.length} stops in the city. First stop: ${this.stops[0].name}`, 5000);
    this.guide();
  }

  /** Spawn at the first stop, heading for the second. */
  get start() { return this.stops.length >= 2 ? { x: this.stops[0].x, z: this.stops[0].z, tx: this.stops[1].x, tz: this.stops[1].z } : null; }

  private guide() {
    const s = this.stops[this.next];
    const [lat, lon] = unprojectLocal(s.x, s.z);
    this.nav.go({ name: `${this.route.code} stop: ${s.name}`, address: `Lanka Metro ${this.route.code}`, lat, lon, kind: 'bus stop' });
  }

  update(dt: number) {
    if (this.stops.length < 2) return;
    const c = this.car, s = this.stops[this.next], d = Math.hypot(c.x - s.x, c.z - s.z);
    this.still = Math.abs(c.forwardSpeed) < 0.5 ? this.still + dt : 0;
    const stats = `On board ${this.onboard}/${CAPACITY} · Served ${this.served} · Missed ${this.missed} · Rs ${this.revenue.toLocaleString()}`;

    if (d < SERVE_RADIUS && this.still > 0.5) {
      this.dwell += dt;
      this.hud.set(`Doors open — ${s.name}`, `Boarding… ${Math.max(0, Math.ceil(DWELL - this.dwell))} s`, stats);
      if (this.dwell >= DWELL) this.serve(s);
      return;
    }
    this.dwell = 0;
    if (d < SERVE_RADIUS * 2) this.wasNear = true;
    else if (this.wasNear && d > SERVE_RADIUS * 4) { // drove past without stopping
      this.wasNear = false;
      this.missed++;
      this.hud.toast(`Missed stop ${s.name}! Passengers left waiting.`);
      this.advance();
      return;
    }
    const after = this.stops[this.next + this.dir] ?? (this.route.loop ? this.stops[0] : null);
    this.hud.set(`Next stop: ${s.name}`, `${Math.round(d)} m${after ? ' · then ' + after.name : ''}`, stats);
  }

  private serve(s: PlayStop) {
    const alight = Math.min(this.onboard, Math.round(this.onboard * (0.15 + Math.random() * 0.35)));
    const board = Math.min(CAPACITY - (this.onboard - alight), s.waiting.length + Math.floor(Math.random() * 4));
    this.onboard += board - alight;
    const [lo, hi] = this.route.fare;
    const fares = Array.from({ length: board }, () => lo + Math.round(Math.random() * Math.min(hi - lo, 120) / 5) * 5).reduce((a, b) => a + b, 0);
    this.revenue += fares;
    this.served++;
    s.waiting.forEach(e => e.destroy());
    s.waiting = [];
    this.hud.toast(`${s.name}: ${alight} off, ${board} on · +Rs ${fares}`);
    this.wasNear = false;
    this.dwell = 0;
    this.advance();
  }

  private advance() {
    this.next += this.dir;
    if (this.next >= this.stops.length || this.next < 0) {
      if (this.route.loop) this.next = 0;
      else { this.dir = -this.dir; this.next += 2 * this.dir; this.hud.toast(`End of the in-city section — returning ${this.dir > 0 ? 'outbound' : 'inbound'}.`); }
    }
    // Passengers gradually gather again at served stops.
    for (const st of this.stops) if (st !== this.stops[this.next] && !st.waiting.length && Math.random() < 0.3)
      st.waiting.push(this.people.person(st.x + 1.2, st.z, 1, 0, false));
    this.guide();
  }
}

