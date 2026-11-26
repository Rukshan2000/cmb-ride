import * as pc from 'playcanvas';
import { CATALOG } from '../../traffic/VehicleCatalog';
import { ModelCache } from '../../traffic/VehicleModels';
import type { VehiclePhysics } from '../../vehicle/VehiclePhysics';
import type { MapChunkManager } from '../../map/MapChunkManager';
import type { ModeHUD } from './ModeHUD';
import { IMPORTED, glbEntity } from '../../vehicle/ImportedModels';
import { GARAGE } from '../../vehicle/VehicleConfig';
import type { Sound, HornKind } from '../../audio/Sound';
import type { Wallet } from '../Wallet';

// Shared rooms (backend /api/mp over a WebSocket, 20 Hz): see each other drive, plus room events.
//   Y = race from here (to your navigation destination if one is set) · U = start tag (you're "it") · X = stop the event
//   B = choose the race stake · K = match the stake during the countdown

interface Remote { id: string; name: string; model: string; color: number; x: number; y: number; z: number; yaw: number; v: number; cp: number; horn: boolean; hornId: string }
type Ev = { id: number; kind: 'race'; cps: [number, number][]; start: number; results: { id: string; name: string; ms: number }[]; name: string; yaw?: number; bet: number; bettors: string[]; winner?: string }
  | { id: number; kind: 'tag'; it: string; since: number; tags: number; end: number } | null;
interface Shown { e: pc.Entity; label: HTMLDivElement; tx: number; ty: number; tz: number; yaw: number; data: Remote }

const CP_RADIUS = 14;
const BETS = [0, 500, 1000, 5000];
const HORN_FOR: Record<string, HornKind> = { motorcycle: 'disc', tuktuk: 'disc', bus: 'bus', van: 'bus' };

/** What the room needs from the rest of the game. */
export interface MpGame {
  sound: Sound; wallet: Wallet;
  horn: () => boolean;
  destination: () => { name: string; x: number; z: number } | null;
  navigate: (name: string, x: number, z: number) => void;
}

export class Multiplayer {
  private id = Math.random().toString(36).slice(2, 10);
  private others = new Map<string, Shown>();
  private models: ModelCache;
  private event: Ev = null;
  private clockSkew = 0;            // server now - local now
  private cp = 0;                   // race: checkpoints reached (start counts)
  private grid?: [number, number, number];
  private beacon: pc.Entity;
  private itMarker: pc.Entity;
  private action?: Record<string, unknown>;
  private ws?: WebSocket;
  private wasDown = false;
  private lastEventId = 0;
  private full = false;
  private bet = 0;                  // stake for the next race I start
  private staked = 0;               // money already in the current pot
  private hornClip?: ArrayBuffer;
  private hornId = '';

