// Map data pipeline: OpenStreetMap (Overpass API) -> local-metre chunk files in public/data.
// Run: npm run fetch-map   (Node >= 22.18, uses built-in TypeScript stripping)
// Data © OpenStreetMap contributors, ODbL. Raw responses are cached in scripts/.cache.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { project } from '../src/map/MapProjection.ts';
import { zoneAt, type Zone } from './landuse.ts';
import type { BuildingData, BuildingKind, ChunkData, MapIndex, RoadData } from '../src/map/MapTypes.ts';

// Colombo Fort / Pettah / Maradana down to Dehiwala.
const BOUNDS = { south: 6.835, west: 79.838, north: 6.958, east: 79.885 };
const CHUNK = 500;
const ENDPOINTS = (process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter').split(',');
const OUT = 'public/data';
const CACHE = 'scripts/.cache';

const ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const DEFAULT_WIDTH: Record<string, number> = {
  motorway: 14, trunk: 13, primary: 12, secondary: 10, tertiary: 8,
  unclassified: 6, residential: 6, living_street: 5,
};

interface OsmWay { type: 'way'; id: number; nodes: number[]; geometry: { lat: number; lon: number }[]; tags?: Record<string, string> }
interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }

async function overpass(query: string, cacheKey: string): Promise<(OsmWay | OsmNode)[]> {
  const file = `${CACHE}/${cacheKey}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).elements;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'cmb-rider-map-pipeline/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        writeFileSync(file, text);
        return JSON.parse(text).elements;
      }
      console.warn(`  ${url} -> ${res.status}, retrying`);
    } catch (e) {
      console.warn(`  ${url} -> ${(e as Error).message}, retrying`);
    }
    await new Promise(r => setTimeout(r, 2000 * 2 ** Math.min(attempt, 4)));
  }
  throw new Error('Overpass unavailable for ' + cacheKey);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function flat(geom: { lat: number; lon: number }[]): number[] {
  const out: number[] = [];
  for (const g of geom) { const [x, z] = project(g.lat, g.lon); out.push(r1(x), r1(z)); }
  return out;
}

function roadWidth(t: Record<string, string>): number {
  const w = parseFloat(t.width);
  if (w > 2 && w < 40) return w;
  const lanes = parseInt(t.lanes);
  if (lanes > 0) return Math.max(lanes * 3.3, 5);
  const base = t.highway.replace('_link', '');
  return t.highway.endsWith('_link') ? 6.5 : DEFAULT_WIDTH[base] ?? 6;
}

// OSM building/amenity/shop tags -> the architectural class the generator styles by.
function classify(t: Record<string, string>, area: number, zone?: Zone): BuildingKind {
  const b = t.building;
  if (/^(house|detached|semidetached_house|terrace|residential|bungalow)$/.test(b)) return area > 450 && b === 'residential' ? 'apartments' : 'house';
  if (/^(apartments|dormitory|hotel)$/.test(b) || t.tourism === 'hotel') return 'apartments';
  if (/^(office|government|bank)$/.test(b) || t.office || t.amenity === 'bank') return 'office';
  if (/^(retail|kiosk|supermarket)$/.test(b) || t.shop) return 'shop';
  if (/^(commercial|mall)$/.test(b)) return 'commercial';
  if (/^(industrial|warehouse|factory|service|garage|garages|hangar|storage_tank)$/.test(b)) return 'industrial';
  if (/^(church|mosque|temple|buddhist|hindu|shrine|kovil|cathedral|chapel)$/.test(b) || t.amenity === 'place_of_worship') return 'religious';
  if (/^(school|university|college|hospital|public|civic|train_station|transportation|stadium)$/.test(b) || t.amenity) return 'civic';
  if (/^(hut|shed|roof|cabin|carport)$/.test(b)) return 'hut';
  // building=yes: use the official land-use zone the footprint sits in (CMC area), then footprint size.
  switch (zone) {
    case 'residential': return area > 450 ? 'apartments' : 'house';
    case 'commercial': return area < 120 ? 'shop' : area > 1500 ? 'office' : 'commercial';
    case 'education': case 'institutional': case 'health': case 'socio': return area < 60 ? 'hut' : 'civic';
    case 'industrial': return 'industrial';
    case 'religious': return area < 60 ? 'hut' : 'religious';
  }
  // Outside the plan area: guess from footprint. Small = house, mid = shophouse/commercial, huge = office block.
  if (area < 160) return 'house';
  if (area < 700) return 'commercial';
  return area > 2500 ? 'office' : 'apartments';
}

// Typical storey ranges per class when OSM has no height (Colombo: low-rise houses, 2-4 floor shophouses).
const LEVELS: Record<BuildingKind, [number, number]> = {
  house: [1, 2], hut: [1, 1], shop: [1, 3], commercial: [2, 4], apartments: [3, 8],
  office: [4, 12], industrial: [1, 2], religious: [1, 2], civic: [2, 4],
};

function buildingHeight(t: Record<string, string>, id: number, area: number, kind: BuildingKind): [number, number, boolean] {
  const lv = parseFloat(t['building:levels']);
  const h = parseFloat(t.height ?? t['building:height']);
  if (h > 0) return [h, lv > 0 ? lv : Math.max(1, Math.round(h / 3.3)), false];
  if (lv > 0) return [lv * 3.3 + (kind === 'industrial' ? 3 : 0.8), lv, false];
  const rnd = ((id * 2654435761) >>> 0) / 2 ** 32;
  const [lo, hi] = LEVELS[kind];
  // Bigger footprints of the same class trend taller.
  const levels = Math.min(hi, lo + Math.floor(rnd * (hi - lo + 1) + Math.min(area / 1500, 2)));
  return [levels * (kind === 'industrial' ? 5 : 3.3) + 0.8, levels, true];
}

function colour(v?: string): number | undefined {
  if (!v) return undefined;
  const named: Record<string, number> = { white: 0xf2f2ee, grey: 0x9a9a9a, gray: 0x9a9a9a, red: 0xa8463a, brown: 0x7a5a40, yellow: 0xe8cf6a, beige: 0xe2d6b5, blue: 0x5a7aa8, green: 0x6a9a6a, black: 0x303030, orange: 0xd98a40 };
  if (named[v.toLowerCase()]) return named[v.toLowerCase()];
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  return m ? parseInt(m[1], 16) : undefined;
}

function ringArea(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a / 2);
}

// --- Road/building reconciliation ---------------------------------------------------------------------
// Default widths (no width/lanes tag) are guesses and often wider than the real street, painting asphalt under
// real buildings. Narrow each untagged way to the space actually free between footprints, and drop footprints that
// sit on a drivable centreline (OSM errors or arcades), which would otherwise be solid walls across the road.
function fitRoadsToBuildings(chunks: Map<string, ChunkData>, tagged: Set<number>) {
  const CELL = 20, grid = new Map<string, number[]>(); // flat building edges [x0,z0,x1,z1,...]
  const rings: { b: BuildingData; c: ChunkData }[] = [];
  for (const c of chunks.values()) for (const b of c.buildings) {
    rings.push({ b, c });
    const p = b.p, n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[j * 2], z1 = p[j * 2 + 1];
      for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++)
        for (let cz = Math.floor(Math.min(z0, z1) / CELL); cz <= Math.floor(Math.max(z0, z1) / CELL); cz++) {
          const k = cx + ',' + cz; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(x0, z0, x1, z1);
        }
    }
  }
  const clearance = (x: number, z: number, max: number) => {
    let best = max;
    for (let cx = Math.floor((x - max) / CELL); cx <= Math.floor((x + max) / CELL); cx++)
      for (let cz = Math.floor((z - max) / CELL); cz <= Math.floor((z + max) / CELL); cz++) {
        const e = grid.get(cx + ',' + cz); if (!e) continue;
        for (let i = 0; i < e.length; i += 4) {
          const ex = e[i + 2] - e[i], ez = e[i + 3] - e[i + 1], l2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - e[i]) * ex + (z - e[i + 1]) * ez) / l2));
          best = Math.min(best, Math.hypot(e[i] + ex * t - x, e[i + 1] + ez * t - z));
        }
      }
    return best;
  };
  // Samples every ~4 m along each way (across all its chunk pieces).
  const samples = new Map<number, { pts: number[]; w: number }>();
  for (const c of chunks.values()) for (const r of c.roads) {
    let s = samples.get(r.id); if (!s) samples.set(r.id, (s = { pts: [], w: r.w }));
    for (let i = 0; i < r.p.length - 2; i += 2) {
      const dx = r.p[i + 2] - r.p[i], dz = r.p[i + 3] - r.p[i + 1], n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 4));
      for (let k = 0; k < n; k++) s.pts.push(r.p[i] + dx * k / n, r.p[i + 1] + dz * k / n);
    }
  }
  const newWidth = new Map<number, number>();
  let narrowed = 0;
  for (const [id, s] of samples) {
    if (tagged.has(id)) continue;
    const d: number[] = [];
    for (let i = 0; i < s.pts.length; i += 2) d.push(clearance(s.pts[i], s.pts[i + 1], s.w / 2 + 3));
    d.sort((a, b) => a - b);
    const free = d[Math.floor(d.length * 0.2)] ?? s.w; // 20th percentile: robust to a single protruding building
    const w = Math.max(4.5, Math.min(s.w, 2 * (free - 0.6)));
    if (w < s.w - 0.3) { newWidth.set(id, Math.round(w * 10) / 10); narrowed++; }
  }
  for (const c of chunks.values()) for (const r of c.roads) { const w = newWidth.get(r.id); if (w) r.w = w; }

  // Drop footprints that contain a drivable centreline sample.
  const drivable = new Set<number>();
  for (const c of chunks.values()) for (const r of c.roads) if (r.h !== 'service') drivable.add(r.id);
  const PT = 10, ptGrid = new Map<string, number[]>();
  for (const [id, s] of samples) if (drivable.has(id)) for (let i = 0; i < s.pts.length; i += 2) {
    const k = Math.floor(s.pts[i] / PT) + ',' + Math.floor(s.pts[i + 1] / PT); let a = ptGrid.get(k); if (!a) ptGrid.set(k, (a = [])); a.push(s.pts[i], s.pts[i + 1]);
  }
  const inside = (p: number[], x: number, z: number) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) if ((p[i * 2 + 1] > z) !== (p[j * 2 + 1] > z) && x < ((p[j * 2] - p[i * 2]) * (z - p[i * 2 + 1])) / (p[j * 2 + 1] - p[i * 2 + 1]) + p[i * 2]) c = !c; return c; };
  let dropped = 0;
  for (const { b, c } of rings) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
    let hit = false;
    for (let cx = Math.floor(x0 / PT); cx <= Math.floor(x1 / PT) && !hit; cx++) for (let cz = Math.floor(z0 / PT); cz <= Math.floor(z1 / PT) && !hit; cz++) {
      const a = ptGrid.get(cx + ',' + cz); if (!a) continue;
      for (let i = 0; i < a.length && !hit; i += 2) hit = inside(b.p, a[i], a[i + 1]);
    }
    if (hit) { c.buildings.splice(c.buildings.indexOf(b), 1); dropped++; }
  }
  console.log(`road fit: narrowed ${narrowed} untagged ways to building clearance; dropped ${dropped} footprints on drivable centrelines`);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  rmSync(`${OUT}/chunks`, { recursive: true, force: true });
  mkdirSync(`${OUT}/chunks`, { recursive: true });

  // Fetch in latitude strips to keep each Overpass query small.
  const ways = new Map<number, OsmWay>();
  const places: MapIndex['places'] = [];
  const STRIPS = 5;
  const dLat = (BOUNDS.north - BOUNDS.south) / STRIPS;
  for (let s = 0; s < STRIPS; s++) {
    const bb = `${(BOUNDS.south + s * dLat).toFixed(4)},${BOUNDS.west},${(BOUNDS.south + (s + 1) * dLat).toFixed(4)},${BOUNDS.east}`;
    console.log(`strip ${s + 1}/${STRIPS} (${bb})`);
    const q = `[out:json][timeout:180];(way["highway"~"^(${ROAD_CLASSES})$"](${bb});way["building"](${bb});way["natural"="coastline"](${bb});node["place"~"^(suburb|neighbourhood|quarter)$"](${bb}););out body geom;`;
    for (const el of await overpass(q, `strip${s}`)) {
      if (el.type === 'way' && el.geometry) ways.set(el.id, el);
      if (el.type === 'node' && el.tags?.name) {
        const [x, z] = project(el.lat, el.lon);
        places.push({ name: el.tags['name:en'] ?? el.tags.name, x: r1(x), z: r1(z) });
      }
    }
  }

  const chunks = new Map<string, ChunkData>();
  const chunkOf = (x: number, z: number) => {
    const key = `${Math.floor(x / CHUNK)}_${Math.floor(z / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { roads: [], buildings: [], junctions: [] }));
    return c;
  };

  const coast: number[][] = [];
  const nodeUse = new Map<number, { count: number; width: number; x: number; z: number }>();
  const nodeRoads = new Map<number, { p: number[]; i: number; w: number; o: boolean }[]>();
  let roadCount = 0, buildingCount = 0, estimated = 0;
  const taggedWidth = new Set<number>(); // ways whose width comes from OSM width/lanes tags (never narrowed)

  for (const w of ways.values()) {
    const t = w.tags ?? {};
    if (t.natural === 'coastline') { coast.push(flat(w.geometry)); continue; }

    if (t.highway) {
      if (t.area === 'yes') continue;
      const p = flat(w.geometry);
      const width = roadWidth(t);
      if (parseFloat(t.width) > 2 || parseInt(t.lanes) > 0) taggedWidth.add(w.id);
      const road: Omit<RoadData, 'p'> = { id: w.id, n: t['name:en'] ?? t.name ?? '', h: t.highway, w: width, o: t.oneway === 'yes' || t.junction === 'roundabout' };
      const lanes = parseInt(t.lanes);
      if (lanes > 0) road.l = lanes;
      roadCount++;
      // Split the polyline into runs by chunk (segment midpoint), overlapping by one vertex.
      let run: number[] = [p[0], p[1]];
      let runKey = '';
      for (let i = 1; i < p.length / 2; i++) {
        const mx = (p[i * 2 - 2] + p[i * 2]) / 2, mz = (p[i * 2 - 1] + p[i * 2 + 1]) / 2;
        const key = `${Math.floor(mx / CHUNK)}_${Math.floor(mz / CHUNK)}`;
        if (runKey && key !== runKey) {
          chunks.get(runKey)!.roads.push({ ...road, p: run });
          run = [p[i * 2 - 2], p[i * 2 - 1]];
        }
        if (!runKey || key !== runKey) { runKey = key; chunkOf(mx, mz); }
        run.push(p[i * 2], p[i * 2 + 1]);
      }
      chunks.get(runKey)!.roads.push({ ...road, p: run });

      w.nodes.forEach((id, i) => {
        const u = nodeUse.get(id) ?? { count: 0, width: 0, x: p[i * 2], z: p[i * 2 + 1] };
        u.count += i === 0 || i === w.nodes.length - 1 ? 1 : 2;
        u.width = Math.max(u.width, width);
        nodeUse.set(id, u);
        let nr = nodeRoads.get(id);
        if (!nr) nodeRoads.set(id, (nr = []));
        nr.push({ p, i, w: width, o: road.o });
      });
      continue;
    }

    if (t.building) {
      const p = flat(w.geometry);
      if (p.length >= 8 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2; // drop closing vertex
      if (p.length < 6) continue;
      const area = ringArea(p);
      if (area < 8) continue;
      let la = 0, lo = 0;
      for (const g of w.geometry) { la += g.lat; lo += g.lon; }
      const k = classify(t, area, t.building === 'yes' ? zoneAt(la / w.geometry.length, lo / w.geometry.length) : undefined);
      const [h, l, e] = buildingHeight(t, w.id, area, k);
      let cx = 0, cz = 0;
      for (let i = 0; i < p.length; i += 2) { cx += p[i]; cz += p[i + 1]; }
      const b: BuildingData = { id: w.id, h: r1(h), e, k, l: Math.round(l), p };
      if (t['roof:shape']) b.r = t['roof:shape'];
      if (t['name:en'] ?? t.name) b.n = t['name:en'] ?? t.name;
      const c = colour(t['building:colour']), rc = colour(t['roof:colour']);
      if (c !== undefined) b.c = c;
      if (rc !== undefined) b.rc = rc;
      chunkOf(cx / (p.length / 2), cz / (p.length / 2)).buildings.push(b);
      buildingCount++;
      if (e) estimated++;
    }
  }

  for (const u of nodeUse.values()) {
    if (u.count >= 3) chunkOf(u.x, u.z).junctions.push(u.x, u.z, r1(u.width / 2));
  }

  fitRoadsToBuildings(chunks, taggedWidth);

  // Street furniture from OSM nodes, oriented by the road way(s) each node sits on.
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const dirAt = (p: number[], from: number, to: number) => {
    const dx = p[to * 2] - p[from * 2], dz = p[to * 2 + 1] - p[from * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  let nSig = 0, nCr = 0, nLamp = 0, nSign = 0, nBus = 0;
  for (let s = 0; s < STRIPS; s++) {
    const bb = `${(BOUNDS.south + s * dLat).toFixed(4)},${BOUNDS.west},${(BOUNDS.south + (s + 1) * dLat).toFixed(4)},${BOUNDS.east}`;
    const q = `[out:json][timeout:180];node["highway"~"^(traffic_signals|crossing|street_lamp|stop|give_way|bus_stop)$"](${bb});out body;`;
    for (const el of await overpass(q, `nodes${s}`)) {
      if (el.type !== 'node') continue;
      const t = el.tags ?? {};
      const [x, z] = project(el.lat, el.lon);
      const c = chunkOf(x, z);
      const on = nodeRoads.get(el.id) ?? [];
      const junction = (nodeUse.get(el.id)?.count ?? 0) >= 3;
      const dirTag = t['traffic_signals:direction'] ?? t.direction;
      switch (t.highway) {
        case 'traffic_signals': {
          // One stop position per incoming carriageway direction.
          const maxW = Math.max(0, ...on.map(r => r.w));
          for (const r of on) {
            const n = r.p.length / 2;
            const incoming: number[][] = [];
            if (r.i > 0 && dirTag !== 'backward') incoming.push(dirAt(r.p, r.i - 1, r.i));
            if (r.i < n - 1 && !r.o && dirTag !== 'forward') incoming.push(dirAt(r.p, r.i + 1, r.i));
            for (const [ux, uz] of incoming) {
              const back = junction ? maxW / 2 + 3 : 1.5;
              (c.sig ??= []).push(r1(x - ux * back), r1(z - uz * back), r2(Math.atan2(ux, uz)), r1(r.w / 2), r.o ? 1 : 0);
              nSig++;
            }
          }
          break;
        }
        case 'crossing': {
          if (/^(unmarked|no)$/.test(t.crossing ?? '') || !on.length) break;
          const r = on[0], n = r.p.length / 2;
          const [ux, uz] = dirAt(r.p, Math.max(r.i - 1, 0), Math.min(r.i + 1, n - 1));
          (c.cr ??= []).push(r1(x), r1(z), r2(Math.atan2(ux, uz)), r1(r.w / 2), t.crossing === 'traffic_signals' ? 1 : 0);
          nCr++;
          break;
        }
        case 'street_lamp': (c.lamp ??= []).push(r1(x), r1(z)); nLamp++; break;
        case 'bus_stop': (c.bus ??= []).push(r1(x), r1(z)); nBus++; break;
        default: { // stop / give_way: sign for traffic heading towards the junction
          const r = on[0];
          if (!r) break;
          const n = r.p.length / 2;
          const fwd = dirTag === 'forward' || (dirTag !== 'backward' && r.i >= n / 2);
          const [ux, uz] = fwd ? dirAt(r.p, Math.max(r.i - 1, 0), r.i || 1) : dirAt(r.p, Math.min(r.i + 1, n - 1), r.i === n - 1 ? n - 2 : r.i);
          (c.sign ??= []).push(r1(x), r1(z), r2(Math.atan2(ux, uz)), r1(r.w / 2), t.highway === 'stop' ? 0 : 1);
          nSign++;
        }
      }
    }
  }
  console.log(`signal heads ${nSig}, crossings ${nCr}, OSM lamps ${nLamp}, stop/give-way ${nSign}, bus stops ${nBus}`);

  for (const [key, c] of chunks) writeFileSync(`${OUT}/chunks/${key}.json`, JSON.stringify(c));

  const index: MapIndex = {
    chunkSize: CHUNK,
    bounds: BOUNDS,
    chunks: [...chunks.keys()],
    coast,
    places,
    fetched: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  console.log(`roads ${roadCount}, buildings ${buildingCount} (${estimated} with estimated height), chunks ${chunks.size}, coast ways ${coast.length}, places ${places.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
