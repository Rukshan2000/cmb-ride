import type { GeometryBuffer } from '../map/MeshUtil';
import { CATALOG } from '../traffic/VehicleCatalog';
import { buildModel, randomLook } from '../traffic/VehicleModels';
import { box } from './StreetFurniture';

// Kerbside life: parked three-wheelers and motorbikes, king coconut and fruit carts, sleeping street dogs.
// (ux,uz) = along the road. Everything is merged into the chunk's static buffer.

type R = () => number;

/** A parked vehicle (the traffic model without its rider), pointing along (ux,uz). */
export function parked(g: GeometryBuffer, kind: 'tuktuk' | 'motorcycle', x: number, z: number, ux: number, uz: number, r: R) {
  const spec = CATALOG.find(c => c.id === kind)!, parts = buildModel({ ...spec, ...randomLook(spec, r) });
  const yaw = Math.atan2(-ux, -uz), c = Math.cos(yaw), s = Math.sin(yaw);
  for (const [name, p] of Object.entries(parts) as [string, GeometryBuffer][]) {
    if (typeof p !== 'object' || !p) continue;
    const base = g.vertexCount;
    for (let i = 0; i < p.pos.length; i += 3) {
      const [px, py, pz] = [p.pos[i], p.pos[i + 1], p.pos[i + 2]], [nx, ny, nz] = [p.nrm[i], p.nrm[i + 1], p.nrm[i + 2]];
      g.pos.push(x + px * c + pz * s, py, z - px * s + pz * c);
      g.nrm.push(nx * c + nz * s, ny, -nx * s + nz * c);
    }
    if (name === 'glass') for (let i = 0; i < p.pos.length / 3; i++) g.col.push(30, 42, 52, 255);
    else for (const v of p.col) g.col.push(v);
    // Vehicle meshes expect a double-sided material; the chunk's isn't, so emit both windings.
    for (let i = 0; i < p.idx.length; i += 3) {
      const [a, b, d] = [base + p.idx[i], base + p.idx[i + 1], base + p.idx[i + 2]];
      g.idx.push(a, b, d, a, d, b);
    }
  }
}

/** King coconut / fruit hand cart with an umbrella. */
export function cart(g: GeometryBuffer, x: number, z: number, ux: number, uz: number, r: R) {
  const coconut = r() < 0.55, shade = [0xd8262e, 0x1f5fa8, 0x1e8a4a, 0xf2c230][Math.floor(r() * 4)];
  box(g, x, 0.55, z, ux, uz, 0.9, 0.18, 1.5, 0x7a5a38);
  for (const s of [-0.6, 0.6]) box(g, x + ux * s, 0, z + uz * s, ux, uz, 0.95, 0.55, 0.09, 0x2a2420);
  const fruit = coconut ? [0xf0a018, 0xe88a12] : [0xd8262e, 0xf2c230, 0x6aa82a, 0xf07820];
  for (let i = 0; i < 22; i++) {
    const a = (r() - 0.5) * 1.3, w = (r() - 0.5) * 0.65, size = coconut ? 0.2 : 0.13;
    box(g, x + ux * a - uz * w, 0.73 + r() * (coconut ? 0.22 : 0.12), z + uz * a + ux * w, ux, uz, size, size, size, fruit[Math.floor(r() * fruit.length)]);
  }
  box(g, x, 0.7, z, ux, uz, 0.05, 1.5, 0.05, 0x555555);
  box(g, x, 2.2, z, ux, uz, 1.9, 0.08, 1.9, shade);
  box(g, x, 2.28, z, ux, uz, 1.0, 0.12, 1.0, shade);
}

/** A street dog, lying down or standing. */
export function dog(g: GeometryBuffer, x: number, z: number, ux: number, uz: number, r: R) {
  const col = [0xa8743c, 0xc8a064, 0x2e2824, 0x8a6a4a][Math.floor(r() * 4)], up = r() < 0.5 ? 0.28 : 0.04;
  box(g, x, up, z, ux, uz, 0.22, 0.22, 0.62, col);
  box(g, x + ux * 0.38, up + 0.14, z + uz * 0.38, ux, uz, 0.18, 0.18, 0.2, col);
  for (const s of [-0.06, 0.06]) box(g, x + ux * 0.36 - uz * s, up + 0.32, z + uz * 0.36 + ux * s, ux, uz, 0.05, 0.08, 0.03, col);
  box(g, x - ux * 0.38, up + 0.12, z - uz * 0.38, ux, uz, 0.05, 0.05, 0.22, col);
  if (up > 0.1) for (const a of [-0.24, 0.24]) for (const s of [-0.08, 0.08]) box(g, x + ux * a - uz * s, 0, z + uz * a + ux * s, ux, uz, 0.06, up, 0.06, col);
}
