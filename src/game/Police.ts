import * as pc from 'playcanvas';
import type { MapChunkManager } from '../map/MapChunkManager';
import { face, makeHuman } from '../people/Human';
import { groundAt } from '../map/Terrain';
import type { TrafficManager } from '../traffic/TrafficManager';
import { CATALOG } from '../traffic/VehicleCatalog';
import { ModelCache } from '../traffic/VehicleModels';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { pointOn } from './modes/TaxiMode';
import type { Wallet } from './Wallet';

// Traffic police: officers hidden at the kerb (behind trees / poles) and patrol cars in traffic.
// If one of them sees a violation you must pull over and stop; you get a spot fine. Drive off = bigger fine.
// ponytail: fine amounts are gameplay values in the spirit of Sri Lankan spot fines, not the official schedule.
const FINES = { speeding: 3000, 'red light': 5000, 'reckless driving (collision)': 10000 } as const;
const FLEE_FINE = 25000;
const OFFICER_SIGHT = 45, CAR_SIGHT = 70, PULL_OVER_TIME = 25, OFFICERS = 4, WALK = 1.5;
const POLICE_SPEC = { ...CATALOG.find(c => c.id === 'sedan')!, label: 'Police patrol car' };
type Offence = keyof typeof FINES;

/** Sri Lankan urban limits (km/h) by OSM road class. */
function limitFor(h: string) { return h === 'motorway' ? 100 : h === 'trunk' || h === 'primary' ? 60 : 50; }

export class Police {
  private officers: { e: pc.Entity; x: number; z: number }[] = [];
  private stop: Stop | null = null;
  private models: ModelCache;
  private siren = [new pc.Color(1, 0.1, 0.1), new pc.Color(0.15, 0.3, 1)].map(c => {
    const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(0, 0, 0); m.emissive = c; m.useLighting = false; m.update(); return m;
  });
  private blink = 0;
  /** Your recent path, snapped to the left lane of the road you were on (3 m spacing, ~200 m). The patrol car follows it. */
  private trail: { x: number; z: number }[] = [];
  private ticket = document.createElement('div');
  private cool = new Map<Offence, number>();
  private slow = 0;
  private limit = 50;
  private prev = { x: 0, z: 0 };
  private lastCol = '';

  constructor(private app: pc.AppBase, private map: MapChunkManager, private traffic: TrafficManager,
    private car: VehiclePhysics, private wallet: Wallet, private toast: (m: string, ms?: number) => void) {
    this.prev = { x: car.x, z: car.z };
    this.lastCol = traffic.lastCollision;
    this.models = new ModelCache(app.graphicsDevice);
    Object.assign(this.ticket.style, { position: 'fixed', right: '16px', bottom: '120px', width: '280px', padding: '14px 16px', display: 'none',
      background: '#fbf8ec', color: '#1a1a1a', font: '13px/1.5 "Courier New", monospace', borderTop: '6px solid #1b3f8a',
      boxShadow: '0 6px 24px rgba(0,0,0,.45)', transform: 'rotate(-1.5deg)', zIndex: '30', whiteSpace: 'pre-wrap' });
    document.body.appendChild(this.ticket);
  }

  get speedLimit() { return this.limit; }
  /** Cinematic shot for the camera while a police scene plays (null = normal camera). y is height. */
  shot: { px: number; py: number; pz: number; lx: number; ly: number; lz: number } | null = null;
  private bars = [0, 1].map(i => {
    const b = document.createElement('div');
    Object.assign(b.style, { position: 'fixed', left: '0', right: '0', height: '0', background: '#000', zIndex: '25',
      transition: 'height .6s ease', [i ? 'bottom' : 'top']: '0', color: '#fff', font: 'italic 600 18px system-ui',
      display: 'flex', alignItems: 'center', justifyContent: 'center', letterSpacing: '.04em', overflow: 'hidden' });
    document.body.appendChild(b); return b;
  });
  private caption = '';
  private shotT = 0;

  private film(on: boolean, caption = '') {
    for (const b of this.bars) b.style.height = on ? '11vh' : '0';
    if (caption !== this.caption) { this.caption = caption; this.bars[1].textContent = caption; }
    if (!on) this.shot = null;
  }

  get pullingOver() { return !!this.stop && this.stop.stage !== 'leave'; }

