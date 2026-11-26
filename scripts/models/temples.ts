// Jami Ul-Alfar (Red Mosque, Pettah; outline = OSM relation 20279441) and Gangaramaya Temple (OSM footprints
// 1054624854/5/6, identified by position). Facades and proportions are a stylised approximation, not surveyed.
// Run: node scripts/models/temples.ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Model } from './glb.ts';
import { unproject } from '../../src/map/MapProjection.ts';

const records = JSON.parse(readFileSync('public/data/buildings/records.json', 'utf8'));
function save(id: string, name: string, osm: number[], x: number, z: number, m: Model) {
  m.write(`public/data/buildings/models/${id}.glb`, 0.75);
  const [latitude, longitude] = unproject(x, z);
  const r = { id, name, latitude, longitude, osm, buildingType: 'religious', model: `buildings/models/${id}.glb`, references: [], source: 'OSM outline; stylised model', confidence: 'approximate' };
  const i = records.findIndex((q: any) => q.id === id);
  if (i < 0) records.push(r); else records[i] = r;
}
const TAU = Math.PI * 2;
const ring = (r: number, a: number, y: number, cx: number, cz: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
/** Surface of revolution; colour may vary by (profile step, segment). */
function lathe(m: Model, color: number | ((i: number, k: number) => number), cx: number, cz: number, prof: [number, number][], seg = 24) {
  for (let i = 0; i < prof.length - 1; i++) for (let k = 0; k < seg; k++) {
    const a = (k / seg) * TAU, b = ((k + 1) / seg) * TAU, [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
    m.poly(typeof color === 'number' ? color : color(i, k), [ring(r0, a, y0, cx, cz), ring(r0, b, y0, cx, cz), ring(r1, b, y1, cx, cz), ring(r1, a, y1, cx, cz)]);
  }
}
/** Walls round an outline between two heights. */
function walls(m: Model, c: number, p: number[][], y0: number, y1: number) {
  p.forEach((a, i) => { const b = p[(i + 1) % p.length]; m.poly(c, [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]]); });
}

// --- Red Mosque: candy-striped masonry, pomegranate domes, minarets, clock tower -------------------------
{
  const RED = 0xa3231f, WHITE = 0xf0ebe0, DARK = 0x2a1a18, GOLD = 0xd8b24a, GREEN = 0x1f6a4a;
  const outline = [[777.2, -1238.8], [770.1, -1254.4], [763.4, -1251.4], [743.6, -1242.4], [739, -1244.4], [732, -1272.6], [738.4, -1278.4], [746.8, -1275.4], [774, -1284.4], [791.7, -1245.4]];
  const cx = 761, cz = -1261, m = new Model(), p = outline.map(([x, z]) => [x - cx, z - cz]);
  m.night.set(WHITE, 0.35); m.night.set(RED, 0.3); m.night.set(GOLD, 0.8);
  const H = 17;
  for (let y = 0, i = 0; y < H; y += 0.8, i++) walls(m, i % 3 === 2 ? WHITE : RED, p, y, Math.min(H, y + 0.8));
  m.poly(WHITE, p.map(([x, z]) => [x, H, z]));
  // Arched windows on every face, three tiers.
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 6) return;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let nx = uz, nz = -ux; if (nx * (a[0] + b[0]) + nz * (a[1] + b[1]) < 0) { nx = -nx; nz = -nz; }
    for (let t = 3; t < L - 2; t += 4) for (const y of [1, 6.5, 11.5]) {
      const arch = (c: number, w: number, h: number, out: number) => {
        const P = (s: number, yy: number) => [a[0] + ux * s + nx * out, yy, a[1] + uz * s + nz * out];
        const pts = [P(t - w, y), P(t + w, y)];
        for (let k = 0; k <= 8; k++) { const th = (k / 8) * Math.PI; pts.push(P(t + Math.cos(th) * w, y + h + Math.sin(th) * w)); }
        m.poly(c, pts);
      };
      arch(WHITE, 1.25, 2.4, 0.08); arch(DARK, 0.85, 2.3, 0.14);
    }
  });
  const dome = (x: number, z: number, r: number, y: number) => {
    lathe(m, (_, k) => (k % 2 ? RED : WHITE), x, z, [[r * 0.8, y], [r * 0.8, y + r * 0.5]]);
    lathe(m, (i, k) => ((i + k) % 2 ? RED : WHITE), x, z, [[r * 0.8, y + r * 0.5], [r, y + r * 0.9], [r * 1.05, y + r * 1.35], [r * 0.85, y + r * 1.85], [r * 0.45, y + r * 2.2], [r * 0.1, y + r * 2.45]], 28);
    lathe(m, GOLD, x, z, [[0.18, y + r * 2.45], [0.35, y + r * 2.65], [0.05, y + r * 3.1]], 8);
  };
  const minaret = (x: number, z: number, h: number) => {
    for (let y = H, i = 0; y < h; y += 1, i++) lathe(m, i % 2 ? WHITE : RED, x, z, [[1.15, y], [1.15, Math.min(h, y + 1)]], 8);
    lathe(m, WHITE, x, z, [[1.7, h], [1.7, h + 0.5]], 8);
    dome(x, z, 1.4, h + 0.5);
  };
  p.forEach(([x, z], i) => { if ([0, 3, 5, 8, 9].includes(i)) minaret(x * 0.96, z * 0.96, 23); });
  dome(0, 0, 5.5, H); dome(-10, -4, 3.2, H); dome(11, 6, 3.2, H); dome(3, -13, 2.6, H);
  // Clock tower by the street corner.
  const [tx, tz] = [p[9][0] * 0.82, p[9][1] * 0.82];
  for (let y = H, i = 0; y < 31; y += 0.9, i++) lathe(m, i % 3 === 1 ? WHITE : RED, tx, tz, [[2.8, y], [2.8, Math.min(31, y + 0.9)]], 8);
  for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.39; lathe(m, WHITE, tx + Math.cos(a) * 2.75, tz + Math.sin(a) * 2.75, [[0.01, 28], [0.9, 28.4], [0.9, 28.6], [0.01, 29]], 12); }
  dome(tx, tz, 2.6, 31);
  lathe(m, GREEN, 0, 0, [[0.05, H + 17], [0.4, H + 17.6], [0.05, H + 18.2]], 8);
  save('red-mosque', 'Jami Ul-Alfar Mosque (Red Mosque)', [], cx, cz, m);
}

