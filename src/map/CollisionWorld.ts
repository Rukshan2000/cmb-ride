import type { BuildingData } from './MapTypes';

const CELL = 25;

/** 2D spatial hash of building wall segments, added/removed per map chunk. */
export class CollisionWorld {
  // cell -> chunkKey -> flat [x0,z0,x1,z1,...]
  private cells = new Map<string, Map<string, number[]>>();
  private chunkCells = new Map<string, string[]>();

  /** posts: [x,z,halfSize,...] poles/tree trunks/kades, added as small square outlines. */
  addChunk(chunkKey: string, buildings: BuildingData[], posts: number[] = []) {
    const touched = new Set<string>();
    const outlines: { p: number[] }[] = [...buildings];
    for (let i = 0; i < posts.length; i += 3) {
      const [x, z, h] = [posts[i], posts[i + 1], posts[i + 2]];
      outlines.push({ p: [x - h, z - h, x + h, z - h, x + h, z + h, x - h, z + h] });
    }
    for (const b of outlines) {
      const p = b.p, n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[j * 2], z1 = p[j * 2 + 1];
        for (let cx = cellOf(Math.min(x0, x1)); cx <= cellOf(Math.max(x0, x1)); cx++) {
          for (let cz = cellOf(Math.min(z0, z1)); cz <= cellOf(Math.max(z0, z1)); cz++) {
            const key = cx + ',' + cz;
            let cell = this.cells.get(key);
            if (!cell) this.cells.set(key, (cell = new Map()));
            let segs = cell.get(chunkKey);
            if (!segs) cell.set(chunkKey, (segs = []));
            segs.push(x0, z0, x1, z1);
            touched.add(key);
          }
        }
      }
    }
    this.chunkCells.set(chunkKey, [...touched]);
  }

  removeChunk(chunkKey: string) {
    for (const key of this.chunkCells.get(chunkKey) ?? []) {
      const cell = this.cells.get(key)!;
      cell.delete(chunkKey);
      if (!cell.size) this.cells.delete(key);
    }
    this.chunkCells.delete(chunkKey);
  }

  /** Calls fn for each wall segment whose cell overlaps the square around (x,z). May repeat segments. */
  forEachNear(x: number, z: number, r: number, fn: (x0: number, z0: number, x1: number, z1: number) => void) {
    for (let cx = cellOf(x - r); cx <= cellOf(x + r); cx++) {
      for (let cz = cellOf(z - r); cz <= cellOf(z + r); cz++) {
        const cell = this.cells.get(cx + ',' + cz);
        if (!cell) continue;
        for (const segs of cell.values()) {
          for (let i = 0; i < segs.length; i += 4) fn(segs[i], segs[i + 1], segs[i + 2], segs[i + 3]);
        }
      }
    }
  }

  /** Fraction t in [0,1] along (ax,az)->(bx,bz) of the first wall hit, or 1 if clear. */
  raycast(ax: number, az: number, bx: number, bz: number): number {
    let best = 1;
    const dx = bx - ax, dz = bz - az;
    this.forEachNear((ax + bx) / 2, (az + bz) / 2, Math.hypot(dx, dz) / 2 + 1, (x0, z0, x1, z1) => {
      const ex = x1 - x0, ez = z1 - z0;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) return;
      const t = ((x0 - ax) * ez - (z0 - az) * ex) / den;
      const u = ((x0 - ax) * dz - (z0 - az) * dx) / den;
      if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
    });
    return best;
  }
}

const cellOf = (v: number) => Math.floor(v / CELL);