  update(dt: number) {
    const c = this.car, kmh = Math.abs(c.forwardSpeed) * 3.6;
    this.slow -= dt;
    if (this.slow <= 0) {
      this.slow = 0.25;
      const hit = this.map.roads.nearest(c.x, c.z);
      this.limit = hit && hit.dist < 25 ? limitFor(hit.road.h) : 50;
      this.manageOfficers();
    }
    for (const [k, t] of this.cool) this.cool.set(k, t - dt);
    this.record();

    // --- detect offences
    const seen: Offence[] = [];
    if (kmh > this.limit + 8) seen.push('speeding');
    if (this.ranRed()) seen.push('red light');
    if (this.traffic.lastCollision !== this.lastCol) { this.lastCol = this.traffic.lastCollision; seen.push('reckless driving (collision)'); }
    this.prev = { x: c.x, z: c.z };
    for (const o of seen) {
      if ((this.cool.get(o) ?? 0) > 0 || !this.witnessed()) continue;
      this.cool.set(o, 20);
      if (!this.stop) this.start(o);
      else if (this.stop.stage !== 'leave' && !this.stop.offences.includes(o)) this.stop.offences.push(o);
    }

    // --- pull-over scene
    if (!this.stop) return;
    this.blink += dt;
    const on = Math.sin(this.blink * 12) > 0;
    this.siren[0].emissiveIntensity = on ? 4 : 0.3; this.siren[1].emissiveIntensity = on ? 0.3 : 4;
    this.siren.forEach(m => m.update());
    const before = this.stop.stage;
    this.scene(dt, kmh);
    if (this.stop?.stage !== before) this.shotT = before === 'chase' && this.stop?.stage === 'walk' ? 0 : this.shotT;
    this.direct(dt);
  }

  private start(o: Offence) {
    const c = this.car, fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    // Patrol car appears behind you (just out of sight) with lights on.
    // Spawn on your own trail ~45 m back (so it's on the road, in lane); fallback: straight behind.
    let i = this.trail.length - 1, back = 0;
    while (i > 0 && back < 45) { back += Math.hypot(this.trail[i].x - this.trail[i - 1].x, this.trail[i].z - this.trail[i - 1].z); i--; }
    const start = this.trail.length > 2 ? this.trail[i] : { x: c.x - fx * 45, z: c.z - fz * 45 };
    const route = this.trail.slice(i + 1);
    const nxt = route[0] ?? { x: c.x, z: c.z };
    const x = start.x, z = start.z, yaw0 = Math.atan2(-(nxt.x - x), -(nxt.z - z));
    const { root } = this.models.entity(POLICE_SPEC, { color: 0xf2f2f0, accent: 0x1b3f8a });
    for (const [i, mat] of this.siren.entries()) {
      const l = new pc.Entity();
      l.addComponent('render', { type: 'box', material: mat, castShadows: false });
      l.setLocalScale(0.55, 0.14, 0.25);
      l.setLocalPosition(i ? 0.3 : -0.3, POLICE_SPEC.height + 0.07, 0.2);
      root.addChild(l);
    }
    this.app.root.addChild(root);
    this.shotT = 0;
    this.stop = { offences: [o], stage: 'chase', t: PULL_OVER_TIME, still: 0, pc: { e: root, x, z, yaw: yaw0, v: Math.abs(c.forwardSpeed) }, route };
    this.place(this.stop.pc);
    this.toast(`🚨 POLICE: ${o}! Pull over to the kerb and stop.`, 6000);
  }

