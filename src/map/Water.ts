import * as pc from 'playcanvas';
import earcut, { flatten } from 'earcut';
import { GeometryBuffer, vertexColorMaterial } from './MeshUtil';
import { groundAt } from './Terrain';

// Lakes, canals, basins and beaches from public/data/water.json (scripts/fetch-water.ts), plus the animated water
// material shared with the sea.
// ponytail: visual only — you can still drive across water; add shoreline collision if that bothers.

export interface Area { n?: string; p: number[]; holes: number[][] }
export interface WaterData { water: Area[]; beach: Area[] }

/** Dark, glossy, sky-reflecting water with two-scale ripples; call update() to move them. */
export class WaterSurface {
  readonly material = new pc.StandardMaterial();
  private t = 0;

  constructor(device: pc.GraphicsDevice) {
    const S = 256, data = new Uint8Array(S * S * 4), TAU = Math.PI * 2;
    // Tileable ripple height field from a few integer-frequency waves; normal = its gradient.
    const waves = [[3, 1, 1], [-2, 4, 0.7], [7, -3, 0.4], [5, 9, 0.25], [-11, -6, 0.18]];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let dx = 0, dy = 0;
      for (const [i, j, a] of waves) { const c = Math.cos(TAU * (i * x + j * y) / S) * a / Math.hypot(i, j); dx += c * i; dy += c * j; }
      const nx = -dx * 0.22, ny = -dy * 0.22, l = Math.hypot(nx, ny, 1), k = (y * S + x) * 4;
      data[k] = (nx / l * 0.5 + 0.5) * 255; data[k + 1] = (ny / l * 0.5 + 0.5) * 255; data[k + 2] = (1 / l * 0.5 + 0.5) * 255; data[k + 3] = 255;
    }
    const tex = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 8 });
    tex.lock().set(data); tex.unlock();
    const m = this.material;
    m.diffuse = new pc.Color(0.035, 0.15, 0.17);
    m.normalMap = tex; m.bumpiness = 0.55; m.normalMapTiling = new pc.Vec2(0.6, 0.6);
    m.useMetalness = true; m.metalness = 0.35; m.gloss = 0.9;
    m.cull = pc.CULLFACE_NONE;
    m.update();
  }

  update(dt: number) {
    this.t += dt;
    this.material.normalMapOffset = new pc.Vec2((this.t * 0.025) % 1, (this.t * 0.014) % 1);
    this.material.update();
  }
}

/** Fill a polygon (with holes) into g. height() gives each vertex's y. */
function polygon(g: GeometryBuffer, a: Area, color: number, height: (x: number, z: number) => number) {
  const { vertices, holes, dimensions } = flatten([a.p, ...a.holes].map(r => Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]])));
  const base = g.vertexCount;
  for (let i = 0; i < vertices.length; i += 2) g.vertex(vertices[i], height(vertices[i], vertices[i + 1]), vertices[i + 1], 0, 1, 0, color);
  for (const i of earcut(vertices, holes, dimensions)) g.idx.push(base + i);
}

/** Flat water level for an area: high percentile of the terrain under it, so the ground never pokes through. */
function level(a: Area) {
  const h: number[] = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < a.p.length; i += 2) { h.push(groundAt(a.p[i], a.p[i + 1])); x0 = Math.min(x0, a.p[i]); x1 = Math.max(x1, a.p[i]); z0 = Math.min(z0, a.p[i + 1]); z1 = Math.max(z1, a.p[i + 1]); }
  for (let x = x0; x <= x1; x += 25) for (let z = z0; z <= z1; z += 25) h.push(groundAt(x, z));
  h.sort((p, q) => p - q);
  return h[Math.floor(h.length * 0.8)] - 0.12; // under road surfaces (bridges, causeways stay dry)
}

export function buildWater(app: pc.AppBase, data: WaterData, water: pc.Material) {
  const add = (name: string, g: GeometryBuffer, mat: pc.Material) => {
    const mesh = g.toMesh(app.graphicsDevice);
    if (!mesh) return;
    const e = new pc.Entity(name);
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], castShadows: false, receiveShadows: true });
    app.root.addChild(e);
  };
  const w = new GeometryBuffer();
  for (const a of data.water) { const y = level(a); polygon(w, a, 0xffffff, () => y); }
  add('inland water', w, water);
  const s = new GeometryBuffer();
  for (const a of data.beach) polygon(s, a, 0xd9c394, (x, z) => Math.max(0.05, groundAt(x, z) - 0.1));
  add('beaches', s, vertexColorMaterial(true));
}
