import * as pc from 'playcanvas';
import { GameConfig } from '../game/GameConfig';
import { buildBuildings, newBuffers, type BuildingBuffers } from './BuildingGenerator';
import { LandmarkManager } from './Landmarks';
import { CollisionWorld } from './CollisionWorld';
import { groundAt, loadTerrain } from './Terrain';
import type { MapDataProvider } from './MapLoader';
import type { BuildingData, ChunkData, MapIndex } from './MapTypes';
import { GeometryBuffer, vertexColorMaterial } from './MeshUtil';
import { buildRoads } from './RoadMeshBuilder';
import { RoadNetwork } from './RoadNetwork';
import { Signage, type WallPanel } from '../roads/Signage';
import { signMaterial } from './ShopSigns';
import type { WaterData } from './Water';
import { foliageMaterial } from '../roads/Vegetation';
import { farWindowMaterial, litGlass } from '../roads/NightLights';
import { asphaltMaterial, lampHeadMaterial, plasterMaterial } from '../roads/RoadMaterialSystem';
import { buildFurniture, signalGroups, type FurnitureBuffers } from '../roads/StreetFurniture';
import { TrafficLightSystem } from '../roads/TrafficLightSystem';
import { buildRoadside } from '../roads/RoadsideEnvironment';

/** Streams map chunks in and out around the player and owns their meshes and collision data. */
export class MapChunkManager {
  index!: MapIndex;
  readonly roads = new RoadNetwork();
  readonly collision = new CollisionWorld();
  private loaded = new Map<string, pc.Entity>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private available = new Set<string>();
  readonly groundMat: pc.StandardMaterial;
  readonly lampMat = lampHeadMaterial();
  private bloomMat = vertexColorMaterial(true);
  readonly foliageMat: pc.StandardMaterial;
  /** Water bodies and beaches (loaded in init). */
  water: WaterData = { water: [], beach: [] };
  private raw = new Map<string, Promise<ChunkData | null>>();

  /** Chunk JSON, fetched once (also used as a neighbour). ponytail: kept forever; evict if memory grows. */
  private data(key: string) {
    let p = this.raw.get(key);
    if (!p) this.raw.set(key, (p = this.provider.loadChunk(key).catch(() => null)));
    return p;
  }
  readonly signals = new TrafficLightSystem();
  /** Streetlight head positions per loaded chunk [x,y,z,...], for night light pooling. */
  readonly lamps = new Map<string, number[]>();
  /** Signal stop lines per loaded chunk, for traffic AI. (ux,uz) = travel direction. */
  /** Zebra crossings per loaded chunk [x,z,a,hw,signalled,...] (pedestrians). */
  readonly crossings = new Map<string, number[]>();
  readonly stops = new Map<string, { x: number; z: number; ux: number; uz: number; hw: number; group: number }[]>();
  private buildingMat: pc.StandardMaterial;
  private glassMat = glassMaterial();
  private farWindowMat: pc.StandardMaterial;
  private signMat: pc.StandardMaterial;
  signage?: Signage;
  private tankMat = tankMaterial();
  private tankMesh: pc.Mesh;
  private root = new pc.Entity('map');
  readonly landmarks: LandmarkManager;
  /** Near-detail building entity per chunk, built lazily the first time the player comes close. */
  private detail = new Map<string, { far: pc.Entity; near?: pc.Entity; data: BuildingData[] }>();

  constructor(private app: pc.AppBase, private provider: MapDataProvider) {
    app.root.addChild(this.root);
    this.groundMat = asphaltMaterial(app.graphicsDevice);
    this.foliageMat = foliageMaterial(app.graphicsDevice);
    this.buildingMat = plasterMaterial(app.graphicsDevice);
    litGlass(app.graphicsDevice, this.glassMat);
    this.farWindowMat = farWindowMaterial(app.graphicsDevice);
    this.signMat = signMaterial(app.graphicsDevice);
    this.tankMesh = pc.Mesh.fromGeometry(app.graphicsDevice, new pc.CylinderGeometry({ radius: 0.7, height: 1.4, capSegments: 10 }));
    this.landmarks = new LandmarkManager(app, GameConfig.dataUrl, this.root);
  }

  /** Reconstruction overrides by OSM id (public/data/colombo/*.json): real colour, floors, height, roof. */
  private overrides = new Map<number, { colour?: string; roofColour?: string; floors?: number; height?: number; roof?: string; category?: string }>();

  async init() {
    this.index = await this.provider.loadIndex();
    await loadTerrain(`${GameConfig.dataUrl}/terrain.json`);
    try {
      const db = await (await fetch(`${GameConfig.dataUrl}/colombo/route1.json`)).json();
      for (const b of db.buildings) if (b.status !== 'generic') this.overrides.set(b.id, b);
    } catch { /* no reconstruction data */ }
    this.index.chunks.forEach(k => this.available.add(k));
    this.signage = new Signage(this.app.graphicsDevice, this.index.places);
    try { this.water = await (await fetch(`${GameConfig.dataUrl}/water.json`)).json(); } catch { /* no water file: land only */ }
    await this.landmarks.init();
  }

