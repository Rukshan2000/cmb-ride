// Ranks OSM building footprints for replacement with real, reference-based models.
// Run: node scripts/building-priority.ts   -> public/data/buildings/worklist.json (+ .csv for spreadsheets)
//
// Priority 1: frontage on major roads (primary/trunk/secondary)   Priority 2: at signalised junctions
// Priority 3: landmarks (landmarks.json)                             Priority 4: everything else (background)
// Each row links to street-level / map references so an artist can find photos of THAT building.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { project, unproject } from '../src/map/MapProjection.ts';
import type { ChunkData } from '../src/map/MapTypes.ts';

const DIR = 'public/data/chunks', OUT = 'public/data/buildings';
const MAJOR = /^(trunk|primary|secondary)(_link)?$/;
const CELL = 50;

const chunks: ChunkData[] = readdirSync(DIR).map(f => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')));
const grid = new Map<string, { x0: number; z0: number; x1: number; z1: number; name: string; hw: number }[]>();
const signals: number[] = [];
for (const c of chunks) {
  for (const r of c.roads) {
    if (!MAJOR.test(r.h)) continue;
    for (let i = 0; i < r.p.length - 2; i += 2) {
      const s = { x0: r.p[i], z0: r.p[i + 1], x1: r.p[i + 2], z1: r.p[i + 3], name: r.n, hw: r.w / 2 };
      for (let cx = Math.floor(Math.min(s.x0, s.x1) / CELL) - 1; cx <= Math.floor(Math.max(s.x0, s.x1) / CELL) + 1; cx++)
        for (let cz = Math.floor(Math.min(s.z0, s.z1) / CELL) - 1; cz <= Math.floor(Math.max(s.z0, s.z1) / CELL) + 1; cz++) {
          const k = cx + ',' + cz; (grid.get(k) ?? grid.set(k, []).get(k)!).push(s);
        }
    }
  }
  for (let i = 0; i < (c.sig ?? []).length; i += 5) signals.push(c.sig![i], c.sig![i + 1]);
}
const landmarks: { name: string; lat: number; lon: number }[] = JSON.parse(readFileSync('public/data/landmarks.json', 'utf8'));

function segDist(x: number, z: number, s: { x0: number; z0: number; x1: number; z1: number }) {
  const ex = s.x1 - s.x0, ez = s.z1 - s.z0, l2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((x - s.x0) * ex + (z - s.z0) * ez) / l2));
  return Math.hypot(s.x0 + ex * t - x, s.z0 + ez * t - z);
}
function inside(x: number, z: number, p: number[]) {
  let c = false;
  for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++)
    if ((p[i * 2 + 1] > z) !== (p[j * 2 + 1] > z) && x < ((p[j * 2] - p[i * 2]) * (z - p[i * 2 + 1])) / (p[j * 2 + 1] - p[i * 2 + 1]) + p[i * 2]) c = !c;
  return c;
}

const rows: any[] = [];
const best3: Record<string, { id: number; rank: number }> = {};
const all = new Map<number, any>();
function ringArea(p: number[]) { let a = 0; for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; } return Math.abs(a / 2); }
for (const c of chunks) for (const b of c.buildings) {
  const p = b.p, n = p.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
  cx /= n; cz /= n;
  // Frontage: footprint perimeter within 12 m of a major road's kerb.
  let frontage = 0, road = '', best = Infinity;
  const segs = grid.get(Math.floor(cx / CELL) + ',' + Math.floor(cz / CELL)) ?? [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, mx = (p[i * 2] + p[j * 2]) / 2, mz = (p[i * 2 + 1] + p[j * 2 + 1]) / 2;
    for (const s of segs) {
      const d = segDist(mx, mz, s) - s.hw;
      if (d < best) { best = d; road = s.name; }
      if (d < 12) { frontage += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); break; }
    }
  }
  const atJunction = signals.some((_, k) => k % 2 === 0 && Math.hypot(signals[k] - cx, signals[k + 1] - cz) < 45);
  const [lat, lon] = unproject(cx, cz);
  for (const l of landmarks) {
    const [x, z] = project(l.lat, l.lon);
    const key = l.name.split(' (')[0].toLowerCase(), nm = (b.n ?? '').toLowerCase();
    const named = !!nm && Math.hypot(x - cx, z - cz) < 400 && (nm.includes(key) || key.includes(nm));
    // Name match beats position; among candidates the largest structure wins (not the ticket booth).
    const rank = (named ? 1e6 : 0) + b.h * 100 + ringArea(p) / 100;
    if ((named || (!b.n && inside(x, z, p))) && rank > (best3[l.name]?.rank ?? -1)) best3[l.name] = { id: b.id, rank };
  }
  const priority = frontage > 0 ? (atJunction ? 2 : 1) : 4;
  const score = Math.round(frontage * Math.min(b.h, 40) / 10 + (atJunction ? 50 : 0));
  const row = ({
    osm: b.id, name: b.n ?? '', priority, score, lat: +lat.toFixed(6), lon: +lon.toFixed(6), road: road || '(unnamed major road)',
    kind: b.k, height: b.h, heightEstimated: b.e, floors: b.l, frontage: Math.round(frontage),
    osmUrl: `https://www.openstreetmap.org/way/${b.id}`,
    streetLevel: `https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=19`,
  });
  all.set(b.id, row);
  if (priority !== 4) rows.push(row);
}
const landmarkMatches: Record<string, number> = {};
for (const [name, { id }] of Object.entries(best3)) {
  landmarkMatches[name] = id;
  const r = all.get(id); r.priority = 3; r.landmark = name;
  if (!rows.includes(r)) rows.push(r);
}
rows.sort((a, b) => (a.priority === 3 ? -1 : 0) - (b.priority === 3 ? -1 : 0) || b.score - a.score);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/worklist.json`, JSON.stringify({ generated: new Date().toISOString(), landmarkMatches, buildings: rows }, null, 1));
const cols = ['priority', 'score', 'osm', 'name', 'road', 'lat', 'lon', 'kind', 'height', 'heightEstimated', 'floors', 'frontage', 'osmUrl', 'streetLevel'];
writeFileSync(`${OUT}/worklist.csv`, [cols.join(','), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n'));
const byP = [1, 2, 3].map(p => rows.filter(r => r.priority === p).length);
console.log(`major-road frontage buildings: P1 ${byP[0]}, P2 (signal junctions) ${byP[1]}, P3 (landmarks) ${byP[2]}; background ${chunks.reduce((s, c) => s + c.buildings.length, 0) - rows.length}`);
console.log('landmark footprints:', landmarkMatches, 'unmatched:', landmarks.filter(l => !landmarkMatches[l.name]).map(l => l.name));
console.log('top 10:'); rows.slice(0, 10).forEach(r => console.log(` P${r.priority} ${r.osm} ${r.road} h=${r.height}${r.heightEstimated ? '(est)' : ''} frontage=${r.frontage}m`));
