// Lanka Metro Transit (Colombo metro bus, started Sept 2026) routes -> public/data/metro.json
// Stop lists: slrailwayforum.com/lanka-metro-bus-routes (route pages, Nov 2026); colours: srilankatrip.com.lk.
// Each stop is geocoded (Photon/OSM), then snapped to the nearest real OSM bus_stop node within 250 m.
// Stops outside the 3D map bounds are kept (inMap=false) so the HUD can show the whole line.
// Run: node scripts/fetch-metro.ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { project, unproject } from '../src/map/MapProjection.ts';

const ROUTES = [
  { code: 'CM01', colour: '#1f6fd1', name: 'Makumbura – Pettah', fare: [65, 300], stops: ['Makumbura', 'Kottawa', 'Dharmapala College, Pannipitiya', 'Pannipitiya', 'Araliya Uyana', 'Polwatta', 'Kalalgoda Junction', 'Thalawathugada', 'Wikramasinghepura', 'Isurupaya', 'Palam Thuna Junction', 'Battaramulla', 'Sethsiripaya', 'Diyatha Uyana', 'NAITA Rajagiriya', 'Rajagiriya', 'Ayurvedha Junction, Rajagiriya', 'Castle Street Hospital', 'Singer Mega, Borella', 'Wijerama, Colombo 7', 'Town Hall, Colombo', 'Hedges Court', 'Maradana', 'Colombo Fort', 'Pettah'] },
  { code: 'CM02', colour: '#f2c230', name: 'Millennium City – Pettah', fare: [65, 285], stops: ['Millennium City Athurugiriya', 'Athurugiriya Hospital', 'Athurugiriya', 'Nisaco Mall', 'Hokandara Junction', 'Arangala Junction', 'Malabe Bus Stand', 'Thalahena Junction', 'Thalangama Junction', 'Maga Neguma', 'Sethsiripaya', 'Diyatha Uyana', 'NAITA Rajagiriya', 'Rajagiriya', 'Castle Street Hospital', 'YMBA Borella', 'Town Hall, Colombo', 'Union Place', 'Nawaloka Hospital', 'Regal Cinema, Colombo', 'Colombo Fort', 'Pettah'] },
  { code: 'CM03', colour: '#4b3fa8', name: 'Makumbura – Kadawatha', fare: [65, 375], stops: ['Makumbura', 'Kottawa', 'Dharmapala College, Pannipitiya', 'Pannipitiya', 'Maharagama', 'Apeksha Hospital', 'Navinna Junction', 'Wijerama Junction Nugegoda', 'Delkanda Junction', 'Nugegoda', 'Kirulapone', 'Narahenpita Junction', 'Army Hospital Narahenpita', 'YMBA Borella', 'Campbell Park', 'Dematagoda', 'Orion City Orugodawatta', 'Thorana Junction', 'Kelaniya University', 'Kiribathgoda', 'Mahara Junction', 'Kadawatha'] },
  { code: 'CM04', colour: '#f07820', name: 'Panadura – Dematagoda', fare: [65, 300], stops: ['Panadura', 'Panadura Base Hospital', 'Mahanama Junction', 'Egoda Uyana', 'Moratuwa', 'Rawathawatta', 'Katubedda Junction', 'Angulana', 'Borupana Junction', 'Maliban Junction', 'Mount Lavinia', 'Mount Lavinia Court', 'Dehiwala', 'William Junction', 'Wellawatte', 'Bambalapitiya', 'Thummulla Junction', 'Independence Arcade', 'D. S. Senanayake College', 'YMBA Borella', 'Campbell Park', 'Dematagoda', 'Dematagoda Railway Station'] },
  { code: 'CM05', colour: '#8a2fa8', name: 'Ekala – Thalangama Depot', fare: [65, 300], stops: ['Ekala', 'CTB Junction Ja-Ela', 'Ja-Ela', 'Weligampitiya', 'Kandana', 'Nagoda Kandana', 'Welisara Chest Hospital', 'Mahabage', 'Wattala Court', 'Mabola', 'Wattala', 'Hendala', 'Hekitta Junction', 'STC Peliyagoda', 'Peliyagoda', 'New Kelani Bridge', 'Orion City Orugodawatta', 'Dematagoda', 'Campbell Park', 'YMBA Borella', 'Castle Street Hospital', 'Ayurvedha Junction, Rajagiriya', 'Rajagiriya', 'NAITA Rajagiriya', 'Diyatha Uyana', 'Sethsiripaya', 'Battaramulla', 'Thalangama', 'Thalangama Depot'] },
  { code: 'CM06', colour: '#6cc04a', name: 'Kollupitiya Circular', fare: [65, 185], loop: true, stops: ['Kollupitiya', 'Liberty Plaza', 'Colombo Public Library', 'Town Hall, Colombo', 'Nelum Pokuna', 'Padanama Mawatha', 'Independence Square', 'Jawatta Road', 'Jawatta', 'Hirdaramani, Colombo 5', 'Narahenpita Railway Station', 'Narahenpita', 'Anderson Flats', 'Havelock Town', 'W. A. Silva Mawatha', 'Wellawatte', 'Bambalapitiya', 'Sea Avenue', 'Kollupitiya'] },
  { code: 'CM08', colour: '#1e6a3a', name: 'Kahathuduwa – Pettah', fare: [65, 300], stops: ['Kahathuduwa', 'Kahathuduwa Police', 'Rilawala Junction', 'Polgasowita', '14th Mile Post', 'Kesbewa', 'Piliyandala Bus Stand', 'Lanka Fiber Fabrica', 'Weerasinghe Mawatha', 'Werahera', 'Boralesgamuwa', 'Raththanapitiya', 'Pepiliyana', 'Kohuwala', 'Kirulapone', 'Havelock Town', 'Thimbirigasyaya', 'Thummulla', 'Kollupitiya', 'One Galle Face', 'Colombo Fort', 'Pettah'] },
];

