import earcut from 'earcut';
import type { BuildingData, BuildingKind } from './MapTypes';
import { GeometryBuffer } from './MeshUtil';

// Procedural Colombo architecture from real OSM footprints.
// Everything is vertex-coloured into shared per-chunk buffers (one draw call per material per chunk);
// randomness is seeded by OSM way id, so a building looks identical every session.
//
//  lod 0 (near): windows, shopfronts, signboards, balconies, parapets, roof tanks
//  lod 1 (far):  plain extrusion + roof shape, same colours

export interface BuildingBuffers {
  solid: GeometryBuffer;  // walls, roofs, trims
  glass: GeometryBuffer;  // windows / curtain walls (glossy material)
  tanks: number[];        // rooftop water tank positions [x,y,z,scale,...] -> hardware instanced
}

type V3 = [number, number, number];

// Palettes observed around Colombo: whitewash and pastel lime-wash on houses, cream/grey render on
// shophouses, sun-faded blues/greens/yellows, unpainted concrete on older commercial blocks.
const PAL = {
  house: [0xf1ece0, 0xe9dfc4, 0xf3e3b5, 0xdfe8d2, 0xd6e3e8, 0xf0d6c8, 0xe8e0f0, 0xcfe0c0, 0xf5f0e6, 0xe6c99a],
  commercial: [0xe4ddcd, 0xd2cbbd, 0xbfbab0, 0xe8e1c8, 0xc8d4d6, 0xd9c7a6, 0xf0ead8, 0xa9a59c, 0xd6d0e0, 0xe0b98c],
  apartments: [0xeeeae0, 0xe2ddd2, 0xd8d2c6, 0xf2efe8, 0xd0d8dc, 0xe6dccb],
  office: [0xd9d9d6, 0xc4c6c8, 0xe6e4de, 0xb8bcc0],
  industrial: [0xb5b2a8, 0xa8aaa6, 0xc8c2b4, 0x9ea4a8],
  religious: [0xf8f6f0, 0xf6efe0, 0xf4e9c8],
  civic: [0xece4cc, 0xe8e2d6, 0xd9cfb8, 0xf2eee4],
};
const ROOF_TILE = [0xa0543a, 0x9a4a32, 0x8c5040, 0xb0624a, 0x7a4636];   // Calicut/half-round clay tiles
const ROOF_SHEET = [0x8c9094, 0x7c848a, 0x9aa0a0, 0x6c7a86, 0xa0603e]; // asbestos / zinc / colorbond
const GLASS = [0x2f3d48, 0x34444e, 0x2a3640, 0x3a4a52];
const CURTAIN = [0x4c6f85, 0x3f6070, 0x5a7d8c, 0x6a8a96, 0x34505e, 0x557868];
const SIGNS = [0xd8262e, 0xf2c230, 0x1f5fa8, 0x1e8a4a, 0xf07820, 0xffffff, 0x7a1fa0, 0x00a0c8];
const SHUTTER = 0x8e9396, SHOP_DARK = 0x2a2826, DOOR = 0x5a3a24, TRIM = 0xf4f2ec;

const FLOOR = 3.3;

export function newBuffers(): BuildingBuffers {
  return { solid: new GeometryBuffer(), glass: new GeometryBuffer(), tanks: [] };
}

export function buildBuildings(buildings: BuildingData[], out: BuildingBuffers, lod: 0 | 1, skip?: Set<number>) {
  for (const b of buildings) if (!skip?.has(b.id)) buildOne(b, out, lod);
}

