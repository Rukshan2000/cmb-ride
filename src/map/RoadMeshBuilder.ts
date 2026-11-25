import type { ChunkData } from './MapTypes';
import { GeometryBuffer } from './MeshUtil';
import { isElevated } from './RoadNetwork';

import { buildMarkings, buildSurfaceDetail, disc, rankOf } from '../roads/RoadMarkingGenerator';

// Draw order via small height offsets: sidewalks < minor roads < major roads < markings (0.115) < junction pads (0.125) < crossings.
// Colours are pre-texture: the asphalt grain map multiplies by ~0.86.
const ASPHALT = [0x46474b, 0x3f4044, 0x36373b]; // weathered grey, average, newly-laid black
const SIDEWALK = 0xa39e93;
const hash = (id: number) => ((id * 2654435761) >>> 0) / 2 ** 32;

/** Builds road surfaces, sidewalks, markings, surface detail and junction pads for one chunk into one buffer. */
export function buildRoads(chunk: ChunkData, g: GeometryBuffer) {
  for (const r of chunk.roads) {
    const rank = rankOf(r);
    if (isElevated(r)) { // flyover deck: asphalt + edge lines at deck height (structure is in StreetFurniture)
      ribbon(g, r.p, r.w / 2, r.y!.map(v => v + 0.06), ASPHALT[2]);
      for (const s of [-1, 1]) ribbon(g, r.p, 0.08, r.y!.map(v => v + 0.08), 0xe2e0d8, s * (r.w / 2 - 0.4));
      if (!r.o) ribbon(g, r.p, 0.07, r.y!.map(v => v + 0.08), 0xe8c040);
      continue;
    }
    const y = 0.06 + rank * 0.01;
    ribbon(g, r.p, r.w / 2 + (rank >= 1 ? 3.2 : 1.8), 0.03, SIDEWALK); // paved footpath + verge
    // Major roads trend newer/darker; residential lanes older and greyer.
    const h = hash(r.id);
    ribbon(g, r.p, r.w / 2, y, ASPHALT[rank >= 2 ? (h < 0.4 ? 2 : 1) : (h < 0.6 ? 0 : 1)]);
    buildSurfaceDetail(r, g, y);
    buildMarkings(r, g);
  }
  const j = chunk.junctions;
  for (let i = 0; i < j.length; i += 3) disc(g, j[i], j[i + 1], j[i + 2] * 1.05, 0.125, ASPHALT[1], 16);
}

/** Strip of half-width hw along polyline p with mitred joins. y: constant or per vertex; off: lateral shift. */
export function ribbon(g: GeometryBuffer, p: number[], hw: number, y: number | number[], color: number, off = 0) {
  if (typeof y === 'number') p = densify(p, 12); // ground ribbons: extra vertices so they drape over terrain
  const n = p.length / 2;
  if (n < 2) return;
  const base = g.vertexCount;
  for (let i = 0; i < n; i++) {
    // Average the normals of the adjacent segments; scale for the miter, capped against spikes.
    const [ax, az] = segNormal(p, Math.max(i - 1, 0));
    const [bx, bz] = segNormal(p, Math.min(i, n - 2));
    let mx = ax + bx, mz = az + bz;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const scale = Math.min(1 / Math.max(mx * ax + mz * az, 0.5), 2);
    const x = p[i * 2], z = p[i * 2 + 1];
    const yy = typeof y === 'number' ? y : y[i], c = off * scale;
    g.vertex(x + mx * (hw * scale + c), yy, z + mz * (hw * scale + c), 0, 1, 0, color);
    g.vertex(x - mx * (hw * scale - c), yy, z - mz * (hw * scale - c), 0, 1, 0, color);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    g.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); // ground material is double-sided

  }
}

function segNormal(p: number[], i: number): [number, number] {
  const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1];
  const l = Math.hypot(dx, dz) || 1;
  return [-dz / l, dx / l];
}


/** Insert vertices so no segment is longer than max metres. */
function densify(p: number[], max: number): number[] {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1], k = Math.ceil(Math.hypot(bx - ax, bz - az) / max);
    for (let s = 1; s <= k; s++) out.push(ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k);
  }
  return out;
}