const B = { south: 6.835, west: 79.838, north: 6.958, east: 79.885 };
const inMap = (lat: number, lon: number) => lat > B.south && lat < B.north && lon > B.west && lon < B.east;

const busStops: [number, number][] = [];
for (const f of readdirSync('public/data/chunks')) {
  const c = JSON.parse(readFileSync(`public/data/chunks/${f}`, 'utf8'));
  for (let i = 0; i < (c.bus ?? []).length; i += 2) busStops.push([c.bus[i], c.bus[i + 1]]);
}

const cache = new Map<string, { lat: number; lon: number; label: string } | null>();
async function geocode(name: string) {
  if (cache.has(name)) return cache.get(name)!;
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(name + ', Colombo')}&lat=6.90&lon=79.87&limit=5&lang=en`;
  let json: any = null;
  for (let attempt = 0; attempt < 6 && !json; attempt++) {
    await new Promise(r => setTimeout(r, 1200 * 2 ** attempt)); // polite to the public Photon instance; back off on rate limits
    const text = await (await fetch(url, { headers: { 'User-Agent': 'cmb-rider-metro-pipeline/0.1' } })).text();
    if (text.startsWith('{')) json = JSON.parse(text);
  }
  if (!json) throw new Error('geocoder unavailable for ' + name);
  const f = (json.features as any[]).find(f => f.properties.countrycode === 'LK');
  const r = f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: [f.properties.name, f.properties.street, f.properties.district ?? f.properties.city].filter(Boolean).join(', ') } : null;
  cache.set(name, r);
  return r;
}

const out = [];
for (const r of ROUTES) {
  const stops = [];
  for (const name of r.stops) {
    const g = await geocode(name);
    if (!g) { stops.push({ name, lat: null, lon: null, inMap: false, source: 'not found' }); continue; }
    let { lat, lon } = g, source = `geocoded (${g.label})`;
    if (inMap(lat, lon)) {
      const [x, z] = project(lat, lon);
      let best: [number, number] | null = null, bd = 250;
      for (const s of busStops) { const d = Math.hypot(s[0] - x, s[1] - z); if (d < bd) { bd = d; best = s; } }
      if (best) { [lat, lon] = unproject(best[0], best[1]); source = `OSM bus stop ${Math.round(bd)} m from geocode (${g.label})`; }
    }
    stops.push({ name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), inMap: inMap(lat, lon), source });
  }
  const n = stops.filter(s => s.inMap).length;
  console.log(`${r.code} ${r.name}: ${n}/${stops.length} stops inside the 3D map`);
  for (const s of stops) if (s.inMap) console.log(`   ${s.name.padEnd(32)} ${s.lat},${s.lon}  ${s.source}`);
  out.push({ ...r, stops });
}
writeFileSync('public/data/metro.json', JSON.stringify({ source: 'slrailwayforum.com/lanka-metro-bus-routes (Nov 2026), srilankatrip.com.lk; stop positions geocoded + snapped to OSM bus stops, approximate', routes: out }, null, 1));
