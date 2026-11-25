import * as pc from 'playcanvas';
import earcut from 'earcut';
import { GeometryBuffer } from '../map/MeshUtil';
import { box } from '../roads/StreetFurniture';
import type { VehicleSpec } from './VehicleCatalog';

// Procedural vehicles built from side profiles (bonnet, raked screens, roofline, boot) extruded across the width
// with tumblehome, round wheels with rims, bumpers, mirrors, plates and lamps.
// Local frame: +Y up, forward = -Z, x = right. Three buffers: paint (glossy), glass, trim (matte).

interface Parts { paint: GeometryBuffer; glass: GeometryBuffer; trim: GeometryBuffer; lamp: GeometryBuffer; noWheels?: boolean } // lamp: emissive, blooms
type Prof = [number, number][]; // [z, y] around the side outline

const TYRE = 0x161616, RIM = 0xb9bcc0, BLACK = 0x1c1c1c, LAMP = 0xf2f0e6, TAIL = 0xa8121a, AMBER = 0xe08a1a, PLATE = 0xf0f0ea, CHROME = 0xc8cacc;

/** Extrude a side profile across the width. hw(y) = half width at height y (tumblehome). */
function extrude(g: GeometryBuffer, prof: Prof, hw: (y: number) => number, c: number, xOff = 0) {
  const n = prof.length;
  // Sides (x = ±hw), triangulated with earcut on (z, y).
  const tri = earcut(prof.flat());
  for (const s of [-1, 1]) {
    const b = g.vertexCount;
    for (const [z, y] of prof) g.vertex(xOff + s * hw(y), y, z, s, 0, 0, c);
    for (let i = 0; i < tri.length; i += 3) g.idx.push(b + tri[i], b + tri[i + 1], b + tri[i + 2]);
  }
  // Skin between consecutive outline points.
  for (let i = 0; i < n; i++) {
    const [z0, y0] = prof[i], [z1, y1] = prof[(i + 1) % n];
    const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy) || 1;
    const ny = -dz / l, nz = dy / l; // outward for a clockwise-in-(z,y) outline; material is double-sided anyway
    const b = g.vertexCount;
    g.vertex(xOff - hw(y0), y0, z0, 0, ny, nz, c); g.vertex(xOff + hw(y0), y0, z0, 0, ny, nz, c);
    g.vertex(xOff + hw(y1), y1, z1, 0, ny, nz, c); g.vertex(xOff - hw(y1), y1, z1, 0, ny, nz, c);
    g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
}

/** Wheel: tyre cylinder along X, dark dished rim face, five spokes and a hub cap on the outer face. */
function wheel(p: Parts, x: number, z: number, r: number, w: number, rim = RIM) {
  if (p.noWheels) return; // player car: wheels are separate animated entities
  const SEG = 28, g = p.trim, x0 = x - w / 2, x1 = x + w / 2, out = Math.sign(x) || 1;
  const b = g.vertexCount;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2, cy = Math.cos(a), cz = Math.sin(a);
    g.vertex(x0, r + cy * r, z + cz * r, 0, cy, cz, TYRE);
    g.vertex(x1, r + cy * r, z + cz * r, 0, cy, cz, TYRE);
  }
  for (let i = 0; i < SEG; i++) { const a = b + i * 2; g.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const face = x + (w / 2) * out;
  const disc = (xx: number, rr: number, col: number) => {
    const c = g.vertexCount;
    g.vertex(xx, r, z, out, 0, 0, col);
    for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; g.vertex(xx, r + Math.cos(a) * rr, z + Math.sin(a) * rr, out, 0, 0, col); }
    for (let i = 0; i < SEG; i++) g.idx.push(c, c + 1 + i, c + 1 + ((i + 1) % SEG));
  };
  disc(x0 * (out > 0 ? 0 : 1) + x1 * (out > 0 ? 1 : 0), r, TYRE);  // sidewall
  disc(face + 0.004 * out, r * 0.66, rim);                           // rim lip
  disc(face + 0.006 * out, r * 0.58, 0x2a2b2d);                      // dark dish / brake behind spokes
  for (let k = 0; k < 5; k++) {                                       // spokes
    const a = (k / 5) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), pa = -sa, pb = ca, hw = r * 0.07, xx = face + 0.012 * out;
    const c = g.vertexCount;
    for (const [d, s2] of [[0.12, -1], [0.12, 1], [0.6, 1], [0.6, -1]]) g.vertex(xx, r + ca * r * d + pa * hw * s2, z + sa * r * d + pb * hw * s2, out, 0, 0, rim);
    g.idx.push(c, c + 1, c + 2, c, c + 2, c + 3);
  }
  disc(face + 0.016 * out, r * 0.16, CHROME);                        // hub cap
}

