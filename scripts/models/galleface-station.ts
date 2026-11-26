// One Galle Face (Shangri-La) towers and Colombo Fort Railway Station, on their real OSM footprints; writes the
// GLBs and their records.json entries. Looks follow photographs supplied by the user (the towers' twisted, striped
// night design in particular is taken from that reference, not surveyed). Run: node scripts/models/galleface-station.ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Model } from './glb.ts';
import { unproject } from '../../src/map/MapProjection.ts';

const fps = new Map<number, number[]>();
for (const f of readdirSync('public/data/chunks')) for (const b of JSON.parse(readFileSync(`public/data/chunks/${f}`, 'utf8')).buildings) fps.set(b.id, b.p);
const centre = (id: number) => {
  const p = fps.get(id);
  if (!p) throw new Error(`no footprint ${id}`);
  const xs = p.filter((_, i) => i % 2 === 0), zs = p.filter((_, i) => i % 2 === 1);
  return { p, x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
};
const records = JSON.parse(readFileSync('public/data/buildings/records.json', 'utf8'));
function record(id: string, name: string, osm: number, x: number, z: number, extra: object) {
  const [latitude, longitude] = unproject(x, z);
  const r = { id, name, latitude, longitude, osm: [osm], buildingType: 'landmark', model: `buildings/models/${id}.glb`, references: [], source: 'OSM footprint; appearance from user-supplied photos', confidence: 'approximate', ...extra };
  const i = records.findIndex((q: any) => q.id === id);
  if (i < 0) records.push(r); else records[i] = r;
}

// --- Twisted, light-striped towers ---------------------------------------------------------------------
const GLASS = 0x2b3640, SLAB = 0xc9a56a, STRIPE = 0xfff1cf, CROWN = 0x1d2428;
function tower(id: string, name: string, osm: number, h: number, twist: number) {
  const { p, x, z } = centre(osm), n = p.length / 2, m = new Model();
  m.night.set(SLAB, 0.9); m.night.set(STRIPE, 3); m.night.set(GLASS, 0.12);
  m.finish.set(GLASS, [0.6, 0.12]);
  // Outline resampled to rounded-corner plan, pulled in slightly so the twist stays on the plot.
  const base: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = [p[i * 2] - x, p[i * 2 + 1] - z], b = [p[j * 2] - x, p[j * 2 + 1] - z];
    for (let k = 1; k < 8; k++) { const t = k / 8; base.push([(a[0] + (b[0] - a[0]) * t) * 0.86, (a[1] + (b[1] - a[1]) * t) * 0.86]); }
  }
  const N = base.length;
  const at = (i: number, y: number, grow = 1): number[] => {
    const a = (y / h) * twist, c = Math.cos(a), s = Math.sin(a), [bx, bz] = base[((i % N) + N) % N];
    const k = grow * (1 - 0.1 * (y / h) ** 2);
    return [(bx * c - bz * s) * k, y, (bx * s + bz * c) * k];
  };
  const floors = Math.round(h / 4.1), fh = h / floors;
  for (let f = 0; f < floors; f++) {
    const y = f * fh;
    for (let i = 0; i < N; i++) {
      m.poly(GLASS, [at(i, y), at(i + 1, y), at(i + 1, y + fh), at(i, y + fh)]);
      m.poly(SLAB, [at(i, y, 1.045), at(i + 1, y, 1.045), at(i + 1, y + 0.8, 1.045), at(i, y + 0.8, 1.045)]);
      m.poly(CROWN, [at(i, y + 0.8, 1.045), at(i + 1, y + 0.8, 1.045), at(i + 1, y + 0.8), at(i, y + 0.8)]);
    }
  }
  // Diagonal light ribbons climbing around the facade.
  const RIBBONS = 8, STEPS = 120;
  for (let r = 0; r < RIBBONS; r++) for (let s = 0; s < STEPS; s++) {
    const pt = (t: number, dy: number) => {
      const y = 12 + t * (h * 0.84), u = (r / RIBBONS) * N + t * N * 0.55, i = Math.floor(u), fr = u - i;
      const a = at(i, y + dy, 1.07), b = at(i + 1, y + dy, 1.07);
      return a.map((v, k) => v + (b[k] - v) * fr);
    };
    m.poly(STRIPE, [pt(s / STEPS, 0), pt((s + 1) / STEPS, 0), pt((s + 1) / STEPS, 2.2), pt(s / STEPS, 2.2)]);
  }
  // Crown and roof.
  const top = Array.from({ length: N }, (_, i) => at(i, h + 6, 0.96));
  for (let i = 0; i < N; i++) m.poly(CROWN, [at(i, h), at(i + 1, h), at(i + 1, h + 6, 0.96), at(i, h + 6, 0.96)]);
  m.poly(CROWN, top);
  m.write(`public/data/buildings/models/${id}.glb`, 0.4);
  record(id, name, osm, x, z, { height: h, skyline: true });
}
tower('one-galle-face-1', 'One Galle Face Tower 1 (Shangri-La)', 839411971, 194, 0.95);
tower('one-galle-face-2', 'One Galle Face Tower 2 (Shangri-La)', 839411972, 194, 0.95);
tower('one-galle-face-3', 'Shangri-La Colombo', 705103818, 158, -0.7);

