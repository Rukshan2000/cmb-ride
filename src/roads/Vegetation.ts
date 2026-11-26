import * as pc from 'playcanvas';
import type { GeometryBuffer } from '../map/MeshUtil';

// Trees, palms, bushes, flowering plants and garden walls, plus the wind that moves the foliage.
// Leaves are alpha-cut cards from a small atlas (left half: leaf cluster, right half: palm frond).
// Vertex alpha is the sway weight (0 = rigid, 255 = free to move).

type R = () => number;
const LEAF_TINT = [0x5d8f36, 0x6a9c3c, 0x4f7f33, 0x78a445, 0x467530, 0x84a83e];
const BLOSSOM = [0xe8452c /* flamboyant */, 0xf2c230 /* ehela */, 0xd63a8c /* bougainvillea */, 0xf4f1ea /* araliya */];
const BARK = 0x6b5846, PALM_BARK = 0x8a7a66;
const LEAVES: [number, number, number, number] = [0, 0, 0.5, 1], FROND: [number, number, number, number] = [0.5, 0, 1, 1];

function vert(g: GeometryBuffer, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, u: number, v: number, sway: number) {
  g.vertex(x, y, z, nx, ny, nz, c);
  g.col[g.col.length - 1] = Math.round(Math.max(0, Math.min(1, sway)) * 255);
  g.uv.push(u, v);
}

/** A leaf card centred at (x,y,z), randomly turned, normals pointing out of the canopy for soft shading. */
function card(g: GeometryBuffer, x: number, y: number, z: number, size: number, c: number, nx: number, ny: number, nz: number, sway: number, r: R) {
  const a = r() * Math.PI * 2, tilt = (r() - 0.5) * 1.6;
  const ax = Math.cos(a) * size / 2, az = Math.sin(a) * size / 2;
  const bx = -Math.sin(a) * Math.sin(tilt) * size / 2, by = Math.cos(tilt) * size / 2, bz = Math.cos(a) * Math.sin(tilt) * size / 2;
  const v = g.vertexCount, [u0, v0, u1, v1] = LEAVES, l = Math.hypot(nx, ny + 0.6, nz) || 1;
  const n = [nx / l, (ny + 0.6) / l, nz / l] as const;
  vert(g, x - ax - bx, y - by, z - az - bz, ...n, c, u0, v0, sway); vert(g, x + ax - bx, y - by, z + az - bz, ...n, c, u1, v0, sway);
  vert(g, x + ax + bx, y + by, z + az + bz, ...n, c, u1, v1, sway); vert(g, x - ax + bx, y + by, z - az + bz, ...n, c, u0, v1, sway);
  g.quad(v);
}

/** Ellipsoidal crown of leaf cards. */
function crown(g: GeometryBuffer, x: number, y: number, z: number, rx: number, ry: number, count: number, size: number, c: number, sway: number, r: R, blossom?: number) {
  for (let i = 0; i < count; i++) {
    const th = Math.acos(2 * r() - 1), ph = r() * Math.PI * 2, d = 0.55 + 0.45 * Math.sqrt(r());
    const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
    const shade = 0.72 + (ny + 1) * 0.18 + (r() - 0.5) * 0.1; // darker underneath
    const col = blossom !== undefined && ny > -0.1 && r() < 0.45 ? blossom : tint(c, shade);
    card(g, x + nx * rx * d, y + ny * ry * d, z + nz * rx * d, size * (0.8 + r() * 0.45), col, nx, ny, nz, sway * (0.4 + 0.6 * r()), r);
  }
}

const tint = (c: number, f: number) => (Math.min(255, ((c >> 16) & 255) * f) << 16) | (Math.min(255, ((c >> 8) & 255) * f) << 8) | Math.min(255, (c & 255) * f);

/** Tapered six-sided limb from a to b. */
function limb(g: GeometryBuffer, a: number[], b: number[], r0: number, r1: number, c: number) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l = Math.hypot(dx, dy, dz) || 1;
  let ux = -dz, uz = dx; const ul = Math.hypot(ux, uz);
  if (ul < 1e-3) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
  const wx = (dy * uz) / l, wy = (dz * ux - dx * uz) / l, wz = (-dy * ux) / l; // second axis ⟂ limb
  const v = g.vertexCount, N = 6;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2, nx = ux * Math.cos(t) + wx * Math.sin(t), ny = wy * Math.sin(t), nz = uz * Math.cos(t) + wz * Math.sin(t);
    const col = tint(c, 0.85 + (i % 2) * 0.25);
    g.vertex(a[0] + nx * r0, a[1] + ny * r0, a[2] + nz * r0, nx, ny, nz, col);
    g.vertex(b[0] + nx * r1, b[1] + ny * r1, b[2] + nz * r1, nx, ny, nz, col);
  }
  for (let i = 0; i < N; i++) { const p = v + i * 2; g.idx.push(p, p + 1, p + 3, p, p + 3, p + 2); }
}

