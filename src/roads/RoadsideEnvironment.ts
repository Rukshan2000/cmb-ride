import type { ChunkData, RoadData } from '../map/MapTypes';
import type { GeometryBuffer } from '../map/MeshUtil';
import { isElevated } from '../map/RoadNetwork';
import { box } from './StreetFurniture';
import { rankOf } from './RoadMarkingGenerator';

// Roadside life along every road: shade trees (rain trees on main roads, palms / mango / jak on side streets),
// small roadside boutiques ('kade'), CEB concrete utility poles with overhead wires.
// Deterministic per road (seeded by OSM id); nothing is placed inside an OSM building footprint or in a junction.

const LEAF = [0x3f6b2c, 0x4a7a32, 0x36602a, 0x557f36, 0x2f5a26], TRUNK = 0x5a4a3c, PALM_TRUNK = 0x7a6a58;
const KADE_WALL = [0xe8dcc0, 0xd6e2d0, 0xf0e0b0, 0xdcd0e8, 0xe6cfc0], KADE_BOARD = [0xd8262e, 0xf2c230, 0x1f5fa8, 0x1e8a4a, 0xf07820];
const POLE = 0x9c9a92, WIRE = 0x1a1a1a, ZINC = 0x8c9094;

function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** True if (x,z) is on any road carriageway of this chunk (plus margin m). Used to keep props off every road. */
export function roadMask(c: ChunkData) {
  const CELL = 20, grid = new Map<string, number[]>(); // [x0,z0,x1,z1,hw,...]
  for (const r of c.roads) for (let i = 0; i < r.p.length - 2; i += 2) {
    const x0 = r.p[i], z0 = r.p[i + 1], x1 = r.p[i + 2], z1 = r.p[i + 3], hw = r.w / 2;
    for (let cx = Math.floor((Math.min(x0, x1) - hw) / CELL); cx <= Math.floor((Math.max(x0, x1) + hw) / CELL); cx++)
      for (let cz = Math.floor((Math.min(z0, z1) - hw) / CELL); cz <= Math.floor((Math.max(z0, z1) + hw) / CELL); cz++) {
        const k = cx + ',' + cz; (grid.get(k) ?? grid.set(k, []).get(k)!).push(x0, z0, x1, z1, hw);
      }
  }
  return (x: number, z: number, m: number) => {
    for (let cx = Math.floor((x - m) / CELL); cx <= Math.floor((x + m) / CELL); cx++)
      for (let cz = Math.floor((z - m) / CELL); cz <= Math.floor((z + m) / CELL); cz++) {
        const s = grid.get(cx + ',' + cz); if (!s) continue;
        for (let i = 0; i < s.length; i += 5) {
          const ex = s[i + 2] - s[i], ez = s[i + 3] - s[i + 1], l2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - s[i]) * ex + (z - s[i + 1]) * ez) / l2));
          if (Math.hypot(s[i] + ex * t - x, s[i + 1] + ez * t - z) < s[i + 4] + m) return true;
        }
      }
    return false;
  };
}

/** Footprint lookup: point inside any building (with margin) in this chunk. */
function occupancy(c: ChunkData) {
  const CELL = 20, grid = new Map<string, number[][]>();
  for (const b of c.buildings) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = i + ',' + j; (grid.get(k) ?? grid.set(k, []).get(k)!).push(b.p);
    }
  }
  const inside = (p: number[], x: number, z: number) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) if ((p[i * 2 + 1] > z) !== (p[j * 2 + 1] > z) && x < ((p[j * 2] - p[i * 2]) * (z - p[i * 2 + 1])) / (p[j * 2 + 1] - p[i * 2 + 1]) + p[i * 2]) c = !c; return c; };
  return (x: number, z: number, m: number) => {
    for (const [dx, dz] of [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]]) {
      const list = grid.get(Math.floor((x + dx) / CELL) + ',' + Math.floor((z + dz) / CELL));
      if (list?.some(p => inside(p, x + dx, z + dz))) return true;
    }
    return false;
  };
}

