import * as pc from 'playcanvas';

// Sky dome: procedural gradient + tileable cumulus noise on an inside-out sphere that follows the camera.
// Horizon colour == fog colour, so distant city fades into the sky. Tinted per time of day via emissive.
export const DAY_SKY = [0.62, 0.76, 0.9];

export class Sky {
  readonly entity = new pc.Entity('sky');
  private mat = new pc.StandardMaterial();

  constructor(app: pc.AppBase, radius: number) {
    const W = 512, H = 256, data = new Uint8Array(W * H * 4);
    const N = 16, grid = Array.from({ length: 3 }, (_, o) => { const n = N << o; return { n, v: Float32Array.from({ length: n * n }, Math.random) }; });
    const noise = (u: number, v: number) => grid.reduce((s, { n, v: g }, o) => {
      const x = u * n, y = v * n, x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
      const at = (i: number, j: number) => g[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      return s + (a + (b - a) * ty) / (1 << o);
    }, 0) / 1.75;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = y / H, up = Math.max(0, 1 - v * 2); // 1 at zenith, 0 at horizon and below
      let r = DAY_SKY[0] + (0.32 - DAY_SKY[0]) * up, g = DAY_SKY[1] + (0.53 - DAY_SKY[1]) * up, b = DAY_SKY[2] + (0.86 - DAY_SKY[2]) * up;
      // Tropical cumulus: denser near the horizon band, none below it.
      const cl = v < 0.5 ? Math.max(0, noise(x / W, v * 2) - 0.52) * 3.2 * Math.min(1, (0.5 - v) * 12) * (0.5 + 0.5 * (1 - up)) : 0;
      const c = Math.min(1, cl);
      r += (0.97 - r) * c; g += (0.97 - g) * c; b += (0.98 - b) * c;
      const i = (y * W + x) * 4;
      data[i] = r * 255; data[i + 1] = g * 255; data[i + 2] = b * 255; data[i + 3] = 255;
    }
    const tex = new pc.Texture(app.graphicsDevice, { width: W, height: H, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
    tex.lock().set(data); tex.unlock();
    const m = this.mat;
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissiveMap = tex;
    m.emissive = new pc.Color(1, 1, 1);
    m.useLighting = false;
    m.useFog = false;
    m.useSkybox = false;
    m.depthWrite = false;
    m.cull = pc.CULLFACE_FRONT; // seen from inside
    m.update();
    this.entity.addComponent('render', { type: 'sphere', material: m, castShadows: false, receiveShadows: false });
    this.entity.setLocalScale(radius * 2, radius * 2, radius * 2);
    app.root.addChild(this.entity);
  }

  /** Tint relative to the day palette (sunset orange, night near-black). */
  tint(sky: number[]) {
    this.mat.emissive = new pc.Color(sky[0] / DAY_SKY[0], sky[1] / DAY_SKY[1], sky[2] / DAY_SKY[2]);
    this.mat.update();
  }

  follow(pos: pc.Vec3) { this.entity.setPosition(pos.x, 0, pos.z); }
}