function buildOne(b: BuildingData, out: BuildingBuffers, lod: 0 | 1) {
  const rnd = rng(b.id);
  const p = b.p, n = p.length / 2;
  const { solid: g, glass } = out;
  const kind = b.k ?? 'commercial';
  const levels = Math.max(1, b.l ?? Math.round(b.h / FLOOR));
  const h = b.h;

  let area2 = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area2 += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  const s = area2 > 0 ? 1 : -1;
  const area = Math.abs(area2) / 2;

  const wall = b.c ?? pick(rnd, PAL[palKey(kind)]);
  const curtain = (kind === 'office' && h > 18 && rnd() < 0.75) || (kind === 'commercial' && h > 25 && rnd() < 0.4);
  const glassCol = curtain ? pick(rnd, CURTAIN) : pick(rnd, GLASS);
  const shopfront = kind === 'shop' || (kind === 'commercial' && rnd() < 0.85) || (kind === 'apartments' && rnd() < 0.3);
  const groundH = shopfront ? 4 : FLOOR;
  const balconies = (kind === 'apartments' && rnd() < 0.8) || (kind === 'commercial' && levels > 1 && rnd() < 0.35);
  const roof = roofStyle(b, kind, area, rnd);
  const parapet = roof === 'flat' && kind !== 'hut' ? 0.6 + rnd() * 0.6 : 0;
  const bandEvery = rnd() < 0.5; // painted floor band trims
  const signCol = pick(rnd, SIGNS);
  // Picked before the detail loop: LOD 0 consumes extra random numbers, LOD 1 must still match.
  const roofCol = b.rc ?? (roof === 'hip' || roof === 'gable'
    ? pick(rnd, kind === 'house' || kind === 'religious' ? ROOF_TILE : ROOF_SHEET)
    : shade(wall, 0.72));
  let doorPlaced = false;

  // Walls, per footprint edge.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[j * 2], z1 = p[j * 2 + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.05) continue;
    const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
    const nx = uz * s, nz = -ux * s; // outward normal
    const lit = shade(wall, 0.88 + 0.12 * Math.abs(nx));
    const N: V3 = [nx, 0, nz];
    const at = (t: number, y: number, off = 0): V3 => [x0 + ux * t + nx * off, y, z0 + uz * t + nz * off];

    if (curtain) {
      // Concrete podium/ground floor, glass above with spandrel lines per floor.
      quad(g, [at(0, 0), at(L, 0), at(L, groundH), at(0, groundH)], N, lit);
      quad(glass, [at(0, groundH), at(L, groundH), at(L, h), at(0, h)], N, shade(glassCol, 0.9 + 0.1 * Math.abs(nz)));
      if (lod === 0) for (let f = 1; f < levels; f++) {
        const y = groundH + (f - 1) * ((h - groundH) / Math.max(1, levels - 1));
        quad(g, [at(0, y, 0.04), at(L, y, 0.04), at(L, y + 0.25, 0.04), at(0, y + 0.25, 0.04)], N, shade(glassCol, 0.6));
      }
    } else {
      quad(g, [at(0, 0), at(L, 0), at(L, h), at(0, h)], N, lit);
    }
    if (parapet) quad(g, [at(0, h), at(L, h), at(L, h + parapet), at(0, h + parapet)], N, shade(lit, 0.95));
    if (lod === 1 || curtain || L < 1.6) continue;

    // --- Near detail ---
    const bays = Math.max(1, Math.floor(L / (kind === 'house' ? 3.6 : 3.0)));
    const bw = L / bays;
    const upperH = levels > 1 ? (h - groundH - 0.3) / (levels - 1) : FLOOR;

    // Ground floor
    if (shopfront && L > 3) {
      // Open shop bays with roller shutters, signboard band above: the Pettah/Galle Road look.
      for (let k = 0; k < bays; k++) {
        const t0 = k * bw + 0.25, t1 = (k + 1) * bw - 0.25;
        const open = rnd() < 0.7;
        quad(g, [at(t0, 0.1, 0.03), at(t1, 0.1, 0.03), at(t1, 2.9, 0.03), at(t0, 2.9, 0.03)], N, open ? SHOP_DARK : SHUTTER);
      }
      const sc = rnd() < 0.7 ? signCol : pick(rnd, SIGNS);
      box(g, at(L / 2, 0, 0.25), ux, uz, nx, nz, L / 2 - 0.1, 0.2, 3.0, 3.85, sc);
      // Cantilevered rain/sun awning over the pavement.
      if (rnd() < 0.6) slab(g, at(0, 2.95, 0), at(L, 2.95, 0), nx, nz, 1.3, 0.08, shade(wall, 0.7));
    } else {
      for (let k = 0; k < bays; k++) {
        const tc = (k + 0.5) * bw;
        if (!doorPlaced && kind !== 'industrial' && k === Math.floor(bays / 2) && L > 3) {
          quad(g, [at(tc - 0.5, 0, 0.03), at(tc + 0.5, 0, 0.03), at(tc + 0.5, 2.2, 0.03), at(tc - 0.5, 2.2, 0.03)], N, DOOR);
          doorPlaced = true;
        } else if (kind !== 'industrial' || k % 2 === 0) window_(glass, g, at, tc, 0.9, Math.min(1.4, bw - 0.8), 1.4, N, glassCol, kind === 'house');
      }
    }

    // Upper floors
    for (let f = 1; f < levels; f++) {
      const y = groundH + (f - 1) * upperH;
      if (bandEvery) quad(g, [at(0, y, 0.04), at(L, y, 0.04), at(L, y + 0.22, 0.04), at(0, y + 0.22, 0.04)], N, TRIM);
      for (let k = 0; k < bays; k++) {
        const tc = (k + 0.5) * bw;
        window_(glass, g, at, tc, y + 0.9, Math.min(1.5, bw - 0.7), Math.min(1.5, upperH - 1.2), N, glassCol, kind === 'house');
      }
      if (balconies && L > 4 && (f % 2 === 1 || kind === 'apartments')) {
        // Slab + solid parapet wall, typical of Colombo apartment and shophouse balconies.
        const t0 = L * 0.15, t1 = L * 0.85;
        slab(g, at(t0, y, 0), at(t1, y, 0), nx, nz, 1.1, 0.15, shade(wall, 0.92));
        quad(g, [at(t0, y + 0.15, 1.1), at(t1, y + 0.15, 1.1), at(t1, y + 1.05, 1.1), at(t0, y + 1.05, 1.1)], N, shade(wall, 1.03));
      }
    }
  }

  // Roof
  if (roof === 'flat') {
    const tris = earcut(p);
    const r = g.vertexCount;
    for (let i = 0; i < n; i++) g.vertex(p[i * 2], h, p[i * 2 + 1], 0, 1, 0, roofCol);
    for (let i = 0; i < tris.length; i += 3) {
      if (s > 0) g.idx.push(r + tris[i], r + tris[i + 2], r + tris[i + 1]);
      else g.idx.push(r + tris[i], r + tris[i + 1], r + tris[i + 2]);
    }
    if (lod === 0 && kind !== 'industrial' && kind !== 'hut' && area > 30 && rnd() < 0.8) {
      // Black/blue rooftop water tank: ubiquitous in Colombo. Instanced, see MapChunkManager.
      let cx = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
      out.tanks.push(cx / n, h, cz / n, 0.8 + rnd() * 0.5);
    }
  } else {
    pitchedRoof(g, p, h, roof, roofCol, kind === 'house' ? 0.5 : 0.25);
  }
}