/** Low-poly blob canopy (lat-long sphere, squashed), per-vertex shade variation. */
function blob(g: GeometryBuffer, x: number, y: number, z: number, rx: number, ry: number, c: number, r: () => number) {
  const SU = 7, SV = 4, b = g.vertexCount;
  for (let v = 0; v <= SV; v++) for (let u = 0; u <= SU; u++) {
    const th = (v / SV) * Math.PI, ph = (u / SU) * Math.PI * 2, j = 0.85 + r() * 0.3;
    const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
    const sh = 0.8 + (ny + 1) * 0.15, col = ((Math.min(255, ((c >> 16) & 255) * sh) << 16) | (Math.min(255, ((c >> 8) & 255) * sh) << 8) | Math.min(255, (c & 255) * sh)) >>> 0;
    g.vertex(x + nx * rx * j, y + ny * ry * j, z + nz * rx * j, nx, ny, nz, col);
  }
  for (let v = 0; v < SV; v++) for (let u = 0; u < SU; u++) {
    const a = b + v * (SU + 1) + u, d = a + SU + 1;
    g.idx.push(a, d, a + 1, a + 1, d, d + 1);
  }
}

function palm(g: GeometryBuffer, x: number, z: number, r: () => number) {
  const h = 7 + r() * 4, lx = (r() - 0.5) * 0.8, lz = (r() - 0.5) * 0.8; // slight lean
  box(g, x + lx * 0.5, 0, z + lz * 0.5, 0, -1, 0.3, h, 0.3, PALM_TRUNK);
  const tx = x + lx, tz = z + lz;
  const FR = 9;
  for (let k = 0; k < FR; k++) { // drooping fronds: two-triangle strips out and down
    const a = (k / FR) * Math.PI * 2 + r() * 0.3, ca = Math.cos(a), sa = Math.sin(a), len = 3 + r();
    const px = -sa * 0.35, pz = ca * 0.35, col = LEAF[k % LEAF.length], b = g.vertexCount;
    g.vertex(tx - px, h, tz - pz, 0, 1, 0, col); g.vertex(tx + px, h, tz + pz, 0, 1, 0, col);
    g.vertex(tx + ca * len * 0.55 + px, h + 0.5, tz + sa * len * 0.55 + pz, 0, 1, 0, col); g.vertex(tx + ca * len * 0.55 - px, h + 0.5, tz + sa * len * 0.55 - pz, 0, 1, 0, col);
    g.vertex(tx + ca * len, h - 1.2, tz + sa * len, 0, 1, 0, col);
    g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b + 3, b + 2, b + 4);
  }
}

function shadeTree(g: GeometryBuffer, x: number, z: number, big: boolean, r: () => number) {
  const h = big ? 4 + r() * 2 : 2.2 + r(), rad = big ? 4.5 + r() * 2.5 : 2.3 + r() * 1.2;
  box(g, x, 0, z, 0, -1, big ? 0.55 : 0.32, h + 0.6, big ? 0.55 : 0.32, TRUNK);
  const col = LEAF[Math.floor(r() * LEAF.length)];
  blob(g, x, h + rad * 0.35, z, rad, rad * (big ? 0.42 : 0.7), col, r);
  if (big) blob(g, x + (r() - 0.5) * rad, h + rad * 0.5, z + (r() - 0.5) * rad, rad * 0.6, rad * 0.35, LEAF[(LEAF.indexOf(col) + 1) % LEAF.length], r);
}

/** Petti kade: small lean-to roadside shop with signboard, open front and zinc roof, facing the road. */
function kade(g: GeometryBuffer, x: number, z: number, fx: number, fz: number, r: () => number) {
  const wall = KADE_WALL[Math.floor(r() * KADE_WALL.length)], board = KADE_BOARD[Math.floor(r() * KADE_BOARD.length)];
  const W = 2.6 + r() * 1.5, D = 2.2;
  // box(): (ux,uz) forward = towards the road, w = across, d = depth
  box(g, x - fx * D / 2, 0, z - fz * D / 2, fx, fz, W, 2.6, D, wall);
  box(g, x + fx * 0.02, 0.9, z + fz * 0.02, fx, fz, W - 0.4, 1.4, 0.05, 0x2a2622);     // open front (dark interior)
  box(g, x + fx * 0.1, 0, z + fz * 0.1, fx, fz, W - 0.3, 0.9, 0.35, 0x8a6a4a);        // counter
  box(g, x + fx * 0.05, 2.3, z + fz * 0.05, fx, fz, W, 0.45, 0.06, board);            // signboard (blank)
  box(g, x - fx * (D / 2 - 0.5), 2.6, z - fz * (D / 2 - 0.5), fx, fz, W + 0.3, 0.06, D + 1.0, ZINC); // zinc roof overhang
  for (let k = 0; k < 4; k++) box(g, x + fx * 0.25 + (-fz) * (k - 1.5) * 0.45, 0.95, z + fz * 0.25 + fx * (k - 1.5) * 0.45, fx, fz, 0.3, 0.35, 0.25, [0xd04a2a, 0xe8c040, 0x3a8a3a, 0xf0f0e0][k]); // goods
}

