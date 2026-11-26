import { store, username } from '../account/Store';
import type { CollisionWorld } from '../map/CollisionWorld';
import * as pc from 'playcanvas';
import { CameraController } from '../camera/CameraController';
import { InputManager } from '../input/InputManager';
import { MapChunkManager } from '../map/MapChunkManager';
import { StaticChunkProvider } from '../map/MapLoader';
import { project, unproject } from '../map/MapProjection';
import { GeometryBuffer } from '../map/MeshUtil';
import { groundMaterial } from '../roads/RoadMaterialSystem';
import { HUD } from '../ui/HUD';
import { MiniMap } from '../ui/MiniMap';
import { VehicleController } from '../vehicle/VehicleController';
import { GARAGE, cityBus, type GarageKey } from '../vehicle/VehicleConfig';
import { METRO_RED } from '../traffic/VehicleModels';
import { ModeHUD } from './modes/ModeHUD';
import { RouteCompare } from './RouteCompare';
import { Police } from './Police';
import { Wallet, isRush, lightFor } from './Wallet';
import { groundAt, terrainGrid } from '../map/Terrain';
import { Sound } from '../audio/Sound';
import { Pedestrians } from '../people/Pedestrians';
import { Weather } from '../roads/Weather';
import { Wind } from '../roads/Vegetation';
import { buildWater, WaterSurface } from '../map/Water';
import { Settings, type SettingValues } from '../ui/Settings';
import { hornSetting } from '../ui/HornSetting';
import { saveButton } from '../ui/SaveButton';
import { Friends } from '../ui/Friends';
import { TaxiMode } from './modes/TaxiMode';
import { Multiplayer } from './modes/Multiplayer';
import { MetroBusMode, playableStops, type MetroRoute } from './modes/MetroBusMode';
import { showLobby, type LobbyChoice } from '../ui/Lobby';
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
  private mp?: Multiplayer;
  private friendsT = 0;
  private compare?: RouteCompare;
  private police?: Police;
  private groundMat!: pc.StandardMaterial;
  private wallet!: Wallet;
  private opts!: SettingValues;
  private saveT = 5;
  private settings!: Settings;
  private peds!: Pedestrians;
  private weather!: Weather;
  private waterSurface!: WaterSurface;
  private wind!: Wind;
  private coastT = 0;
  private coastDist = Infinity;
  private sound = new Sound();
  private navToast: (m: string) => void = () => {};
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
    opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem, pc.ParticleSystemComponentSystem];
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
    this.waterSurface = new WaterSurface(app.graphicsDevice);
    this.buildSea();
    this.buildTerrain();
    buildWater(app, this.map.water, this.waterSurface.material);

    // Load the street around the spawn (saved parking spot or default) first: the lobby shows it behind the garage.
    const spawn = GameConfig.spawn, q = new URLSearchParams(location.search);
    const wallet = (this.wallet = new Wallet());
    let [sx, sz] = project(spawn.lat, spawn.lon);
    const saved = q.has('at') ? undefined : wallet.data.pos;
    if (saved && [saved.x, saved.z].every(Number.isFinite)) [sx, sz] = [saved.x, saved.z];
    app.start();
    await this.loadAround(sx, sz);
    // The showroom needs space to orbit: prefer a wide road near the spawn over whatever lane is closest.
    const wide = this.map.roads.nearest(sx, sz, r => r.w >= 9 && !r.y);
    const spot = wide && wide.dist < 250 ? wide : this.map.roads.nearest(sx, sz);
    const lobbyAt = spot ? { x: spot.x, y: groundAt(spot.x, spot.z), z: spot.z, yaw: Math.atan2(-spot.dx, -spot.dz) } : { x: sx, y: groundAt(sx, sz), z: sz, yaw: 0 };

    const friends = new Friends();
    // Lobby (garage + mode), or skipped with ?mode=free|taxi|metro&route=CM06 / ?room=name
    const choice = await chooseMode(app, this.camEntity, lobbyAt, this.map.collision);
    const metroRoute = choice.mode === 'metro' ? choice.route : null;
    const metroStart = metroRoute ? playableStops(metroRoute) : [];
    if (metroStart.length >= 2) { [sx, sz] = [metroStart[0].x, metroStart[0].z]; await this.loadAround(sx, sz); }

    const cfg = metroRoute ? { ...cityBus, color: [0.96, 0.96, 0.95] as [number, number, number], accent: METRO_RED } : { ...(GARAGE[choice.vehicle] ?? GARAGE.car), color: choice.color };
    this.car = new VehicleController(app, cfg);
    // ?at=lat,lon,heading: exact viewpoint, e.g. to match a reference photograph's position and bearing.
    const at = q.get('at')?.split(',').map(Number);
    if (at && at.length >= 2 && at.every(Number.isFinite)) { const [ax, az] = project(at[0], at[1]); this.car.physics.reset(ax, az, -((at[2] ?? 0) * Math.PI) / 180); }
    else if (metroStart.length >= 2) this.placeOnRoad(sx, sz, undefined, metroStart[1].x, metroStart[1].z);
    else this.placeOnRoad(sx, sz, spawn.road ? n => n === spawn.road : undefined);
    if (!at && !metroRoute && saved && [saved.x, saved.z, saved.yaw].every(Number.isFinite)) this.car.physics.reset(saved.x, saved.z, saved.yaw); // resume where you parked
    const camera = app.root.findByName('camera') as pc.Entity;
    this.car.physics.surfaceAt = (x, z, y, h) => this.map.roads.surface(x, z, y, h);
    this.cam = new CameraController(camera, canvas);
    this.cam.vehicleLength = cfg.length;
    this.time = new TimeOfDay(app, app.root.findByName('sun') as pc.Entity, camera, this.map.lampMat, this.sky);
    this.hud.show();
    this.mapView = new MapView(document.getElementById('navmap')!, spawn.lat, spawn.lon);
    const p = this.car.physics;
    this.traffic = new TrafficManager(app, this.map, p);
    this.peds = new Pedestrians(app, this.map, this.traffic, p);
    const navHud = new NavigationHUD();
    this.navToast = (m: string) => navHud.toast(m, 5000);
    this.trafficAI = new TrafficIntelligenceService(this.traffic,
      () => ({ road: this.streetName, timeOfDay: this.time.current, signal: this.map.signals.aspect(0) }), msg => navHud.toast(msg, 5000));
    if (import.meta.env.DEV) this.debug = new TrafficDebugPanel(this.traffic, this.trafficAI, this.map.signals, this.time, p);
    this.nav = new NavigationManager(app, navHud, this.mapView, photonGeocoder, osrmRouter, () => p, this.map.index.bounds);
    const modeHud = new ModeHUD((m, ms) => navHud.toast(m, ms));
    if (choice.mode === 'taxi') this.mode = new TaxiMode(app, this.map, this.nav, p, modeHud, () => this.traffic.lastCollision, wallet);
    this.police = new Police(app, this.map, this.traffic, p, wallet, (m, ms) => navHud.toast(m, ms));
    if (metroRoute) this.mode = new MetroBusMode(app, metroRoute, this.nav, p, modeHud);
    if (choice.mode !== 'metro' && choice.room) {
      const hex = (Math.round(cfg.color[0] * 255) << 16) | (Math.round(cfg.color[1] * 255) << 8) | Math.round(cfg.color[2] * 255);
      this.mp = new Multiplayer(app, camera, p, this.map, modeHud, choice.room, username, cfg.model ?? 'sedan', hex, {
        sound: this.sound, wallet,
        horn: () => this.input.drive().horn,
        destination: () => {
          const t = this.nav.target;
          if (!t) return null;
          const [x, z] = project(t.lat, t.lon);
          return { name: t.name, x, z };
        },
        navigate: (name, x, z) => { const [lat, lon] = unproject(x, z); void this.nav.go({ name, address: '', kind: 'race finish', lat, lon }); },
      });
    }
    const cmp = new URLSearchParams(location.search).get('compare');
    if (cmp) { this.compare = new RouteCompare(app, p, this.cam, canvas); await this.compare.init(cmp); }
    window.addEventListener('keydown', e => { if (!(e.target instanceof HTMLInputElement)) this.compare?.key(e.code); });
    this.weather = new Weather(app, [this.map.groundMat, this.groundMat], this.map.roads, this.sound);
    this.wind = new Wind(this.map.foliageMat, (s, d) => this.sound.gust(s, d));
    this.settings = new Settings(v => {
      p.manual = v.manual;
      if (!v.manual && p.gear === 0) p.gear = 1;
      this.traffic.enabled = v.traffic;
      this.traffic.policeEnabled = v.police;
      this.peds.enabled = v.pedestrians;
      if (!v.police) this.police?.clear();
      this.weather.set(v.rain);
      p.grip = v.rain ? 0.68 : 1;      // wet asphalt: ~0.6-0.7 of dry friction
      this.traffic.rain = v.rain;
      this.sound.raining = v.rain;
      this.sound.hornKind = cfg.model === 'motorcycle' || cfg.model === 'tuktuk' ? 'disc' : cfg.model === 'bus' || cfg.model === 'van' ? 'bus' : 'car';
    });
    this.opts = this.settings.values;
    void this.sound.init();
    hornSetting(this.settings, async clip => { await this.sound.setHorn(clip); this.mp?.setHorn(clip); });
    friends.button.style.cssText += ';top:116px;left:12px;right:auto';
    if (this.mp) { friends.room = this.mp.room; friends.inRoom = true; }
    saveButton(async () => {
      wallet.savePosition(p.x, p.z, p.yaw);
      wallet.commit();
      navHud.toast(await store.synced() ? '💾 Game saved' : "Couldn't reach the server. Will keep trying.", 3000);
    });
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
    sun.light!.shadowType = pc.SHADOW_PCF5_32F; // soft shadow edges
    sun.light!.intensity = 1.6;                 // HDR: highlights roll off in the tonemapper and feed bloom

    // Cinematic post stack (?nofx to disable on weak GPUs): HDR + ACES, SSAO, bloom, grading, vignette.
    if (!new URLSearchParams(location.search).has('nofx')) {
      const f = new pc.CameraFrame(app, camera.camera!);
      f.rendering.toneMapping = pc.TONEMAP_ACES2;
      f.rendering.samples = 4;
      f.ssao.type = pc.SSAOTYPE_COMBINE; f.ssao.intensity = 0.6; f.ssao.radius = 2.5; f.ssao.samples = 12; f.ssao.blurEnabled = true;
      f.bloom.intensity = 0.03; f.bloom.blurLevel = 16;
      f.grading.enabled = true; f.grading.contrast = 1.12; f.grading.saturation = 1.18; f.grading.tint = new pc.Color(1, 0.97, 0.92); // warm Vice-City-style punch
      f.colorEnhance.enabled = true; f.colorEnhance.vibrance = 0.25; f.colorEnhance.shadows = 0.15; f.colorEnhance.dehaze = 0.1;
      f.vignette.enabled = true; f.vignette.intensity = 0.35; f.vignette.inner = 0.55; f.vignette.outer = 1.1;
      f.fringing.enabled = true; f.fringing.intensity = 4;
      f.update();
    }

    // Ground: one large flat plane (Colombo's coastal plain is near sea level).
    const ground = new pc.Entity('ground');
    const gm = new pc.StandardMaterial();
    gm.diffuse = new pc.Color(0.47, 0.45, 0.36); // dusty compound earth / worn grass, as in built-up Colombo
    gm.update();
    ground.addComponent('render', { type: 'plane', material: gm, castShadows: false });
    ground.setLocalScale(30000, 1, 30000);
    ground.setLocalPosition(0, -0.3, 0); // beyond the terrain grid
    app.root.addChild(ground);
    this.groundMat = gm;
  }

  /** Ground surface from the FABDEM heightmap: one grid mesh (~30 m cells), sunk 0.25 m so draped roads sit on top. */
  private buildTerrain() {
    const t = terrainGrid();
    if (!t) return;
    const g = new GeometryBuffer(), C = 0x787359, h = (i: number, j: number) => t.dm[Math.min(t.h - 1, Math.max(0, j)) * t.w + Math.min(t.w - 1, Math.max(0, i))] / 10;
    for (let j = 0; j < t.h; j++) for (let i = 0; i < t.w; i++) {
      const nx = (h(i - 1, j) - h(i + 1, j)) / (2 * t.dx), nz = (h(i, j - 1) - h(i, j + 1)) / (2 * t.dz), l = Math.hypot(nx, 1, nz);
      g.vertex(t.x0 + i * t.dx, h(i, j) - 0.25, t.z0 + j * t.dz, nx / l, 1 / l, nz / l, C);
    }
    for (let j = 0; j < t.h - 1; j++) for (let i = 0; i < t.w - 1; i++) {
      const a = j * t.w + i;
      g.idx.push(a, a + t.w, a + 1, a + 1, a + t.w, a + t.w + 1);
    }
    const mesh = g.toMesh(this.app.graphicsDevice);
    if (!mesh) return;
    const mat = groundMaterial(this.app.graphicsDevice);
    const e = new pc.Entity('terrain');
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], castShadows: false, receiveShadows: true });
    this.app.root.addChild(e);
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
    const mat = this.waterSurface.material;
    const sea = new pc.Entity('sea');
    sea.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], castShadows: false });
    this.app.root.addChild(sea);
  }

  /** Stream in the chunks around (x,z), driving the loading bar. */
  private loadAround(x: number, z: number) {
    const initial = this.map.wanted(x, z).slice(0, 9);
    return new Promise<void>(resolve => {
      const tick = () => {
        this.map.update(x, z);
        const done = initial.filter(k => this.map.isLoaded(k)).length;
        this.hud.setLoading(done / initial.length);
        if (done === initial.length || (this.map.pendingCount === 0 && done > 0)) resolve();
        else setTimeout(tick, 50);
      };
      tick();
    });
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

  /** Game clock: lighting follows the hour; rush hour ramps traffic in/out over ~15 game minutes. */
  private wasRush?: boolean;
  private tickClock(dt: number) {
    const w = this.wallet;
    if (this.opts.timeFlow) w.tick(dt);
    const clock = lightFor(w.data.clock), light = this.opts.rain && clock !== 'night' ? 'storm' : clock; // monsoon storm: dark sky by day
    if (light !== this.time.current) { this.time.set(light); this.hud.setTime(light); }
    const rush = isRush(w.data.clock);
    this.traffic.rush += Math.max(-dt / 15, Math.min(dt / 15, (rush ? 1 : 0) - this.traffic.rush));
    if (this.traffic.rush < 0.02) this.traffic.rush = 0;
    if (rush !== this.wasRush) {
      if (this.wasRush !== undefined) this.navToast(rush ? '🚦 Rush hour: Colombo traffic is building up. Expect jams and horns.' : 'Rush hour over: traffic is flowing again.');
      this.wasRush = rush;
    }
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
    if (input.wasPressed('KeyG') || (this.settings.isOpen && input.wasPressed('Escape'))) { this.settings.toggle(); input.consumeFrame(); return; }
    if (this.settings.isOpen) { input.consumeFrame(); return; } // paused while the popup is open
    if (input.wasPressed('Escape')) { this.paused = !this.paused; this.hud.setPaused(this.paused); }
    if (input.wasPressed('KeyC')) this.cam.cycle();
    if (!this.compare) for (let i = 1; i <= 8; i++) if (input.wasPressed('Digit' + i)) this.cam.select(i - 1);
    // J: jump to the next rush-hour start/end; N: skip the clock forward 3 hours.
    if (input.wasPressed('KeyJ')) { const c = this.wallet.data.clock, marks = [420, 570, 990, 1140]; this.wallet.data.clock = marks.find(m => m > c + 1) ?? marks[0]; }
    if (this.opts.manual && input.wasPressed('KeyE')) this.car.physics.shift(1);
    if (this.opts.manual && input.wasPressed('KeyQ')) this.car.physics.shift(-1);
    if (input.wasPressed('KeyN')) this.wallet.data.clock = (this.wallet.data.clock + 180) % 1440;
    if (input.wasPressed('KeyM')) { document.getElementById('navmap')!.classList.toggle('big'); this.mapView.resize(); }
    if (input.wasPressed('Slash')) { (document.getElementById('nav-q') as HTMLInputElement).focus(); }
    if (input.wasPressed('KeyP')) this.toggleCompare();
    if (input.wasPressed('KeyR')) { const p = this.car.physics; this.placeOnRoad(p.x, p.z); }
    input.consumeFrame();
    if (this.paused) return;

    const p = this.car.physics;
    this.tickClock(dt);
    const drive = input.drive();
    this.car.update(dt, drive, this.map.collision);
    this.sound.update(dt, p, Math.max(drive.throttle, drive.brake * (p.gear < 0 ? 1 : 0)), drive.horn, this.traffic.rush, !!this.police?.pullingOver, drive.brake, this.traffic.vehicles);
    this.cam.update(dt, p, this.map.collision);
    this.sky.follow(this.camEntity.getPosition());
    this.map.landmarks.skyline(this.camEntity.getPosition());
    this.weather.update(dt, this.camEntity.getPosition(), p);
    this.wind.update(dt, this.opts.rain);
    this.waterSurface.update(dt);
    this.map.signage?.update(dt);
    if ((this.coastT -= dt) <= 0) { // distance to the shore, twice a second
      this.coastT = 0.5;
      let best = Infinity;
      for (const l of this.map.index.coast) for (let i = 0; i < l.length; i += 2) best = Math.min(best, Math.hypot(l[i] - p.x, l[i + 1] - p.z));
      this.coastDist = best;
    }
    this.sound.ambience(dt, { night: this.time.current === 'night', rain: this.opts.rain, coastDist: this.coastDist });
    const t0 = performance.now();
    this.map.signals.update(dt);
    this.traffic.update(dt);
    this.peds.update(dt);
    const t1 = performance.now();
    this.trafficAI.update(dt);
    this.debug?.update();
    this.nav.update(dt, this.streetName);
    this.mode?.update(dt);
    this.mp?.update(dt);
    if (this.opts.police) this.police?.update(dt);
    if ((this.saveT -= dt) <= 0) { this.saveT = 5; this.wallet.savePosition(p.x, p.z, p.yaw); }
    this.cam.cinematic = this.police?.shot ?? null;
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
    const friends = this.mp?.friends() ?? [];
    const spots = this.police?.hideouts ?? [];
    this.minimap.draw(this.map.roads, p.x, p.z, p.yaw, friends, spots);
    if ((this.friendsT -= dt) <= 0) {
      this.friendsT = 0.25;
      const geo = <T extends { x: number; z: number }>(l: T[]) => l.map(f => { const [lat, lon] = unproject(f.x, f.z); return { ...f, lat, lon }; });
      if (this.mp) this.mapView.setFriends(geo(friends));
      this.mapView.setSpots(geo(spots));
    }
    const t4 = performance.now();
    // Slow-frame report: which system ate the frame (console + debug panel).
    if (t4 - t0 > 50) {
      this.lastSlow = `slow frame ${Math.round(t4 - t0)} ms: traffic ${Math.round(t1 - t0)}, nav/ai ${Math.round(t2 - t1)}, map/chunks ${Math.round(t3 - t2)}, minimap ${Math.round(t4 - t3)} (vehicles ${this.traffic.vehicles.length}, chunks ${this.map.stops.size})`;
      console.warn(this.lastSlow);
      this.traffic.perf = this.lastSlow;
    }
    // Manual shift advice: up near the auto-box upshift point, down when lugging under load.
    const c = this.car.cfg, inGear = p.manual && p.gear > 0;
    const shiftAdvice = !inGear ? (p.manual && p.gear === 0 && drive.throttle ? 1 : 0)
      : p.rpm > c.shiftUpRpm && p.gear < c.gears.length ? 1 : p.rpm < c.shiftDownRpm * 0.85 && p.gear > 1 ? -1 : 0;
    this.hud.update(Math.abs(p.forwardSpeed) * 3.6, p.gearLabel, p.rpm, c.redline, this.streetName, this.cam.mode, shiftAdvice);
  }
}

/** Lobby (garage + mode). URL shortcuts skip it: ?mode=free|taxi|metro&route=CMxx, ?room=name, ?vehicle=car|... */
async function chooseMode(app: pc.AppBase, camera: pc.Entity, at: { x: number; y: number; z: number; yaw: number }, walls: CollisionWorld): Promise<LobbyChoice> {
  const q = new URLSearchParams(location.search);
  let routes: MetroRoute[] = [];
  try { routes = (await (await fetch(`${GameConfig.dataUrl}/metro.json`)).json()).routes; } catch { /* metro mode unavailable */ }
  const m = q.get('mode'), qRoom = q.get('room')?.trim() || undefined;
  if (!m && !qRoom) return showLobby(app, camera, at, routes, walls);
  const vehicle = (q.get('vehicle') ?? store.getItem('cmb-rider-vehicle') ?? 'car') as GarageKey, color = (GARAGE[vehicle] ?? GARAGE.car).color;
  if (m === 'metro') {
    const route = routes.find(r => r.code === q.get('route')) ?? routes.find(r => r.code === 'CM06');
    if (route) return { mode: 'metro', route, vehicle: 'bus', color };
  }
  return { mode: m === 'taxi' ? 'taxi' : 'free', room: qRoom, vehicle, color };
}
