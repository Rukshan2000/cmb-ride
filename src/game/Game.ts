import * as pc from 'playcanvas';
import { CameraController } from '../camera/CameraController';
import { InputManager } from '../input/InputManager';
import { MapChunkManager } from '../map/MapChunkManager';
import { StaticChunkProvider } from '../map/MapLoader';
import { project, unproject } from '../map/MapProjection';
import { GeometryBuffer, vertexColorMaterial } from '../map/MeshUtil';
import { HUD } from '../ui/HUD';
import { MiniMap } from '../ui/MiniMap';
import { VehicleController } from '../vehicle/VehicleController';
import { cityBus, compactSedan } from '../vehicle/VehicleConfig';
import { ModeHUD } from './modes/ModeHUD';
import { RouteCompare } from './RouteCompare';
import { TaxiMode } from './modes/TaxiMode';
import { MetroBusMode, playableStops, type MetroRoute } from './modes/MetroBusMode';
import { GameConfig } from './GameConfig';
import { TimeOfDay } from '../roads/TimeOfDay';
import { Sky } from '../roads/Sky';
import { osrmRouter, photonGeocoder } from '../nav/GeoServices';
import { MapView } from '../nav/MapView';
import { NavigationHUD } from '../nav/NavigationHUD';
import { NavigationManager } from '../nav/NavigationManager';
import { TrafficManager } from '../traffic/TrafficManager';
import { TrafficIntelligenceService } from '../traffic/TrafficIntelligenceService';
import { TrafficDebugPanel } from '../traffic/TrafficDebugPanel';

const SKY = new pc.Color(0.62, 0.76, 0.9);

export class Game {
  private app!: pc.AppBase;
  private map!: MapChunkManager;
  private car!: VehicleController;
  private cam!: CameraController;
  private input = new InputManager();
  private hud = new HUD();
  private minimap = new MiniMap(document.getElementById('minimap') as HTMLCanvasElement);
  private paused = false;
  private streetName = '—';
  private slowTimer = 0;
  private time!: TimeOfDay;
  private nav!: NavigationManager;
  private mapView!: MapView;
  private sky!: Sky;
  private camEntity!: pc.Entity;
  private traffic!: TrafficManager;
  private trafficAI!: TrafficIntelligenceService;
  private debug?: TrafficDebugPanel;
  private mode?: { update(dt: number): void };
  private compare?: RouteCompare;
  lastSlow = '';

