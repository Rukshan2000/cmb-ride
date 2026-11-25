// Pulls openly licensed (CC-BY-SA 4.0) Mapillary street-level photos that FACE each priority building.
// Run: node scripts/fetch-references.ts [count=30]   (token from backend/.env: MAPILLARY_TOKEN)
// Writes public/data/buildings/refs/<osm>/<imageId>.jpg and adds/updates records in records.json
// (confidence stays 'unverified' until a model is built and compared in-game).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

process.loadEnvFile('backend/.env');
const TOKEN = process.env.MAPILLARY_TOKEN;
if (!TOKEN) throw new Error('MAPILLARY_TOKEN missing in backend/.env');
const COUNT = Number(process.argv[2] ?? 30), PER_BUILDING = 3;
const DIR = 'public/data/buildings';

const worklist = JSON.parse(readFileSync(`${DIR}/worklist.json`, 'utf8')).buildings as any[];
const records = JSON.parse(readFileSync(`${DIR}/records.json`, 'utf8')) as any[];

const D = Math.PI / 180;
const metres = (lat1: number, lon1: number, lat2: number, lon2: number) => Math.hypot((lat2 - lat1) * 111320, (lon2 - lon1) * 111320 * Math.cos(lat1 * D));
const bearing = (lat1: number, lon1: number, lat2: number, lon2: number) => (Math.atan2((lon2 - lon1) * Math.cos(lat1 * D), lat2 - lat1) / D + 360) % 360;
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

async function images(lat: number, lon: number, d: number) {
  const url = `https://graph.mapillary.com/images?fields=id,thumb_1024_url,compass_angle,computed_compass_angle,computed_geometry,geometry,captured_at,creator,is_pano&bbox=${lon - d},${lat - d},${lon + d},${lat + d}&limit=200`;
  const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
  if (!res.ok) throw new Error(`Mapillary HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).data as any[];
}

let added = 0;
for (const b of worklist.slice(0, COUNT)) {
  // Tall buildings must be photographed from further away (and never from on/inside the building).
  const minD = Math.max(10, Math.min(b.height ?? 10, 300) * 0.6), maxD = Math.max(80, minD * 3);
  const box = Math.min(maxD / 111320, 0.0045);
  const daytime = (ms: number) => { const h = (new Date(ms).getUTCHours() + 5.5) % 24; return h >= 7 && h <= 17.5; }; // Colombo UTC+5:30
  const cands = (await images(b.lat, b.lon, box)).filter(i => !i.is_pano && i.thumb_1024_url).map(i => {
    const [lon, lat] = (i.computed_geometry ?? i.geometry).coordinates;
    const heading = i.computed_compass_angle ?? i.compass_angle;
    const dist = metres(lat, lon, b.lat, b.lon), off = angDiff(heading, bearing(lat, lon, b.lat, b.lon));
    return { i, lat, lon, heading, dist, off, score: off + Math.abs(dist - minD * 1.8) * 0.3 };
  }).filter(c => c.dist > minD && c.dist < maxD && c.off < 30 && (!c.i.captured_at || daytime(c.i.captured_at))).sort((a, b) => a.score - b.score);

  // Spread picks across viewpoints: skip photos taken within 10 m of an already chosen one.
  const picks: typeof cands = [];
  for (const c of cands) if (picks.length < PER_BUILDING && !picks.some(p => metres(p.lat, p.lon, c.lat, c.lon) < 10)) picks.push(c);

  const id = b.landmark ? records.find(r => r.name === b.landmark)?.id : `colombo_osm_${b.osm}`;
  let rec = records.find(r => r.id === id);
  if (!rec) {
    rec = { id, name: b.name || '', latitude: b.lat, longitude: b.lon, osm: [b.osm], buildingType: b.kind, architecturalStyle: '', primaryColor: '', secondaryColors: [], roofType: '',
      floors: b.heightEstimated ? undefined : b.floors, height: b.heightEstimated ? undefined : b.height, model: '', references: [],
      source: `OSM way ${b.osm} footprint; Mapillary street-level references`, confidence: 'unverified' };
    records.push(rec);
  }
  mkdirSync(`${DIR}/refs/${b.osm}`, { recursive: true });
  for (const c of picks) {
    const path = `buildings/refs/${b.osm}/${c.i.id}.jpg`;
    if (rec.references.some((r: any) => r.path === path)) continue;
    if (!existsSync(`public/data/${path}`)) {
      const img = await fetch(c.i.thumb_1024_url);
      if (!img.ok) continue;
      writeFileSync(`public/data/${path}`, Buffer.from(await img.arrayBuffer()));
    }
    rec.references.push({
      path, license: 'CC BY-SA 4.0 (Mapillary)', author: c.i.creator?.username ?? 'Mapillary contributor',
      url: `https://www.mapillary.com/app/?pKey=${c.i.id}`, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), heading: Math.round(c.heading),
      captured: c.i.captured_at ? new Date(c.i.captured_at).toISOString().slice(0, 10) : undefined, distance: Math.round(c.dist),
    });
    added++;
  }
  console.log(`P${b.priority} ${b.osm} ${b.name || b.road}: ${cands.length} facing photos, kept ${picks.length}`);
}
writeFileSync(`${DIR}/records.json`, JSON.stringify(records, null, 1));
console.log(`added ${added} reference photos; records ${records.length}`);
