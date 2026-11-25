import * as pc from 'playcanvas';
import { GeometryBuffer } from '../map/MeshUtil';
import { groundAt } from '../map/Terrain';
import type { RoadNetwork } from '../map/RoadNetwork';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import type { Sound } from '../audio/Sound';

// Monsoon thunderstorm: falling streaks around the camera, wet asphalt (darker, glossy, reflective), lower tyre grip,
// lightning (scene flash + thunder delayed by distance), reflective puddles on the roads, wheel spray and puddle splashes.
// The dark sky itself is the 'storm' lighting preset (TimeOfDay), chosen by Game while it rains.
const BOX = 50, HEIGHT = 28, DROPS = 6000, FALL = 16; // m, m, count, m/s
const PUDDLES = 36, PUDDLE_RANGE = 110;                 // puddles kept around the car

interface Puddle { e: pc.Entity; x: number; z: number; r: number }

export class Weather {
  raining = false;
  private rain = new pc.Entity('rain');
  private layers: pc.Entity[] = [];
  private dry: { gloss: number; specular: pc.Color; diffuse: pc.Color }[];
  private t = 0;
  private puddles: Puddle[] = [];
  private puddleMesh: pc.Mesh;
  private puddleMat: pc.StandardMaterial;
  private flash: pc.Entity;
  private nextStrike = 8;
  private strike: number[] = [];   // flash envelope keyframes (s remaining)
  private spray: pc.Entity[] = [];
  private splashFx: pc.Entity;
  private inPuddle = false;