/** Shade / flowering tree: flared trunk, forking branches, a leaf crown on each. big = rain tree on main roads. */
export function tree(wood: GeometryBuffer, leaves: GeometryBuffer, x: number, z: number, big: boolean, r: R) {
  const h = big ? 3.8 + r() * 1.8 : 2.1 + r() * 1.1, rad = big ? 4.2 + r() * 2.2 : 1.9 + r() * 1.1;
  const col = LEAF_TINT[Math.floor(r() * LEAF_TINT.length)];
  const blossom = r() < (big ? 0.12 : 0.22) ? BLOSSOM[Math.floor(r() * BLOSSOM.length)] : undefined;
  const t = big ? 0.34 : 0.17, top = [x + (r() - 0.5) * 0.5, h, z + (r() - 0.5) * 0.5];
  limb(wood, [x, 0, z], [x, 0.5, z], t * 1.7, t * 1.1, BARK);
  limb(wood, [x, 0.5, z], top, t * 1.1, t * 0.75, BARK);
  const n = big ? 4 : 3, turn = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = turn + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.6, out = rad * (0.45 + r() * 0.25);
    const end = [top[0] + Math.cos(a) * out, h + rad * (0.25 + r() * 0.25), top[2] + Math.sin(a) * out];
    limb(wood, top, end, t * 0.55, t * 0.18, BARK);
    crown(leaves, end[0], end[1] + 0.3, end[2], rad * 0.55, rad * (big ? 0.28 : 0.42), big ? 16 : 11, rad * 0.48, col, 0.55, r, blossom);
  }
  crown(leaves, top[0], h + rad * 0.55, top[2], rad * 0.62, rad * (big ? 0.3 : 0.5), big ? 20 : 12, rad * 0.5, col, 0.65, r, blossom);
}

/** Coconut palm: curved ringed trunk, arching fronds, coconuts. */
export function palm(wood: GeometryBuffer, leaves: GeometryBuffer, x: number, z: number, r: R) {
  const h = 7 + r() * 4.5, lx = (r() - 0.5) * 1.8, lz = (r() - 0.5) * 1.8, SEG = 7;
  const at = (t: number) => [x + lx * t * t, h * t, z + lz * t * t];
  for (let i = 0; i < SEG; i++) limb(wood, at(i / SEG), at((i + 1) / SEG), 0.2 - 0.07 * (i / SEG), 0.17 - 0.07 * (i / SEG), PALM_BARK);
  const [tx, ty, tz] = at(1);
  for (let i = 0; i < 4; i++) { const a = r() * 6.28; limb(wood, [tx, ty - 0.1, tz], [tx + Math.cos(a) * 0.3, ty - 0.45, tz + Math.sin(a) * 0.3], 0.09, 0.14, 0x7a6a2a); }
  const N = 11, [u0, , u1] = FROND;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2 + r() * 0.4, ca = Math.cos(a), sa = Math.sin(a), len = 3.4 + r() * 1.2, rise = 0.4 + r() * 1.6, S = 5;
    const col = tint(0x6f9a38, 0.8 + r() * 0.35), v = g0(leaves);
    for (let i = 0; i <= S; i++) {
      const t = i / S, y = ty + rise * t * 2 - (rise + 1.6) * t * t * 1.5, w = 0.75;
      for (const s of [-1, 1]) vert(leaves, tx + ca * len * t - sa * w * s, y - 0.15, tz + sa * len * t + ca * w * s, 0, 1, 0, col, s < 0 ? u0 : u1, t, t);
    }
    for (let i = 0; i < S; i++) { const p = v + i * 2; leaves.idx.push(p, p + 1, p + 3, p, p + 3, p + 2); }
  }
}
const g0 = (g: GeometryBuffer) => g.vertexCount;

/** Low shrub; flowering ones carry coloured heads (bougainvillea, ixora, hibiscus). */
export function bush(leaves: GeometryBuffer, x: number, z: number, r: R, flowering = false) {
  const rad = 0.35 + r() * 0.4;
  crown(leaves, x, rad * 0.75, z, rad, rad * 0.8, 9, rad * 1.1, LEAF_TINT[Math.floor(r() * LEAF_TINT.length)], 0.25, r,
    flowering ? [0xd63a8c, 0xe0302a, 0xf07820, 0xf4f1ea][Math.floor(r() * 4)] : undefined);
}