// --- Gangaramaya: tiered clay-tile roofs, white stupa with golden spire, Bo tree ------------------------
{
  const WALL = 0xf2ede0, TILE = 0xc4561f, GOLD = 0xe0b43a, DARK = 0x4a2a1a, WHITE = 0xfaf8f2, LEAF = 0x4f8a34, TRUNK = 0x6b5846, SAFFRON = 0xe8871a;
  const ids = [1054624854, 1054624855, 1054624856], fp: number[][][] = [];
  for (const f of readdirSync('public/data/chunks')) for (const b of JSON.parse(readFileSync(`public/data/chunks/${f}`, 'utf8')).buildings)
    if (ids.includes(b.id)) fp[ids.indexOf(b.id)] = Array.from({ length: b.p.length / 2 }, (_, i) => [b.p[i * 2], b.p[i * 2 + 1]]);
  if (fp.filter(Boolean).length !== 3) throw new Error('temple footprints not found');
  const cx = 1268, cz = 1180, m = new Model();
  m.night.set(GOLD, 1.4); m.night.set(WHITE, 0.45); m.night.set(WALL, 0.25); m.night.set(SAFFRON, 0.8);
  m.finish.set(GOLD, [0.85, 0.25]);
  const local = fp.map(p => p.map(([x, z]) => [x - cx, z - cz]));
  const centre = (p: number[][]) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  /** Pillared hall with two overlapping hip roofs and gilded ridge finials. */
  const hall = (p: number[][], h: number) => {
    const [ox, oz] = centre(p), shrink = (k: number, y: number) => p.map(([x, z]) => [ox + (x - ox) * k, y, oz + (z - oz) * k]);
    walls(m, WALL, shrink(0.9, 0).map(q => [q[0], q[2]]), 0, h);
    for (const q of shrink(1, 0)) lathe(m, WALL, q[0], q[2], [[0.3, 0], [0.3, h]], 8);
    for (const [k0, y0, k1, y1] of [[1.18, h, 0.7, h + 2.4], [0.8, h + 2.9, 0.2, h + 6]]) {
      const a = shrink(k0, y0), b = shrink(k1, y1);
      a.forEach((q, i) => { const j = (i + 1) % a.length; m.poly(TILE, [q, a[j], b[j], b[i]]); m.poly(GOLD, [q, a[j], [a[j][0], y0 + 0.35, a[j][2]], [q[0], y0 + 0.35, q[2]]]); });
      m.poly(TILE, b);
      for (const q of a) lathe(m, GOLD, q[0], q[2], [[0.25, y0], [0.35, y0 + 0.5], [0.03, y0 + 1.5]], 8);
    }
    walls(m, DARK, shrink(0.7, 0).map(q => [q[0], q[2]]), h + 2.3, h + 2.9);
    lathe(m, GOLD, ox, oz, [[0.6, h + 6], [0.9, h + 6.6], [0.2, h + 7.4], [0.03, h + 9]], 10);
  };
  hall(local[0], 4.5); hall(local[1], 6.5); hall(local[2], 4);
  // Stupa and Bo tree stand on open ground beside the halls (clear of every footprint and road).
  const sx = 1227 - cx, sz = 1167 - cz;
  const k = 0.8, stupa = (c: number, prof: [number, number][], seg: number) => lathe(m, c, sx, sz, prof.map(([r, y]) => [r * k, y * k] as [number, number]), seg);
  stupa(WHITE, [[7, 0], [7, 1], [6, 1], [6, 2], [5.2, 2], [5.2, 3.5], [5, 6], [4, 8.2], [2.2, 9.6], [0.8, 10]], 32);
  stupa(WHITE, [[1.5, 9.6], [1.5, 11.2]], 4);
  stupa(GOLD, [[1.2, 11.2], [0.9, 12.4], [0.7, 14], [0.45, 15.6], [0.3, 17], [0.55, 17.6], [0.03, 19]], 16);
  // Bo tree on a raised terrace.
  const bx = 1275 - cx, bz = 1203 - cz;
  lathe(m, WHITE, bx, bz, [[4, 0], [4, 1.4], [0, 1.4]], 8);
  lathe(m, GOLD, bx, bz, [[4.1, 1.4], [4.1, 2]], 8);
  lathe(m, TRUNK, bx, bz, [[1.1, 1.4], [0.8, 7]], 8);
  for (const [dx, y, dz, r] of [[0, 10, 0, 5], [3.5, 8.5, 1, 3.2], [-3, 9, -2, 3.4], [0, 12.5, 1, 3]]) lathe(m, LEAF, bx + dx, bz + dz, [[0.1, y - r * 0.6], [r * 0.9, y - r * 0.2], [r, y + r * 0.1], [r * 0.6, y + r * 0.5], [0.1, y + r * 0.65]], 12);
  for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; lathe(m, SAFFRON, bx + Math.cos(a) * 4.4, bz + Math.sin(a) * 4.4, [[0.06, 0], [0.06, 3.2], [0.4, 2.8], [0.06, 2.4]], 6); }
  save('gangaramaya', 'Gangaramaya Temple', ids, cx, cz, m);
}
writeFileSync('public/data/buildings/records.json', JSON.stringify(records, null, 1) + '\n');
console.log('ok');