/** Front/rear details common to four-wheelers: lamps, plates, bumpers, mirrors. */
function details(p: Parts, L: number, W: number, lampY: number, bumperY: number, mirrorY: number, mirrorZ: number) {
  const t = p.trim;
  for (const s of [-1, 1]) {
    box(p.lamp, s * (W / 2 - 0.28), lampY, -L / 2 - 0.015, 0, -1, 0.34, 0.14, 0.05, LAMP);
    box(p.lamp, s * (W / 2 - 0.12), lampY, -L / 2 + 0.02, 0, -1, 0.06, 0.1, 0.05, AMBER);
    box(p.lamp, s * (W / 2 - 0.22), lampY + 0.02, L / 2 + 0.015, 0, -1, 0.3, 0.16, 0.05, TAIL);
    box(t, s * (W / 2 + 0.08), mirrorY, mirrorZ, 0, -1, 0.16, 0.12, 0.1, BLACK); // mirror
  }
  box(t, 0, bumperY, -L / 2 - 0.03, 0, -1, W - 0.1, 0.2, 0.08, BLACK);
  box(t, 0, bumperY, L / 2 + 0.03, 0, -1, W - 0.1, 0.2, 0.08, BLACK);
  box(t, 0, bumperY + 0.03, -L / 2 - 0.08, 0, -1, 0.5, 0.13, 0.02, PLATE);
  box(t, 0, bumperY + 0.25, L / 2 + 0.06, 0, -1, 0.5, 0.13, 0.02, PLATE);
}

const taper = (hw: number, y0: number, y1: number, inset: number) => (y: number) => hw - Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) * inset;

// --- Lofted cars -------------------------------------------------------------------------------------------
// Proportions of a real Axio-class sedan / Aqua-class hatch: body and glasshouse are lofts of rounded
// cross-sections along the length (smooth normals), with wheel arches cut out of the lower body.
type V3 = [number, number, number];

/** Piecewise smooth (cosine) interpolation through [t, v] keys. */
const curve = (keys: [number, number][]) => (t: number) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
    const [t0, v0] = keys[i - 1], [t1, v1] = keys[i], u = (1 - Math.cos(((t - t0) / (t1 - t0)) * Math.PI)) / 2;
    return v0 + (v1 - v0) * u;
  }
  return keys[keys.length - 1][1];
};

/** Emit a grid of rows (stations along the car) as quads with smooth per-vertex normals; pick() chooses the buffer per quad. */
function loft(rows: V3[][], closed: boolean, pick: (i: number, k: number) => [GeometryBuffer, number] | null) {
  const n = rows.length, K = rows[0].length;
  const at = (i: number, k: number) => rows[Math.max(0, Math.min(n - 1, i))][closed ? (k + K) % K : Math.max(0, Math.min(K - 1, k))];
  const normal = (i: number, k: number): V3 => {
    const a = at(i + 1, k), b = at(i - 1, k), c = at(i, k + 1), d = at(i, k - 1);
    const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    let x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
    const row = rows[i], cy = row.reduce((s, q) => s + q[1], 0) / K, p = at(i, k);
    if (x * p[0] + y * (p[1] - cy) < 0) { x = -x; y = -y; z = -z; } // outward
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < (closed ? K : K - 1); k++) {
    const r = pick(i, k);
    if (!r) continue;
    const [g, c] = r, base = g.vertexCount;
    for (const [ii, kk] of [[i, k], [i + 1, k], [i + 1, k + 1], [i, k + 1]]) {
      const q = at(ii, kk), nn = normal(ii, kk);
      g.vertex(q[0], q[1], q[2], nn[0], nn[1], nn[2], c);
    }
    g.quad(base);
  }
}

/** Fan cap over one end row (bumper faces). */
function cap(g: GeometryBuffer, row: V3[], nz: number, c: number) {
  const cx = 0, cy = row.reduce((s, q) => s + q[1], 0) / row.length, cz = row[0][2], b = g.vertexCount;
  g.vertex(cx, cy, cz, 0, 0, nz, c);
  for (const q of row) g.vertex(q[0], q[1], q[2], 0, 0, nz, c);
  for (let k = 0; k < row.length; k++) g.idx.push(b, b + 1 + k, b + 1 + ((k + 1) % row.length));
}

const spow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

