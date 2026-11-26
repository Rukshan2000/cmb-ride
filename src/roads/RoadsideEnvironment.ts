import type { ChunkData, RoadData } from '../map/MapTypes';
import type { GeometryBuffer } from '../map/MeshUtil';
import { isElevated } from '../map/RoadNetwork';
import { box } from './StreetFurniture';
import type { WallPanel } from './Signage';
import { cart, dog, parked } from './Clutter';
import { bush, flowers, palm, tree } from './Vegetation';
import { rankOf } from './RoadMarkingGenerator';

// Roadside life along every road: shade trees (rain trees on main roads, palms / mango / jak on side streets),
// small roadside boutiques ('kade'), CEB concrete utility poles with overhead wires.
// Deterministic per road (seeded by OSM id); nothing is placed inside an OSM building footprint or in a junction.

const WALL = [0xe9e4d8, 0xd9c9a8, 0xc9d4c0, 0xe0b8a0, 0xbfc4c8, 0xa8644a], COPING = 0xcfcabc;
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
export function occupancy(c: ChunkData) {
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

/** `around` = this chunk plus its neighbours' roads and buildings, so nothing lands on a road across a tile edge. */
export function buildRoadside(c: ChunkData, around: ChunkData, solid: GeometryBuffer, foliage: GeometryBuffer, blooms: GeometryBuffer, posts: number[], walls: WallPanel[] = []) {
  const inBuilding = occupancy(around), onRoad = roadMask(around);
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
      if (rank >= 2) tree(solid, foliage, tx, tz, big, rnd);
      else if (rnd() < 0.45) palm(solid, foliage, tx, tz, rnd); else tree(solid, foliage, tx, tz, false, rnd);
      posts.push(tx, tz, big ? 0.3 : 0.2);
    });
    if (rank <= 2) walk(r, 55, (x, z, ux, uz) => {          // roadside kades on secondary and smaller streets
      if (rnd() > 0.35) return;
      const s = rnd() < 0.5 ? 1 : -1, off = r.w / 2 + (rank >= 1 ? 2.6 : 1.6) + 1.1, kx = x + uz * off * s, kz = z - ux * off * s;
      if (clear(kx, kz, 2.2)) { kade(solid, kx, kz, -uz * s, ux * s, rnd); posts.push(kx - uz * s * -1.1, kz + ux * s * -1.1, 1.2); }
    });
    // Kerbside clutter: parked three-wheelers and bikes, fruit carts, street dogs.
    walk(r, 24, (x, z, ux, uz) => {
      if (rnd() < 0.45) return;
      const side = rnd() < 0.5 ? 1 : -1, off = r.w / 2 + 1.0, px = x + uz * off * side, pz = z - ux * off * side;
      const roll = rnd(), dir = side > 0 ? 1 : -1; // parked facing the way that side of the road flows
      if (![-1.4, 0, 1.4].every(d => clear(px + ux * d, pz + uz * d, 0.65))) return;
      if (posts.some((v, i) => i % 3 === 0 && Math.abs(v - px) < 1.8 && Math.abs(posts[i + 1] - pz) < 1.8)) return;
      if (roll < 0.34) { parked(solid, 'tuktuk', px, pz, ux * dir, uz * dir, rnd); posts.push(px, pz, 0.6); }
      else if (roll < 0.62) for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) { // bikes in a row
        parked(solid, 'motorcycle', px + ux * (k - 1) * 0.9, pz + uz * (k - 1) * 0.9, -uz * side, ux * side, rnd);
        posts.push(px + ux * (k - 1) * 0.9, pz + uz * (k - 1) * 0.9, 0.35);
      } else if (roll < 0.8 && rank <= 2) { cart(solid, px, pz, ux, uz, rnd); posts.push(px, pz, 0.7); }
      else dog(solid, px, pz, rnd() < 0.5 ? ux : -uz, rnd() < 0.5 ? uz : ux, rnd);
    });
    // Garden walls with planting in front on side streets; shrubs and flower beds along bigger roads.
    const paint = WALL[Math.floor(rnd() * WALL.length)];
    for (const side of [-1, 1]) walk(r, 6, (x, z, ux, uz) => {
      const at = (off: number) => [x + uz * off * side, z - ux * off * side] as const;
      const [px, pz] = at(r.w / 2 + (rank >= 1 ? 1.1 : 0.7)); // planting strip
      const [wx, wz] = at(r.w / 2 + (rank >= 1 ? 3.4 : 1.7)); // wall line
      const fits = (qx: number, qz: number) => [-2.6, 0, 2.6].every(d => clear(qx + ux * d, qz + uz * d, 0.35));
      if (rank <= 1 && rnd() < 0.65 && fits(wx, wz) && !posts.some((v, i) => i % 3 === 0 && Math.abs(v - wx) < 3 && Math.abs(posts[i + 1] - wz) < 3)) {
        const col = rnd() < 0.75 ? paint : WALL[Math.floor(rnd() * WALL.length)], h = 1.3 + rnd() * 0.5;
        box(solid, wx, 0, wz, ux, uz, 0.18, h, 5.6, col);
        box(solid, wx, h, wz, ux, uz, 0.26, 0.09, 5.7, COPING);
        for (const d of [-2.8, 2.8]) box(solid, wx + ux * d, 0, wz + uz * d, ux, uz, 0.34, h + 0.28, 0.34, COPING); // gate pillars
        walls.push([wx, wz, ux, uz, side]);
        for (let d = -2.5; d <= 2.5; d += 1) posts.push(wx + ux * d, wz + uz * d, 0.12);
        if (rnd() < 0.35) bush(foliage, wx, wz, rnd, true); // bougainvillea spilling over
      }
      const roll = rnd();
      if (roll < 0.3 && clear(px, pz, 0.45)) bush(foliage, px + ux * (rnd() * 3 - 1.5), pz + uz * (rnd() * 3 - 1.5), rnd, rnd() < 0.35);
      else if (roll < 0.42 && clear(px, pz, 0.6)) flowers(foliage, blooms, px, pz, rnd);
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
