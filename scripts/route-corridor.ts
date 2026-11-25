// Route-first Colombo reconstruction: Fort -> Pettah -> Maradana -> Ananda College -> Borella.
// Builds the source-of-truth database public/data/colombo/route1.json (geography only, no rendering logic):
//   route geometry (OSRM over OSM), sections, every building within 50 m (OSM footprint, height, floors, priority),
//   the road ways the route uses (width/lanes/oneway and whether those are tagged or estimated),
//   and driver-perspective Mapillary reference photos every ~40 m (CC BY-SA) in references/<section>/.
// Manual annotations in route1.json (colour, floors, roof, status, notes...) are PRESERVED on re-run.
// Run: node scripts/route-corridor.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { project, unproject } from '../src/map/MapProjection.ts';
import type { ChunkData } from '../src/map/MapTypes.ts';

process.loadEnvFile('backend/.env');
const OUT = 'public/data/colombo', DB = `${OUT}/route1.json`;
// Waypoints: snapped to the correct carriageway in OSM so OSRM drives straight through (no loops/backtracking).
// Olcott Mawatha is a one-way dual carriageway: Fort/Pettah points sit on the EASTBOUND side.
// Ananda College lies between Maradana and Borella, so it is visited before Borella (front on Kularatne Mawatha).
const WAYPOINTS = [
  { id: 'fort', name: 'Colombo Fort', lat: 6.93420, lon: 79.84900 },       // Olcott Mawatha eastbound, Fort station forecourt
  { id: 'pettah', name: 'Pettah', lat: 6.93425, lon: 79.85537 },           // Olcott Mawatha eastbound, past Pettah bus stand
  { id: 'maradana', name: 'Maradana', lat: 6.92905, lon: 79.86505 },       // Maradana junction (Panchikawatte Rd)
  { id: 'ananda', name: 'Ananda College', lat: 6.92466, lon: 79.86786 },   // P. de S. Kularatne Mawatha frontage
  { id: 'borella', name: 'Borella', lat: 6.91430, lon: 79.87775 },         // Borella, D. S. Senanayake Mawatha
];
const CORRIDOR = 50, REF_STEP = 40;

const prev = existsSync(DB) ? JSON.parse(readFileSync(DB, 'utf8')) : null;
const keep = (list: any[] | undefined, id: any) => list?.find((x: any) => x.id === id) ?? {};