function car(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, hatch = s.id === 'hatch', c = s.color!, t = p.trim;
  const wr = 0.31, R = wr + 0.07;
  // Axle positions (from the front): real wheelbase ~2.6 m (sedan) / ~2.5 m (hatch); the player car passes its physics axles.
  const [zF, zR] = s.axles ? [s.axles[0] - f, s.axles[1] - f] : hatch ? [0.68, L - 0.6] : [0.86, L - 0.94];
  // Side profile of the body top (bonnet -> cowl -> beltline -> boot), metres from the front.
  const top = curve(hatch
    ? [[0, 0.5], [0.06, 0.64], [0.22, 0.73], [0.75, 0.84], [1.8, 0.92], [L - 0.12, 0.96], [L, 0.62]]
    : [[0, 0.5], [0.07, 0.63], [0.28, 0.72], [1.15, 0.83], [2.5, 0.9], [L - 0.9, 0.93], [L - 0.22, 0.93], [L - 0.04, 0.86], [L, 0.62]]);
  // Glasshouse: windscreen base, roof start/end, rear screen base.
  const [gA, gB, gC, gD] = hatch ? [0.75, 1.5, L - 0.28, L - 0.08] : [1.15, 2.05, L - 1.5, L - 0.9];
  const zB = (gA + gD) / 2 - (hatch ? 0.1 : 0.05);                    // B-pillar
  // Plan view: rounded nose and tail corners.
  const hw = (z: number) => { const u = Math.abs((2 * z) / L - 1), e = Math.max(0, (u - 0.8) / 0.2); return (W / 2) * Math.sqrt(1 - e * e * 0.3); };
  // Body bottom: sill, cut up around the wheels (arches).
  const bottom = (z: number) => {
    let y = 0.24;
    for (const zw of [zF, zR]) { const d = z - zw; if (Math.abs(d) < R) y = Math.max(y, wr + Math.sqrt(R * R - d * d) * 0.95); }
    return y;
  };
  // --- body loft (closed rounded-rectangle sections, tumblehome on the upper half)
  const N = 64, K = 28, rows: V3[][] = [];
  for (let i = 0; i <= N; i++) {
    const z = (i / N) * L, yb = bottom(z), yt = top(z), mid = (yb + yt) / 2, h = yt - yb, w = hw(z);
    const row: V3[] = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2, sy = spow(Math.sin(a), 0.3);
      row.push([spow(Math.cos(a), 0.25) * w * (sy > 0 ? 1 - 0.07 * sy : 1), mid + (sy * h) / 2, f + z]);
    }
    rows.push(row);
  }
  loft(rows, true, () => [p.paint, c]);
  cap(p.paint, rows[0], -1, c); cap(p.paint, rows[N], 1, c);
  // --- glasshouse loft (open arch section from belt to roof); quads are glass or paint (pillars, rails, roof)
  const G: V3[][] = [], M = 40, KG = 16, zs: number[] = [];
  for (let i = 0; i <= M; i++) zs.push(gA + ((gD - gA) * i) / M);
  for (const z of zs) {
    const y0 = top(z) - 0.01, y1 = Math.max(y0 + 0.005, z < gB ? y0 + (H - y0) * Math.sin(((z - gA) / (gB - gA)) * Math.PI / 2) ** 0.8
      : z > gC ? y0 + (H - y0) * Math.cos(((z - gC) / (gD - gC)) * Math.PI / 2) ** (hatch ? 0.6 : 1.1) : H - 0.03 * (((z - (gB + gC) / 2) / ((gC - gB) / 2)) ** 2));
    const wb = hw(z) * 0.93 - 0.02, wt = wb - 0.2, row: V3[] = [];
    for (let k = 0; k <= KG; k++) {
      const a = (k / KG) * Math.PI, ys = Math.abs(Math.sin(a)) ** 0.4;
      row.push([spow(Math.cos(a), 0.3) * (wb * (1 - ys) + wt * ys), y0 + (y1 - y0) * ys, f + z]);
    }
    G.push(row);
  }
  loft(G, false, (i, k) => {
    const z = (zs[i] + zs[i + 1]) / 2, tm = (k + 0.5) / KG;
    const side = tm < 0.22 || tm > 0.78, corner = !side && (tm < 0.34 || tm > 0.66);
    if (corner) return [p.paint, c];                                                  // A/C pillars + roof rails
    if (!side) return z > gB + 0.04 && z < gC - 0.04 ? [p.paint, c] : [p.glass, 0xffffff]; // roof skin / screens
    const pillar = Math.abs(z - zB) < 0.07 || z < gA + 0.22 || z > (hatch ? gD - 0.32 : gC - 0.05);
    return pillar ? [p.paint, c] : [p.glass, 0xffffff];
  });
  // --- arch liners (dark half discs) and wheels
  for (const zw of [zF, zR]) for (const side of [-1, 1]) {
    const x = side * (hw(zw) - 0.06), b = t.vertexCount;
    t.vertex(x, wr, f + zw, side, 0, 0, 0x0c0c0c);
    for (let k = 0; k <= 12; k++) { const a = (k / 12) * Math.PI; t.vertex(x, wr + Math.sin(a) * R, f + zw + Math.cos(a) * R, side, 0, 0, 0x0c0c0c); }
    for (let k = 0; k < 12; k++) t.idx.push(b, b + 1 + k, b + 2 + k);
    wheel(p, side * (W / 2 - 0.15), f + zw, wr, 0.2);
  }
  // --- front: swept headlight clusters, grille, lower intake, plate; rear: tail clusters, plate; mirrors, seams, handles
  for (const side of [-1, 1]) {
    const hz = 0.12;
    box(p.lamp, side * (hw(hz) - 0.3), top(hz) - 0.13, f + hz - 0.04, 0, -1, 0.42, 0.11, 0.12, LAMP);
    box(p.lamp, side * (hw(hz) - 0.08), top(hz) - 0.11, f + hz + 0.04, 0, -1, 0.07, 0.07, 0.16, AMBER);
    const tz = L - 0.08;
    box(p.lamp, side * (hw(tz) - 0.24), top(tz) - 0.17, f + tz, 0, -1, 0.4, 0.14, 0.14, TAIL);
    box(t, side * (hw(gA) + 0.07), top(gA + 0.2) + 0.02, f + gA + 0.2, 0, -1, 0.15, 0.11, 0.09, c === 0x161718 ? BLACK : c); // mirror
    box(t, side * (hw(gA) + 0.02), top(gA + 0.2), f + gA + 0.2, 0, -1, 0.08, 0.05, 0.05, BLACK);
    for (const z of [gA + 0.02, zB, hatch ? zR - R - 0.02 : zR - R - 0.04]) box(t, side * (hw(z) + 0.002), bottom(z) + 0.06, f + z, 0, -1, 0.008, top(z) - bottom(z) - 0.1, 0.01, 0x0a0a0a);
    for (const z of [zB - 0.28, (hatch ? zR - R : zR - R) - 0.3]) box(t, side * (hw(z) + 0.006), top(z) - 0.12, f + z, 0, -1, 0.018, 0.03, 0.14, CHROME);
    box(t, side * (W / 2 - 0.05), 0.2, f + (zF + zR) / 2, 0, -1, 0.06, 0.08, zR - zF - 2 * R, 0x141414);   // side skirt
  }
  box(t, 0, 0.47, f + 0.02, 0, -1, W * 0.42, 0.12, 0.05, 0x0c0c0d);                    // grille
  for (let k = 0; k < 3; k++) box(t, 0, 0.48 + k * 0.035, f + 0.0, 0, -1, W * 0.4, 0.008, 0.02, CHROME);
  box(t, 0, 0.28, f + 0.05, 0, -1, W * 0.6, 0.1, 0.05, 0x101010);                       // lower intake
  box(t, 0, 0.33, f - 0.01, 0, -1, 0.5, 0.12, 0.02, PLATE);
  box(t, 0, top(L - 0.05) - 0.3, f + L + 0.005, 0, -1, 0.5, 0.12, 0.02, PLATE);
  box(t, 0, 0.24, f + L - 0.05, 0, -1, W * 0.8, 0.1, 0.08, 0x141414);                  // rear diffuser/bumper lower
}