type Roof = 'flat' | 'hip' | 'gable';

function roofStyle(b: BuildingData, kind: BuildingKind, area: number, rnd: () => number): Roof {
  if (b.r) return b.r === 'flat' ? 'flat' : /gable|saltbox/.test(b.r) ? 'gable' : 'hip';
  if (b.h > 14 || area > 900) return 'flat';
  switch (kind) {
    case 'house': return rnd() < 0.7 ? 'hip' : rnd() < 0.5 ? 'gable' : 'flat';
    case 'hut': case 'industrial': return 'gable';
    case 'religious': case 'civic': return rnd() < 0.6 ? 'hip' : 'flat';
    case 'commercial': return rnd() < 0.25 ? 'hip' : 'flat';
    default: return 'flat';
  }
}

/** Hip or gable roof over the footprint's oriented bounding box (good fit for the near-rectangular houses that get one). */
function pitchedRoof(g: GeometryBuffer, p: number[], h: number, style: Roof, c: number, overhang: number) {
  const n = p.length / 2;
  let best = 0, ax = 1, az = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1], l = Math.hypot(dx, dz);
    if (l > best) { best = l; ax = dx / l; az = dz / l; }
  }
  let bx = -az, bz = ax;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = p[i * 2] * ax + p[i * 2 + 1] * az, bb = p[i * 2] * bx + p[i * 2 + 1] * bz;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, bb); b1 = Math.max(b1, bb);
  }
  a0 -= overhang; a1 += overhang; b0 -= overhang; b1 += overhang;
  if (b1 - b0 > a1 - a0) { [ax, az, bx, bz] = [bx, bz, -ax, -az]; [a0, a1, b0, b1] = [b0, b1, -a1, -a0]; }
  const W = b1 - b0, L = a1 - a0, rise = Math.min(W * 0.32, 4);
  const pt = (a: number, bb: number, y: number): V3 => [ax * a + bx * bb, y, az * a + bz * bb];
  const inset = style === 'hip' ? W / 2 : 0;
  const bm = (b0 + b1) / 2, y0 = h - 0.15, y1 = h + rise;
  const r0 = pt(a0 + inset, bm, y1), r1 = pt(a1 - inset, bm, y1);
  const c00 = pt(a0, b0, y0), c10 = pt(a1, b0, y0), c11 = pt(a1, b1, y0), c01 = pt(a0, b1, y0);
  const slopeN = (dirx: number, dirz: number): V3 => { const k = W / 2, l = Math.hypot(rise, k); return [dirx * rise / l, k / l, dirz * rise / l]; };
  quad(g, [c00, c10, r1, r0], slopeN(-bx, -bz), c);
  quad(g, [c11, c01, r0, r1], slopeN(bx, bz), shade(c, 0.9));
  if (style === 'hip') {
    tri(g, [c01, c00, r0], slopeN(-ax, -az), shade(c, 0.95));
    tri(g, [c10, c11, r1], slopeN(ax, az), shade(c, 0.85));
  } else {
    const wall = 0xe8e2d4; // gable end walls
    tri(g, [c01, c00, r0], [-ax, 0, -az], wall);
    tri(g, [c10, c11, r1], [ax, 0, az], wall);
  }
  // Ceiling underside so the overhang isn't see-through from below.
  quad(g, [c00, c01, c11, c10], [0, -1, 0], shade(c, 0.5));
}

