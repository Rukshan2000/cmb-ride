import * as pc from 'playcanvas';
import { GeometryBuffer } from '../map/MeshUtil';

// Things in the sky: drifting clouds, sun, moon, stars, bird flocks and airliners with blinking lights.
// Everything hangs off one root that follows the camera (inside the sky dome of radius R).

type Mood = 'day' | 'sunset' | 'storm' | 'night';

const unlit = (r: number, g: number, b: number, intensity = 1) => {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(r, g, b); m.emissiveIntensity = intensity;
  m.useLighting = false; m.useFog = false; m.useSkybox = false; m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
};

export class SkyLife {
  readonly root = new pc.Entity('sky life');
  private sun: pc.Entity; private moon: pc.Entity; private stars: pc.Entity; private clouds: pc.Entity;
  private sunMat = unlit(1, 0.93, 0.75, 5);
  private cloudMat: pc.StandardMaterial;
  private birds = new pc.Entity('birds');
  private flocks: { e: pc.Entity; r: number; h: number; speed: number; a: number; wings: pc.Entity[] }[] = [];
  private planes: { e: pc.Entity; lights: pc.Entity; heading: number; off: number; h: number; s: number }[] = [];
  private t = 0;
  private sunAt = new pc.Vec3();
  private last = performance.now();

