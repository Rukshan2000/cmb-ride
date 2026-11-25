import type { ChunkData, RoadData } from '../map/MapTypes';
import type { GeometryBuffer } from '../map/MeshUtil';
import { ribbon } from '../map/RoadMeshBuilder';
import { rankOf } from './RoadMarkingGenerator';
import { roadMask } from './RoadsideEnvironment';

// Crossings, signals, streetlights and bus stops for one chunk.
const TOP_Y = 0.135; // stop lines / zebras sit above junction pads
const WHITE = 0xe2e0d8;
const POLE = 0x6d7075, HOUSING = 0x1c1d1f, CONCRETE = 0xa8a49a;

export interface FurnitureBuffers {
  solid: GeometryBuffer;      // poles, housings, shelters (vertex colour)
  lights: GeometryBuffer[];   // [group*3 + (0 red,1 amber,2 green)] signal lenses
  lampHeads: GeometryBuffer;  // streetlight heads (emissive at night)
  lamps: number[];            // [x,y,z,...] lamp head positions for light pooling
}

/** Oriented box. (ux,uz) = local forward, centred at (x, y0..y0+h, z). */
export function box(g: GeometryBuffer, x: number, y0: number, z: number, ux: number, uz: number, w: number, h: number, d: number, c: number) {
  const rx = -uz, rz = ux; // right of forward
  const corner = (a: number, b: number): [number, number] => [x + rx * a * w / 2 + ux * b * d / 2, z + rz * a * w / 2 + uz * b * d / 2];
  const P = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = P[i], [bx, bz] = P[(i + 1) % 4];
    const nx = bz - az, nz = -(bx - ax), l = Math.hypot(nx, nz) || 1;
    const v = g.vertexCount;
    g.vertex(ax, y0, az, -nx / l, 0, -nz / l, c); g.vertex(bx, y0, bz, -nx / l, 0, -nz / l, c);
    g.vertex(bx, y0 + h, bz, -nx / l, 0, -nz / l, c); g.vertex(ax, y0 + h, az, -nx / l, 0, -nz / l, c);
    g.idx.push(v, v + 1, v + 2, v, v + 2, v + 3, v, v + 2, v + 1, v, v + 3, v + 2); // both windings: winding-agnostic
  }
  const v = g.vertexCount;
  for (const [px, pz] of P) g.vertex(px, y0 + h, pz, 0, 1, 0, c);
  g.idx.push(v, v + 1, v + 2, v, v + 2, v + 3, v, v + 2, v + 1, v, v + 3, v + 2);
}

/** Vertical square facing (fx,fz), centred at (x,y,z). */
function face(g: GeometryBuffer, x: number, y: number, z: number, fx: number, fz: number, s: number, c: number) {
  const rx = -fz * s / 2, rz = fx * s / 2, v = g.vertexCount;
  g.vertex(x - rx, y - s / 2, z - rz, fx, 0, fz, c); g.vertex(x + rx, y - s / 2, z + rz, fx, 0, fz, c);
  g.vertex(x + rx, y + s / 2, z + rz, fx, 0, fz, c); g.vertex(x - rx, y + s / 2, z - rz, fx, 0, fz, c);
  g.idx.push(v, v + 1, v + 2, v, v + 2, v + 3, v, v + 2, v + 1, v, v + 3, v + 2);
}

/** Splits signals into two conflicting phase groups per junction cluster. */
export function signalGroups(sig: number[]): number[] {
  const groups: number[] = [];
  for (let i = 0; i < sig.length; i += 5) {
    let g = 0;
    for (let j = 0; j < i; j += 5) {
      if (Math.hypot(sig[i] - sig[j], sig[i + 1] - sig[j + 1]) < 45) {
        const crossing = Math.abs(Math.sin(sig[i + 2] - sig[j + 2])) > 0.7;
        g = crossing ? 1 - groups[j / 5] : groups[j / 5];
        break;
      }
    }
    groups.push(g);
  }
  return groups;
}

