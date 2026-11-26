// Water bodies (lakes, canals, rivers, harbour basins) and beaches from OpenStreetMap -> public/data/water.json
// (local metres, multipolygon holes = islands). Run: node scripts/fetch-water.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { project } from '../src/map/MapProjection.ts';

const { bounds: b } = JSON.parse(readFileSync('public/data/index.json', 'utf8'));
const bb = `${b.south},${b.west},${b.north},${b.east}`;
const query = `[out:json][timeout:180];(way["natural"~"^(water|beach|sand)$"](${bb});relation["natural"~"^(water|beach|sand)$"](${bb});way["waterway"="riverbank"](${bb});way["landuse"~"^(reservoir|basin)$"](${bb}););out body geom;`;

async function fetchOsm(): Promise<any[]> {
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'map-pipeline/0.1', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(200000) });
      if (res.ok) return (await res.json()).elements;
      console.warn(url, res.status);
    } catch (e) { console.warn(url, (e as Error).message); }
  }
  throw new Error('Overpass unavailable');
}

type Pt = { lat: number; lon: number };
/** Join member ways end-to-end into closed rings. */
function rings(ways: Pt[][]): Pt[][] {
  const same = (a: Pt, c: Pt) => a.lat === c.lat && a.lon === c.lon, left = ways.map(w => w.slice()), out: Pt[][] = [];
  while (left.length) {
    const ring = left.shift()!;
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1], i = left.findIndex(w => same(w[0], end) || same(w[w.length - 1], end));
      if (i < 0) break;
      const w = left.splice(i, 1)[0];
      if (!same(w[0], end)) w.reverse();
      ring.push(...w.slice(1));
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) out.push(ring.slice(0, -1));
  }
  return out;
}
const flat = (r: Pt[]) => r.flatMap(p => project(p.lat, p.lon).map(v => Math.round(v * 10) / 10));
const inside = (p: number[], x: number, z: number) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) if ((p[i * 2 + 1] > z) !== (p[j * 2 + 1] > z) && x < ((p[j * 2] - p[i * 2]) * (z - p[i * 2 + 1])) / (p[j * 2 + 1] - p[i * 2 + 1]) + p[i * 2]) c = !c; return c; };

const water: { n?: string; p: number[]; holes: number[][] }[] = [], beach: typeof water = [];
for (const el of await fetchOsm()) {
  const t = el.tags ?? {};
  if (t.natural === 'sand' && (t.sport || t.leisure || /pitch/i.test(t.name ?? ''))) continue; // sports grounds, not beaches
  const list = t.natural === 'beach' || t.natural === 'sand' ? beach : water;
  const outer = el.type === 'way' ? rings([el.geometry]) : rings(el.members.filter((m: any) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m: any) => m.geometry));
  const inner = el.type === 'way' ? [] : rings(el.members.filter((m: any) => m.role === 'inner' && m.geometry).map((m: any) => m.geometry)).map(flat);
  for (const o of outer) {
    const p = flat(o);
    list.push({ n: t['name:en'] ?? t.name, p, holes: inner.filter(h => inside(p, h[0], h[1])) });
  }
}
writeFileSync('public/data/water.json', JSON.stringify({ attribution: '© OpenStreetMap contributors (ODbL)', fetched: new Date().toISOString(), water, beach }));
console.log(`water areas ${water.length}, beaches ${beach.length}`);
console.log('named:', [...new Set([...water, ...beach].map(w => w.n).filter(Boolean))].join(', '));
