import type * as pc from 'playcanvas';
import type { MapChunkManager } from '../../map/MapChunkManager';
import { project as projectLL, unproject } from '../../map/MapProjection';
import type { RoadData } from '../../map/MapTypes';
import type { NavigationManager } from '../../nav/NavigationManager';
import type { VehiclePhysics } from '../../vehicle/VehiclePhysics';
import type { ModeHUD } from './ModeHUD';
import { PassengerFactory } from './Passengers';

// Taxi: a passenger hails a ride nearby -> drive there and stop -> they give a real Colombo destination ->
// drive there (navigation guides) and stop -> fare paid. Rates modelled on Colombo app taxis (car, 2026).
const BASE = 150, PER_KM = 120, WAIT_STOP = 1.5; // Rs, Rs/km, seconds stationary to board/alight
const BOARD_RADIUS = 12, DROP_RADIUS = 25;

type State = { kind: 'waiting'; who: pc.Entity; x: number; z: number; street: string; since: number }
  | { kind: 'riding'; dest: { name: string; x: number; z: number }; startX: number; startZ: number; start: number; distance: number; name: string }
  | { kind: 'none' };

const NAMES = ['Nimal', 'Kumari', 'Fathima', 'Ravi', 'Dilani', 'Suresh', 'Ayesha', 'Pradeep', 'Thilini', 'Mohamed', 'Shanthi', 'Kasun', 'Priya', 'Ruwan'];

export class TaxiMode {
  private state: State = { kind: 'none' };
  private people: PassengerFactory;
  private earnings = 0;
  private trips = 0;
  private still = 0;
  private cooldown = 2;
  private lastCollision = '';

  constructor(app: pc.AppBase, private map: MapChunkManager, private nav: NavigationManager, private car: VehiclePhysics,
    private hud: ModeHUD, private collisions: () => string) {
    this.people = new PassengerFactory(app);
    hud.show('TAXI', '#f2c230');
  }

  update(dt: number) {
    const c = this.car, speed = Math.abs(c.forwardSpeed);
    this.still = speed < 0.8 ? this.still + dt : 0;
    // Damage: a collision costs the rider's tip.
    const col = this.collisions();
    if (col && col !== this.lastCollision) { this.lastCollision = col; if (this.state.kind === 'riding') { this.earnings -= 200; this.hud.toast('Passenger: "Aiyo! Careful!"  −Rs 200'); } }

    const s = this.state;
    if (s.kind === 'none') {
      if ((this.cooldown -= dt) <= 0) this.spawnPassenger();
    } else if (s.kind === 'waiting') {
      s.since += dt;
      const d = Math.hypot(c.x - s.x, c.z - s.z);
      this.hud.set(`Pick up passenger on ${s.street}`, `${Math.round(d)} m · stop next to them`, this.stats());
      if (d < BOARD_RADIUS && this.still > WAIT_STOP) this.board(s);
      else if (s.since > 240) { s.who.destroy(); this.state = { kind: 'none' }; this.cooldown = 1; this.hud.toast('The passenger took a tuk-tuk instead.'); }
    } else {
      const d = Math.hypot(c.x - s.dest.x, c.z - s.dest.z);
      const meter = BASE + (s.distance / 1000) * PER_KM;
      this.hud.set(`${s.name} → ${s.dest.name}`, `${Math.round(d)} m to drop-off · meter Rs ${Math.round(meter)}`, this.stats());
      s.distance += speed * dt;
      if (d < DROP_RADIUS && this.still > WAIT_STOP) this.drop(s, meter);
    }
  }

  private stats() { return `Trips ${this.trips} · Earned Rs ${Math.round(this.earnings).toLocaleString()}`; }

  /** Passenger waits at the kerb of a real road 250–700 m away. */
  private spawnPassenger() {
    const c = this.car, roads = [...this.map.roads.roads()].filter(r => r.w >= 5 && r.h !== 'service' && r.n);
    for (let tries = 0; tries < 60; tries++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      if (!r) return;
      const pt = pointOn(r, Math.random());
      const d = Math.hypot(pt.x - c.x, pt.z - c.z);
      if (d < 250 || d > 700) continue;
      const kx = pt.x + pt.uz * (r.w / 2 + 1), kz = pt.z - pt.ux * (r.w / 2 + 1); // left kerb (Sri Lanka: kerb on the left)
      const who = this.people.person(kx, kz, -pt.uz, pt.ux, true);
      this.state = { kind: 'waiting', who, x: kx, z: kz, street: r.n, since: 0 };
      const [lat, lon] = unproject(kx, kz);
      this.nav.go({ name: `Passenger on ${r.n}`, address: 'Taxi pickup', lat, lon, kind: 'pickup' });
      this.hud.toast(`New ride request on ${r.n}`);
      return;
    }
    this.cooldown = 2;
  }

  /** Destination: a real named Colombo place (OSM neighbourhoods / named buildings) 1–5 km away. */
  private board(s: Extract<State, { kind: 'waiting' }>) {
    s.who.destroy();
    const c = this.car;
    const candidates = this.map.index.places.map(p => ({ name: p.name, x: p.x, z: p.z }))
      .concat(this.map.landmarks.records.map(r => { const [x, z] = projectLL(r.latitude, r.longitude); return { name: r.name || '', x, z }; }).filter(p => p.name))
      .filter(p => { const d = Math.hypot(p.x - c.x, p.z - c.z); return d > 1000 && d < 5000; });
    if (!candidates.length) { this.state = { kind: 'none' }; this.cooldown = 1; return; }
    const dest = candidates[Math.floor(Math.random() * candidates.length)];
    const name = NAMES[Math.floor(Math.random() * NAMES.length)];
    this.state = { kind: 'riding', dest, startX: c.x, startZ: c.z, start: performance.now(), distance: 0, name };
    this.hud.toast(`${name}: "${dest.name}, please."`);
    const [lat, lon] = unproject(dest.x, dest.z);
    this.nav.go({ name: dest.name, address: 'Taxi drop-off', lat, lon, kind: 'dropoff' });
  }

  private drop(s: Extract<State, { kind: 'riding' }>, meter: number) {
    const mins = (performance.now() - s.start) / 60000, km = s.distance / 1000;
    const tip = mins < km * 2.5 ? 100 : 0; // quick ride: tip
    const fare = Math.round(meter + tip);
    this.earnings += fare;
    this.trips++;
    this.hud.toast(`${s.name} paid Rs ${fare}${tip ? ' (incl. Rs 100 tip)' : ''} · ${km.toFixed(1)} km`);
    this.nav.cancel();
    this.state = { kind: 'none' };
    this.cooldown = 4;
  }
}

export function pointOn(r: RoadData, f: number) {
  const p = r.p, cum = [0];
  for (let i = 2; i < p.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
  const s = cum[cum.length - 1] * f;
  let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const l = cum[i + 1] - cum[i] || 1, t = (s - cum[i]) / l;
  const ux = (p[i * 2 + 2] - p[i * 2]) / l, uz = (p[i * 2 + 3] - p[i * 2 + 1]) / l;
  return { x: p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t, z: p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t, ux, uz };
}
