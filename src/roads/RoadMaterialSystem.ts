import * as pc from 'playcanvas';

const S = 256;

/** Tileable multi-octave value noise in [0,1], S×S. */
function noise(octaves: [number, number][]): Float32Array {
  const out = new Float32Array(S * S);
  for (const [n, w] of octaves) {
    const g = new Float32Array(n * n).map(() => Math.random());
    const at = (i: number, j: number) => g[(j % n) * n + (i % n)];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = (x / S) * n, fy = (y / S) * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * S + x] += (a + (b - a) * sy) * w;
    }
  }
  return out;
}

function texture(device: pc.GraphicsDevice, px: (i: number) => [number, number, number], srgb: boolean): pc.Texture {
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const c = px(i);
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.max(0, Math.min(255, c[k] * 255));
    data[i * 4 + 3] = 255;
  }
  const tex = new pc.Texture(device, { width: S, height: S, format: srgb ? pc.PIXELFORMAT_SRGBA8 : pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 8 });
  tex.lock().set(data); tex.unlock();
  return tex;
}

/** Tangent-space normal map from a tileable height field. */
function normalMap(device: pc.GraphicsDevice, h: Float32Array, strength: number): pc.Texture {
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  return texture(device, i => {
    const x = i % S, y = (i / S) | 0;
    const dx = (at(x - 1, y) - at(x + 1, y)) * strength, dy = (at(x, y - 1) - at(x, y + 1)) * strength, l = Math.hypot(dx, dy, 1);
    return [dx / l * 0.5 + 0.5, dy / l * 0.5 + 0.5, 1 / l * 0.5 + 0.5];
  }, false);
}

/** Asphalt: grain + aggregate speckle (diffuse multiplier over vertex colour), bumpy normal, patchy wear in gloss. */
export function asphaltMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const v = noise([[8, 0.5], [32, 0.3], [128, 0.2]]), wear = noise([[4, 0.7], [16, 0.3]]);
  const h = v.map(x => x + (Math.random() > 0.9 ? 0.25 : 0));
  const m = new pc.StandardMaterial();
  m.diffuseMap = texture(device, i => { const c = 0.86 + (v[i] - 0.5) * 0.22 + (h[i] - v[i]) * 0.4 + (wear[i] - 0.5) * 0.12; return [c, c, c]; }, false);
  m.diffuseVertexColor = true;
  m.normalMap = normalMap(device, h, 6);
  m.bumpiness = 0.6;
  m.glossMap = texture(device, i => { const g = 0.1 + Math.max(0, wear[i] - 0.55) * 1.2; return [g, g, g]; }, false); // polished tyre tracks
  m.glossMapChannel = 'r';
  m.gloss = 0.5;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}

/** Weathered render/plaster for buildings: stains, streaks and a stucco bump; tinted by vertex colour. */
export function plasterMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const blot = noise([[4, 0.6], [16, 0.4]]), fine = noise([[64, 0.5], [256, 0.5]]);
  const streak = new Float32Array(S * S);
  const cols = noise([[32, 1]]);
  for (let i = 0; i < S * S; i++) streak[i] = cols[i % S] * (1 - ((i / S) | 0) / S * 0.3); // vertical monsoon streaks
  const m = new pc.StandardMaterial();
  m.diffuseMap = texture(device, i => { const c = 0.9 + (fine[i] - 0.5) * 0.1 - Math.max(0, blot[i] - 0.55) * 0.5 - Math.max(0, streak[i] - 0.6) * 0.35; return [c, c * 0.99, c * 0.96]; }, false);
  m.diffuseVertexColor = true;
  m.normalMap = normalMap(device, fine, 3);
  m.bumpiness = 0.5;
  m.gloss = 0.18;
  m.update();
  return m;
}

/** Grass/dust ground for the terrain: green patches over dry earth. */
export function groundMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const patch = noise([[6, 0.6], [24, 0.4]]), fine = noise([[128, 0.6], [256, 0.4]]);
  const m = new pc.StandardMaterial();
  m.diffuseMap = texture(device, i => {
    const g = Math.min(1, Math.max(0, (patch[i] - 0.4) * 3)), f = 0.85 + fine[i] * 0.3;
    return [(0.5 * (1 - g) + 0.3 * g) * f, (0.45 * (1 - g) + 0.42 * g) * f, (0.34 * (1 - g) + 0.18 * g) * f];
  }, true);
  m.normalMap = normalMap(device, fine, 4);
  m.gloss = 0.1;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}

/** Streetlight heads: dim by day, glowing at night (see TimeOfDay). */
export function lampHeadMaterial(): pc.StandardMaterial {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0.9, 0.9, 0.85);
  m.emissive = new pc.Color(1, 0.82, 0.55);
  m.emissiveIntensity = 0;
  m.update();
  return m;
}
