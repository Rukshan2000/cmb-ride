import { project } from './MapProjection';

// Ground height (m above sea level) from public/data/terrain.json (FABDEM bare-earth DEM, see scripts/terrain.py).
// Bilinear over the ~30 m grid. The projection is linear, so the lat/lon grid is a regular x/z grid too.
// Until loaded, or outside the grid, the ground is at 0 (sea level).

let grid: { x0: number; z0: number; dx: number; dz: number; w: number; h: number; dm: Int16Array } | null = null;

export async function loadTerrain(url: string) {
  try {
    const t = await (await fetch(url)).json();
    const [x0, z0] = project(t.north, t.west), [x1, z1] = project(t.north - t.step, t.west + t.step);
    grid = { x0, z0, dx: x1 - x0, dz: z1 - z0, w: t.w, h: t.h, dm: Int16Array.from(t.dm) };
  } catch (e) {
    console.warn('terrain unavailable, flat ground:', e);
  }
}

export function groundAt(x: number, z: number): number {
  const g = grid;
  if (!g) return 0;
  const fx = (x - g.x0) / g.dx, fz = (z - g.z0) / g.dz;
  if (fx < 0 || fz < 0 || fx > g.w - 1 || fz > g.h - 1) return 0;
  const i = Math.min(g.w - 2, Math.floor(fx)), j = Math.min(g.h - 2, Math.floor(fz)), tx = fx - i, tz = fz - j;
  const k = j * g.w + i, d = g.dm;
  const top = d[k] + (d[k + 1] - d[k]) * tx, bot = d[k + g.w] + (d[k + g.w + 1] - d[k + g.w]) * tx;
  return (top + (bot - top) * tz) / 10;
}

/** Ground mesh data: grid vertices (x, ground, z) for the whole terrain, or null. */
export function terrainGrid() { return grid; }

// Self-check: corners of a cell reproduce the stored samples.
if (import.meta.env?.DEV) {
  const t = { x0: 0, z0: 0, dx: 10, dz: 10, w: 2, h: 2, dm: Int16Array.from([0, 100, 200, 300]) };
  grid = t;
  console.assert(groundAt(0, 0) === 0 && groundAt(10, 0) === 10 && groundAt(0, 10) === 20 && groundAt(5, 5) === 15, 'terrain bilinear');
  grid = null;
}
