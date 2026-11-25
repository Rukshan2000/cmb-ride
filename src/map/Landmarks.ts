import * as pc from 'playcanvas';
import { groundAt } from './Terrain';
import { project } from './MapProjection';

// Real-building asset database (public/data/buildings/records.json): reference-based GLB models
// placed at their real coordinates, replacing the procedural shell of the matching OSM footprint(s).
// Visual only: collision keeps using the OSM footprint. Records without a model are listed but not placed.
// Workflow + worklist: scripts/building-priority.ts, docs in public/data/buildings/README.md.

export type Confidence = 'verified' | 'reference_based' | 'approximate' | 'unverified';

export interface BuildingRecord {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  osm: number[];               // OSM way ids whose procedural building this model replaces
  buildingType: string;
  architecturalStyle?: string;
  primaryColor?: string;       // as measured from reference photos, e.g. "#e8e1cf"
  secondaryColors?: string[];
  roofType?: string;
  floors?: number;
  height?: number;             // metres, if known from a source
  model: string;               // GLB path relative to dataUrl ('' = not modelled yet)
  heading?: number;            // degrees clockwise from north
  scale?: number;
  y?: number;
  references: { path: string; license: string; author?: string; url?: string; lat?: number; lon?: number; heading?: number }[];
  source: string;
  confidence: Confidence;
}

const LOAD_DISTANCE = 1500; // m: GLBs stream in once the player is this close (kept afterwards)

export class LandmarkManager {
  /** OSM ids the procedural generator must skip because a real model stands there. */
  readonly hidden = new Set<number>();
  readonly records: BuildingRecord[] = [];
  private requested = new Set<string>();

  constructor(private app: pc.AppBase, private baseUrl: string, private root: pc.Entity) {}

  async init() {
    try {
      const res = await fetch(`${this.baseUrl}/buildings/records.json`);
      if (res.ok) this.records.push(...(await res.json()));
    } catch { /* no database: procedural only */ }
    // Only hide a footprint once there is a model to show instead.
    for (const r of this.records) if (r.model) r.osm.forEach(id => this.hidden.add(id));
  }

  /** Stream in models near the player. Call a few times per second. */
  update(x: number, z: number) {
    for (const r of this.records) {
      if (!r.model || this.requested.has(r.id)) continue;
      const [rx, rz] = project(r.latitude, r.longitude);
      if (Math.hypot(rx - x, rz - z) < LOAD_DISTANCE) { this.requested.add(r.id); this.place(r, rx, rz); }
    }
  }

  private place(r: BuildingRecord, x: number, z: number) {
    this.app.assets.loadFromUrl(`${this.baseUrl}/${r.model}`, 'container', (err, asset) => {
      if (err || !asset) { console.warn(`Building ${r.id} (${r.name}): ${err}`); return; }
      const e = (asset.resource as pc.ContainerResource).instantiateRenderEntity({ castShadows: true });
      e.setLocalPosition(x, (r.y ?? 0) + groundAt(x, z), z);
      e.setLocalEulerAngles(0, -(r.heading ?? 0), 0);
      e.setLocalScale(r.scale ?? 1, r.scale ?? 1, r.scale ?? 1);
      e.name = `building ${r.id} ${r.name}`;
      this.root.addChild(e);
    });
  }

  /** Nearest record with reference photos, for the comparison view. */
  nearestReference(x: number, z: number) {
    let best: { r: BuildingRecord; d: number } | null = null;
    for (const r of this.records) {
      if (!r.references.length) continue;
      const [rx, rz] = project(r.latitude, r.longitude), d = Math.hypot(rx - x, rz - z);
      if (d < 300 && (!best || d < best.d)) best = { r, d };
    }
    return best?.r ?? null;
  }
}
