import * as pc from 'playcanvas';

// Everything that lights up after dark (building windows, landmarks): materials register once with their full-night
// strength; TimeOfDay sets the level (0 = day, 0.4 = sunset/storm, 1 = night).

const mats: [pc.StandardMaterial, number][] = [];
let level = 0;

export function nightLight(m: pc.StandardMaterial, strength: number) {
  mats.push([m, strength]);
  m.emissiveIntensity = strength * level;
  m.update();
}

export function setNightLights(l: number) {
  level = l;
  for (const [m, s] of mats) { m.emissiveIntensity = s * l; m.update(); }
}

/** 16×16 cells of randomly lit windows (warm, some cool white); gap = dark border around each window (0..0.5). */
function windowTexture(device: pc.GraphicsDevice, gapX: number, gapY: number) {
  const S = 256, N = 16, C = S / N, data = new Uint8Array(S * S * 4);
  const cells = Array.from({ length: N * N }, () => {
    if (Math.random() > 0.55) return [0, 0, 0];
    const k = 0.45 + Math.random() * 0.55, c = Math.random() < 0.7 ? [255, 190, 110] : [205, 225, 255];
    return c.map(v => v * k);
  });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x % C) / C, fy = (y % C) / C, on = fx >= gapX && fx <= 1 - gapX && fy >= gapY && fy <= 1 - gapY;
    const c = on ? cells[Math.floor(y / C) * N + Math.floor(x / C)] : [0, 0, 0], i = (y * S + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  const t = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 4 });
  t.lock().set(data); t.unlock();
  return t;
}

/** Add lit rooms to the window/curtain-wall glass (UVs are box-mapped, 7 m per unit). */
export function litGlass(device: pc.GraphicsDevice, m: pc.StandardMaterial) {
  m.emissive = new pc.Color(1, 1, 1);
  m.emissiveMap = windowTexture(device, 0.04, 0.04);
  m.emissiveMapTiling = new pc.Vec2(0.25, 0.25); // 28 m pattern: ~1.75 m cells
  nightLight(m, 2.2);
}

/** Overlay for far, window-less walls: additive, so it's invisible by day. */
export function farWindowMaterial(device: pc.GraphicsDevice) {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(1, 1, 1);
  m.emissiveMap = windowTexture(device, 0.25, 0.28);
  m.emissiveMapTiling = new pc.Vec2(7 / 48, 7 / 53); // 3 m bays, 3.3 m floors
  m.useLighting = false; m.useFog = false; m.useSkybox = false; m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false;
  nightLight(m, 1.8);
  return m;
}