  get pendingCount() { return this.pending.size; }

  /** Chunks that should be loaded around (x,z), nearest first. */
  wanted(x: number, z: number): string[] {
    const S = this.index.chunkSize, R = GameConfig.loadDistance;
    const out: [string, number][] = [];
    for (let i = Math.floor((x - R) / S); i <= Math.floor((x + R) / S); i++) {
      for (let j = Math.floor((z - R) / S); j <= Math.floor((z + R) / S); j++) {
        const key = `${i}_${j}`;
        const d = Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z);
        if (d <= R && this.available.has(key)) out.push([key, d]);
      }
    }
    return out.sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }

  update(x: number, z: number) {
    for (const key of this.wanted(x, z)) {
      if (this.loaded.has(key) || this.pending.has(key) || this.failed.has(key)) continue;
      if (this.pending.size >= 3) break;
      this.load(key);
    }
    this.updateLod(x, z);
    this.landmarks.update(x, z);
    const S = this.index.chunkSize;
    for (const [key, entity] of this.loaded) {
      const [i, j] = key.split('_').map(Number);
      if (Math.hypot((i + 0.5) * S - x, (j + 0.5) * S - z) > GameConfig.unloadDistance) {
        entity.destroy();
        this.loaded.delete(key);
        this.detail.delete(key);
        this.roads.remove(key);
        this.lamps.delete(key);
        this.stops.delete(key);
        this.crossings.delete(key);
        this.collision.removeChunk(key);
      }
    }
  }

  /** Distance-based building LOD: swap the far shell for the detailed mesh near the player. */
  private updateLod(x: number, z: number) {
    const S = this.index.chunkSize;
    let built = 0;
    for (const [key, d] of this.detail) {
      const [i, j] = key.split('_').map(Number);
      // Distance to the chunk's nearest edge, so buildings at the boundary don't pop late.
      const dx = Math.max(i * S - x, 0, x - (i + 1) * S), dz = Math.max(j * S - z, 0, z - (j + 1) * S);
      const near = Math.hypot(dx, dz) < GameConfig.buildingDetailDistance;
      if (near && !d.near && built++ < 1) { // at most one detailed rebuild per frame
        d.near = this.buildingEntity(d.data, 0);
        if (d.near) d.far.parent!.addChild(d.near);
      }
      if (d.near) d.near.enabled = near;
      d.far.enabled = !(near && d.near);
    }
  }

  private buildingEntity(data: BuildingData[], lod: 0 | 1): pc.Entity | undefined {
    const bufs: BuildingBuffers = newBuffers();
    buildBuildings(data, bufs, lod, this.landmarks.hidden);
    const device = this.app.graphicsDevice;
    const instances: pc.MeshInstance[] = [];
    const solid = bufs.solid.toMesh(device, true), glass = bufs.glass.toMesh(device, true);
    if (solid) instances.push(new pc.MeshInstance(solid, this.buildingMat));
    if (glass) instances.push(new pc.MeshInstance(glass, this.glassMat));
    const signs = bufs.signs?.toMesh(device, true);
    if (signs) instances.push(new pc.MeshInstance(signs, this.signMat));
    const glow = bufs.glow?.toMesh(device, true);
    if (glow) instances.push(new pc.MeshInstance(glow, this.farWindowMat));
    if (bufs.tanks.length) {
      // Hardware-instanced rooftop tanks: one mesh, one draw call, N transforms.
      const n = bufs.tanks.length / 4, m = new Float32Array(n * 16), mat = new pc.Mat4();
      for (let k = 0; k < n; k++) {
        const [tx, ty, tz, sc] = bufs.tanks.slice(k * 4, k * 4 + 4);
        mat.setTRS(new pc.Vec3(tx, ty + 0.7 * sc, tz), pc.Quat.IDENTITY, new pc.Vec3(sc, sc, sc));
        m.set(mat.data, k * 16);
      }
      const vb = new pc.VertexBuffer(device, pc.VertexFormat.getDefaultInstancingFormat(device), n, { data: m });
      const mi = new pc.MeshInstance(this.tankMesh, this.tankMat);
      mi.setInstancing(vb);
      mi.cull = false; // instance bounds aren't known to the culler
      instances.push(mi);
    }
    if (!instances.length) return undefined;
    const e = new pc.Entity('buildings lod' + lod);
    e.addComponent('render', { meshInstances: instances, castShadows: true, receiveShadows: true });
    return e;
  }

  isLoaded(key: string) { return this.loaded.has(key); }

  private async load(key: string) {
    this.pending.add(key);
    try {
      const [i, j] = key.split('_').map(Number);
      const keys = [-1, 0, 1].flatMap(a => [-1, 0, 1].map(b => `${i + a}_${j + b}`)).filter(k => k === key || this.available.has(k));
      const tiles = await Promise.all(keys.map(k => this.data(k)));
      const data = tiles[keys.indexOf(key)];
      if (!data) throw new Error('chunk data missing');
      const around: ChunkData = { ...data, roads: tiles.flatMap(t => t?.roads ?? []), buildings: tiles.flatMap(t => t?.buildings ?? []) };
      // Water counts as "occupied" so no tree, wall or kade is planted in a lake.
      around.buildings.push(...this.water.water.map(a => ({ p: a.p }) as BuildingData));
      for (const b of data.buildings) { // apply verified/annotated reconstruction values over OSM estimates
        const o = this.overrides.get(b.id);
        if (!o) continue;
        if (o.colour) b.c = parseInt(o.colour.slice(1), 16);
        if (o.roofColour) b.rc = parseInt(o.roofColour.slice(1), 16);
        if (o.floors) { b.l = o.floors; b.h = o.height ?? o.floors * 3.3 + 0.8; b.e = false; }
        else if (o.height) { b.h = o.height; b.e = false; }
        if (o.roof) b.r = o.roof;
        if (o.category) b.k = o.category as typeof b.k;
      }
      const device = this.app.graphicsDevice;
      const entity = new pc.Entity('chunk ' + key);

      const roadGeo = new GeometryBuffer();
      buildRoads(data, roadGeo);
      const roadMesh = roadGeo.toMesh(device, true);

      const instances: pc.MeshInstance[] = [];
      if (roadMesh) {
        const mi = new pc.MeshInstance(roadMesh, this.groundMat);
        mi.castShadow = false;
        instances.push(mi);
      }
      if (instances.length) entity.addComponent('render', { meshInstances: instances, castShadows: false, receiveShadows: true });

      // Street furniture: static-batched per chunk (one draw call per material).
      const fb: FurnitureBuffers = { solid: new GeometryBuffer(), lights: Array.from({ length: 6 }, () => new GeometryBuffer()), lampHeads: new GeometryBuffer(), lamps: [], posts: [] };
      const marks = new GeometryBuffer();
      buildFurniture(data, around, fb, marks);
      const foliage = new GeometryBuffer(), blooms = new GeometryBuffer();
      const walls: WallPanel[] = [];
      buildRoadside(data, around, fb.solid, foliage, blooms, fb.posts, walls);
      const signs = this.signage?.build(data, around, fb.solid, walls, fb.posts); // before fb.solid is meshed: adds posts and frames
      if (signs) entity.addChild(signs);
      const furn: pc.MeshInstance[] = [];
      const add = (gb: GeometryBuffer, mat: pc.Material) => { const m = gb.toMesh(device, true); if (m) furn.push(new pc.MeshInstance(m, mat)); };
      add(marks, this.groundMat);
      add(fb.solid, this.buildingMat);
      add(fb.lampHeads, this.lampMat);
      add(foliage, this.foliageMat);
      add(blooms, this.bloomMat);
      fb.lights.forEach((gb, i) => add(gb, this.signals.materials[i]));
      if (furn.length) {
        const fe = new pc.Entity('street furniture');
        fe.addComponent('render', { meshInstances: furn, castShadows: true, receiveShadows: true });
        entity.addChild(fe);
      }
      for (let i = 0; i < fb.lamps.length; i += 3) fb.lamps[i + 1] += groundAt(fb.lamps[i], fb.lamps[i + 2]);
      this.lamps.set(key, fb.lamps);
      const sig = data.sig ?? [], groups = signalGroups(sig);
      this.crossings.set(key, data.cr ?? []);
      this.stops.set(key, groups.map((group, k) => ({ x: sig[k * 5], z: sig[k * 5 + 1], ux: Math.sin(sig[k * 5 + 2]), uz: Math.cos(sig[k * 5 + 2]), hw: sig[k * 5 + 3], group })));

      const far = this.buildingEntity(data.buildings, 1);
      if (far) { entity.addChild(far); this.detail.set(key, { far, data: data.buildings }); }
      this.root.addChild(entity);
      this.loaded.set(key, entity);
      this.roads.add(key, data.roads);
      this.collision.addChunk(key, data.buildings, fb.posts);
    } catch (e) {
      console.warn(`Map chunk ${key} unavailable:`, e);
      this.failed.add(key); // graceful: leave the gap, keep driving
    } finally {
      this.pending.delete(key);
    }
  }
}

function glassMaterial(): pc.StandardMaterial {
  const m = vertexColorMaterial();
  m.gloss = 0.85;
  m.metalness = 0.3;
  m.useMetalness = true;
  m.specular = new pc.Color(0.6, 0.65, 0.7);
  m.update();
  return m;
}

function tankMaterial(): pc.StandardMaterial {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0.08, 0.08, 0.09); // black polyethylene tanks
  m.gloss = 0.4;
  m.update();
  return m;
}
