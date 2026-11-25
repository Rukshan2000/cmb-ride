import * as pc from 'playcanvas';
import { project, unproject } from '../map/MapProjection';
import { GeometryBuffer } from '../map/MeshUtil';
import { ribbon } from '../map/RoadMeshBuilder';
import type { GeocodingService, Place, Route, RoutingService } from './GeoServices';
import type { MapView } from './MapView';
import { fmtDist, fmtTime, type NavigationHUD } from './NavigationHUD';
import { RouteProgressTracker } from './RouteProgressTracker';

export interface PlayerPose { x: number; z: number; yaw: number }
const REROUTE_COOLDOWN = 8; // s, so GPS-like jitter or a brief detour doesn't spam the router

/** Search -> route -> 3D/2D display -> progress, off-route recalculation and arrival. */
export class NavigationManager {
  private place: Place | null = null;
  private route: Route | null = null;
  private tracker: RouteProgressTracker | null = null;
  private driving = false;
  private routing = false;
  private sinceReroute = 99;
  private mapTimer = 0;
  private searchAbort?: AbortController;
  private routeEntity?: pc.Entity;
  private marker: pc.Entity;
  private routeMat: pc.StandardMaterial;

  constructor(private app: pc.AppBase, private hud: NavigationHUD, private mapView: MapView,
    private geocoder: GeocodingService, private router: RoutingService, private pose: () => PlayerPose,
    private bounds: { south: number; west: number; north: number; east: number }) {
    this.routeMat = glowMaterial(new pc.Color(0.18, 0.48, 1), 0.55);
    this.marker = new pc.Entity('destination marker');
    this.marker.addComponent('render', { type: 'cylinder', material: glowMaterial(new pc.Color(1, 0.38, 0.12), 0.45), castShadows: false });
    this.marker.setLocalScale(3, 70, 3);
    this.marker.enabled = false;
    app.root.addChild(this.marker);

    hud.onQuery = q => this.search(q);
    hud.onPick = p => this.select(p);
    hud.onStart = () => this.start();
    hud.onCancel = () => this.cancel();
  }

  private here() {
    const p = this.pose(), [lat, lon] = unproject(p.x, p.z);
    return { lat, lon, bearing: (-p.yaw * 180) / Math.PI };
  }

  private async search(q: string) {
    if (q.trim().length < 3) return this.hud.showResults([]);
    this.searchAbort?.abort();
    this.searchAbort = new AbortController();
    try {
      const places = await this.geocoder.search(q, this.here(), this.searchAbort.signal);
      this.hud.showResults(places, places.length ? '' : 'No places found in Sri Lanka');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.hud.showResults([], (e as Error).message);
    }
  }

  private async select(p: Place) {
    this.hud.showResults([]);
    this.hud.input.value = p.name;
    this.hud.input.blur();
    this.place = p;
    this.driving = false;
    this.hud.showBanner(false);
    this.hud.showDestination(p);
    this.mapView.setDestination(p);
    const [mx, mz] = project(p.lat, p.lon);
    this.marker.setPosition(mx, 35, mz);
    this.marker.enabled = true;
    if (!(await this.calculate())) return;
    this.mapView.fit(this.route!.coords);
    const b = this.bounds, outside = p.lat < b.south || p.lat > b.north || p.lon < b.west || p.lon > b.east;
    this.hud.showDestination(p, `${fmtDist(this.route!.distance)} · ${fmtTime(this.route!.duration)} by road${outside ? ' · ⚠ beyond the 3D city area: you can follow the route on the map' : ''}`, true);
  }

  /** Requests a road route from the car's current position/heading. Returns false on failure. */
  private async calculate(): Promise<boolean> {
    if (!this.place || this.routing) return false;
    this.routing = true;
    this.sinceReroute = 0;
    try {
      this.setRoute(await this.router.route(this.here(), this.place));
      return true;
    } catch (e) {
      this.hud.showDestination(this.place, `Route unavailable: ${(e as Error).message}`);
      this.hud.toast('Could not calculate a road route');
      return false;
    } finally {
      this.routing = false;
    }
  }

  private setRoute(r: Route) {
    this.route = r;
    const pts: number[] = [];
    for (const [lat, lon] of r.coords) pts.push(...project(lat, lon));
    this.tracker = new RouteProgressTracker(pts, r.steps.map(s => s.distance));
    this.mapView.setRoute(r.coords);
    // 3D route: translucent ribbon on the OSM centreline (same source geometry as the drivable roads).
    this.routeEntity?.destroy();
    const g = new GeometryBuffer();
    ribbon(g, pts, 1.1, 0.16, 0xffffff);
    const mesh = g.toMesh(this.app.graphicsDevice, true);
    if (!mesh) return;
    const mi = new pc.MeshInstance(mesh, this.routeMat);
    this.routeEntity = new pc.Entity('route');
    this.routeEntity.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false });
    this.app.root.addChild(this.routeEntity);
  }

  /** Programmatic navigation (game modes): route to a place and start guidance immediately. */
  async go(p: Place) {
    await this.select(p);
    if (this.route && this.place === p) this.start();
  }

  get active() { return !!this.place; }

  private start() {
    if (!this.route) return;
    this.driving = true;
    this.hud.showDestination(null);
    this.hud.showBanner(true);
    this.mapView.follow = true;
  }

  cancel() {
    this.place = this.route = this.tracker = null;
    this.driving = false;
    this.routeEntity?.destroy();
    this.routeEntity = undefined;
    this.marker.enabled = false;
    this.mapView.setRoute(null);
    this.mapView.setDestination(null);
    this.hud.showDestination(null);
    this.hud.showBanner(false);
    this.hud.input.value = '';
  }

  /** Per-frame: progress, instructions, off-route and arrival. */
  update(dt: number, road: string) {
    this.sinceReroute += dt;
    const { x, z, yaw } = this.pose();
    const [lat, lon] = unproject(x, z);
    if ((this.mapTimer -= dt) <= 0) { this.mapTimer = 0.1; this.mapView.setPlayer(lat, lon, (-yaw * 180) / Math.PI); }
    if (!this.driving || !this.tracker || !this.route) return;
    const pr = this.tracker.update(x, z, dt);
    if (pr.arrived) {
      this.hud.toast(`You have arrived at ${this.place?.name}`, 6000);
      const name = this.place?.name;
      this.cancel();
      this.hud.input.value = name ?? '';
      return;
    }
    if (pr.offRoute && !this.routing && this.sinceReroute > REROUTE_COOLDOWN) {
      this.hud.toast('Off route: recalculating…');
      this.calculate();
    }
    const step = this.route.steps[pr.stepIndex];
    const timeLeft = this.route.duration * (pr.remaining / (this.tracker.total || 1));
    this.hud.updateBanner(step.text, step.modifier, step.type, pr.toStep, pr.remaining, timeLeft, road);
  }
}

function glowMaterial(c: pc.Color, opacity: number) {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0);
  m.emissive = c;
  m.opacity = opacity;
  m.blendType = pc.BLEND_NORMAL;
  m.depthWrite = false;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}