  constructor(private app: pc.AppBase, private wetMats: pc.StandardMaterial[], private roads?: RoadNetwork, private sound?: Sound) {
    // Each drop: two crossed thin quads (visible from any side), 0.8 m streak.
    const g = new GeometryBuffer(), C = 0xbfcad6;
    for (let i = 0; i < DROPS; i++) {
      const x = (Math.random() - 0.5) * BOX, y = Math.random() * HEIGHT, z = (Math.random() - 0.5) * BOX;
      for (const [ax, az] of [[0.012, 0], [0, 0.012]]) {
        const v = g.vertexCount;
        g.vertex(x - ax, y, z - az, 0, 0, 1, C); g.vertex(x + ax, y, z + az, 0, 0, 1, C);
        g.vertex(x + ax + 0.06, y + 0.8, z + az, 0, 0, 1, C); g.vertex(x - ax + 0.06, y + 0.8, z - az, 0, 0, 1, C); // wind slant
        g.quad(v);
      }
    }
    const m = new pc.StandardMaterial();
    m.emissive = new pc.Color(0.75, 0.8, 0.88); m.diffuse = new pc.Color(0, 0, 0);
    m.useLighting = false; m.opacity = 0.38; m.blendType = pc.BLEND_NORMAL; m.depthWrite = false; m.cull = pc.CULLFACE_NONE;
    m.update();
    const mesh = g.toMesh(app.graphicsDevice)!;
    for (let k = 0; k < 2; k++) { // two stacked copies scroll down for a seamless loop
      const e = new pc.Entity();
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, m)], castShadows: false });
      this.rain.addChild(e); this.layers.push(e);
    }
    this.rain.enabled = false;
    app.root.addChild(this.rain);
    this.dry = wetMats.map(w => ({ gloss: w.gloss, specular: w.specular.clone(), diffuse: w.diffuse.clone() }));

    // Puddle: irregular blob, mirror-like water (reflects the sky through the env atlas).
    const pb = new GeometryBuffer(), SEG = 20, c0 = pb.vertexCount;
    pb.vertex(0, 0, 0, 0, 1, 0, 0xffffff);
    const wob = [0, 1, 2].map(() => Math.random() * 6);
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2, r = 1 + 0.18 * Math.sin(a * 2 + wob[0]) + 0.1 * Math.sin(a * 3 + wob[1]) + 0.06 * Math.sin(a * 5 + wob[2]);
      pb.vertex(Math.cos(a) * r, 0, Math.sin(a) * r, 0, 1, 0, 0xffffff);
    }
    for (let i = 0; i < SEG; i++) pb.idx.push(c0, c0 + 1 + ((i + 1) % SEG), c0 + 1 + i);
    this.puddleMesh = pb.toMesh(app.graphicsDevice)!;
    const pm = (this.puddleMat = new pc.StandardMaterial());
    pm.diffuse = new pc.Color(0.03, 0.035, 0.04); pm.gloss = 0.97; pm.useMetalness = true; pm.metalness = 0.55;
    pm.opacity = 0.88; pm.blendType = pc.BLEND_NORMAL; pm.depthWrite = false; pm.cull = pc.CULLFACE_NONE;
    pm.update();

    // Lightning: a bright bluish directional light switched on for a few frames.
    this.flash = new pc.Entity('lightning');
    this.flash.addComponent('light', { type: 'directional', color: new pc.Color(0.78, 0.85, 1), intensity: 0, castShadows: false });
    this.flash.setEulerAngles(60, Math.random() * 360, 0);
    app.root.addChild(this.flash);

    // Spray (rear wheels, continuous while fast on wet road) and a one-shot splash burst for puddles.
    const soft = softDot(app.graphicsDevice);
    for (let i = 0; i < 2; i++) this.spray.push(this.emitter(soft, false));
    this.splashFx = this.emitter(soft, true);
  }

  private emitter(tex: pc.Texture, burst: boolean) {
    const e = new pc.Entity(burst ? 'splash' : 'spray');
    e.addComponent('particlesystem', {
      numParticles: burst ? 160 : 90, lifetime: burst ? 0.9 : 0.55, rate: burst ? 0.002 : 0.008, rate2: burst ? 0.004 : 0.014,
      loop: !burst, autoPlay: false, localSpace: false, emitterShape: pc.EMITTERSHAPE_BOX,
      emitterExtents: burst ? new pc.Vec3(1.6, 0.1, 2.2) : new pc.Vec3(0.25, 0.05, 0.2),
      // Thrown up and back (local +Z is behind the car), then pulled down by gravity.
      localVelocityGraph: new pc.CurveSet([[0, burst ? -2.5 : -0.6], [0, burst ? 3.5 : 1.2, 1, -3], [0, burst ? -1 : 1.5]]),
      localVelocityGraph2: new pc.CurveSet([[0, burst ? 2.5 : 0.6], [0, burst ? 5.5 : 2.2, 1, -2], [0, burst ? 2 : 3.5]]),
      scaleGraph: new pc.Curve([0, burst ? 0.25 : 0.15, 1, burst ? 0.7 : 0.55]),
      alphaGraph: new pc.Curve([0, burst ? 0.7 : 0.35, 1, 0]),
      colorGraph: new pc.CurveSet([[0, 0.82], [0, 0.85], [0, 0.9]]),
      colorMap: tex, lighting: false, blendType: pc.BLEND_NORMAL, depthWrite: false,
    });
    this.app.root.addChild(e);
    return e;
  }

  set(rain: boolean) {
    if (rain === this.raining) return;
    this.raining = rain;
    this.rain.enabled = rain;
    this.wetMats.forEach((w, i) => {
      const d = this.dry[i];
      w.gloss = rain ? 0.86 : d.gloss;
      w.specular = rain ? new pc.Color(0.38, 0.39, 0.41) : d.specular;
      w.diffuse = rain ? new pc.Color(d.diffuse.r * 0.55, d.diffuse.g * 0.55, d.diffuse.b * 0.58) : d.diffuse; // wet asphalt darkens
      w.update();
    });
    if (!rain) {
      this.puddles.forEach(p => p.e.destroy()); this.puddles = [];
      this.spray.forEach(s => s.particlesystem!.stop()); this.flash.light!.intensity = 0; this.strike = [];
    }
  }

  /** Keep the rain volume on the camera, scroll the streaks, run lightning, puddles and spray. */
  update(dt: number, cam: pc.Vec3, car?: VehiclePhysics) {
    if (!this.raining) return;
    this.t = (this.t + dt * FALL) % HEIGHT;
    this.rain.setPosition(Math.round(cam.x / 4) * 4, cam.y - HEIGHT / 2, Math.round(cam.z / 4) * 4);
    this.layers[0].setLocalPosition(0, -this.t, 0);
    this.layers[1].setLocalPosition(0, HEIGHT - this.t, 0);
    this.lightning(dt);
    if (car) { this.updatePuddles(car); this.updateSpray(car); }
  }

  private lightning(dt: number) {
    if ((this.nextStrike -= dt) <= 0) {
      this.nextStrike = 7 + Math.random() * 18;
      const dist = Math.random();                                  // 0 = overhead
      // Real strikes flicker: 2-4 return strokes within ~0.4 s.
      this.strike = [];
      for (let k = 0, at = 0; k < 2 + Math.floor(Math.random() * 3); k++) { at += 0.05 + Math.random() * 0.12; this.strike.push(at, (1 - dist * 0.7) * (k ? 0.6 + Math.random() * 0.4 : 1)); }
      this.flash.setEulerAngles(40 + Math.random() * 40, Math.random() * 360, 0);
      this.strikeT = 0;
      // Sound travels ~340 m/s: a 0-3 km strike thunders 0-9 s later.
      const delay = dist * 9000;
      setTimeout(() => this.raining && this.sound?.thunder(dist), delay);
    }
    if (!this.strike.length) return;
    this.strikeT += dt;
    let I = 0;
    for (let i = 0; i < this.strike.length; i += 2) { const d = this.strikeT - this.strike[i]; if (d >= 0 && d < 0.09) I = Math.max(I, this.strike[i + 1] * (1 - d / 0.09)); }
    this.flash.light!.intensity = I * 6;
    if (I > 0) this.app.scene.skyboxIntensity = 0.35 + I * 2.5; // the whole sky lights up
    if (this.strikeT > this.strike[this.strike.length - 2] + 0.2) { this.strike = []; this.flash.light!.intensity = 0; this.app.scene.skyboxIntensity = 0.35; }
  }
  private strikeT = 0;

  /** Keep ~PUDDLES puddles on road surfaces near the car: drop far ones, add new ones ahead and around. */
  private updatePuddles(car: VehiclePhysics) {
    this.puddles = this.puddles.filter(p => Math.hypot(p.x - car.x, p.z - car.z) < PUDDLE_RANGE * 1.3 || (p.e.destroy(), false));
    for (let tries = 0; tries < 4 && this.puddles.length < PUDDLES && this.roads; tries++) {
      const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * (PUDDLE_RANGE - 25);
      const hit = this.roads.nearest(car.x + Math.cos(a) * d, car.z + Math.sin(a) * d);
      if (!hit || hit.dist > 30 || (hit.road.y && hit.road.y.some(v => v > 0.5))) continue; // not on flyover decks
      const off = (Math.random() - 0.5) * hit.road.w * 0.8;
      const x = hit.x + hit.dz * off, z = hit.z - hit.dx * off, r = 0.8 + Math.random() * 2.2;
      if (this.puddles.some(p => Math.hypot(p.x - x, p.z - z) < p.r + r + 2)) continue;
      const e = new pc.Entity('puddle');
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(this.puddleMesh, this.puddleMat)], castShadows: false, receiveShadows: false });
      e.setPosition(x, groundAt(x, z) + 0.04, z);
      e.setLocalScale(r * (0.8 + Math.random() * 0.5), 1, r);
      e.setEulerAngles(0, Math.random() * 360, 0);
      this.app.root.addChild(e);
      this.puddles.push({ e, x, z, r });
    }
  }

  private updateSpray(car: VehiclePhysics) {
    const speed = Math.abs(car.forwardSpeed), c = car.cfg, yawDeg = (car.yaw * 180) / Math.PI;
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw), rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
    const on = speed > 6 && car.deck < 2;
    this.spray.forEach((e, i) => {
      const side = (i ? 1 : -1) * Math.max(0.01, c.trackWidth / 2);
      e.setPosition(car.x - fx * c.cgToRear + rx * side, car.y + 0.15, car.z - fz * c.cgToRear + rz * side);
      e.setEulerAngles(0, yawDeg, 0);
      const ps = e.particlesystem!;
      if (on && !ps.isPlaying()) ps.play(); else if (!on && ps.isPlaying()) ps.stop();
    });
    // Driving into a puddle: one big sheet of water + splash sound, scaled by speed.
    const inside = this.puddles.some(p => Math.hypot(p.x - car.x, p.z - car.z) < p.r + c.width / 2);
    if (inside && !this.inPuddle && speed > 3) {
      this.splashFx.setPosition(car.x, car.y + 0.1, car.z);
      this.splashFx.setEulerAngles(0, yawDeg, 0);
      const ps = this.splashFx.particlesystem!;
      ps.reset(); ps.play();
      this.sound?.splash(Math.min(1, speed / 20));
    }
    this.inPuddle = inside;
  }
}

/** Soft round particle sprite. */
function softDot(device: pc.GraphicsDevice) {
  const S = 32, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) / (S / 2), a = Math.max(0, 1 - d) ** 1.6, i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = a * 255;
  }
  const t = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_RGBA8, mipmaps: true });
  t.lock().set(data); t.unlock();
  return t;
}
