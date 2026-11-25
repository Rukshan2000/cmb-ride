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

  add(chunkKey: string, roads: RoadData[]) { this.byChunk.set(chunkKey, roads); }
  remove(chunkKey: string) { this.byChunk.delete(chunkKey); }

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