  async start(canvas: HTMLCanvasElement) {
    // WebGPU is opt-in (?webgpu) while the engine's WebGPU backend matures; WebGL 2 by default.
    const wantGpu = new URLSearchParams(location.search).has('webgpu');
    const device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: wantGpu ? [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2] : [pc.DEVICETYPE_WEBGL2],
      antialias: true,
    });
    const opts = new pc.AppOptions();
    opts.graphicsDevice = device;
    opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem];
    opts.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler];
    const app = (this.app = new pc.AppBase(canvas));
    app.init(opts);
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    window.addEventListener('resize', () => app.resizeCanvas());
    canvas.addEventListener('pointerdown', () => (document.activeElement as HTMLElement | null)?.blur?.());
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

    this.setupScene();
    this.map = new MapChunkManager(app, new StaticChunkProvider(GameConfig.dataUrl));
    await this.map.init();
    this.buildSea();

    // Game mode (free drive / taxi / Lanka Metro bus): menu, or ?mode=free|taxi|metro&route=CM06
    const choice = await chooseMode();
    const metroRoute = choice.mode === 'metro' ? choice.route : null;
    const metroStart = metroRoute ? playableStops(metroRoute) : [];

    // Load the chunks around the spawn point before handing over control.
    const spawn = GameConfig.spawn;
    let [sx, sz] = project(spawn.lat, spawn.lon);
    if (metroStart.length >= 2) [sx, sz] = [metroStart[0].x, metroStart[0].z];
    const initial = this.map.wanted(sx, sz).slice(0, 9);
    app.start();
    await new Promise<void>(resolve => {
      const tick = () => {
        this.map.update(sx, sz);
        const done = initial.filter(k => this.map.isLoaded(k)).length;
        this.hud.setLoading(done / initial.length);
        if (done === initial.length || (this.map.pendingCount === 0 && done > 0)) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });

    const cfg = metroRoute ? { ...cityBus, accent: parseInt(metroRoute.colour.slice(1), 16) } : compactSedan;
    this.car = new VehicleController(app, cfg);
    // ?at=lat,lon,heading: exact viewpoint, e.g. to match a reference photograph's position and bearing.
    const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
    if (at && at.length >= 2 && at.every(Number.isFinite)) { const [ax, az] = project(at[0], at[1]); this.car.physics.reset(ax, az, -((at[2] ?? 0) * Math.PI) / 180); }
    else if (metroStart.length >= 2) this.placeOnRoad(sx, sz, undefined, metroStart[1].x, metroStart[1].z);
    else this.placeOnRoad(sx, sz, spawn.road ? n => n === spawn.road : undefined);
    const camera = app.root.findByName('camera') as pc.Entity;
    this.cam = new CameraController(camera, canvas);
    this.cam.vehicleLength = cfg.length;
    this.time = new TimeOfDay(app, app.root.findByName('sun') as pc.Entity, camera, this.map.lampMat, this.sky);
    this.hud.show();
    this.mapView = new MapView(document.getElementById('navmap')!, spawn.lat, spawn.lon);
    const p = this.car.physics;
    this.traffic = new TrafficManager(app, this.map, p);
    const navHud = new NavigationHUD();
    this.trafficAI = new TrafficIntelligenceService(this.traffic,
      () => ({ road: this.streetName, timeOfDay: this.time.current, signal: this.map.signals.aspect(0) }), msg => navHud.toast(msg, 5000));
    if (import.meta.env.DEV) this.debug = new TrafficDebugPanel(this.traffic, this.trafficAI, this.map.signals, this.time, p);
    this.nav = new NavigationManager(app, navHud, this.mapView, photonGeocoder, osrmRouter, () => p, this.map.index.bounds);
    const modeHud = new ModeHUD((m, ms) => navHud.toast(m, ms));
    if (choice.mode === 'taxi') this.mode = new TaxiMode(app, this.map, this.nav, p, modeHud, () => this.traffic.lastCollision);
    if (metroRoute) this.mode = new MetroBusMode(app, metroRoute, this.nav, p, modeHud);
    const cmp = new URLSearchParams(location.search).get('compare');
    if (cmp) { this.compare = new RouteCompare(app, p, this.cam, canvas); await this.compare.init(cmp); }
    window.addEventListener('keydown', e => { if (!(e.target instanceof HTMLInputElement)) this.compare?.key(e.code); });
    app.on('update', (dt: number) => this.update(Math.min(dt, 1 / 20)));
  }

  private setupScene() {
    const app = this.app;
    app.scene.ambientLight = new pc.Color(0.45, 0.47, 0.5);
    app.scene.fog.type = pc.FOG_LINEAR;
    app.scene.fog.color = SKY;
    app.scene.fog.start = GameConfig.fogStart;
    app.scene.fog.end = GameConfig.fogEnd;

    const camera = new pc.Entity('camera');
    camera.addComponent('camera', { clearColor: SKY, fov: 60, nearClip: 0.2, farClip: GameConfig.fogEnd + 200 });
    app.root.addChild(camera);
    this.camEntity = camera;
    this.sky = new Sky(app, GameConfig.fogEnd + 100);

    const sun = new pc.Entity('sun');
    sun.addComponent('light', {
      type: 'directional', color: new pc.Color(1, 0.96, 0.88), intensity: 1.1,
      castShadows: GameConfig.shadows, shadowDistance: 120, shadowResolution: 2048,
      shadowBias: 0.3, normalOffsetBias: 0.05,
    });
    sun.setEulerAngles(50, 35, 0); // tropical high sun
    app.root.addChild(sun);

    // Ground: one large flat plane (Colombo's coastal plain is near sea level).
    const ground = new pc.Entity('ground');
    const gm = new pc.StandardMaterial();
    gm.diffuse = new pc.Color(0.47, 0.45, 0.36); // dusty compound earth / worn grass, as in built-up Colombo
    gm.update();
    ground.addComponent('render', { type: 'plane', material: gm, castShadows: false });
    ground.setLocalScale(30000, 1, 30000);
    app.root.addChild(ground);
  }

  /** Sea from the OSM coastline: each coastline segment extruded westwards to the horizon. */
  private buildSea() {
    const g = new GeometryBuffer();
    const WEST = -8000, Y = 0.02, C = 0x2a6f8c;
    for (const line of this.map.index.coast) {
      for (let i = 0; i < line.length - 2; i += 2) {
        const a = g.vertexCount;
        g.vertex(line[i], Y, line[i + 1], 0, 1, 0, C);
        g.vertex(line[i + 2], Y, line[i + 3], 0, 1, 0, C);
        g.vertex(WEST, Y, line[i + 3], 0, 1, 0, C);
        g.vertex(WEST, Y, line[i + 1], 0, 1, 0, C);
        g.quad(a);
      }
    }
    const mesh = g.toMesh(this.app.graphicsDevice);
    if (!mesh) return;
    const mat = vertexColorMaterial(true);
    mat.gloss = 0.8;
    mat.update();
    const sea = new pc.Entity('sea');
    sea.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], castShadows: false });
    this.app.root.addChild(sea);
  }

  /** Put the car on the nearest matching road, in the left-hand lane, facing along it. */
  /** Snap to the nearest road, left lane, facing along it (or towards (tx,tz) if given). */
  private placeOnRoad(x: number, z: number, nameFilter?: (name: string) => boolean, tx?: number, tz?: number) {
    const hit = (nameFilter && this.map.roads.nearest(x, z, r => nameFilter(r.n))) || this.map.roads.nearest(x, z);
    if (!hit) { this.car.physics.reset(x, z, 0); return; }
    if (tx !== undefined && tz !== undefined && hit.dx * (tx - hit.x) + hit.dz * (tz! - hit.z) < 0 && !hit.road.o) { hit.dx = -hit.dx; hit.dz = -hit.dz; }
    const yaw = Math.atan2(-hit.dx, -hit.dz);
    // Left vector = (-cos yaw, sin yaw) = (dz, -dx). Sri Lanka drives on the left.
    const off = hit.road.o ? 0 : hit.road.w / 4;
    this.car.physics.reset(hit.x + hit.dz * off, hit.z - hit.dx * off, yaw);
  }

  /** Reference comparison: current viewpoint (shareable ?at= link, street-level imagery) + nearest reference photo. */
  private toggleCompare() {
    const el = document.getElementById('compare')!;
    if (!(el.hidden = !el.hidden)) {
      const p = this.car.physics, [lat, lon] = unproject(p.x, p.z), hdg = Math.round(((-p.yaw * 180) / Math.PI + 360) % 360);
      const rec = this.map.landmarks.nearestReference(p.x, p.z), ref = rec?.references[0];
      const at = `${location.origin}${location.pathname}?at=${lat.toFixed(6)},${lon.toFixed(6)},${hdg}`;
      el.innerHTML = '';
      const info = document.createElement('div');
      info.innerHTML = `<span class="label">VIEWPOINT</span>${lat.toFixed(6)}, ${lon.toFixed(6)} · heading ${hdg}°<br>`;
      const a = (href: string, text: string) => { const l = document.createElement('a'); l.href = href; l.target = '_blank'; l.rel = 'noopener'; l.textContent = text; info.append(l, ' · '); };
      a(at, 'link to this view');
      a(`https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=19`, 'street-level photos here');
      el.append(info);
      if (rec && ref) {
        const img = document.createElement('img'); img.src = `${GameConfig.dataUrl}/${ref.path}`;
        const cap = document.createElement('small'); cap.textContent = `${rec.name} — ${ref.license}${ref.author ? ', ' + ref.author : ''} · confidence: ${rec.confidence}`;
        el.append(img, cap);
      } else {
        const s = document.createElement('small'); s.textContent = 'No reference photo recorded within 300 m.'; el.append(s);
      }
    }
  }

  private update(dt: number) {
    const input = this.input;
    if (input.wasPressed('Escape')) { this.paused = !this.paused; this.hud.setPaused(this.paused); }
    if (input.wasPressed('KeyC')) this.cam.cycle();
    if (input.wasPressed('KeyN')) { this.time.cycle(); this.hud.setTime(this.time.current); }
    if (input.wasPressed('KeyM')) { document.getElementById('navmap')!.classList.toggle('big'); this.mapView.resize(); }
    if (input.wasPressed('Slash')) { (document.getElementById('nav-q') as HTMLInputElement).focus(); }
    if (input.wasPressed('KeyP')) this.toggleCompare();
    if (input.wasPressed('KeyR')) { const p = this.car.physics; this.placeOnRoad(p.x, p.z); }
    input.consumeFrame();
    if (this.paused) return;

    const p = this.car.physics;
    this.car.update(dt, input.drive(), this.map.collision);
    this.cam.update(dt, p, this.map.collision);
    this.sky.follow(this.camEntity.getPosition());
    const t0 = performance.now();
    this.map.signals.update(dt);
    this.traffic.update(dt);
    const t1 = performance.now();
    this.trafficAI.update(dt);
    this.debug?.update();
    this.nav.update(dt, this.streetName);
    this.mode?.update(dt);
    const t2 = performance.now();

    this.slowTimer -= dt;
    if (this.slowTimer <= 0) {
      this.slowTimer = 0.25;
      this.map.update(p.x, p.z);
      this.time.updatePool(this.map.lamps.values(), p.x, p.z);
      const hit = this.map.roads.nearest(p.x, p.z);
      this.streetName = hit && hit.dist < 25 ? hit.road.n || 'Unnamed road' : 'Off road';
    }
    const t3 = performance.now();
    this.minimap.draw(this.map.roads, p.x, p.z, p.yaw);
    const t4 = performance.now();
    // Slow-frame report: which system ate the frame (console + debug panel).
    if (t4 - t0 > 50) {
      this.lastSlow = `slow frame ${Math.round(t4 - t0)} ms: traffic ${Math.round(t1 - t0)}, nav/ai ${Math.round(t2 - t1)}, map/chunks ${Math.round(t3 - t2)}, minimap ${Math.round(t4 - t3)} (vehicles ${this.traffic.vehicles.length}, chunks ${this.map.stops.size})`;
      console.warn(this.lastSlow);
      this.traffic.perf = this.lastSlow;
    }
    this.hud.update(Math.abs(p.forwardSpeed) * 3.6, p.gearLabel, p.rpm, this.car.cfg.redline, this.streetName, this.cam.mode);
  }
}