// --- route ------------------------------------------------------------------------------------------
const coords = WAYPOINTS.map(w => `${w.lon},${w.lat}`).join(';');
const osrm = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`)).json();
if (osrm.code !== 'Ok') throw new Error('route failed: ' + osrm.message);
const route = osrm.routes[0];
const pts: number[] = [];
for (const [lon, lat] of route.geometry.coordinates) pts.push(...project(lat, lon));
const cum = [0];
for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
// Section boundaries = route distance where each leg ends (OSRM legs are between consecutive waypoints).
const legEnds: number[] = []; { let a = 0; for (const l of route.legs) legEnds.push((a += l.distance)); }
const scale = cum[cum.length - 1] / legEnds[legEnds.length - 1];
const sections = WAYPOINTS.slice(0, -1).map((w, i) => ({
  id: w.id, name: `${w.name} → ${WAYPOINTS[i + 1].name}`, from: Math.round((i ? legEnds[i - 1] : 0) * scale), to: Math.round(legEnds[i] * scale),
  roads: [...new Set(route.legs[i].steps.map((s: any) => s.name).filter(Boolean))],
  status: keep(prev?.sections, w.id).status ?? 'generic', notes: keep(prev?.sections, w.id).notes ?? '',
}));
const sectionAt = (d: number) => sections.find(s => d <= s.to)?.id ?? sections[sections.length - 1].id;

function nearestOnRoute(x: number, z: number) {
  let best = Infinity, along = 0;
  for (let i = 0; i < pts.length / 2 - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], ex = pts[i * 2 + 2] - ax, ez = pts[i * 2 + 3] - az, l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)), d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < best) { best = d; along = cum[i] + Math.sqrt(l2) * t; }
  }
  return { d: best, along };
}

// --- buildings & roads from the processed OSM chunks ---------------------------------------------------
const chunks: ChunkData[] = readdirSync('public/data/chunks').map(f => JSON.parse(readFileSync(`public/data/chunks/${f}`, 'utf8')));
const buildings: any[] = [];
const roadIds = new Map<number, any>();
for (const c of chunks) {
  for (const b of c.buildings) {
    let cx = 0, cz = 0, near = { d: Infinity, along: 0 };
    for (let i = 0; i < b.p.length; i += 2) { cx += b.p[i]; cz += b.p[i + 1]; const n = nearestOnRoute(b.p[i], b.p[i + 1]); if (n.d < near.d) near = n; }
    if (near.d > CORRIDOR) continue;
    cx /= b.p.length / 2; cz /= b.p.length / 2;
    const [lat, lon] = unproject(cx, cz), old = keep(prev?.buildings, b.id);
    buildings.push({
      id: b.id, name: b.n ?? '', lat: +lat.toFixed(6), lon: +lon.toFixed(6), section: sectionAt(near.along), routeDistance: Math.round(near.along),
      distanceFromRoad: Math.round(near.d), priority: near.d < 20 ? 1 : 2,
      footprint: b.p, osmHeight: b.h, heightEstimated: b.e, osmFloors: b.l, category: b.k,
      // --- manual reconstruction fields (kept across re-runs) ---
      floors: old.floors ?? null, height: old.height ?? null, colour: old.colour ?? null, roofColour: old.roofColour ?? null, roof: old.roof ?? null,
      facade: old.facade ?? '', groundFloor: old.groundFloor ?? '', references: old.references ?? [], model: old.model ?? '',
      source: old.source ?? 'OSM footprint', confidence: old.confidence ?? (b.e ? 'unverified' : 'osm-tagged'), status: old.status ?? 'generic',
    });
  }
  for (const r of c.roads) {
    if (roadIds.has(r.id)) continue;
    let hits = 0;
    for (let i = 0; i < r.p.length; i += 2) if (nearestOnRoute(r.p[i], r.p[i + 1]).d < 6) hits++;
    if (hits >= 2) {
      const n = nearestOnRoute(r.p[0], r.p[1]), old = keep(prev?.roads, r.id);
      roadIds.set(r.id, { id: r.id, name: r.n, highway: r.h, width: r.w, lanes: r.l ?? null, oneway: r.o, section: sectionAt(n.along),
        widthSource: r.l ? 'OSM lanes tag' : 'estimated (default or narrowed to building clearance)',
        verifiedWidth: old.verifiedWidth ?? null, verifiedLanes: old.verifiedLanes ?? null, median: old.median ?? null, notes: old.notes ?? '', status: old.status ?? 'unverified' });
    }
  }
}
buildings.sort((a, b) => a.routeDistance - b.routeDistance);

// --- driver-perspective reference photos -----------------------------------------------------------
const TOKEN = process.env.MAPILLARY_TOKEN;
// RESAMPLE=<section>: drop that section's photos and refetch with a stricter daytime window (good light for colours).
const RESAMPLE = process.env.RESAMPLE;
// Keep old photos only if still on the (possibly rerouted) route; re-derive their position along it.
const refs: any[] = (prev?.references ?? []).filter((r: any) => r.section !== RESAMPLE).flatMap((r: any) => {
  const n = nearestOnRoute(...project(r.lat, r.lon));
  return n.d < 20 ? [{ ...r, routeDistance: Math.round(n.along), section: sectionAt(n.along) }] : [];
});
const [H0, H1, RADIUS] = RESAMPLE ? [8, 16, 30] : [7, 17.5, 20];
if (TOKEN) {
  const daytime = (ms: number) => { const h = (new Date(ms).getUTCHours() + 5.5) % 24; return h >= H0 && h <= H1; };
  for (let s = 0; s < cum[cum.length - 1]; s += REF_STEP) {
    if (refs.some(r => Math.abs(r.routeDistance - s) < REF_STEP / 2)) continue; // already have one here
    if (RESAMPLE && sections.find(x => s >= x.from && s <= x.to)?.id !== RESAMPLE) continue;
    let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    const x = pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * t, z = pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * t;
    const routeBearing = (Math.atan2(pts[i * 2 + 2] - pts[i * 2], -(pts[i * 2 + 3] - pts[i * 2 + 1])) * 180 / Math.PI + 360) % 360;
    const [lat, lon] = unproject(x, z), d = RADIUS / 111000;
    const url = `https://graph.mapillary.com/images?fields=id,thumb_1024_url,computed_compass_angle,compass_angle,computed_geometry,geometry,captured_at,creator,is_pano&bbox=${lon - d},${lat - d},${lon + d},${lat + d}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
    if (!res.ok) { console.warn('mapillary', res.status); continue; }
    const cands = ((await res.json()).data as any[]).filter(im => !im.is_pano && im.thumb_1024_url && (!im.captured_at || daytime(im.captured_at))).map(im => {
      const [ilon, ilat] = (im.computed_geometry ?? im.geometry).coordinates, [ix, iz] = project(ilat, ilon);
      const h = im.computed_compass_angle ?? im.compass_angle, off = Math.abs(((h - routeBearing + 540) % 360) - 180);
      return { im, ilat, ilon, h, off, dist: Math.hypot(ix - x, iz - z), recent: im.captured_at ?? 0 };
    }).filter(c => c.off < 25 && c.dist < RADIUS).sort((a, b) => (a.off + a.dist) - (b.off + b.dist) - (b.recent - a.recent) / 3e10);
    const c = cands[0];
    if (!c) continue;
    const sec = sectionAt(s), path = `colombo/references/${sec}/${String(Math.round(s)).padStart(5, '0')}_${c.im.id}.jpg`;
    mkdirSync(`public/data/colombo/references/${sec}`, { recursive: true });
    const img = await fetch(c.im.thumb_1024_url);
    if (!img.ok) continue;
    writeFileSync(`public/data/${path}`, Buffer.from(await img.arrayBuffer()));
    refs.push({ section: sec, routeDistance: Math.round(s), path, lat: +c.ilat.toFixed(6), lon: +c.ilon.toFixed(6), heading: Math.round(c.h),
      captured: c.im.captured_at ? new Date(c.im.captured_at).toISOString().slice(0, 10) : null, author: c.im.creator?.username ?? 'Mapillary contributor',
      license: 'CC BY-SA 4.0 (Mapillary)', url: `https://www.mapillary.com/app/?pKey=${c.im.id}`, reviewed: false, comparison: null });
  }
  refs.sort((a, b) => a.routeDistance - b.routeDistance);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(DB, JSON.stringify({
  id: 'route1', name: 'Fort → Pettah → Maradana → Ananda College → Borella', generated: new Date().toISOString(),
  sources: ['OpenStreetMap (ODbL): roads, footprints, tags', 'OSRM routing over OSM', 'Mapillary street-level imagery (CC BY-SA 4.0)'],
  route: { distance: Math.round(cum[cum.length - 1]), coordinates: route.geometry.coordinates.map(([lon, lat]: number[]) => [+lat.toFixed(6), +lon.toFixed(6)]) },
  waypoints: WAYPOINTS, sections, roads: [...roadIds.values()], buildings, references: refs,
}, null, 1));
console.log(`route ${Math.round(cum[cum.length - 1])} m; sections ${sections.map(s => `${s.id} ${s.to - s.from} m [${s.roads.join(', ')}]`).join(' | ')}`);
console.log(`buildings in corridor ${buildings.length} (P1 ${buildings.filter(b => b.priority === 1).length}); roads ${roadIds.size}; references ${refs.length}`);