function window_(glass: GeometryBuffer, g: GeometryBuffer, at: (t: number, y: number, o?: number) => V3,
  tc: number, y: number, w: number, hgt: number, N: V3, col: number, frame: boolean) {
  if (w < 0.4 || hgt < 0.4) return;
  const hw = w / 2;
  if (frame) quad(g, [at(tc - hw - 0.12, y - 0.12, 0.02), at(tc + hw + 0.12, y - 0.12, 0.02), at(tc + hw + 0.12, y + hgt + 0.12, 0.02), at(tc - hw - 0.12, y + hgt + 0.12, 0.02)], N, TRIM);
  quad(glass, [at(tc - hw, y, 0.04), at(tc + hw, y, 0.04), at(tc + hw, y + hgt, 0.04), at(tc - hw, y + hgt, 0.04)], N, col);
}

/** Horizontal slab projecting `depth` outward from the wall line a->b. */
function slab(g: GeometryBuffer, a: V3, b: V3, nx: number, nz: number, depth: number, thick: number, c: number) {
  const o = (v: V3, d: number, dy: number): V3 => [v[0] + nx * d, v[1] + dy, v[2] + nz * d];
  quad(g, [o(a, 0, thick), o(b, 0, thick), o(b, depth, thick), o(a, depth, thick)], [0, 1, 0], c);
  quad(g, [o(a, depth, 0), o(b, depth, 0), o(b, depth, thick), o(a, depth, thick)], [nx, 0, nz], shade(c, 0.9));
  quad(g, [o(a, 0, 0), o(b, 0, 0), o(b, depth, 0), o(a, depth, 0)], [0, -1, 0], shade(c, 0.6));
}

/** Box centred at c (on the wall line) with half-length hl along u and depth d along n, from y0 to y1. */
function box(g: GeometryBuffer, c: V3, ux: number, uz: number, nx: number, nz: number, hl: number, d: number, y0: number, y1: number, col: number) {
  const P = (t: number, o: number, y: number): V3 => [c[0] + ux * t + nx * o, y, c[2] + uz * t + nz * o];
  quad(g, [P(-hl, d, y0), P(hl, d, y0), P(hl, d, y1), P(-hl, d, y1)], [nx, 0, nz], col);
  quad(g, [P(-hl, -d, y1), P(hl, -d, y1), P(hl, d, y1), P(-hl, d, y1)], [0, 1, 0], shade(col, 0.8));
  quad(g, [P(-hl, -d, y0), P(hl, -d, y0), P(hl, d, y0), P(-hl, d, y0)], [0, -1, 0], shade(col, 0.5));
  quad(g, [P(-hl, -d, y0), P(-hl, d, y0), P(-hl, d, y1), P(-hl, -d, y1)], [-ux, 0, -uz], shade(col, 0.8));
  quad(g, [P(hl, -d, y0), P(hl, d, y0), P(hl, d, y1), P(hl, -d, y1)], [ux, 0, uz], shade(col, 0.8));
}

/** Quad with winding chosen to face normal N, so callers never think about vertex order. */
function quad(g: GeometryBuffer, v: V3[], N: V3, c: number) {
  const a = g.vertexCount;
  for (const p of v) g.vertex(p[0], p[1], p[2], N[0], N[1], N[2], c);
  if (faces(v, N)) g.idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
  else g.idx.push(a, a + 2, a + 1, a, a + 3, a + 2);
}

function tri(g: GeometryBuffer, v: V3[], N: V3, c: number) {
  const a = g.vertexCount;
  for (const p of v) g.vertex(p[0], p[1], p[2], N[0], N[1], N[2], c);
  if (faces(v, N)) g.idx.push(a, a + 1, a + 2); else g.idx.push(a, a + 2, a + 1);
}

function faces(v: V3[], N: V3) {
  const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
  const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  return cx * N[0] + cy * N[1] + cz * N[2] >= 0;
}

function palKey(k: BuildingKind): keyof typeof PAL {
  return k === 'shop' ? 'commercial' : k === 'hut' ? 'house' : k;
}

/** mulberry32 seeded by OSM id: stable across sessions and data refreshes. */
export function rng(seed: number) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, a: T[]): T { return a[Math.floor(r() * a.length)]; }

function shade(c: number, f: number): number {
  const ch = (v: number) => Math.min(255, Math.round(v * f));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}