/** Start menu: pick a mode (and a Lanka Metro route). ?mode=free|taxi|metro&route=CMxx skips it. */
async function chooseMode(): Promise<{ mode: 'free' | 'taxi' } | { mode: 'metro'; route: MetroRoute }> {
  const q = new URLSearchParams(location.search);
  let routes: MetroRoute[] = [];
  try { routes = (await (await fetch(`${GameConfig.dataUrl}/metro.json`)).json()).routes; } catch { /* metro mode unavailable */ }
  const metro = (code: string | null) => { const r = routes.find(r => r.code === code) ?? routes.find(r => r.code === 'CM06'); return r ? { mode: 'metro' as const, route: r } : { mode: 'free' as const }; };
  const m = q.get('mode');
  if (m === 'free' || m === 'taxi') return { mode: m };
  if (m === 'metro') return metro(q.get('route'));

  const el = document.getElementById('modes')!, sel = document.getElementById('metro-route') as HTMLSelectElement;
  for (const r of routes) {
    const n = playableStops(r).length, o = document.createElement('option');
    o.value = r.code; o.textContent = `${r.code} · ${r.name} (${n} stops in the city)`; o.disabled = n < 2;
    if (r.code === 'CM06') o.selected = true;
    sel.append(o);
  }
  el.hidden = false;
  document.getElementById('loading')!.hidden = true;
  return new Promise(resolve => {
    el.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach(b => b.onclick = () => {
      el.hidden = true;
      document.getElementById('loading')!.hidden = false;
      const mode = b.dataset.mode!;
      resolve(mode === 'metro' ? metro(sel.value) : { mode: mode as 'free' | 'taxi' });
    });
  });
}
