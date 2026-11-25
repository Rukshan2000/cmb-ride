import * as pc from 'playcanvas';

/** Seamless procedural asphalt grain (tileable value noise + aggregate speckle), used as a diffuse multiplier. */
export function asphaltMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const S = 256, data = new Uint8Array(S * S * 4);
  const grid = (n: number) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a; };
  const octaves = [[8, 0.5], [32, 0.3], [128, 0.2]].map(([n, w]) => [grid(n), n, w] as const);
  const sample = (g: Float32Array, n: number, x: number, y: number) => {
    const fx = (x / S) * n, fy = (y / S) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i: number, j: number) => g[((j % n) * n) + (i % n)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const [g, n, w] of octaves) v += sample(g, n, x, y) * w;
    const speck = Math.random();
    let c = 0.86 + (v - 0.5) * 0.22 + (speck > 0.97 ? 0.12 : speck < 0.03 ? -0.1 : 0);
    c = Math.max(0, Math.min(1, c));
    const i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = c * 255; data[i + 3] = 255;
  }
  const tex = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 8 });
  tex.lock().set(data); tex.unlock();
  const m = new pc.StandardMaterial();
  m.diffuseMap = tex;
  m.diffuseVertexColor = true;
  m.gloss = 0.22;
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