export function buildFurniture(c: ChunkData, b: FurnitureBuffers, markings: GeometryBuffer) {
  const onRoad = roadMask(c);
  // --- Traffic signals: stop line, pole on the left kerb, 3-aspect head facing approaching traffic.
  const sig = c.sig ?? [], groups = signalGroups(sig);
  for (let i = 0; i < sig.length; i += 5) {
    const [x, z, a, hw, oneway] = sig.slice(i, i + 5);
    const ux = Math.sin(a), uz = Math.cos(a), lx = uz, lz = -ux; // travel dir, left
    const from = oneway ? -hw : 0;
    ribbon(markings, [x + lx * from, z + lz * from, x + lx * hw, z + lz * hw], 0.2, TOP_Y, WHITE);
    const px = x + lx * (hw + 0.8) + ux * 0.6, pz = z + lz * (hw + 0.8) + uz * 0.6;
    if (onRoad(px, pz, 0.2)) continue; // junction geometry: pole would stand on the crossing road
    box(b.solid, px, 0, pz, ux, uz, 0.14, 3.4, 0.14, POLE);
    box(b.solid, px, 3.4, pz, ux, uz, 0.4, 1.15, 0.3, HOUSING);
    const grp = groups[i / 5];
    [3.0 + 0.85, 3.0 + 0.5, 3.0 + 0.15].forEach((h, k) =>   // red top, amber, green
      face(b.lights[grp * 3 + k], px - ux * 0.16, h + 0.4, pz - uz * 0.16, -ux, -uz, 0.24, 0xffffff));
  }

  // --- Zebra crossings: stripes parallel to traffic, give-way bars both sides.
  const cr = c.cr ?? [];
  for (let i = 0; i < cr.length; i += 5) {
    const [x, z, a, hw, signalled] = cr.slice(i, i + 5);
    const ux = Math.sin(a), uz = Math.cos(a), lx = uz, lz = -ux;
    for (let o = -hw + 0.55; o <= hw - 0.4; o += 1.0)
      ribbon(markings, [x + lx * o - ux * 1.5, z + lz * o - uz * 1.5, x + lx * o + ux * 1.5, z + lz * o + uz * 1.5], 0.25, TOP_Y, WHITE);
    for (const s of [-1, 1]) {
      const sx = x + ux * s * 3, sz = z + uz * s * 3;
      ribbon(markings, [sx - lx * hw, sz - lz * hw, sx + lx * hw, sz + lz * hw], 0.15, TOP_Y, WHITE);
      if (!signalled) { // blue 'pedestrian crossing' sign on each kerb
        const kx = x + lx * s * (hw + 1), kz = z + lz * s * (hw + 1);
        if (onRoad(kx, kz, 0.2)) continue;
        box(b.solid, kx, 0, kz, ux, uz, 0.08, 2.3, 0.08, POLE);
        face(b.solid, kx - ux * s * 0.05, 2.6, kz - uz * s * 0.05, -ux * s, -uz * s, 0.6, 0x1f4fa0);
        face(b.solid, kx - ux * s * 0.06, 2.6, kz - uz * s * 0.06, -ux * s, -uz * s, 0.32, 0xf0f0f0);
      }
    }
  }

  // --- Streetlights: real OSM lamps plus (approximation) staggered single-arm poles on major roads.
  const lamp = (x: number, z: number, ax: number, az: number, reach: number) => {
    if (onRoad(x, z, 0.3)) return; // dual carriageways / junctions: pole would land on another road
    box(b.solid, x, 0, z, ax, az, 0.18, 8.5, 0.18, POLE);
    box(b.solid, x + ax * reach / 2, 8.3, z + az * reach / 2, ax, az, 0.08, 0.1, reach, POLE);
    const hx = x + ax * reach, hz = z + az * reach;
    box(b.lampHeads, hx, 8.05, hz, ax, az, 0.3, 0.2, 0.6, 0xffffff);
    b.lamps.push(hx, 7.9, hz);
  };
  for (const r of c.roads) {
    if (rankOf(r) < 2) continue;
    const p = r.p;
    let acc = 0, k = Math.floor(r.id % 2);
    for (let i = 0; i < p.length / 2 - 1; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], dx = p[i * 2 + 2] - x0, dz = p[i * 2 + 3] - z0, len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const ux = dx / len, uz = dz / len;
      for (let t = 35 - (acc % 35); t < len; t += 35) {
        const s = k++ % 2 ? 1 : -1, off = r.w / 2 + 1.2;  // alternate sides
        lamp(x0 + ux * t + uz * off * s, z0 + uz * t - ux * off * s, -uz * s, ux * s, 2.2);
      }
      acc += len;
    }
  }
  const nearest = (x: number, z: number) => nearestRoad(c.roads, x, z);
  const L = c.lamp ?? [];
  for (let i = 0; i < L.length; i += 2) {
    const h = nearest(L[i], L[i + 1]);
    if (h) lamp(L[i], L[i + 1], h.nx, h.nz, 2.2);
  }

  // --- Bus stops (OSM): concrete shelter with back wall, open to the road.
  const bus = c.bus ?? [];
  for (let i = 0; i < bus.length; i += 2) {
    const h = nearest(bus[i], bus[i + 1]);
    if (!h) continue;
    const off = Math.max(h.road.w / 2 + 2, Math.min(h.dist, h.road.w / 2 + 4));
    const x = h.x - h.nx * off, z = h.z - h.nz * off; // facing road; nx points to road
    const ux = h.nz, uz = -h.nx;                      // along road
    if (onRoad(x, z, 1.2)) continue;
    box(b.solid, x, 0, z, ux, uz, 4, 0.15, 2, CONCRETE);
    box(b.solid, x - h.nx * 0.9, 0, z - h.nz * 0.9, ux, uz, 0.12, 2.5, 4, 0x8a857a);
    for (const s of [-1.8, 1.8]) box(b.solid, x + ux * s + h.nx * 0.9, 0, z + uz * s + h.nz * 0.9, ux, uz, 0.12, 2.5, 0.12, POLE);
    box(b.solid, x, 2.5, z, ux, uz, 2.3, 0.15, 4.4, 0x8f2f2a); // red roof, typical CTB/SLTB shelters
  }
}

/** Nearest road point in a list; (nx,nz) is the unit vector from the query point towards the road. */
function nearestRoad(roads: RoadData[], x: number, z: number) {
  let best: { road: RoadData; dist: number; x: number; z: number; nx: number; nz: number } | null = null;
  for (const road of roads) {
    const p = road.p;
    for (let i = 0; i < p.length - 2; i += 2) {
      const ax = p[i], az = p[i + 1], ex = p[i + 2] - ax, ez = p[i + 3] - az, l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const cx = ax + ex * t, cz = az + ez * t, d = Math.hypot(cx - x, cz - z);
      if (!best || d < best.dist) best = { road, dist: d, x: cx, z: cz, nx: (cx - x) / (d || 1), nz: (cz - z) / (d || 1) };
    }
  }
  if (best && best.dist < 0.01) { const p = best.road.p, l = Math.hypot(p[2] - p[0], p[3] - p[1]) || 1; best.nx = -(p[3] - p[1]) / l; best.nz = (p[2] - p[0]) / l; }
  return best && best.dist < 40 ? best : null;
}
