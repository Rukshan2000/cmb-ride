import type { RoadData } from './MapTypes';

export interface RoadHit {
  road: RoadData;
  dist: number;
  x: number; z: number;     // closest point
  dx: number; dz: number;   // unit direction of the road (polyline order) there
}

/** Road polylines of currently loaded chunks: street-name lookup, spawn snapping, mini-map. */
export class RoadNetwork {
  readonly byChunk = new Map<string, RoadData[]>();

  /** Elevated roads (flyovers) of loaded chunks with a bounding box for culling. */
  private decks = new Map<string, { r: RoadData; x0: number; z0: number; x1: number; z1: number }[]>();

  add(chunkKey: string, roads: RoadData[]) {
    this.byChunk.set(chunkKey, roads);
    const d = roads.filter(isElevated).map(r => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < r.p.length; i += 2) { x0 = Math.min(x0, r.p[i]); x1 = Math.max(x1, r.p[i]); z0 = Math.min(z0, r.p[i + 1]); z1 = Math.max(z1, r.p[i + 1]); }
      const m = r.w / 2 + 1;
      return { r, x0: x0 - m, z0: z0 - m, x1: x1 + m, z1: z1 + m };
    });
    if (d.length) this.decks.set(chunkKey, d); else this.decks.delete(chunkKey);
  }
  remove(chunkKey: string) { this.byChunk.delete(chunkKey); this.decks.delete(chunkKey); }

  /**
   * Surface height under (x,z) for something currently at height prevY. Continuity rule: you are only on a deck
   * if its height there is within 1.5 m of where you were — so traffic passing *under* a flyover stays on the
   * ground and you can only get onto a deck via its ramp. Returns the deck (with lateral offset) or ground.
   */
  surface(x: number, z: number, prevY: number, heading?: [number, number]): { y: number; grade: number; ux: number; uz: number; lat: number; hw: number; px: number; pz: number } | null {
    let best: ReturnType<RoadNetwork['surface']> = null;
    for (const list of this.decks.values()) for (const d of list) {
      if (x < d.x0 || x > d.x1 || z < d.z0 || z > d.z1) continue;
      const p = d.r.p, ys = d.r.y!, hw = d.r.w / 2;
      for (let i = 0; i < p.length - 2; i += 2) {
        const ax = p[i], az = p[i + 1], ex = p[i + 2] - ax, ez = p[i + 3] - az, l2 = ex * ex + ez * ez || 1, l = Math.sqrt(l2);
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
        const lat = Math.hypot(ax + ex * t - x, az + ez * t - z);
        const y = ys[i / 2] + (ys[i / 2 + 1] - ys[i / 2]) * t;
        if (y < 0.3 || Math.abs(y - prevY) > 1.5) continue;
        // Already up there: stay within the deck (parapet handles the edge). Getting on from the ground: only
        // from inside the ramp's width and heading along it, so roads beside a ramp foot aren't lifted.
        if (prevY > 0.3 ? lat > hw + 1.2 : lat > hw - 0.5 || (heading && Math.abs(heading[0] * ex + heading[1] * ez) / l < 0.85)) continue;
        if (!best || lat < best.lat) best = { y, grade: (ys[i / 2 + 1] - ys[i / 2]) / l, ux: ex / l, uz: ez / l, lat, hw, px: ax + ex * t, pz: az + ez * t };
      }
    }
    return best;
  }

  *roads(): Iterable<RoadData> {
    for (const list of this.byChunk.values()) yield* list;
  }

  // ponytail: linear scan over loaded roads (~1-2k); add a grid if called per-frame per AI car.
  nearest(x: number, z: number, filter?: (r: RoadData) => boolean): RoadHit | null {
    let best: RoadHit | null = null;
    for (const road of this.roads()) {
      if (filter && !filter(road)) continue;
      const p = road.p;
      for (let i = 0; i < p.length - 2; i += 2) {
        const ax = p[i], az = p[i + 1], ex = p[i + 2] - ax, ez = p[i + 3] - az;
        const l2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
        const cx = ax + ex * t, cz = az + ez * t;
        const d = Math.hypot(x - cx, z - cz);
        if (!best || d < best.dist) {
          const l = Math.sqrt(l2);
          best = { road, dist: d, x: cx, z: cz, dx: ex / l, dz: ez / l };
        }
      }
    }
    return best;
  }
}

export const isElevated = (r: RoadData) => !!r.y && r.y.some(v => v > 0.5);