/** A little bed of flowers: stems of grass cards with bright blooms on top. */
export function flowers(leaves: GeometryBuffer, blooms: GeometryBuffer, x: number, z: number, r: R) {
  const col = [0xf2437a, 0xf5c518, 0xe83a2a, 0x9a4ad8, 0xffffff, 0xff8a1e][Math.floor(r() * 6)];
  for (let i = 0; i < 7; i++) {
    const px = x + (r() - 0.5) * 1.2, pz = z + (r() - 0.5) * 0.7, y = 0.22 + r() * 0.22, s = 0.06 + r() * 0.04;
    card(leaves, px, y * 0.55, pz, y * 1.1, 0x4f8a30, 0, 1, 0, 0.2, r);
    const v = blooms.vertexCount;
    for (const [dx, dz] of [[-s, 0], [0, s], [s, 0], [0, -s]]) blooms.vertex(px + dx, y + 0.03, pz + dz, 0, 1, 0, col);
    blooms.quad(v);
  }
}

/** Leaf atlas drawn on a canvas, alpha-tested; wind sway is added in the vertex shader. */
export function foliageMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  const leaf = (x: number, y: number, len: number, ang: number, shade: number) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = `rgb(${shade},${shade},${shade * 0.92})`;
    g.beginPath(); g.ellipse(0, 0, len, len * 0.42, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = `rgba(90,90,80,0.5)`; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke();
    g.restore();
  };
  for (let i = 0; i < 150; i++) {
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * 104;
    leaf(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 15 + Math.random() * 11, Math.random() * 6.28, 165 + Math.random() * 90);
  }
  g.strokeStyle = '#b8b490'; g.lineWidth = 6; g.beginPath(); g.moveTo(384, 0); g.lineTo(384, 256); g.stroke(); // frond rib
  for (let y = 6; y < 250; y += 9) for (const s of [-1, 1]) {
    const len = 110 * Math.sin(Math.PI * (0.12 + (y / 256) * 0.82));
    g.save(); g.translate(384, y); g.scale(s, 1); g.rotate(0.38);
    g.fillStyle = `rgb(${200 + Math.random() * 55},${210 + Math.random() * 45},170)`;
    g.beginPath(); g.moveTo(0, -3); g.quadraticCurveTo(len * 0.6, -5, len, 4); g.quadraticCurveTo(len * 0.5, 4, 0, 3); g.fill();
    g.restore();
  }
  const tex = new pc.Texture(device, { width: 512, height: 256, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, anisotropy: 4 });
  tex.setSource(c);
  const m = new pc.StandardMaterial();
  m.diffuseMap = tex; m.diffuseVertexColor = true;
  m.opacityMap = tex; m.opacityMapChannel = 'a'; m.alphaTest = 0.35;
  m.gloss = 0.1; m.cull = pc.CULLFACE_NONE;
  const chunks = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
  chunks.set('litUserDeclarationVS', 'uniform vec3 uWind; // x,z push (m), time');
  chunks.set('litUserMainEndVS', `
    #ifdef VERTEX_COLOR
    {
      float phase = vertex_position.x * 0.31 + vertex_position.z * 0.27;
      float gust = 0.7 + 0.3 * sin(uWind.z * 2.3 + phase);
      float flutter = sin(uWind.z * 9.0 + phase * 7.0 + vertex_position.y * 3.0) * 0.12;
      vec2 push = uWind.xy * (gust + flutter) * vertex_color.a;
      gl_Position += matrix_viewProjection * vec4(push.x, flutter * vertex_color.a * length(uWind.xy) * 0.4, push.y, 0.0);
    }
    #endif`);
  m.setParameter('uWind', [0, 0, 0]);
  m.update();
  return m;
}

/** Breeze all the time, with a proper gust every now and then (stronger and more often in a storm). */
export class Wind {
  private t = 0;
  private gustAt = 8;
  private gustLen = 0;
  private strength = 0;
  private dir = Math.random() * 6.28;

  constructor(private mat: pc.StandardMaterial, private onGust: (strength: number, seconds: number) => void) {}

  update(dt: number, storm: boolean) {
    this.t += dt;
    if (this.t > this.gustAt + this.gustLen) {
      this.gustAt = this.t + (storm ? 4 : 14) + Math.random() * (storm ? 8 : 30);
      this.gustLen = 5 + Math.random() * 6;
      this.strength = (storm ? 0.7 : 0.35) + Math.random() * 0.35;
      this.dir += (Math.random() - 0.5) * 1.5;
      setTimeout(() => this.onGust(this.strength, this.gustLen), (this.gustAt - this.t) * 1000);
    }
    const g = (this.t - this.gustAt) / this.gustLen;
    const amount = (storm ? 0.22 : 0.07) + (g > 0 && g < 1 ? Math.sin(Math.PI * g) * this.strength : 0);
    this.mat.setParameter('uWind', [Math.cos(this.dir) * amount, Math.sin(this.dir) * amount, this.t]);
  }
}