function van(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2;
  // HiAce-style semi-bonnet: short sloped nose, tall flat sides, near-vertical rear.
  extrude(p.paint, [[f, 0.35], [f, 0.95], [f + 0.35, 1.1], [r, 1.12], [r, 0.35], [r - 0.4, 0.3], [f + 0.4, 0.3]], taper(W / 2, 0.9, 1.1, 0.02), s.color!);
  extrude(p.glass, [[f + 0.4, 1.1], [f + 1.0, H - 0.1], [r - 0.05, H - 0.1], [r - 0.02, 1.1]], taper(W / 2 - 0.02, 1.1, H, 0.06), 0xffffff);
  extrude(p.paint, [[f + 0.95, H - 0.15], [f + 1.05, H], [r - 0.02, H], [r - 0.02, H - 0.15]], () => W / 2 - 0.08, s.color!);
  for (const z of [f + 1.5, r - 1.6]) for (const side of [-1, 1]) box(p.paint, side * (W / 2 - 0.04), 1.1, z, 0, -1, 0.03, H - 1.2, 0.18, s.color!); // pillars
  for (const z of [f + 0.75, r - 0.85]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.15), z, 0.33, 0.21);
  details(p, L, W, 0.8, 0.42, 1.25, f + 0.6);
}

export const METRO_RED = 0xd71f26;

function bus(p: Parts, s: VehicleSpec) {
  if (s.accent === METRO_RED) return metroBus(p, s);
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, c = s.color!;
  extrude(p.paint, [[f, 0.45], [f, 1.3], [r, 1.3], [r, 0.45]], () => W / 2, c);
  extrude(p.glass, [[f, 1.3], [f + 0.25, H - 0.35], [r, H - 0.35], [r, 1.3]], () => W / 2 - 0.02, 0xffffff);
  extrude(p.paint, [[f + 0.2, H - 0.35], [f + 0.45, H], [r - 0.1, H], [r, H - 0.35]], taper(W / 2, H - 0.35, H, 0.1), c);
  // Livery: SLTB maroon with yellow band; private buses get a contrasting sweep band.
  const band = c === 0x9a1b1b ? 0xe8c21a : s.accent ?? 0xf0f0f0;
  box(p.paint, 0, 0.95, 0, 0, -1, W + 0.02, 0.22, L - 0.3, band);
  for (let z = f + 1.6; z < r - 0.5; z += 1.25) for (const side of [-1, 1]) box(p.paint, side * (W / 2), 1.3, z, 0, -1, 0.04, H - 1.65, 0.1, c); // window pillars
  box(p.trim, W / 2 + 0.01, 0.5, f + 1.0, 0, -1, 0.02, 1.9, 0.9, BLACK); // front door (left side = kerb in SL? doors are on the left)
  box(p.trim, -(W / 2 + 0.01), 0.5, f + 1.0, 0, -1, 0.02, 1.9, 0.9, BLACK);
  box(p.trim, 0, H - 0.75, f - 0.02, 0, -1, W - 0.5, 0.3, 0.04, 0x101010); // destination board
  for (const z of [f + 2.0, r - 2.5]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.32), z, 0.5, 0.3, 0x8a8d90);
  details(p, L, W, 0.75, 0.5, 2.0, f + 0.1);
}

/**
 * Lanka Metro Transit (Foton low-floor) livery: red front and rear caps, white body, red diagonal wedges low at the
 * front and rear of each side, big tinted windows almost to the roof, black screen band, white roof AC pod.
 */