// --- Colombo Fort Railway Station ------------------------------------------------------------------------
{
  const { x, z } = centre(232514810), m = new Model();
  const WHITE = 0xe9e7de, SHADOW = 0x22252a, ROOF = 0x8a3f2c, IRON = 0x151515, GOLD = 0xd6a62c, STONE = 0x77716a, CLOCK = 0xf8f6ee;
  m.night.set(WHITE, 0.28); m.night.set(GOLD, 0.5); m.night.set(CLOCK, 1.2);
  m.finish.set(GOLD, [0.8, 0.3]);
  // Front edge faces Olcott Mawatha (north): u along it, n outward.
  const A = [520 - x, 0, -748 - z], B = [604 - x, 0, -739.5 - z];
  const L = Math.hypot(B[0] - A[0], B[2] - A[2]), u = [(B[0] - A[0]) / L, 0, (B[2] - A[2]) / L], nn = [u[2], 0, -u[0]];
  const o = [(A[0] + B[0]) / 2, 0, (A[2] + B[2]) / 2], half = L / 2;
  const box = (c: number, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number) => m.fbox(c, o, u, nn, [s0, s1], [y0, y1], [d0, d1]);
  const P = (a: number, y: number, d: number) => [o[0] + u[0] * a + nn[0] * d, y, o[2] + u[2] * a + nn[2] * d];

  box(WHITE, -half, half, 0, 6.6, -14, -3);                                  // main block
  box(ROOF, -half, half, 6.6, 7.4, -14, -3.5);
  for (let a = -half + 3; a < half - 2; a += 4.6) box(SHADOW, a - 1.5, a + 1.5, 0.1, 3.6, -3, -2.95); // doorways
  // Arcaded verandah: columns with shallow arches under a deep fascia that carries the name.
  for (let a = -half; a <= half + 0.1; a += L / 18) {
    box(WHITE, a - 0.18, a + 0.18, 0, 4.2, -0.4, 0);
    if (a < half - 1) for (let k = 0; k < 10; k++) {
      const w = L / 18, t0 = k / 10, t1 = (k + 1) / 10, arch = (t: number) => 2.9 + Math.sin(Math.PI * t) * 1.1;
      m.poly(WHITE, [P(a + w * t0, arch(t0), -0.05), P(a + w * t1, arch(t1), -0.05), P(a + w * t1, 4.2, -0.05), P(a + w * t0, 4.2, -0.05)]);
    }
  }
  box(WHITE, -half, half, 4.2, 6.2, -3, 0.25);                               // fascia
  // Balustrade.
  for (let a = -half; a < half; a += 0.9) box(WHITE, a, a + 0.28, 6.2, 7.2, -0.1, 0.15);
  box(WHITE, -half, half, 7.2, 7.5, -0.25, 0.3);
  // Central pavilion: attic storey, pilasters, rounded pediment, clock, finial.
  box(WHITE, -11, 11, 6.2, 9.6, -3, -0.6);
  for (const a of [-11, -6.5, -4.5, 4.5, 6.5, 11]) { box(WHITE, a - 0.35, a + 0.35, 7.5, 10.4, -0.7, -0.25); box(WHITE, a - 0.5, a + 0.5, 10.4, 10.9, -0.85, -0.1); }
  for (let a = -3.6; a <= 3.6; a += 1.2) box(SHADOW, a - 0.3, a + 0.3, 7.7, 8.9, -0.6, -0.55);
  const arc = Array.from({ length: 25 }, (_, i) => { const t = Math.PI * (i / 24); return [Math.cos(t) * 5.5, 9.6 + Math.sin(t) * 4]; });
  for (const d of [-0.55, -1.4]) m.poly(WHITE, arc.map(([a, y]) => P(a, y, d)));
  for (let i = 0; i < 24; i++) m.poly(WHITE, [P(arc[i][0], arc[i][1], -0.4), P(arc[i + 1][0], arc[i + 1][1], -0.4), P(arc[i + 1][0], arc[i + 1][1], -1.6), P(arc[i][0], arc[i][1], -1.6)]);
  const disc = (c: number, r: number, d: number) => m.poly(c, Array.from({ length: 32 }, (_, i) => { const t = (i / 32) * Math.PI * 2; return P(Math.cos(t) * r, 11.2 + Math.sin(t) * r, d); }));
  disc(SHADOW, 1.45, -0.5); disc(CLOCK, 1.25, -0.47);
  box(SHADOW, -0.06, 0.06, 11.2, 12.15, -0.47, -0.44); box(SHADOW, 0, 0.75, 11.15, 11.27, -0.47, -0.44);
  box(IRON, -0.08, 0.08, 13.5, 17.5, -1.05, -0.9);
  // Iron fence (with the entrance gap), hedge and the gilded statue on its plinth.
  for (let a = -half; a < half; a += 0.45) if (Math.abs(a) > 5 && Math.abs(a - 24) > 3) box(IRON, a, a + 0.08, 0, 1.9, 8, 8.08);
  for (const [s0, s1] of [[-half, -5], [5, 21], [27, half]]) { box(IRON, s0, s1, 1.55, 1.65, 7.98, 8.1); box(0x2f5a2c, s0, s1, 0, 0.8, 6.6, 7.6); }
  box(STONE, -1.1, 1.1, 0, 0.7, 5.4, 7.6); box(SHADOW, -0.65, 0.65, 0.7, 3.6, 5.85, 7.15);
  box(GOLD, -0.3, -0.05, 3.6, 4.7, 6.35, 6.65); box(GOLD, 0.05, 0.3, 3.6, 4.7, 6.35, 6.65);
  box(GOLD, -0.45, 0.45, 4.7, 6.0, 6.25, 6.75); box(GOLD, -0.68, -0.45, 4.8, 5.9, 6.35, 6.65); box(GOLD, 0.45, 0.68, 4.8, 5.9, 6.35, 6.65);
  box(GOLD, -0.25, 0.25, 6.05, 6.6, 6.27, 6.73);
  for (const a of [14, 16.5, 19]) { box(0xbbbbbb, a, a + 0.1, 0, 10, 6, 6.1); box(a === 16.5 ? 0xd98a1c : 0x8c1f1f, a + 0.1, a + 1.7, 8.6, 9.8, 6.02, 6.06); }

  m.write('public/data/buildings/models/fort-station.glb', 0.8);
  const s = P(0, 5.2, 0.3), yaw = (Math.atan2(nn[0], nn[2]) * 180) / Math.PI;
  record('fort-station', 'Colombo Fort Railway Station', 232514810, x, z,
    { sign: { text: 'FORT RAILWAY STATION   කොටුව දුම්රිය ස්ථානය   கோட்டை புகையிரத நிலையம்', x: s[0], y: s[1], z: s[2], yaw, w: 66, h: 1.7 } });
}
writeFileSync('public/data/buildings/records.json', JSON.stringify(records, null, 1) + '\n');
console.log('ok');
