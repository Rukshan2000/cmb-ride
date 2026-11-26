import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Vite can't find maplibre's worker by itself; without it vector layers (the blue route line) never draw.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);

// 2D navigation map: OSM raster tiles (road names, real network), player arrow, destination, route.
// ponytail: tile.openstreetmap.org is fine for development only (tile usage policy); use a tile provider/key for production.
export class MapView {
  readonly map: maplibregl.Map;
  private player: maplibregl.Marker;
  private dest?: maplibregl.Marker;
  follow = true;
  private resumeAt = 0;

  constructor(container: HTMLElement, lat: number, lon: number) {
    this.map = new maplibregl.Map({
      container,
      center: [lon, lat], zoom: 15.5, attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    const el = document.createElement('div');
    el.className = 'map-player';
    this.player = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([lon, lat]).addTo(this.map);
    // Manual pan/rotate pauses follow mode; it resumes (heading-up) after a few idle seconds.
    const pause = (e: { originalEvent?: unknown }) => { if (e.originalEvent) { this.follow = false; this.resumeAt = performance.now() + 8000; } };
    this.map.on('dragstart', pause);
    this.map.on('rotatestart', pause);
    this.map.on('load', () => {
      this.map.addSource('route', { type: 'geojson', data: line([]) });
      this.map.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#0b3d91', 'line-width': 9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      this.map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#2f7bff', 'line-width': 6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      this.map.addLayer({ id: 'route-arrows', type: 'symbol', source: 'route', layout: { 'symbol-placement': 'line', 'symbol-spacing': 60, 'text-field': '›', 'text-size': 22, 'text-keep-upright': false, 'text-font': ['Open Sans Regular'] }, paint: { 'text-color': '#fff' } });
    });
  }

  setPlayer(lat: number, lon: number, bearingDeg: number) {
    this.player.setLngLat([lon, lat]).setRotation(bearingDeg);
    if (!this.follow && this.resumeAt && performance.now() > this.resumeAt) { this.follow = true; this.resumeAt = 0; }
    // Heading-up: rotate the map with the car so the direction of travel always points up.
    if (this.follow) this.map.jumpTo({ center: [lon, lat], bearing: bearingDeg });
  }

  setRoute(coords: [number, number][] | null) {
    const src = this.map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    const data = line(coords ?? []);
    if (src) src.setData(data);
    else this.map.once('load', () => (this.map.getSource('route') as maplibregl.GeoJSONSource).setData(data));
  }

  setDestination(p: { lat: number; lon: number } | null) {
    this.dest?.remove();
    this.dest = p ? new maplibregl.Marker({ color: '#ff5a1f' }).setLngLat([p.lon, p.lat]).addTo(this.map) : undefined;
  }

  fit(coords: [number, number][]) {
    this.follow = false;
    this.resumeAt = performance.now() + 10000; // show the route overview, then return to heading-up
    const b = new maplibregl.LngLatBounds();
    coords.forEach(([lat, lon]) => b.extend([lon, lat]));
    this.map.fitBounds(b, { padding: 30, bearing: 0, duration: 600 });
  }

  resize() { this.map.resize(); }

  /** Police hiding spots: green markers while you're being pursued. */
  private spots: maplibregl.Marker[] = [];
  private spotKey = '';
  setSpots(list: { lat: number; lon: number }[]) {
    const key = list.map(p => p.lat.toFixed(5) + p.lon.toFixed(5)).join();
    if (key === this.spotKey) return;
    this.spotKey = key;
    this.spots.forEach(m => m.remove());
    this.spots = list.map(p => new maplibregl.Marker({ color: '#3ddc84', scale: 0.7 }).setLngLat([p.lon, p.lat]).addTo(this.map));
  }

  /** Multiplayer friends: a coloured dot + name per rider, kept in sync by id. */
  private friends = new Map<string, maplibregl.Marker>();
  setFriends(list: { id: string; name: string; color: string; lat: number; lon: number }[]) {
    const seen = new Set<string>();
    for (const f of list) {
      seen.add(f.id);
      let m = this.friends.get(f.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'map-friend';
        el.innerHTML = '<i></i><span></span>';
        m = new maplibregl.Marker({ element: el }).setLngLat([f.lon, f.lat]).addTo(this.map);
        this.friends.set(f.id, m);
      }
      const el = m.getElement();
      (el.firstChild as HTMLElement).style.background = f.color;
      el.lastChild!.textContent = f.name;
      m.setLngLat([f.lon, f.lat]);
    }
    for (const [id, m] of this.friends) if (!seen.has(id)) { m.remove(); this.friends.delete(id); }
  }
}

const line = (coords: [number, number][]) => ({
  type: 'Feature' as const, properties: {},
  geometry: { type: 'LineString' as const, coordinates: coords.map(([lat, lon]) => [lon, lat]) },
});