function metroBus(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, RED = METRO_RED, WHITE = 0xf4f4f2;
  extrude(p.paint, [[f + 0.3, 0.35], [f + 0.3, 1.05], [r - 0.3, 1.05], [r - 0.3, 0.35]], () => W / 2, WHITE);         // white lower body
  extrude(p.glass, [[f + 0.3, 1.05], [f + 0.3, H - 0.32], [r - 0.3, H - 0.32], [r - 0.3, 1.05]], () => W / 2 - 0.01, 0xffffff); // windows
  extrude(p.paint, [[f + 0.3, H - 0.32], [f + 0.3, H], [r - 0.3, H], [r - 0.3, H - 0.32]], () => W / 2, WHITE);       // roof rail
  // Red front cap: bumper, black windscreen band, rounded top; white chevron under the screen.
  extrude(p.paint, [[f, 0.3], [f - 0.02, 0.75], [f + 0.3, 0.75], [f + 0.3, 0.3]], () => W / 2, RED);
  extrude(p.paint, [[f - 0.02, 0.75], [f - 0.02, 0.95], [f + 0.3, 0.95], [f + 0.3, 0.75]], () => W / 2, WHITE);
  extrude(p.glass, [[f - 0.02, 0.95], [f + 0.02, H - 0.35], [f + 0.3, H - 0.35], [f + 0.3, 0.95]], () => W / 2 - 0.08, 0xffffff);
  extrude(p.paint, [[f + 0.02, H - 0.35], [f + 0.12, H], [f + 0.3, H], [f + 0.3, H - 0.35]], () => W / 2, RED);
  for (const side of [-1, 1]) box(p.paint, side * (W / 2 - 0.04), 0.3, f + 0.12, 0, -1, 0.08, H - 0.3, 0.32, RED); // front corner pillars
  // Red rear cap.
  extrude(p.paint, [[r - 0.3, 0.3], [r - 0.3, H], [r - 0.1, H], [r, H - 0.3], [r, 0.3]], () => W / 2, RED);
  // Side wedges (both sides): low red triangle behind the front wheel and a big one sweeping up at the rear.
  for (const prof of [[[f + 0.3, 0.35], [f + 1.7, 0.35], [f + 0.3, 1.05]], [[r - 3.6, 0.35], [r - 0.3, 0.35], [r - 0.3, 1.05], [r - 1.4, 1.05]]] as Prof[])
    extrude(p.paint, prof, () => W / 2 + 0.012, RED);
  for (let k = 0; k < 4; k++) for (const side of [-1, 1]) box(p.paint, side * (W / 2 + 0.013), 0.45 + k * 0.15, f + 3.55, 0, -1, 0.01, 0.08, 0.25, RED); // red bars by the door
  // Window pillars, doors (kerb side = left), destination display, roof AC pod.
  for (let z = f + 1.9; z < r - 0.6; z += 1.5) for (const side of [-1, 1]) box(p.trim, side * (W / 2 + 0.005), 1.05, z, 0, -1, 0.02, H - 1.37, 0.07, 0x1a1a1a);
  for (const z of [f + 1.2, f + 4.6]) box(p.glass, -(W / 2 + 0.01), 0.35, z, 0, -1, 0.02, H - 0.7, 1.1, 0xffffff);
  box(p.trim, 0, H - 0.55, f - 0.03, 0, -1, W - 0.6, 0.22, 0.03, 0x0a0a0a);
  box(p.lamp, 0, H - 0.52, f - 0.04, 0, -1, W - 0.9, 0.14, 0.02, AMBER);
  box(p.paint, 0, H, -0.5, 0, -1, W - 0.5, 0.28, 3.2, WHITE);
  for (const side of [-1, 1]) box(p.lamp, side * (W / 2 - 0.35), 0.55, f - 0.025, 0, -1, 0.45, 0.14, 0.04, LAMP); // LED headlamps
  for (const z of [f + 2.0, r - 2.5]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.32), z, 0.5, 0.3, 0x5a5d60);
  for (const side of [-1, 1]) box(p.lamp, side * (W / 2 - 0.3), 0.6, r + 0.01, 0, -1, 0.2, 0.3, 0.03, TAIL);
}

function lorry(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, cab = 1.9, c = s.color!;
  extrude(p.paint, [[f, 0.55], [f, 1.45], [f + 0.1, 1.55], [f + cab, 1.55], [f + cab, 0.55]], () => W / 2, c);
  extrude(p.glass, [[f + 0.1, 1.55], [f + 0.25, H - 0.2], [f + cab - 0.05, H - 0.2], [f + cab - 0.05, 1.55]], () => W / 2 - 0.03, 0xffffff);
  extrude(p.paint, [[f + 0.2, H - 0.2], [f + 0.3, H], [f + cab, H], [f + cab, H - 0.2]], () => W / 2 - 0.02, c);
  box(p.trim, 0, 0.75, f + cab + (L - cab) / 2, 0, -1, W - 0.3, 0.25, L - cab, 0x2a2a2a);          // chassis
  box(p.paint, 0, 1.0, f + cab + 0.1 + (L - cab - 0.2) / 2, 0, -1, W, 0.5, L - cab - 0.2, s.accent ?? 0x6a5a3a); // body sides
  box(p.trim, 0, 1.5, f + cab + 0.3 + (L - cab - 0.5) / 2, 0, -1, W - 0.05, H - 1.6, L - cab - 0.5, s.cargo ?? 0x4e5a3a); // tarpaulin load
  for (const z of [f + 1.1, r - 1.6, r - 0.6]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.3), z, 0.48, 0.32, 0x8a8d90);
  details(p, L, W, 0.85, 0.6, 2.1, f + 0.2);
}

/**
 * Bajaj RE-style three-wheeler, modelled on the classic Colombo tuk-tuk: narrow rounded front cowl with one headlamp
 * and a contrasting (usually yellow) upper cowl + windscreen frame, black canvas hood that wraps down the back,
 * open sides, a pressed-steel passenger tub, blue vinyl bench, front mudguard over the single wheel.
 */
