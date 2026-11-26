import * as pc from 'playcanvas';
import type { CollisionWorld } from '../map/CollisionWorld';
import { CATALOG } from '../traffic/VehicleCatalog';
import { ModelCache } from '../traffic/VehicleModels';
import { GARAGE, type GarageKey, type VehicleConfig } from '../vehicle/VehicleConfig';
import { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { IMPORTED, glbEntity } from '../vehicle/ImportedModels';
import { playableStops, type MetroRoute } from '../game/modes/MetroBusMode';

// Start lobby: garage (3D turntable on the real street behind the UI, stats, paint), mode tiles, multiplayer room
// peek. Keyboard: ←/→ vehicle, Enter start.

export type LobbyChoice = ({ mode: 'free' | 'taxi'; room?: string } | { mode: 'metro'; route: MetroRoute }) & { vehicle: GarageKey; color: [number, number, number] };

const KEYS = Object.keys(GARAGE) as GarageKey[];
const BLURB: Record<GarageKey, string> = {
  muscle: 'V8 muscle coupe. Rear-wheel drive, mind the throttle.',
  car: 'Axio-class hybrid sedan. The all-rounder.', motorcycle: '150 cc commuter. Splits traffic, leans hard.',
  tuktuk: 'Bajaj-style three-wheeler. King of Colombo streets.', van: 'HiAce-class diesel. Torque for days.', bus: '10.5 m city bus. Everyone moves out of the way.',
};
const PAINT: [string, [number, number, number]][] = [
  ['Pearl', [0.93, 0.93, 0.92]], ['Silver', [0.72, 0.74, 0.76]], ['Midnight', [0.06, 0.06, 0.07]], ['Racing red', [0.75, 0.05, 0.08]],
  ['Sunset orange', [1, 0.35, 0.12]], ['Taxi yellow', [0.95, 0.72, 0.08]], ['Lagoon teal', [0.05, 0.55, 0.6]], ['Royal blue', [0.1, 0.22, 0.6]],
];
const MODES = [
  { id: 'free', title: 'Free roam', sub: 'Explore Colombo at your own pace' },
  { id: 'taxi', title: 'Taxi', sub: 'Pick up fares, drop them at real places' },
  { id: 'metro', title: 'Metro bus', sub: 'Drive a real Lanka Metro route' },
  { id: 'multi', title: 'Multiplayer', sub: 'Ride with friends · race · tag' },
] as const;

/** Real numbers from the physics: flat-road full-throttle run (top speed, 0-60 km/h) for each garage vehicle. */
function measure(cfg: VehicleConfig) {
  const p = new VehiclePhysics(cfg), dt = 1 / 30, input = { throttle: 1, brake: 0, steer: 0, handbrake: false, horn: false } as never;
  p.reset(0, 0, 0);
  let t60 = 99;
  for (let t = 0; t < 45; t += dt) { p.step(dt, input, null); if (t60 === 99 && p.forwardSpeed * 3.6 >= 60) t60 = t; }
  return { top: p.forwardSpeed * 3.6, t60, grip: cfg.mu * Math.min(1, cfg.corneringStiffness / cfg.mass / 60) * (1 + cfg.maxSteer), mass: cfg.mass };
}

export async function showLobby(app: pc.AppBase, camera: pc.Entity, at: { x: number; y: number; z: number; yaw: number }, routes: MetroRoute[], walls?: CollisionWorld): Promise<LobbyChoice> {
  const stats = Object.fromEntries(KEYS.map(k => [k, measure(GARAGE[k])])) as Record<GarageKey, ReturnType<typeof measure>>;
  const max = { top: Math.max(...KEYS.map(k => stats[k].top)), grip: Math.max(...KEYS.map(k => stats[k].grip)) };
  let vi = Math.max(0, KEYS.indexOf((localStorage.getItem('cmb-rider-vehicle') ?? 'car') as GarageKey));
  let paint = Number(localStorage.getItem('cmb-rider-paint') ?? -1);  // -1 = the vehicle's stock colour
  let mode: (typeof MODES)[number]['id'] = (localStorage.getItem('cmb-rider-mode') as never) ?? 'free';
  if (!MODES.some(m => m.id === mode)) mode = 'free';

  // --- DOM ---------------------------------------------------------------------------------------------
  const root = document.createElement('div');
  root.className = 'lobby';
  root.innerHTML = `
    <aside class="lobby-side">
      <h1>CMB<span>RIDER</span></h1>
      <section class="garage">
        <span class="lb-label">GARAGE</span>
        <div class="veh-row"><button class="arrow" data-d="-1" aria-label="Previous vehicle">‹</button>
          <div><b class="veh-name"></b><small class="veh-blurb"></small></div>
          <button class="arrow" data-d="1" aria-label="Next vehicle">›</button></div>
        <div class="stats"></div>
        <div class="paint" role="radiogroup" aria-label="Paint"></div>
      </section>
      <section><span class="lb-label">GAME MODE</span><div class="modes"></div><div class="mode-opts"></div></section>
      <button class="go">START <span>▶</span></button>
    </aside>
    <div class="lobby-hint">← → vehicle · drag to spin · Enter to start</div>`;
  document.body.append(root);
  document.getElementById('loading')!.hidden = true;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;

  const routeSel = document.createElement('select');
  for (const r of routes) {
    const n = playableStops(r).length, o = document.createElement('option');
    o.value = r.code; o.textContent = `${r.code} · ${r.name} (${n} stops)`; o.disabled = n < 2; o.selected = r.code === 'CM06';
    routeSel.append(o);
  }
  const roomIn = Object.assign(document.createElement('input'), { placeholder: 'Room name (share it with friends)', maxLength: 24, value: localStorage.getItem('cmb-rider-room') ?? '' });
  const nameIn = Object.assign(document.createElement('input'), { placeholder: 'Your rider name', maxLength: 16, value: localStorage.getItem('cmb-rider-name') ?? '' });
  const riders = document.createElement('div'); riders.className = 'riders';

  // --- 3D turntable on the street ----------------------------------------------------------------------
  const models = new ModelCache(app.graphicsDevice);
  let car: pc.Entity | null = null, spin = 0, orbit = 0.6, drag = false;
  const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
  const down = () => (drag = true), up = () => (drag = false), move = (e: MouseEvent) => { if (drag) orbit -= e.movementX * 0.01; };
  canvas.addEventListener('mousedown', down); window.addEventListener('mouseup', up); window.addEventListener('mousemove', move);
  const cfgOf = () => GARAGE[KEYS[vi]], colorOf = (): [number, number, number] => (paint >= 0 ? PAINT[paint][1] : cfgOf().color);
  const rebuild = () => {
    car?.destroy();
    const c = cfgOf(), [r, g, b] = colorOf(), hex = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
    const spec = { ...CATALOG.find(s => s.id === (c.model ?? 'sedan'))!, length: c.length, width: c.width, height: c.height };
    const imp = IMPORTED[c.model ?? ''];
    car = imp ? new pc.Entity('showroom') : models.entity(spec, { color: hex, accent: c.accent, rider: 0x2a3a5a, helmet: 0x151515 }).root;
    car.setPosition(at.x, at.y, at.z);
    app.root.addChild(car);
    if (imp) {
      car.addChild(glbEntity(app, imp.file, imp.yaw, imp.paint ? [r, g, b] : undefined));
      if (imp.wheel) for (const z of [-c.cgToFront, c.cgToRear]) for (const x of [-1, 1]) {
        const w = new pc.Entity(); car.addChild(w);
        w.setLocalPosition(x * c.trackWidth / 2, c.wheelRadius, z); w.setLocalScale(x, 1, 1);
        w.addChild(glbEntity(app, imp.wheel));
      }
    }
  };
  const frame = (dt: number) => {
    if (!car) return;
    if (!drag) orbit += dt * 0.25;
    spin += dt;
    const L = cfgOf().length, d = 4 + L * 0.9, h = 1.2 + L * 0.12;
    // Never orbit through a wall: pull in to just short of the first one, and rise to keep the vehicle in view.
    const cx = at.x + Math.sin(orbit) * d, cz = at.z + Math.cos(orbit) * d, t = walls?.raycast(at.x, at.z, cx, cz) ?? 1;
    const k = t < 1 ? Math.max(0.35, t - 0.08) : 1;
    camera.setPosition(at.x + (cx - at.x) * k, at.y + h + (1 - k) * 4, at.z + (cz - at.z) * k);
    // Aim left of the car so it sits in the open area right of the side panel.
    const rx = Math.cos(orbit), rz = -Math.sin(orbit), off = innerWidth > 800 ? -L * 0.35 : 0;
    camera.lookAt(at.x + rx * off, at.y + 0.8, at.z + rz * off);
    car.setEulerAngles(0, (at.yaw * 180) / Math.PI, 0);
  };
  app.on('update', frame);

  // --- rendering the panel -----------------------------------------------------------------------------
  const bar = (label: string, frac: number, value: string) => `<div class="stat"><span>${label}</span><i style="--f:${Math.max(0.05, Math.min(1, frac))}"></i><em>${value}</em></div>`;
  const renderGarage = () => {
    const k = KEYS[vi], s = stats[k], c = GARAGE[k];
    $('.veh-name').textContent = c.name;
    $('.veh-blurb').textContent = BLURB[k];
    $('.stats').innerHTML = bar('TOP SPEED', s.top / max.top, `${Math.round(s.top)} km/h`)
      + bar('ACCELERATION', s.t60 >= 99 ? 0.05 : 1 - Math.min(0.95, (s.t60 - 2) / 30), s.t60 >= 99 ? '—' : `0-60 ${s.t60.toFixed(1)} s`)
      + bar('HANDLING', s.grip / max.grip, `${Math.round((s.grip / max.grip) * 10)}/10`)
      + bar('WEIGHT', Math.log10(s.mass) / Math.log10(11000), `${s.mass.toLocaleString()} kg`);
    $('.paint').innerHTML = [['Stock', c.color] as [string, [number, number, number]], ...PAINT].map(([n, [r, g, b]], i) =>
      `<button role="radio" aria-checked="${paint === i - 1}" title="${n}" aria-label="${n}" data-p="${i - 1}" style="--c:rgb(${r * 255},${g * 255},${b * 255})"></button>`).join('');
    rebuild();
  };
  const renderModes = () => {
    $('.modes').innerHTML = MODES.map(m => `<button class="tile${m.id === mode ? ' on' : ''}" data-m="${m.id}" ${m.id === 'metro' && !routes.length ? 'disabled' : ''}><b>${m.title}</b><small>${m.sub}</small></button>`).join('');
    const opts = $('.mode-opts');
    opts.replaceChildren(...(mode === 'metro' ? [routeSel] : mode === 'multi' ? [roomIn, nameIn, riders] : []));
    if (mode === 'metro') { vi = KEYS.indexOf('bus'); renderGarage(); }
  };
  root.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.d) { vi = (vi + Number(b.dataset.d) + KEYS.length) % KEYS.length; renderGarage(); }
    if (b.dataset.p) { paint = Number(b.dataset.p); renderGarage(); }
    if (b.dataset.m) { mode = b.dataset.m as never; renderModes(); }
  });

  // Live "who's in this room" while the multiplayer tile is open.
  let peekWs: WebSocket | null = null;
  const peek = () => {
    if (mode !== 'multi') return;
    const room = roomIn.value.trim() || 'colombo';
    if (peekWs?.readyState !== WebSocket.OPEN) {
      if (!peekWs || peekWs.readyState === WebSocket.CLOSED) {
        peekWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/mp`);
        peekWs.onmessage = m => {
          const r = JSON.parse(m.data) as { players?: { name: string; model: string }[] };
          if (!r.players) return;
          riders.innerHTML = r.players.length
            ? `<span class="live">● ${r.players.length} riding in “${room}”</span>` + r.players.map(p => `<span class="rider">${p.name.replace(/[<&]/g, '')} <small>${p.model}</small></span>`).join('')
            : `<span class="empty">Room “${room}” is empty. Start it and share the name.</span>`;
        };
        peekWs.onopen = peek;
        peekWs.onerror = () => { riders.innerHTML = '<span class="empty">Multiplayer server offline (npm run backend)</span>'; };
      }
      return;
    }
    peekWs.send(JSON.stringify({ room, id: 'lobby-peek', peek: true }));
  };
  const peekTimer = setInterval(peek, 1500);
  roomIn.addEventListener('input', () => setTimeout(peek, 50));

  renderGarage(); renderModes();
  return new Promise(resolve => {
    const start = () => {
      const k = KEYS[vi], color = colorOf();
      localStorage.setItem('cmb-rider-vehicle', k); localStorage.setItem('cmb-rider-paint', String(paint)); localStorage.setItem('cmb-rider-mode', mode);
      const room = roomIn.value.trim() || 'colombo';
      if (mode === 'multi') { localStorage.setItem('cmb-rider-room', room); if (nameIn.value.trim()) localStorage.setItem('cmb-rider-name', nameIn.value.trim()); }
      // Tear down the lobby.
      clearInterval(peekTimer); peekWs?.close(); app.off('update', frame); car?.destroy(); root.remove();
      canvas.removeEventListener('mousedown', down); window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move); window.removeEventListener('keydown', key);
      document.getElementById('loading')!.hidden = false;
      const route = routes.find(r => r.code === routeSel.value);
      if (mode === 'metro' && route) return resolve({ mode: 'metro', route, vehicle: 'bus', color });
      resolve({ mode: mode === 'taxi' ? 'taxi' : 'free', room: mode === 'multi' ? room : undefined, vehicle: k, color });
    };
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) { if (e.key === 'Enter') start(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { vi = (vi + (e.key === 'ArrowLeft' ? -1 : 1) + KEYS.length) % KEYS.length; renderGarage(); }
      if (e.key === 'Enter') start();
    };
    window.addEventListener('keydown', key);
    $('.go').onclick = start;
  });
}