function wire(g: GeometryBuffer, ax: number, az: number, bx: number, bz: number, y: number) {
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, px = (-dz / l) * 0.02, pz = (dx / l) * 0.02;
  const SAG = 6, b = g.vertexCount;
  for (let i = 0; i <= SAG; i++) {
    const t = i / SAG, sag = Math.sin(t * Math.PI) * 0.6;
    g.vertex(ax + dx * t - px, y - sag, az + dz * t - pz, 0, 1, 0, WIRE);
    g.vertex(ax + dx * t + px, y - sag + 0.03, az + dz * t + pz, 0, 1, 0, WIRE);
  }
  for (let i = 0; i < SAG; i++) { const a = b + i * 2; g.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
}

export function buildRoadside(c: ChunkData, solid: GeometryBuffer, foliage: GeometryBuffer, posts: number[]) {
  const inBuilding = occupancy(c), onRoad = roadMask(c);
  const blocked = (x: number, z: number, m: number) => inBuilding(x, z, m) || onRoad(x, z, m);
  const near = (x: number, z: number, list: number[] | undefined, stride: number, d: number) => {
    if (!list) return false;
    for (let i = 0; i < list.length; i += stride) if (Math.abs(list[i] - x) < d && Math.abs(list[i + 1] - z) < d) return true;
    return false;
  };
  const clear = (x: number, z: number, m: number) =>
    !blocked(x, z, m) && !near(x, z, c.junctions, 3, 14) && !near(x, z, c.cr, 5, 6) && !near(x, z, c.sig, 5, 6) && !near(x, z, c.bus, 2, 6);

  for (const r of c.roads) {
    if (r.h === 'service' || r.w < 4 || isElevated(r)) continue;
    const rank = rankOf(r), rnd = rng(r.id);
    const kerb = r.w / 2 + (rank >= 1 ? 2.0 : 1.2);
    walk(r, rank >= 2 ? 22 : 26, (x, z, ux, uz, k) => {  // trees, alternating sides
      const s = k % 2 ? 1 : -1, tx = x + uz * kerb * s, tz = z - ux * kerb * s;
      if (rnd() < (rank >= 2 ? 0.25 : 0.4) || !clear(tx, tz, 1.5)) return;
      const big = rank >= 2 && rnd() < 0.7;
      if (rank >= 2) shadeTree(foliage, tx, tz, big, rnd);
      else if (rnd() < 0.45) palm(foliage, tx, tz, rnd); else shadeTree(foliage, tx, tz, false, rnd);
      posts.push(tx, tz, big ? 0.3 : 0.2);
    });
    if (rank <= 2) walk(r, 55, (x, z, ux, uz) => {          // roadside kades on secondary and smaller streets
      if (rnd() > 0.35) return;
      const s = rnd() < 0.5 ? 1 : -1, off = r.w / 2 + (rank >= 1 ? 2.6 : 1.6) + 1.1, kx = x + uz * off * s, kz = z - ux * off * s;
      if (clear(kx, kz, 2.2)) { kade(solid, kx, kz, -uz * s, ux * s, rnd); posts.push(kx - uz * s * -1.1, kz + ux * s * -1.1, 1.2); }
    });
    // CEB concrete poles on the left kerb every ~35 m, wired together.
    let prev: [number, number] | null = null;
    walk(r, 35, (x, z, ux, uz) => {
      const px = x + uz * (r.w / 2 + 0.5), pz = z - ux * (r.w / 2 + 0.5);
      if (inBuilding(px, pz, 0.3) || onRoad(px, pz, 0.25)) { prev = null; return; }
      box(solid, px, 0, pz, ux, uz, 0.22, 9, 0.22, POLE);
      posts.push(px, pz, 0.13);
      box(solid, px, 8.3, pz, ux, uz, 1.4, 0.12, 0.12, POLE); // cross-arm
      if (prev && Math.hypot(prev[0] - px, prev[1] - pz) < 45) { wire(solid, prev[0], prev[1], px, pz, 8.4); wire(solid, prev[0] + uz * 0.5, prev[1] - ux * 0.5, px + uz * 0.5, pz - ux * 0.5, 8.4); }
      prev = [px, pz];
    });
  }
}

/** Calls fn every `step` metres along the road polyline with position, direction and index. */
function walk(r: RoadData, step: number, fn: (x: number, z: number, ux: number, uz: number, k: number) => void) {
  const p = r.p;
  let acc = 0, k = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    for (let t = (step - (acc % step)) % step; t < len; t += step) fn(p[i] + ux * t, p[i + 1] + uz * t, ux, uz, k++);
    acc += len;
  }
}