function tuktuk(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, f = -L / 2, r = L / 2, c = s.color!, top = s.accent ?? 0xf2c230, SEAT = 0x2a3f8f;
  // Front cowl: lower in body colour, upper (dash + screen surround) in the accent colour, rounded nose.
  extrude(p.paint, [[f + 0.02, 0.32], [f - 0.02, 0.6], [f + 0.02, 0.82], [f + 0.6, 0.82], [f + 0.7, 0.32]], taper(0.4, 0.32, 0.82, 0.06), c);
  extrude(p.paint, [[f + 0.02, 0.82], [f + 0.1, 1.02], [f + 0.62, 1.0], [f + 0.6, 0.82]], taper(0.42, 0.82, 1.02, 0.05), top);
  // Windscreen (slightly raked) with accent frame and a centre bar, roof pillars back to the hood.
  extrude(p.glass, [[f + 0.12, 1.02], [f + 0.2, 1.56], [f + 0.24, 1.56], [f + 0.16, 1.02]], () => 0.4, 0xffffff);
  for (const side of [-1, 1]) {
    box(p.paint, side * 0.42, 1.0, f + 0.17, 0, -1, 0.05, 0.6, 0.05, top);                     // screen frame sides
    box(p.trim, side * (W / 2 - 0.04), 0.85, f + 0.75, 0, -1, 0.04, 0.85, 0.04, BLACK);         // front hood stays
  }
  box(p.paint, 0, 1.56, f + 0.21, 0, -1, 0.86, 0.06, 0.08, top);                                 // screen header
  box(p.trim, 0, 1.0, f + 0.2, 0, -1, 0.025, 0.56, 0.02, BLACK);                                  // wiper / centre bar
  // Passenger tub: pressed steel, wider than the cowl, rounded rear corners; open above the waistline.
  extrude(p.paint, [[f + 0.6, 0.3], [f + 0.6, 0.86], [r - 0.12, 0.86], [r, 0.74], [r, 0.3]], taper(W / 2, 0.3, 0.86, 0.04), c);
  for (const y of [0.45, 0.6]) for (const side of [-1, 1]) box(p.trim, side * (W / 2 + 0.005), y, 0.25, 0, -1, 0.01, 0.025, L * 0.5, 0x0e0e0e); // side ribs
  // Black canvas hood: rounded, overhangs the screen, wraps down the back with a small rear window.
  extrude(p.trim, [[f + 0.12, 1.58], [f + 0.25, 1.72], [r - 0.3, 1.77], [r - 0.04, 1.65], [r + 0.02, 0.86], [r - 0.06, 0.86], [r - 0.1, 1.58]], () => W / 2 + 0.03, 0x161616);
  extrude(p.glass, [[r - 0.05, 1.25], [r - 0.03, 1.5], [r + 0.03, 1.5], [r + 0.03, 1.25]], () => 0.22, 0xffffff);
  // Interior: blue bench + backrest, driver's seat, handlebar, driver.
  box(p.trim, 0, 0.82, r - 0.55, 0, -1, W - 0.16, 0.12, 0.55, SEAT);
  box(p.trim, 0, 0.94, r - 0.22, 0, -1, W - 0.16, 0.6, 0.12, SEAT);
  box(p.trim, 0, 0.82, -0.1, 0, -1, 0.42, 0.1, 0.38, SEAT);
  box(p.trim, 0, 1.12, f + 0.55, 0, -1, 0.62, 0.035, 0.035, CHROME);                             // handlebar
  box(p.trim, 0, 0.92, -0.1, 0, -1, 0.4, 0.5, 0.28, s.rider ?? 0x5a6a8a);                         // driver
  box(p.trim, 0, 1.42, -0.1, 0, -1, 0.21, 0.24, 0.22, 0x5c3e2a);
  box(p.trim, 0, 1.62, -0.08, 0, -1, 0.23, 0.07, 0.23, 0x141010);
  // Front: round headlamp on the nose, indicators, mudguard over the wheel; rear lamps + plate.
  box(p.lamp, 0, 0.66, f - 0.04, 0, -1, 0.18, 0.18, 0.06, LAMP);
  for (const side of [-1, 1]) box(p.lamp, side * 0.3, 0.88, f + 0.06, 0, -1, 0.06, 0.05, 0.04, AMBER);
  extrude(p.trim, [[f - 0.12, 0.42], [f - 0.05, 0.5], [f + 0.4, 0.5], [f + 0.45, 0.4], [f + 0.38, 0.44], [f - 0.05, 0.44]], () => 0.08, BLACK);
  for (const side of [-1, 1]) box(p.lamp, side * (W / 2 - 0.16), 0.58, r + 0.01, 0, -1, 0.12, 0.1, 0.04, TAIL);
  box(p.trim, 0, 0.42, r + 0.02, 0, -1, 0.42, 0.13, 0.02, PLATE);
  wheel(p, 0, f + 0.15, 0.22, 0.12);
  for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.1), r - 0.45, 0.22, 0.14);
}

