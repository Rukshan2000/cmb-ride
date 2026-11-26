import * as pc from 'playcanvas';
import { groundAt } from './Terrain';
import { project } from './MapProjection';
import { nightLight } from '../roads/NightLights';

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
  skyline?: boolean;           // visible from anywhere: no fog, never distance-clipped (see skyline())
  sign?: { text: string; x: number; y: number; z: number; yaw: number; w: number; h: number }; // lettering board, model space
  model: string;               // GLB path relative to dataUrl ('' = not modelled yet)
  heading?: number;            // degrees clockwise from north
  scale?: number;
  y?: number;
  references: { path: string; license: string; author?: string; url?: string; lat?: number; lon?: number; heading?: number }[];
  source: string;
  confidence: Confidence;
}

const LOAD_DISTANCE = 1500; // m: GLBs stream in once the player is this close (kept afterwards)
const SKYLINE_AT = 800;     // m: farther skyline buildings are drawn at this distance (inside the sky dome and far clip)

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
      if (r.skyline || Math.hypot(rx - x, rz - z) < LOAD_DISTANCE) { this.requested.add(r.id); this.place(r, rx, rz); }
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
      // Facade lighting: the model glows in its own colours at night (strong on the Lotus Tower, a soft floodlight elsewhere).
      const seen = new Set<pc.Material>();
      for (const c of e.findComponents('render') as pc.RenderComponent[]) for (const mi of c.meshInstances) {
        const m = mi.material as pc.StandardMaterial;
        if (seen.has(m)) continue;
        seen.add(m);
        m.emissive = m.diffuse.clone();
        const tag = /^night:([\d.]+)/.exec(m.name); // models with their own lighting design say which parts glow
        nightLight(m, tag ? Number(tag[1]) : r.skyline ? 2.5 : 0.25);
      }
      if (r.skyline) {
        for (const c of e.findComponents('render') as pc.RenderComponent[]) for (const mi of c.meshInstances) {
          const m = mi.material as pc.StandardMaterial; m.useFog = false; m.update();
        }
        this.far.push({ e, at: e.getLocalPosition().clone(), scale: r.scale ?? 1 });
      }
      if (r.sign) e.addChild(signBoard(this.app.graphicsDevice, r.sign));
      this.root.addChild(e);
    });
  }

  private far: { e: pc.Entity; at: pc.Vec3; scale: number }[] = [];

  /**
   * Call every frame. A distant skyline building is pulled towards the camera and shrunk by the same factor, which
   * looks identical on screen but stays inside the far clip. Near buildings between SKYLINE_AT and its true spot
   * would wrongly sit behind it; fog hides most of those.
   */
  skyline(cam: pc.Vec3) {
    for (const { e, at, scale } of this.far) {
      const k = Math.min(1, SKYLINE_AT / Math.hypot(at.x - cam.x, at.z - cam.z));
      e.setLocalPosition(cam.x + (at.x - cam.x) * k, cam.y + (at.y - cam.y) * k, cam.z + (at.z - cam.z) * k);
      e.setLocalScale(scale * k, scale * k, scale * k);
    }
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

/** Black lettering on a white board, drawn with the browser's own fonts (handles Sinhala and Tamil). */
function signBoard(device: pc.GraphicsDevice, s: NonNullable<BuildingRecord['sign']>) {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = Math.round((2048 * s.h) / s.w);
  const g = c.getContext('2d')!;
  g.fillStyle = '#eceae2'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#141414'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${Math.round(c.height * 0.62)}px system-ui, sans-serif`;
  g.fillText(s.text, c.width / 2, c.height / 2, c.width * 0.96);
  const tex = new pc.Texture(device, { width: c.width, height: c.height, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, anisotropy: 8 });
  tex.setSource(c);
  const m = new pc.StandardMaterial();
  m.diffuseMap = tex; m.emissiveMap = tex; m.emissive = new pc.Color(1, 1, 1);
  nightLight(m, 0.7);
  const e = new pc.Entity('sign');
  e.addComponent('render', { type: 'plane', material: m, castShadows: false });
  e.setLocalPosition(s.x, s.y, s.z);
  e.setLocalEulerAngles(90, s.yaw, 0); // stand the plane up, face +Z, then turn
  e.setLocalScale(s.w, 1, s.h);
  return e;
}