  constructor(private app: pc.AppBase, private R: number) {
    app.root.addChild(this.root);
    const ball = (name: string, mat: pc.Material, size: number) => {
      const e = new pc.Entity(name);
      e.addComponent('render', { type: 'sphere', material: mat, castShadows: false, receiveShadows: false });
      e.setLocalScale(size, size, size);
      this.root.addChild(e);
      return e;
    };
    this.sun = ball('sun disc', this.sunMat, R * 0.05);
    this.moon = ball('moon', unlit(0.86, 0.89, 0.96, 1.6), R * 0.036);
    this.moon.setLocalPosition(this.dir(-120, 24, R * 0.975));
    // Two grey "seas" so it reads as the moon.
    const mare = unlit(0.55, 0.58, 0.66, 1.2);
    for (const [x, y, s] of [[-0.16, 0.1, 0.4], [0.14, -0.14, 0.28]]) {
      const m = new pc.Entity(); m.addComponent('render', { type: 'sphere', material: mare, castShadows: false });
      m.setLocalScale(s, s, s);
      const toward = this.moon.getLocalPosition().clone().mulScalar(-1).normalize(); // face the viewer
      m.setLocalPosition(toward.x * 0.36 + x * -toward.z, toward.y * 0.36 + y, toward.z * 0.36 + x * toward.x);
      this.moon.addChild(m);
    }

    // Stars: tiny quads scattered over the upper dome.
    const g = new GeometryBuffer();
    for (let i = 0; i < 900; i++) {
      const p = this.dir(Math.random() * 360, 5 + Math.asin(Math.random()) * 52, R * 0.975), s = R * (Math.random() < 0.05 ? 0.0022 : 0.0009);
      const side = new pc.Vec3().cross(p, pc.Vec3.UP).normalize().mulScalar(s), up = new pc.Vec3().cross(side, p).normalize().mulScalar(s);
      const v = g.vertexCount;
      for (const [a, b] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) g.vertex(p.x + side.x * a + up.x * b, p.y + side.y * a + up.y * b, p.z + side.z * a + up.z * b, 0, 1, 0, 0xffffff);
      g.quad(v);
    }
    this.stars = new pc.Entity('stars');
    this.stars.addComponent('render', { meshInstances: [new pc.MeshInstance(g.toMesh(app.graphicsDevice)!, unlit(1, 0.97, 0.92, 1.8))], castShadows: false });
    this.root.addChild(this.stars);

    // Drifting cloud layer: alpha noise on the upper half of a slightly smaller dome, slowly rotating.
    const m = (this.cloudMat = unlit(1, 1, 1));
    const tex = cloudTexture(app.graphicsDevice);
    m.opacityMap = tex; m.opacityMapChannel = 'a'; m.blendType = pc.BLEND_NORMAL; m.depthWrite = false; m.cull = pc.CULLFACE_FRONT;
    m.update();
    this.clouds = ball('clouds', m, R * 1.92);

    // Birds: loose V-formations of flapping wings.
    const wg = new GeometryBuffer(), v0 = 0;
    wg.vertex(0, 0, -0.18, 0, 1, 0, 0xffffff); wg.vertex(0, 0, 0.18, 0, 1, 0, 0xffffff); wg.vertex(0.75, 0, 0.12, 0, 1, 0, 0xffffff);
    wg.idx.push(v0, 1, 2);
    const wing = wg.toMesh(app.graphicsDevice)!, black = unlit(0.04, 0.04, 0.05);
    this.root.addChild(this.birds);
    for (let f = 0; f < 4; f++) {
      const e = new pc.Entity('flock'), wings: pc.Entity[] = [];
      for (let i = 0; i < 7; i++) {
        const bird = new pc.Entity(), k = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
        bird.setLocalPosition(side * k * 2.2, Math.random() * 0.8, k * 2 + Math.random());
        for (const s of [-1, 1]) {
          const w = new pc.Entity();
          w.addComponent('render', { meshInstances: [new pc.MeshInstance(wing, black)], castShadows: false });
          w.setLocalScale(s, 1, 1); bird.addChild(w); wings.push(w);
        }
        e.addChild(bird);
      }
      this.birds.addChild(e);
      this.flocks.push({ e, wings, r: 50 + Math.random() * 130, h: 28 + Math.random() * 45, speed: (7 + Math.random() * 5) * (f % 2 ? 1 : -1), a: Math.random() * 6.28 });
    }

    // Airliners crossing high overhead.
    const body = unlit(0.62, 0.65, 0.7);
    const part = (parent: pc.Entity, type: 'box' | 'capsule' | 'sphere', mat: pc.Material, pos: number[], scale: number[], rot = [0, 0, 0]) => {
      const e = new pc.Entity();
      e.addComponent('render', { type, material: mat, castShadows: false });
      e.setLocalPosition(pos[0], pos[1], pos[2]); e.setLocalScale(scale[0], scale[1], scale[2]); e.setLocalEulerAngles(rot[0], rot[1], rot[2]);
      parent.addChild(e);
    };
    const red = unlit(1, 0.1, 0.1, 6), green = unlit(0.1, 1, 0.2, 6), white = unlit(1, 1, 1, 8);
    for (let i = 0; i < 2; i++) {
      const e = new pc.Entity('airliner'), lights = new pc.Entity();
      part(e, 'capsule', body, [0, 0, 0], [4, 16, 4], [90, 0, 0]);                       // fuselage (forward -Z)
      for (const s of [-1, 1]) {
        part(e, 'box', body, [s * 9, 0, 2.5], [17, 0.5, 4], [0, -s * 24, 0]);            // swept wings
        part(e, 'box', body, [s * 3.5, 0.5, 15], [6.5, 0.35, 2.4], [0, -s * 26, 0]);     // tailplane
      }
      part(e, 'box', body, [0, 4, 14.5], [0.4, 7, 4], [28, 0, 0]);                        // fin
      part(lights, 'sphere', red, [-16.5, 0, 6], [1.4, 1.4, 1.4]);
      part(lights, 'sphere', green, [16.5, 0, 6], [1.4, 1.4, 1.4]);
      part(lights, 'sphere', white, [0, -2.6, 0], [1.8, 1.8, 1.8]);
      e.addChild(lights);
      this.root.addChild(e);
      this.planes.push({ e, lights, heading: Math.random() * 360, off: (Math.random() - 0.5) * R, h: 230 + i * 90, s: Math.random() });
    }
    this.set('day');
  }