function motorcycle(p: Parts, s: VehicleSpec) {
  const L = s.length, f = -L / 2, r = L / 2, c = s.color!, scooter = (s.accent ?? 0) === 1;
  if (scooter) { // Dio/Activa-style: step-through with front apron and body panels
    extrude(p.paint, [[f + 0.35, 0.35], [f + 0.25, 1.0], [f + 0.45, 1.0], [f + 0.6, 0.45], [r - 0.6, 0.4], [r - 0.55, 0.8], [r - 0.15, 0.8], [r - 0.1, 0.4]], () => 0.2, c);
  } else {     // commuter / FZ / Pulsar: tank, engine, tail
    extrude(p.paint, [[f + 0.55, 0.75], [f + 0.7, 0.95], [-0.05, 0.92], [0.1, 0.78], [-0.05, 0.5], [f + 0.6, 0.55]], () => 0.17, c);
    box(p.trim, 0, 0.3, -0.05, 0, -1, 0.26, 0.35, 0.5, 0x3a3a3a); // engine
    extrude(p.paint, [[0.1, 0.8], [0.15, 0.88], [r - 0.15, 0.95], [r - 0.1, 0.85], [0.1, 0.72]], () => 0.12, c);
  }
  box(p.trim, 0, 0.86, 0.25, 0, -1, 0.26, 0.09, 0.55, BLACK);                       // seat
  box(p.trim, 0, 1.0, f + 0.32, 0, -1, 0.64, 0.04, 0.04, CHROME);                   // handlebar
  box(p.trim, 0, 0.45, f + 0.32, 0, -1, 0.06, 0.6, 0.06, CHROME);                   // forks
  box(p.lamp, 0, 0.88, f + 0.22, 0, -1, 0.16, 0.14, 0.06, LAMP);
  box(p.lamp, 0, 0.82, r - 0.08, 0, -1, 0.12, 0.08, 0.05, TAIL);
  wheel(p, 0, f + 0.32, 0.3, 0.1); wheel(p, 0, r - 0.32, 0.3, 0.12);
  // Rider: legs, torso, arms, helmet (helmets are compulsory in Sri Lanka).
  const shirt = s.rider ?? 0x2a3a5a;
  box(p.trim, 0, 0.6, 0.1, 0, -1, 0.36, 0.35, 0.3, 0x2a2a30);
  box(p.trim, 0, 0.95, 0.18, 0, -1, 0.4, 0.55, 0.26, shirt);
  for (const side of [-1, 1]) box(p.trim, side * 0.2, 1.05, -0.12, 0, -1, 0.09, 0.09, 0.5, shirt);
  box(p.trim, 0, 1.52, 0.14, 0, -1, 0.26, 0.28, 0.3, s.helmet ?? 0xdedede);
}

export function buildModel(spec: VehicleSpec, noWheels = false): Parts {
  const p: Parts = { paint: new GeometryBuffer(), glass: new GeometryBuffer(), trim: new GeometryBuffer(), lamp: new GeometryBuffer(), noWheels };
  ({ tuktuk, motorcycle, car, van, bus, lorry } as Record<string, (p: Parts, s: VehicleSpec) => void>)[spec.category](p, spec);
  return p;
}

