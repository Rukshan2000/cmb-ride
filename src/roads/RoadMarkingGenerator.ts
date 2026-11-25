import type { RoadData } from '../map/MapTypes';
import type { GeometryBuffer } from '../map/MeshUtil';
import { ribbon } from '../map/RoadMeshBuilder';

// Sri Lankan RDA practice: white markings; double solid centre on 4+ lane two-way roads,
// dashed centre on two-lane roads, dashed lane dividers, solid edge lines on major roads.
export const MARK_Y = 0.115;  // above all asphalt ranks, below junction pads (0.125)
const WHITE = 0xdedbd0, WORN = 0xb4b2aa;
const RANK: Record<string, number> = { motorway: 4, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
export const rankOf = (r: RoadData) => RANK[r.h.replace('_link', '')] ?? 0;
const rnd = (id: number) => ((id * 2654435761) >>> 0) / 2 ** 32;

export function buildMarkings(r: RoadData, g: GeometryBuffer) {
  const rank = rankOf(r);
  if (r.w < 5.5 || rank === 0 && r.w < 7) return; // narrow lanes in Colombo are mostly unmarked
  const col = rnd(r.id) < 0.35 ? WORN : WHITE;     // faded paint on ~1/3 of roads
  const lanes = Math.max(r.l ?? Math.round(r.w / 3.3), r.o ? 1 : 2);
  const hw = r.w / 2;
  if (rank >= 2) {
    ribbon(g, offsetLine(r.p, hw - 0.35), 0.075, MARK_Y, col);
    ribbon(g, offsetLine(r.p, -(hw - 0.35)), 0.075, MARK_Y, col);
  }
  const lw = r.w / lanes;
  if (r.o) {
    for (let k = 1; k < lanes; k++) dashes(g, offsetLine(r.p, -hw + k * lw), 3, 6, col);
    return;
  }
  if (lanes >= 4) {
    ribbon(g, offsetLine(r.p, 0.12), 0.06, MARK_Y, col);
    ribbon(g, offsetLine(r.p, -0.12), 0.06, MARK_Y, col);
  } else dashes(g, r.p, 3, 5, col);
  for (let k = 1; k < lanes / 2; k++) { dashes(g, offsetLine(r.p, k * lw), 3, 6, col); dashes(g, offsetLine(r.p, -k * lw), 3, 6, col); }
}

/** Polyline shifted sideways by d (positive = right of travel direction) with mitred joins. */
export function offsetLine(p: number[], d: number): number[] {
  const n = p.length / 2, out: number[] = [];
  const nrm = (i: number) => {
    const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1], l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  };
  for (let i = 0; i < n; i++) {
    const [ax, az] = nrm(Math.max(i - 1, 0)), [bx, bz] = nrm(Math.min(i, n - 2));
    let mx = ax + bx, mz = az + bz;
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const s = Math.min(1 / Math.max(mx * ax + mz * az, 0.5), 2);
    out.push(p[i * 2] - mx * d * s, p[i * 2 + 1] - mz * d * s);
  }
  return out;
}

export function dashes(g: GeometryBuffer, p: number[], dash: number, gap: number, color: number, hw = 0.06, y = MARK_Y) {
  let phase = 0;
  for (let i = 0; i < p.length / 2 - 1; i++) {
    const x0 = p[i * 2], z0 = p[i * 2 + 1], dx = p[i * 2 + 2] - x0, dz = p[i * 2 + 3] - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    for (let t = -phase; t < len; t += dash + gap) {
      const s = Math.max(t, 0), e = Math.min(t + dash, len);
      if (e > s) ribbon(g, [x0 + ux * s, z0 + uz * s, x0 + ux * e, z0 + uz * e], hw, y, color);
    }
    phase = (phase + len) % (dash + gap);
  }
}

/** Patches, discoloured repairs and manhole covers, deterministic per road. */
export function buildSurfaceDetail(r: RoadData, g: GeometryBuffer, y: number) {
  const p = r.p;
  let acc = 0;
  for (let i = 0; i < p.length / 2 - 1; i++) {
    const x0 = p[i * 2], z0 = p[i * 2 + 1], dx = p[i * 2 + 2] - x0, dz = p[i * 2 + 3] - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    for (let t = 15 - (acc % 30); t < len; t += 30) {
      const h = rnd(r.id + Math.floor(acc + t));
      const side = (h - 0.5) * (r.w - 2), cx = x0 + ux * t - uz * side, cz = z0 + uz * t + ux * side;
      if (h < 0.25) ribbon(g, [cx - ux * 1.5, cz - uz * 1.5, cx + ux * 1.5, cz + uz * 1.5], 0.6 + h * 2, y + 0.003, h < 0.12 ? 0x2c2d30 : 0x4a4a4c);
      else if (h > 0.9) disc(g, cx, cz, 0.35, y + 0.004, 0x3a3936);
    }
    acc += len;
  }
}

export function disc(g: GeometryBuffer, x: number, z: number, r: number, y: number, color: number, seg = 12) {
  const c = g.vertexCount;
  g.vertex(x, y, z, 0, 1, 0, color);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    g.vertex(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0, 1, 0, color);
  }
  for (let i = 0; i < seg; i++) g.idx.push(c, c + 1 + ((i + 1) % seg), c + 1 + i);
}