  constructor(private app: pc.AppBase, private camera: pc.Entity, private p: VehiclePhysics, private map: MapChunkManager,
    private hud: ModeHUD, readonly room: string, private name: string, private model: string, private color: number, private game: MpGame) {
    this.models = new ModelCache(app.graphicsDevice);
    const glow = (c: pc.Color) => { const m = new pc.StandardMaterial(); m.emissive = c; m.emissiveIntensity = 2; m.opacity = 0.4; m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false; m.useLighting = false; m.update(); return m; };
    this.beacon = new pc.Entity('race checkpoint');
    this.beacon.addComponent('render', { type: 'cylinder', material: glow(new pc.Color(0.2, 0.9, 1)), castShadows: false });
    this.beacon.setLocalScale(CP_RADIUS * 1.2, 60, CP_RADIUS * 1.2);
    this.beacon.enabled = false;
    this.itMarker = new pc.Entity('tag it');
    this.itMarker.addComponent('render', { type: 'cone', material: glow(new pc.Color(1, 0.1, 0.1)), castShadows: false });
    this.itMarker.setLocalScale(1.5, -2, 1.5); // point down
    this.itMarker.enabled = false;
    app.root.addChild(this.beacon); app.root.addChild(this.itMarker);
    hud.show(`ROOM · ${room}`, '#2ad4ff');
    hud.toast(`Joined room "${room}". Share it: ${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`, 8000);
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyY') this.startRace();
      if (e.code === 'KeyB') { this.bet = BETS[(BETS.indexOf(this.bet) + 1) % BETS.length]; this.hud.toast(this.bet ? `Race stake: Rs ${this.bet}` : 'Race stake: none', 2000); }
      if (e.code === 'KeyK') this.joinBet();
      if (e.code === 'KeyU') this.action = { action: 'tag' };
      if (e.code === 'KeyX') this.action = { action: 'stop' };
    });
    this.connect();
    setInterval(() => this.send(), 50);
  }

  private get now() { return Date.now() + this.clockSkew; }

  private startRace() {
    if (this.bet > this.game.wallet.data.money) return this.hud.toast(`You can't cover a Rs ${this.bet} stake.`, 3000);
    const d = this.game.destination();
    this.action = d
      ? { action: 'race', cps: [[this.p.x, this.p.z], [Math.round(d.x), Math.round(d.z)]], dest: d.name, gridYaw: this.p.yaw, bet: this.bet }
      : { action: 'race', cps: this.raceRoute(), bet: this.bet };
  }

  private joinBet() {
    const ev = this.event;
    if (ev?.kind !== 'race' || !ev.bet || this.now >= ev.start || ev.bettors.includes(this.id)) return;
    if (ev.bet > this.game.wallet.data.money) return this.hud.toast(`You can't cover the Rs ${ev.bet} stake.`, 3000);
    this.action = { action: 'bet' };
  }

  /** Money follows the server's bettor list: pay in when listed, pot to the winner, refund if the race dies first. */
  private settle(ev: Ev) {
    const old = this.event;
    if (this.staked && old?.kind === 'race' && ev?.id !== old.id) { // stopped or replaced with no winner
      this.game.wallet.pay(this.staked, 'Bet refund'); this.staked = 0;
      this.hud.toast('Race cancelled: stake refunded.', 3000);
    }
    if (ev?.kind !== 'race') return;
    const seen = old?.kind === 'race' && old.id === ev.id ? old : null;
    if (ev.bettors.includes(this.id) && !seen?.bettors.includes(this.id)) {
      this.staked = ev.bet; this.game.wallet.pay(-ev.bet, 'Race bet');
    }
    if (ev.winner && !seen?.winner) {
      const pot = ev.bet * ev.bettors.length;
      if (ev.winner === this.id) this.game.wallet.pay(pot, 'Race pot');
      this.staked = 0;
      this.hud.toast(`💰 ${this.nameOf(ev.winner)} took the Rs ${pot} pot`, 5000);
    }
  }

  /** My custom horn (undefined = stock): uploaded so others can hear it. */
  setHorn(clip?: ArrayBuffer) { this.hornClip = clip; this.hornId = ''; void this.uploadHorn(); }

  private async uploadHorn() {
    const clip = this.hornClip;
    if (!clip) return;
    try {
      const r = await fetch('/api/horn', { method: 'POST', body: clip });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { id } = await r.json() as { id: string };
      if (this.hornClip === clip) this.hornId = id;
    } catch { this.hud.toast("Couldn't share your horn: others hear the stock one.", 4000); }
  }

  /** Start + 6 checkpoints ~300 m apart, wandering from where you face; snapped to roads that are loaded. */
  private raceRoute(): [number, number][] {
    let x = this.p.x, z = this.p.z, h = this.p.yaw;
    const cps: [number, number][] = [[x, z]];
    for (let i = 0; i < 6; i++) {
      h += (Math.random() - 0.5) * 1.6;
      x -= Math.sin(h) * 300; z -= Math.cos(h) * 300;
      const r = this.map.roads.nearest(x, z);
      if (r && Math.hypot(r.x - x, r.z - z) < 120) { x = r.x; z = r.z; }
      cps.push([Math.round(x), Math.round(z)]);
    }
    return cps;
  }

  /** Open the room socket; on drop, reconnect with backoff (server also forgets us at once on close). */
  private connect(delay = 500) {
    const ws = (this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/mp`));
    ws.onopen = () => { void this.uploadHorn(); if (this.wasDown) this.hud.toast('Reconnected to room.', 3000); this.wasDown = false; delay = 500; };
    ws.onmessage = m => {
      const r = JSON.parse(m.data) as { now?: number; players?: Remote[]; event?: Ev; full?: boolean };
      if (r.full) { this.full = true; this.hud.toast(`Room "${this.room}" is full (10 riders). Pick another room.`, 10000); return ws.close(); }
      if (!r.players) return;
      this.clockSkew = r.now! - Date.now();
      this.apply(r.players);
      this.setEvent(r.event ?? null);
    };
    ws.onclose = () => {
      if (this.full) return;
      if (!this.wasDown) this.hud.toast('Lost connection to the multiplayer server (is `npm run backend` running?)', 6000);
      this.wasDown = true;
      setTimeout(() => this.connect(Math.min(delay * 2, 8000)), delay);
    };
  }

  private send() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const p = this.p, ev = this.event;
    this.ws.send(JSON.stringify({ room: this.room, id: this.id, name: this.name, model: this.model, color: this.color, x: p.x, y: p.y, z: p.z, yaw: p.yaw, v: p.forwardSpeed, cp: this.cp, horn: this.game.horn(), hornId: this.hornId,
      finished: ev?.kind === 'race' && this.cp >= ev.cps.length, ...this.action }));
    this.action = undefined;
  }

  private apply(list: Remote[]) {
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      let s = this.others.get(r.id);
      if (s && (s.data.model !== r.model || s.data.color !== r.color)) { s.e.destroy(); s.label.remove(); this.others.delete(r.id); s = undefined; }
      if (!s) {
        const spec = CATALOG.find(c => c.id === r.model) ?? CATALOG.find(c => c.id === 'sedan')!;
        const imp = IMPORTED[r.model];
        const root = imp ? new pc.Entity(r.model) : this.models.entity(spec, { color: r.color, rider: 0x2a3a5a, helmet: 0x151515 }).root;
        this.app.root.addChild(root);
        if (imp) {
          const rgb: [number, number, number] = [((r.color >> 16) & 255) / 255, ((r.color >> 8) & 255) / 255, (r.color & 255) / 255];
          root.addChild(glbEntity(this.app, imp.file, imp.yaw, imp.paint ? rgb : undefined));
          const g = Object.values(GARAGE).find(v => v.model === r.model)!;
          if (imp.wheel) for (const z of [-g.cgToFront, g.cgToRear]) for (const x of [-1, 1]) {
            const w = new pc.Entity(); root.addChild(w);
            w.setLocalPosition(x * g.trackWidth / 2, g.wheelRadius, z); w.setLocalScale(x, 1, 1);
            w.addChild(glbEntity(this.app, imp.wheel));
          }
        }
        root.setPosition(r.x, r.y, r.z);
        const label = document.createElement('div');
        label.style.cssText = 'position:fixed;pointer-events:none;font:600 12px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:2px 7px;border-radius:9px;transform:translate(-50%,-100%);white-space:nowrap;z-index:5';
        document.body.append(label);
        s = { e: root, label, tx: r.x, ty: r.y, tz: r.z, yaw: r.yaw, data: r };
        this.others.set(r.id, s);
        this.hud.toast(`${r.name} joined the room`, 3000);
      }
      Object.assign(s, { tx: r.x, ty: r.y, tz: r.z, yaw: r.yaw, data: r });
      s.label.textContent = r.name;
    }
    for (const [id, s] of this.others) if (!seen.has(id)) { this.game.sound.remoteHorn(id, false, 0, 0, 'car'); this.hud.toast(`${s.data.name} left`, 3000); s.e.destroy(); s.label.remove(); this.others.delete(id); }
  }

  private setEvent(ev: Ev) {
    this.settle(ev);
    if (ev?.id !== this.lastEventId) {
      this.lastEventId = ev?.id ?? 0;
      this.grid = undefined;
      if (ev?.kind === 'race') {
        // Grid slot by sorted id, side by side behind the start line, facing the first checkpoint.
        const ids = [this.id, ...this.others.keys()].sort(), slot = ids.indexOf(this.id);
        const [sx, sz] = ev.cps[0], [nx, nz] = ev.cps[1], yaw = ev.yaw ?? Math.atan2(-(nx - sx), -(nz - sz));
        const off = (slot % 2 ? 1 : -1) * 2.5, back = Math.floor(slot / 2) * 7;
        this.grid = [sx + Math.cos(yaw) * off + Math.sin(yaw) * back, sz - Math.sin(yaw) * off + Math.cos(yaw) * back, yaw];
        this.cp = 1;
        if (ev.name) this.game.navigate(ev.name, nx, nz);
        this.hud.toast(`🏁 Race${ev.name ? ` to ${ev.name}` : ': follow the blue beacons'}!${ev.bet ? ` Stake Rs ${ev.bet}: press K to bet.` : ''}`, 6000);
      } else if (ev?.kind === 'tag') this.hud.toast(`🔴 Tag! ${this.nameOf(ev.it)} is IT. Don't get touched!`, 5000);
      else this.hud.toast('Event over. Free roam.', 3000);
    }
    if (ev?.kind === 'race' && this.event?.kind === 'race' && ev.results.length > this.event.results.length)
      for (const r of ev.results.slice(this.event.results.length)) this.hud.toast(`🏆 #${ev.results.indexOf(r) + 1} ${r.name}: ${(r.ms / 1000).toFixed(1)} s`, 5000);
    if (ev?.kind === 'tag' && this.event?.kind === 'tag' && ev.it !== this.event.it) this.hud.toast(ev.it === this.id ? '🔴 You are IT! Catch someone.' : `${this.nameOf(ev.it)} is IT now`, 3000);
    this.event = ev;
  }

  /**
   * Bump into other players: my car as three circles vs their box (same model as TrafficManager.collidePlayer).
   * Each client resolves only its own car; the other side does the mirror image, so both react.
   */
  private collide() {
    const P = this.p, c = P.cfg, R = c.width / 2, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), span = c.length / 2 - R;
    for (const s of this.others.values()) {
      const spec = CATALOG.find(k => k.id === s.data.model) ?? CATALOG[3], pos = s.e.getPosition();
      if (Math.abs(P.y - pos.y) > 2.5 || Math.hypot(P.x - pos.x, P.z - pos.z) > c.length + spec.length) continue;
      const yaw = s.e.getEulerAngles().y * Math.PI / 180, ux = -Math.sin(yaw), uz = -Math.cos(yaw), lx = uz, lz = -ux;
      const vx = ux * s.data.v, vz = uz * s.data.v;
      for (const o of [-span, 0, span]) {
        const px = P.x + fx * o, pz = P.z + fz * o, dx = px - pos.x, dz = pz - pos.z;
        const ca = Math.max(-spec.length / 2, Math.min(spec.length / 2, dx * ux + dz * uz)), cl = Math.max(-spec.width / 2, Math.min(spec.width / 2, dx * lx + dz * lz));
        const ox = dx - (ux * ca + lx * cl), oz = dz - (uz * ca + lz * cl), d = Math.hypot(ox, oz);
        if (d >= R) continue;
        const nx = d > 1e-3 ? ox / d : -ux, nz = d > 1e-3 ? oz / d : -uz;
        const share = spec.mass / (spec.mass + c.mass);              // heavier vehicle wins the shove
        P.x += nx * (R - d) * share; P.z += nz * (R - d) * share;
        const rx = px - nx * R - P.x, rz = pz - nz * R - P.z;
        const rel = (P.vx + P.omega * rz - vx) * nx + (P.vz - P.omega * rx - vz) * nz;
        if (rel >= 0) continue;
        const e = 0.3 / (1 + -rel / 4), rn = rz * nx - rx * nz;
        const j = (-(1 + e) * rel) / (1 / c.mass + 1 / spec.mass + (rn * rn) / c.inertia);
        P.applyImpulse(j * nx, j * nz, rx, rz);
        P.impact = Math.max(P.impact, -rel);
      }
    }
  }

  /** Other riders for the minimap / nav map. */
  friends() {
    return [...this.others.values()].map(s => { const p = s.e.getPosition(); return { id: s.data.id, name: s.data.name, x: p.x, z: p.z, color: `#${s.data.color.toString(16).padStart(6, '0')}` }; });
  }

  private nameOf(id: string) { return id === this.id ? 'You' : this.others.get(id)?.data.name ?? '?'; }

  update(dt: number) {
    const k = Math.min(1, dt * 15), w = this.app.graphicsDevice.width / this.app.graphicsDevice.maxPixelRatio, h = this.app.graphicsDevice.height / this.app.graphicsDevice.maxPixelRatio;
    const cam = this.camera.camera!, sp = new pc.Vec3();
    for (const s of this.others.values()) {
      const pos = s.e.getPosition();
      s.e.setPosition(pos.x + (s.tx - pos.x) * k, pos.y + (s.ty - pos.y) * k, pos.z + (s.tz - pos.z) * k);
      const cur = s.e.getEulerAngles().y * Math.PI / 180;
      let d = s.yaw - cur; d = Math.atan2(Math.sin(d), Math.cos(d));
      s.e.setEulerAngles(0, (cur + d * k) * 180 / Math.PI, 0);
      cam.worldToScreen(new pc.Vec3(pos.x, pos.y + 3, pos.z), sp, w, h);
      const far = Math.hypot(pos.x - this.p.x, pos.z - this.p.z);
      s.label.style.display = sp.z > 0 && far < 400 ? '' : 'none';
      this.game.sound.remoteHorn(s.data.id, s.data.horn, pos.x, pos.z, HORN_FOR[s.data.model] ?? 'car', s.data.hornId);
      s.label.style.left = `${(sp.x / w) * innerWidth}px`; s.label.style.top = `${(sp.y / h) * innerHeight}px`;
    }
    this.collide();
    this.itMarker.enabled = false; this.beacon.enabled = false;
    const ev = this.event, now = this.now, players = this.others.size + 1;
    if (!ev) { this.hud.set(`${players} in room`, 'Free roam', `Y race (set a destination to race there) · B stake Rs ${this.bet} · U tag · H horn`); return; }
    if (ev.kind === 'race') {
      if (now < ev.start && this.grid) { this.p.reset(...this.grid); this.hud.set(`Race starts in ${Math.ceil((ev.start - now) / 1000)}`, ev.bet ? `Pot Rs ${ev.bet * ev.bettors.length} · ${ev.bettors.includes(this.id) ? "you're in" : `K to bet Rs ${ev.bet}`}` : `${ev.cps.length - 1} checkpoints`, 'X cancels'); return; }
      const done = this.cp >= ev.cps.length;
      if (!done) {
        const [cx, cz] = ev.cps[this.cp];
        this.beacon.enabled = true;
        this.beacon.setPosition(cx, 30, cz);
        if (Math.hypot(this.p.x - cx, this.p.z - cz) < CP_RADIUS) { this.cp++; this.hud.toast(this.cp >= ev.cps.length ? '🏁 Finished!' : `Checkpoint ${this.cp - 1}/${ev.cps.length - 1}`, 1500); }
      }
      // Live position: more checkpoints first, then closer to the next one.
      const next = (cp: number) => ev.cps[Math.min(cp, ev.cps.length - 1)];
      const rank = [{ id: this.id, cp: this.cp, x: this.p.x, z: this.p.z }, ...[...this.others.values()].map(s => s.data)]
        .map(r => ({ id: r.id, cp: r.cp, d: Math.hypot(r.x - next(r.cp)[0], r.z - next(r.cp)[1]) }))
        .sort((a, b) => b.cp - a.cp || a.d - b.d).findIndex(r => r.id === this.id) + 1;
      const t = ((now - ev.start) / 1000).toFixed(1);
      const board = ev.results.map((r, i) => `${i + 1}. ${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(' · ');
      this.hud.set(done ? 'Finished!' : `Position ${rank}/${players} · CP ${this.cp - 1}/${ev.cps.length - 1}`, board || `${t} s`, 'X ends the race');
    } else {
      const it = ev.it === this.id ? { x: this.p.x, y: this.p.y, z: this.p.z } : this.others.get(ev.it)?.e.getPosition();
      if (it) { this.itMarker.enabled = true; this.itMarker.setPosition(it.x, it.y + 4.5 + Math.sin(now / 200) * 0.3, it.z); }
      const left = Math.max(0, Math.ceil((ev.end - now) / 1000));
      this.hud.set(ev.it === this.id ? '🔴 You are IT' : `${this.nameOf(ev.it)} is IT`, `${ev.tags} tags · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`, now < ev.since ? 'Immunity…' : 'X ends tag');
    }
  }
}