  private scene(dt: number, kmh: number) {
    const s = this.stop!, c = this.car, pcar = s.pc;
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw), rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
    s.t -= dt;
    s.still = kmh < 3 ? s.still + dt : 0;
    if (s.stage === 'chase') {
      // Follow your lane-snapped trail; only the last few metres aim straight at the slot 8 m behind you.
      const r = s.route;
      while (r.length && Math.hypot(r[0].x - pcar.x, r[0].z - pcar.z) < 6) r.shift();
      const tx = c.x - fx * 8, tz = c.z - fz * 8, d = Math.hypot(tx - pcar.x, tz - pcar.z);
      const gap = Math.hypot(c.x - pcar.x, c.z - pcar.z);
      const aim = gap > 16 && r.length > 2 ? r[0] : { x: tx, z: tz };
      this.drive(pcar, aim.x, aim.z, Math.min(32, Math.abs(c.forwardSpeed) + Math.max(0, gap - 8) * 0.6), dt, d < 3 ? c.yaw : undefined);
      if (s.still > 1.5 && d < 4) {
        pcar.v = 0;
        const ox = pcar.x + Math.cos(pcar.yaw) * 1.2, oz = pcar.z - Math.sin(pcar.yaw) * 1.2;
        s.officer = { ...this.officer(ox, oz, fx, fz), x: ox, z: oz };
        s.stage = 'walk';
        this.toast('👮 The officer is walking to your window. Stay stopped.', 4000);
      } else if (s.t <= 0) this.fled(s);
    } else if (s.stage === 'walk' || s.stage === 'write') {
      if (kmh > 10) return this.fled(s); // drove off mid-stop
      const o = s.officer!, wx = c.x + rx * 1.4 + fx * 0.3, wz = c.z + rz * 1.4 + fz * 0.3; // driver's window (right-hand drive)
      if (s.stage === 'walk') {
        if (this.walk(o, wx, wz, dt)) { s.stage = 'write'; s.t = 4.5; o.e.setEulerAngles(0, (Math.atan2(rx, rz) * 180) / Math.PI, 0); this.showTicket(s, 0); }
      } else {
        o.arm.setLocalEulerAngles(-70 + Math.sin(this.blink * 14) * 8, 0, 0); // writing in the notebook
        this.showTicket(s, 1 - s.t / 4.5);
        if (s.t <= 0) {
          const total = s.offences.reduce((a, x) => a + FINES[x], 0);
          this.wallet.fine(total);
          this.showTicket(s, 1, `PAID — Rs ${total.toLocaleString()} deducted`);
          o.arm.setLocalEulerAngles(0, 0, 0);
          s.stage = 'leave'; s.t = 8;
        }
      }
    } else if (s.stage === 'leave') {
      const o = s.officer;
      if (o && this.walk(o, pcar.x + Math.cos(pcar.yaw) * 1.2, pcar.z - Math.sin(pcar.yaw) * 1.2, dt)) { o.e.destroy(); s.officer = undefined; }
      if (!s.officer) this.drive(pcar, pcar.x - Math.sin(pcar.yaw) * 30 + rx * 3, pcar.z - Math.cos(pcar.yaw) * 30 + rz * 3, 12, dt);
      if (s.t <= 0) this.end();
    }
  }

  /** Append a breadcrumb every 3 m, snapped to the left-hand lane (Sri Lanka) when on a road. */
  private record() {
    const c = this.car, last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(c.x - last.x, c.z - last.z) < 3) return;
    let x = c.x, z = c.z;
    const hit = this.map.roads.nearest(x, z);
    if (hit && hit.dist < hit.road.w / 2 + 2) {
      const dir = Math.sign(hit.dx * -Math.sin(c.yaw) + hit.dz * -Math.cos(c.yaw)) || 1; // travel along or against the polyline
      const ux = hit.dx * dir, uz = hit.dz * dir, w = hit.road.w;
      const off = hit.road.o ? 0 : Math.max(1.3, Math.min(w / 4, w / 2 - 1.2));
      x = hit.x + uz * off; z = hit.z - ux * off;      // left of travel direction
    }
    this.trail.push({ x, z });
    if (this.trail.length > 70) this.trail.shift();
    this.stop?.stage === 'chase' && this.stop.route.push({ x, z });
  }

  /** Director: picks a camera per stage. While you're still driving in the chase, only a short intro shot. */
  private direct(dt: number) {
    const s = this.stop;
    if (!s) return this.film(false);
    this.shotT += dt;
    const c = this.car, p = s.pc, rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw), fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    const pfx = -Math.sin(p.yaw), pfz = -Math.cos(p.yaw);
    const set = (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => (this.shot = { px, py: py + c.y, pz, lx, ly: ly + c.y, lz }); // heights relative to the car's ground
    if (s.stage === 'chase') {
      if (this.shotT < 2.5) { // intro: low behind the patrol car, lights flashing, looking up the road at you
        set(p.x - pfx * 5 + Math.cos(p.yaw) * 1.2, 1.1, p.z - pfz * 5 - Math.sin(p.yaw) * 1.2, c.x, 1, c.z);
        this.film(true, 'A patrol unit has spotted you…');
      } else if (s.still > 0.5) { // you've stopped: wide side shot of both cars at the kerb
        set(c.x + rx * 9 + fx * 4, 2.2, c.z + rz * 9 + fz * 4, (c.x + p.x) / 2, 1, (c.z + p.z) / 2);
        this.film(true, 'Pulled over');
      } else this.film(false);
    } else if (s.stage === 'walk' && s.officer) { // from in front of your car, officer walking up alongside
      const o = s.officer;
      set(c.x + fx * 5 + rx * 2.5, 1.3, c.z + fz * 5 + rz * 2.5, o.x, 1.4, o.z);
      this.film(true, `Officer ${s.officerNo ??= `PC ${40000 + Math.floor(Math.random() * 9999)}`} approaches`);
    } else if (s.stage === 'write' && s.officer) { // over the officer's shoulder into your window
      const o = s.officer;
      set(o.x + rx * 1.1 - fx * 0.6, 1.85, o.z + rz * 1.1 - fz * 0.6, c.x + rx * 0.3, 1.0, c.z + rz * 0.3);
      this.film(true, 'Licence, please… writing your spot fine');
    } else if (s.stage === 'leave') { // from your bonnet, patrol car pulling away
      set(c.x + fx * 2.5 + rx * 1.5, 1.4, c.z + fz * 2.5 + rz * 1.5, p.x, 1, p.z);
      this.film(true, s.fled ? 'Number plate recorded. A fine is on its way.' : 'You are free to go. Drive safely.');
    }
  }

  /** Police switched off: remove officers, end any stop in progress. */
  clear() {
    for (const o of this.officers) o.e.destroy();
    this.officers = [];
    if (this.stop) this.end();
    this.ticket.style.display = 'none';
  }

  private fled(s: Stop) {
    s.fled = true;
    const total = s.offences.reduce((a, o) => a + FINES[o], 0) + FLEE_FINE;
    this.wallet.fine(total);
    this.showTicket(s, 1, `FLED — plate recorded\nRs ${total.toLocaleString()} incl. Rs ${FLEE_FINE.toLocaleString()} for evading police`);
    this.toast(`📸 You fled the police. Number plate recorded — Rs ${total.toLocaleString()} fine.`, 7000);
    s.officer?.e.destroy(); s.officer = undefined;
    s.stage = 'leave'; s.t = 6;
  }

  private end() {
    this.stop?.pc.e.destroy(); this.stop?.officer?.e.destroy();
    this.stop = null;
    this.film(false);
    setTimeout(() => (this.ticket.style.display = 'none'), 3000);
  }

  /** Kinematic patrol car: turn towards target, accelerate to speed, keep off buildings by sliding along. */
  private drive(p: Stop['pc'], tx: number, tz: number, speed: number, dt: number, faceYaw?: number) {
    const want = faceYaw ?? Math.atan2(-(tx - p.x), -(tz - p.z));
    const dy = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw));
    p.yaw += Math.max(-2 * dt, Math.min(2 * dt, dy));
    p.v += Math.max(-8 * dt, Math.min(5 * dt, speed - p.v));
    const nx = p.x - Math.sin(p.yaw) * p.v * dt, nz = p.z - Math.cos(p.yaw) * p.v * dt;
    p.x = nx; p.z = nz; // path is road-snapped; no wall check needed
    this.place(p);
  }

  private place(p: Stop['pc']) { p.e.setPosition(p.x, 0.1 + groundAt(p.x, p.z), p.z); p.e.setEulerAngles(0, (p.yaw * 180) / Math.PI, 0); }

  /** Walk towards (x,z); true when arrived. */
  private walk(o: NonNullable<Stop['officer']>, x: number, z: number, dt: number) {
    const dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz);
    if (d < 0.15) return true;
    const st = Math.min(d, WALK * dt);
    o.x += (dx / d) * st; o.z += (dz / d) * st;
    o.e.setPosition(o.x, 0.03 + groundAt(o.x, o.z) + Math.abs(Math.sin(this.blink * 9)) * 0.04, o.z);
    o.e.setEulerAngles(0, (Math.atan2(-dx, -dz) * 180) / Math.PI, 0);
    o.arm.setLocalEulerAngles(Math.sin(this.blink * 9) * 25, 0, 0);
    return false;
  }

  /** Paper spot-fine ticket, filled in line by line while the officer writes. */
  private showTicket(s: Stop, progress: number, stamp?: string) {
    s.no ??= String(100000 + Math.floor(Math.random() * 899999));
    s.officerNo ??= `PC ${40000 + Math.floor(Math.random() * 9999)}`;
    const total = s.offences.reduce((a, o) => a + FINES[o], 0);
    const lines = [
      'TRAFFIC POLICE — SPOT FINE', `Notice No. ${s.no}`, new Date().toLocaleString(), '',
      ...s.offences.map(o => `${o.padEnd(24)} Rs ${FINES[o].toLocaleString()}`), '',
      `TOTAL ${' '.repeat(18)} Rs ${total.toLocaleString()}`, `Officer: ${s.officerNo}  ✍`,
    ];
    const n = Math.ceil(lines.length * Math.min(1, progress));
    this.ticket.textContent = lines.slice(0, Math.max(1, n)).join('\n') + (stamp ? `\n\n[ ${stamp} ]` : '');
    this.ticket.style.display = 'block';
  }

  /** Crossed a stop line (in its direction of travel) while it showed red. */
  private ranRed() {
    const c = this.car, p = this.prev;
    for (const list of this.map.stops.values()) for (const st of list) {
      if (Math.abs(st.x - c.x) > 30 || Math.abs(st.z - c.z) > 30) continue;
      const before = (p.x - st.x) * st.ux + (p.z - st.z) * st.uz, after = (c.x - st.x) * st.ux + (c.z - st.z) * st.uz;
      if (!(before < 0 && after >= 0)) continue;
      const lat = Math.abs((c.x - st.x) * st.uz - (c.z - st.z) * st.ux);
      if (lat <= st.hw + 1 && this.map.signals.aspect(st.group) === 'red') return true;
    }
    return false;
  }

  /** A hidden officer with line of sight, or a patrol car, close enough to see you. */
  private witnessed() {
    const c = this.car;
    for (const o of this.officers)
      if (Math.hypot(o.x - c.x, o.z - c.z) < OFFICER_SIGHT && this.map.collision.raycast(o.x, o.z, c.x, c.z) >= 1) return true;
    return this.traffic.vehicles.some(v => v.police && Math.hypot(v.x - c.x, v.z - c.z) < CAR_SIGHT);
  }

  /** Keep a few officers 80–400 m away, standing just off the kerb (where the trees and poles are). */
  private manageOfficers() {
    const c = this.car;
    this.officers = this.officers.filter(o => Math.hypot(o.x - c.x, o.z - c.z) < 450 || (o.e.destroy(), false));
    if (this.officers.length >= OFFICERS) return;
    const roads = [...this.map.roads.roads()].filter(r => r.w >= 5 && r.h !== 'service');
    for (let tries = 0; tries < 20; tries++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      if (!r) return;
      const pt = pointOn(r, Math.random()), d = Math.hypot(pt.x - c.x, pt.z - c.z);
      if (d < 80 || d > 400) continue;
      const s = Math.random() < 0.7 ? 1 : -1, off = r.w / 2 + 2.6;   // mostly on the left kerb
      const x = pt.x + pt.uz * off * s, z = pt.z - pt.ux * off * s;
      if (this.map.collision.raycast(pt.x, pt.z, x, z) < 1) continue; // would be inside a building
      this.officers.push({ e: this.officer(x, z, -pt.uz * s, pt.ux * s).e, x, z });
      return;
    }
  }

  /** Traffic officer in khaki with white cap and gauntlets (people/Human); right arm is animated by the scene. */
  private officer(x: number, z: number, fx: number, fz: number) {
    const h = makeHuman(this.app, 'police');
    face(h, x, z, fx, fz);
    this.app.root.addChild(h.root);
    return { e: h.root, arm: h.rArm };
  }
}

interface Stop {
  offences: Offence[]; stage: 'chase' | 'walk' | 'write' | 'leave'; t: number; still: number;
  pc: { e: pc.Entity; x: number; z: number; yaw: number; v: number };
  route: { x: number; z: number }[];
  officer?: { e: pc.Entity; arm: pc.Entity; x: number; z: number };
  no?: string; officerNo?: string; fled?: boolean;
}
