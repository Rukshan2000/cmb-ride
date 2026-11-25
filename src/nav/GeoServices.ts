// Geocoding + routing behind small swappable interfaces.
// Dev defaults: Photon (komoot, OSM data, typeahead allowed under fair use) and the OSRM demo server.
// The OSRM demo is NOT for production traffic: point VITE_OSRM_URL at a self-hosted OSRM before shipping.

export interface Place { name: string; address: string; lat: number; lon: number; kind: string }
export interface RouteStep { text: string; name: string; distance: number; lat: number; lon: number; type: string; modifier?: string }
export interface Route { coords: [number, number][]; distance: number; duration: number; steps: RouteStep[] } // coords: [lat, lon]

export interface GeocodingService { search(q: string, near: { lat: number; lon: number }, signal?: AbortSignal): Promise<Place[]> }
export interface RoutingService { route(from: { lat: number; lon: number; bearing?: number }, to: { lat: number; lon: number }): Promise<Route> }

/** "Go to Ananda College" -> "Ananda College". */
export const cleanQuery = (q: string) => q.trim().replace(/^(please\s+)?(go|take me|navigate|drive|directions)\s+(to\s+)?/i, '').trim();

export const photonGeocoder: GeocodingService = {
  async search(q, near, signal) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery(q))}&lat=${near.lat}&lon=${near.lon}&limit=12&lang=en`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
    const json = await res.json();
    const out: Place[] = [];
    // Prefer the named feature (school, station...) over its individual building outlines; drop near-duplicates.
    const feats = (json.features as any[]).filter(f => f.properties.countrycode === 'LK')
      .sort((a, b) => Number(a.properties.osm_key === 'building') - Number(b.properties.osm_key === 'building'));
    for (const f of feats) {
      const p = f.properties, [lon, lat] = f.geometry.coordinates;
      const name = p.name ?? p.street ?? '';
      if (!name || out.some(o => o.name === name && Math.hypot(o.lat - lat, o.lon - lon) < 0.004)) continue;
      const address = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, p.district ?? p.locality, p.city, p.state]
        .filter((v, i, a) => v && v !== name && a.indexOf(v) === i).join(', ');
      out.push({ name, address, lat, lon, kind: (p.osm_value ?? '').replace(/_/g, ' ') });
    }
    return out.slice(0, 6);
  },
};

const OSRM = import.meta.env.VITE_OSRM_URL ?? 'https://router.project-osrm.org';
const TURN: Record<string, string> = {
  uturn: 'Turn around', 'sharp left': 'Turn sharp left', left: 'Turn left', 'slight left': 'Keep left',
  straight: 'Continue straight', 'slight right': 'Keep right', right: 'Turn right', 'sharp right': 'Turn sharp right',
};
const ord = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] ?? 'th');

export function stepText(type: string, modifier: string | undefined, name: string, exit?: number): string {
  const onto = name ? ` onto ${name}` : '';
  switch (type) {
    case 'depart': return `Head ${name ? 'along ' + name : 'off'}`;
    case 'arrive': return 'Destination ahead';
    case 'roundabout': case 'rotary': return exit ? `At the roundabout, take the ${ord(exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'exit roundabout': case 'exit rotary': return `Exit the roundabout${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'fork': return `${modifier?.includes('left') ? 'Keep left' : 'Keep right'} at the fork${onto}`;
    default: return `${TURN[modifier ?? 'straight'] ?? 'Continue'}${onto}`;
  }
}

export const osrmRouter: RoutingService = {
  async route(from, to) {
    const bearing = from.bearing === undefined ? '' : `&bearings=${Math.round((from.bearing + 360) % 360)},70;`;
    const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true${bearing}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message ?? 'No road route found');
    const r = json.routes[0];
    return {
      coords: r.geometry.coordinates.map(([lon, lat]: number[]) => [lat, lon]),
      distance: r.distance,
      duration: r.duration,
      steps: r.legs[0].steps.map((s: any) => ({
        text: stepText(s.maneuver.type, s.maneuver.modifier, s.name, s.maneuver.exit),
        name: s.name, distance: s.distance, type: s.maneuver.type, modifier: s.maneuver.modifier,
        lat: s.maneuver.location[1], lon: s.maneuver.location[0],
      })),
    };
  },
};