  private dir(azimuth: number, elevation: number, r: number) {
    const a = (azimuth * Math.PI) / 180, e = (elevation * Math.PI) / 180;
    return new pc.Vec3(Math.sin(a) * Math.cos(e) * r, Math.sin(e) * r, -Math.cos(a) * Math.cos(e) * r);
  }

  set(mood: Mood) {
    this.sun.enabled = mood === 'day' || mood === 'sunset';
    this.sunMat.emissive = mood === 'sunset' ? new pc.Color(1, 0.55, 0.2) : new pc.Color(1, 0.93, 0.75);
    this.sunMat.update();
    this.moon.enabled = this.stars.enabled = mood === 'night';
    this.birds.enabled = mood === 'day' || mood === 'sunset';
    const [r, g, b, o] = { day: [1, 1, 1, 0.8], sunset: [1, 0.62, 0.52, 0.85], storm: [0.2, 0.22, 0.26, 1], night: [0.12, 0.12, 0.18, 0.55] }[mood];
    this.cloudMat.emissive = new pc.Color(r, g, b); this.cloudMat.opacity = o; this.cloudMat.update();
  }

  update(x: number, z: number) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now; this.t += dt;
    this.root.setPosition(x, 0, z);
    const light = this.app.root.findByName('sun') as pc.Entity | null;
    if (light) this.sun.setLocalPosition(this.sunAt.copy(light.up).mulScalar(this.R * 0.975)); // disc where the light comes from
    this.clouds.setLocalEulerAngles(0, this.t * 0.5, 0);
    if (this.birds.enabled) for (const f of this.flocks) {
      f.a += (f.speed / f.r) * dt;
      f.e.setLocalPosition(Math.cos(f.a) * f.r, f.h + Math.sin(this.t * 0.3 + f.r) * 4, Math.sin(f.a) * f.r);
      // Face the direction of travel (tangent of the circle).
      const vx = -Math.sin(f.a) * f.speed, vz = Math.cos(f.a) * f.speed;
      f.e.setLocalEulerAngles(0, (Math.atan2(-vx, -vz) * 180) / Math.PI, 0);
      f.wings.forEach((w, i) => w.setLocalEulerAngles(0, 0, Math.sin(this.t * 9 + (i >> 1)) * 32 * (i % 2 ? 1 : -1)));
    }
    const span = this.R * 1.5;
    for (const p of this.planes) {
      p.s = (p.s + (70 * dt) / span) % 1;
      const along = (p.s - 0.5) * span, h = (p.heading * Math.PI) / 180, fx = -Math.sin(h), fz = -Math.cos(h);
      const px = fx * along - fz * p.off * 0.6, pz = fz * along + fx * p.off * 0.6;
      p.e.setLocalPosition(px, p.h, pz);
      p.e.setLocalEulerAngles(0, p.heading, 0);
      p.e.enabled = Math.hypot(px, p.h, pz) < this.R * 0.94;   // stay inside the dome
      p.lights.enabled = this.t % 1.2 < 0.7;
    }
  }
}

/** Tileable cumulus alpha for a lat-long dome: clouds above the horizon only. */
function cloudTexture(device: pc.GraphicsDevice) {
  const W = 1024, H = 512, data = new Uint8Array(W * H * 4);
  const octaves = [8, 16, 32, 64].map(n => ({ n, g: Float32Array.from({ length: n * n }, Math.random) }));
  for (let y = 0; y < H / 2; y++) {
    const v = y / H, fade = Math.min(1, (0.5 - v) * 7) * Math.min(1, v * 6);
    for (let x = 0; x < W; x++) {
      let s = 0, w = 0.5;
      for (const { n, g } of octaves) {
        const fx = (x / W) * n, fy = v * 2 * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const at = (i: number, j: number) => g[(j % n) * n + (i % n)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        s += (a + (b - a) * ty) * w; w /= 2;
      }
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.max(0, Math.min(1, (s / 0.9375 - 0.5) * 3.4)) * fade * 255;
    }
  }
  const t = new pc.Texture(device, { width: W, height: H, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
  t.lock().set(data); t.unlock();
  return t;
}