// --- paint ---------------------------------------------------------------------------------------------
// Rough Colombo street colour shares: private cars skew white/silver/grey/black.
const CAR_PAINT: [number, number][] = [
  [0xf2f2f0, 30], [0xc4c7cb, 18], [0x7e8388, 12], [0x161718, 12], [0x6b1a24, 6], [0x1f3f7a, 6], [0xa01c22, 5],
  [0x2f4a36, 3], [0x8a7a62, 3], [0x3a5a8c, 3], [0xd9c79a, 2],
];
const pickW = (r: () => number, list: [number, number][]) => { let x = r() * list.reduce((s, e) => s + e[1], 0); for (const [c, w] of list) if ((x -= w) <= 0) return c; return list[0][0]; };
/** Subtle per-vehicle variation (fading, dirt), quantised so meshes can still be shared. */
const vary = (c: number, k: number) => {
  const f = [1, 0.94, 0.88][k], ch = (s: number) => Math.round(Math.min(255, ((c >> s) & 255) * f));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

export interface Look { color: number; accent?: number; cargo?: number; rider?: number; helmet?: number }

export function randomLook(spec: VehicleSpec, r: () => number): Look {
  const k = Math.floor(r() * 3);
  const any = (l: number[]) => l[Math.floor(r() * l.length)];
  switch (spec.category) {
    case 'car': return { color: vary(pickW(r, CAR_PAINT), k) };
    case 'van': return { color: vary(r() < 0.1 ? 0xe8c21a /* school van */ : pickW(r, CAR_PAINT.slice(0, 4)), k) };
    case 'bus': {
      if (r() < 0.4) return { color: 0x9a1b1b }; // SLTB
      if (r() < 0.3) return { color: 0xf4f4f2, accent: METRO_RED }; // Lanka Metro Transit
      return { color: any([0x2a63c8, 0xe6e6e6, 0xd65a1a, 0x1f8a4a, 0x7a1f8a, 0xc81e3a, 0x1a1a1a]), accent: any([0xf2c230, 0xffffff, 0x2ab0e0, 0xe02a6a, 0x30c060]) };
    }
    case 'lorry': return { color: any([0x2a5aa8, 0xd8b21a, 0xe8e8e8, 0x2f7a3a, 0xb02020]), accent: any([0x6a5a3a, 0x3a4a6a, 0x8a2a1a]), cargo: any([0x4e5a3a, 0x2a3a6a, 0x6a6a6a, 0x8a6a3a]) };
    case 'tuktuk': return { color: vary(any([0x151515, 0x151515, 0x7a1424, 0xb0181f, 0x1d5e2a, 0x1b3f8a, 0x2a7a8a]), k), accent: any([0xf2c230, 0xf2c230, 0x151515, 0xd8d8d0]) };
    case 'motorcycle': return { color: any([0x151515, 0x151515, 0xb0181f, 0x1b3f8a, 0xdedede, 0x5a5a5a, 0x1d6a2a]), accent: r() < 0.4 ? 1 : 0,
      rider: any([0x2a3a5a, 0xe8e8e8, 0x8a2a2a, 0x3a3a3a, 0x5a7a9a, 0x2a5a3a]), helmet: any([0xdedede, 0x151515, 0xb0181f, 0x1b3f8a, 0xd6a417]) };
  }
}

/** Every ModelCache's lamp material, so time of day can switch all vehicle lights at once. */
const lampMats: pc.StandardMaterial[] = [];
let lampsOn = false;
export function setVehicleLamps(on: boolean) {
  lampsOn = on;
  for (const m of lampMats) { m.emissiveIntensity = on ? 1.6 : 0; m.update(); }
}

/** Mesh cache per (kind, look): each distinct model is built once and shared. */
export class ModelCache {
  private meshes = new Map<string, pc.MeshInstance[]>();
  readonly hazardMat: pc.StandardMaterial;
  private mats: { paint: pc.StandardMaterial; glass: pc.StandardMaterial; trim: pc.StandardMaterial; lamp: pc.StandardMaterial };
  private hazardMesh: pc.Mesh;

  constructor(private device: pc.GraphicsDevice) {
    const mat = (gloss: number, metal: number) => {
      const m = new pc.StandardMaterial();
      m.diffuseVertexColor = true; m.gloss = gloss; m.useMetalness = true; m.metalness = metal; m.cull = pc.CULLFACE_NONE;
      m.update(); return m;
    };
    this.mats = { paint: mat(0.7, 0.35), glass: mat(0.95, 0.1), trim: mat(0.35, 0.2), lamp: mat(0.9, 0) };
    // Lens colour by day; lit (emissive, feeds the bloom) at sunset/night via setVehicleLamps.
    const l = this.mats.lamp; l.emissive = new pc.Color(1, 1, 1); l.emissiveVertexColor = true; l.emissiveIntensity = lampsOn ? 1.6 : 0; l.update();
    lampMats.push(l);
    this.mats.paint.clearCoat = 0.8; this.mats.paint.clearCoatGloss = 0.92; this.mats.paint.update(); // lacquered car paint
    this.mats.glass.diffuse = new pc.Color(0.12, 0.15, 0.18); this.mats.glass.diffuseVertexColor = false; this.mats.glass.update();
    this.hazardMat = new pc.StandardMaterial();
    this.hazardMat.emissive = new pc.Color(1, 0.55, 0.05);
    this.hazardMat.update();
    const g = new GeometryBuffer();
    box(g, 0, 0, 0, 0, -1, 0.18, 0.12, 0.06, 0xffffff);
    this.hazardMesh = g.toMesh(device)!;
  }

  /** Body only (no wheels), for the player's car whose wheels steer and spin. */
  body(spec: VehicleSpec, look: Look): pc.MeshInstance[] {
    const b = buildModel({ ...spec, ...look } as VehicleSpec, true);
    return (['paint', 'glass', 'trim', 'lamp'] as const).flatMap(k => { const m = b[k].toMesh(this.device); return m ? [new pc.MeshInstance(m, this.mats[k])] : []; });
  }

  /** One wheel (tyre + rim) centred at the origin, rim facing +X. */
  wheel(radius: number, width: number): pc.MeshInstance {
    const p: Parts = { paint: new GeometryBuffer(), glass: new GeometryBuffer(), trim: new GeometryBuffer(), lamp: new GeometryBuffer() };
    wheel(p, 0.0001, 0, radius, width);
    const m = p.trim.toMesh(this.device)!;
    return new pc.MeshInstance(m, this.mats.trim);
  }

  entity(spec: VehicleSpec, look: Look): { root: pc.Entity; hazard: pc.Entity } {
    const key = spec.id + JSON.stringify(look);
    let parts = this.meshes.get(key);
    if (!parts) {
      const b = buildModel({ ...spec, ...look } as VehicleSpec);
      parts = (['paint', 'glass', 'trim', 'lamp'] as const).flatMap(k => { const m = b[k].toMesh(this.device); return m ? [new pc.MeshInstance(m, this.mats[k])] : []; });
      this.meshes.set(key, parts);
    }
    const root = new pc.Entity(spec.id);
    root.addComponent('render', { meshInstances: parts.map(mi => new pc.MeshInstance(mi.mesh!, mi.material!)), castShadows: true });
    const hazard = new pc.Entity('hazards');
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const h = new pc.Entity();
      h.addComponent('render', { meshInstances: [new pc.MeshInstance(this.hazardMesh, this.hazardMat)], castShadows: false });
      h.setLocalPosition(x * (spec.width / 2), Math.min(spec.height * 0.45, 0.85), z * (spec.length / 2 + 0.03));
      hazard.addChild(h);
    }
    hazard.enabled = false;
    root.addChild(hazard);
    return { root, hazard };
  }
}
