import * as pc from 'playcanvas';
import earcut from 'earcut';
import { GeometryBuffer } from '../map/MeshUtil';
import { box } from '../roads/StreetFurniture';
import type { VehicleSpec } from './VehicleCatalog';

// Procedural vehicles built from side profiles (bonnet, raked screens, roofline, boot) extruded across the width
// with tumblehome, round wheels with rims, bumpers, mirrors, plates and lamps.
// Local frame: +Y up, forward = -Z, x = right. Three buffers: paint (glossy), glass, trim (matte).

interface Parts { paint: GeometryBuffer; glass: GeometryBuffer; trim: GeometryBuffer; noWheels?: boolean }
type Prof = [number, number][]; // [z, y] around the side outline

const TYRE = 0x161616, RIM = 0xb9bcc0, BLACK = 0x1c1c1c, LAMP = 0xf2f0e6, TAIL = 0xa8121a, AMBER = 0xe08a1a, PLATE = 0xf0f0ea, CHROME = 0xc8cacc;

/** Extrude a side profile across the width. hw(y) = half width at height y (tumblehome). */
function extrude(g: GeometryBuffer, prof: Prof, hw: (y: number) => number, c: number, xOff = 0) {
  const n = prof.length;
  // Sides (x = ±hw), triangulated with earcut on (z, y).
  const tri = earcut(prof.flat());
  for (const s of [-1, 1]) {
    const b = g.vertexCount;
    for (const [z, y] of prof) g.vertex(xOff + s * hw(y), y, z, s, 0, 0, c);
    for (let i = 0; i < tri.length; i += 3) g.idx.push(b + tri[i], b + tri[i + 1], b + tri[i + 2]);
  }
  // Skin between consecutive outline points.
  for (let i = 0; i < n; i++) {
    const [z0, y0] = prof[i], [z1, y1] = prof[(i + 1) % n];
    const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy) || 1;
    const ny = -dz / l, nz = dy / l; // outward for a clockwise-in-(z,y) outline; material is double-sided anyway
    const b = g.vertexCount;
    g.vertex(xOff - hw(y0), y0, z0, 0, ny, nz, c); g.vertex(xOff + hw(y0), y0, z0, 0, ny, nz, c);
    g.vertex(xOff + hw(y1), y1, z1, 0, ny, nz, c); g.vertex(xOff - hw(y1), y1, z1, 0, ny, nz, c);
    g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
}

/** Wheel: tyre cylinder along X plus a rim disc on the outer face. */
function wheel(p: Parts, x: number, z: number, r: number, w: number, rim = RIM) {
  if (p.noWheels) return; // player car: wheels are separate animated entities
  const SEG = 14, g = p.trim, x0 = x - w / 2, x1 = x + w / 2, out = Math.sign(x) || 1;
  const b = g.vertexCount;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2, cy = Math.cos(a), cz = Math.sin(a);
    g.vertex(x0, r + cy * r, z + cz * r, 0, cy, cz, TYRE);
    g.vertex(x1, r + cy * r, z + cz * r, 0, cy, cz, TYRE);
  }
  for (let i = 0; i < SEG; i++) { const a = b + i * 2; g.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  for (const [xx, rr, col] of [[x1 * (out > 0 ? 1 : 0) + x0 * (out > 0 ? 0 : 1), r, TYRE], [x + (w / 2 + 0.005) * out, r * 0.62, rim]] as [number, number, number][]) {
    const c = g.vertexCount;
    g.vertex(xx, r, z, out, 0, 0, col);
    for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; g.vertex(xx, r + Math.cos(a) * rr, z + Math.sin(a) * rr, out, 0, 0, col); }
    for (let i = 0; i < SEG; i++) g.idx.push(c, c + 1 + i, c + 1 + ((i + 1) % SEG));
  }
}

/** Front/rear details common to four-wheelers: lamps, plates, bumpers, mirrors. */
function details(p: Parts, L: number, W: number, lampY: number, bumperY: number, mirrorY: number, mirrorZ: number) {
  const t = p.trim;
  for (const s of [-1, 1]) {
    box(t, s * (W / 2 - 0.28), lampY, -L / 2 - 0.015, 0, -1, 0.34, 0.14, 0.05, LAMP);
    box(t, s * (W / 2 - 0.12), lampY, -L / 2 + 0.02, 0, -1, 0.06, 0.1, 0.05, AMBER);
    box(t, s * (W / 2 - 0.22), lampY + 0.02, L / 2 + 0.015, 0, -1, 0.3, 0.16, 0.05, TAIL);
    box(t, s * (W / 2 + 0.08), mirrorY, mirrorZ, 0, -1, 0.16, 0.12, 0.1, BLACK); // mirror
  }
  box(t, 0, bumperY, -L / 2 - 0.03, 0, -1, W - 0.1, 0.2, 0.08, BLACK);
  box(t, 0, bumperY, L / 2 + 0.03, 0, -1, W - 0.1, 0.2, 0.08, BLACK);
  box(t, 0, bumperY + 0.03, -L / 2 - 0.08, 0, -1, 0.5, 0.13, 0.02, PLATE);
  box(t, 0, bumperY + 0.25, L / 2 + 0.06, 0, -1, 0.5, 0.13, 0.02, PLATE);
}

const taper = (hw: number, y0: number, y1: number, inset: number) => (y: number) => hw - Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) * inset;

function car(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, hatch = s.id === 'hatch';
  const belt = hatch ? 0.95 : 0.92, sill = 0.28;
  // Lower body: bumper -> bonnet -> cowl -> beltline -> boot/hatch -> rear bumper.
  const body: Prof = hatch
    ? [[f, sill + 0.1], [f, 0.62], [f + 0.12, 0.8], [f + 0.75, belt - 0.04], [r - 0.05, belt], [r, 0.7], [r, sill + 0.12], [r - 0.3, sill], [f + 0.3, sill]]
    : [[f, sill + 0.12], [f, 0.6], [f + 0.15, 0.74], [f + 1.05, belt - 0.05], [r - 0.85, belt], [r - 0.12, belt - 0.03], [r, 0.78], [r, sill + 0.15], [r - 0.35, sill], [f + 0.35, sill]];
  extrude(p.paint, body, taper(W / 2, 0.6, belt, 0.05), s.color!);
  // Greenhouse: raked windscreen, roof, rear screen; glass, slightly narrower towards the roof.
  const g: Prof = hatch
    ? [[f + 0.78, belt], [f + 1.55, H - 0.05], [r - 0.35, H - 0.05], [r - 0.12, belt]]
    : [[f + 1.1, belt], [f + 2.0, H - 0.04], [r - 1.45, H - 0.04], [r - 0.8, belt]];
  extrude(p.glass, g, taper(W / 2 - 0.08, belt, H, 0.16), 0xffffff);
  // Painted roof skin + pillars over the glass.
  const roofZ0 = g[1][0] + 0.05, roofZ1 = g[2][0] - 0.05;
  extrude(p.paint, [[roofZ0, H - 0.07], [roofZ0 + 0.05, H + 0.02], [roofZ1 - 0.05, H + 0.02], [roofZ1, H - 0.07]], () => W / 2 - 0.22, s.color!);
  const bPillar = (roofZ0 + roofZ1) / 2;
  for (const side of [-1, 1]) box(p.paint, side * (W / 2 - 0.13), belt, bPillar, 0, -1, 0.04, H - belt, 0.12, s.color!);
  const wr = 0.31;
  for (const z of [f + 0.82, r - 0.72]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.13), z, wr, 0.2);
  details(p, L, W, 0.66, 0.4, belt + 0.08, f + 1.2);
}

function van(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2;
  // HiAce-style semi-bonnet: short sloped nose, tall flat sides, near-vertical rear.
  extrude(p.paint, [[f, 0.35], [f, 0.95], [f + 0.35, 1.1], [r, 1.12], [r, 0.35], [r - 0.4, 0.3], [f + 0.4, 0.3]], taper(W / 2, 0.9, 1.1, 0.02), s.color!);
  extrude(p.glass, [[f + 0.4, 1.1], [f + 1.0, H - 0.1], [r - 0.05, H - 0.1], [r - 0.02, 1.1]], taper(W / 2 - 0.02, 1.1, H, 0.06), 0xffffff);
  extrude(p.paint, [[f + 0.95, H - 0.15], [f + 1.05, H], [r - 0.02, H], [r - 0.02, H - 0.15]], () => W / 2 - 0.08, s.color!);
  for (const z of [f + 1.5, r - 1.6]) for (const side of [-1, 1]) box(p.paint, side * (W / 2 - 0.04), 1.1, z, 0, -1, 0.03, H - 1.2, 0.18, s.color!); // pillars
  for (const z of [f + 0.75, r - 0.85]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.15), z, 0.33, 0.21);
  details(p, L, W, 0.8, 0.42, 1.25, f + 0.6);
}

function bus(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, c = s.color!;
  extrude(p.paint, [[f, 0.45], [f, 1.3], [r, 1.3], [r, 0.45]], () => W / 2, c);
  extrude(p.glass, [[f, 1.3], [f + 0.25, H - 0.35], [r, H - 0.35], [r, 1.3]], () => W / 2 - 0.02, 0xffffff);
  extrude(p.paint, [[f + 0.2, H - 0.35], [f + 0.45, H], [r - 0.1, H], [r, H - 0.35]], taper(W / 2, H - 0.35, H, 0.1), c);
  // Livery: SLTB maroon with yellow band; private buses get a contrasting sweep band.
  const band = c === 0x9a1b1b ? 0xe8c21a : s.accent ?? 0xf0f0f0;
  box(p.paint, 0, 0.95, 0, 0, -1, W + 0.02, 0.22, L - 0.3, band);
  for (let z = f + 1.6; z < r - 0.5; z += 1.25) for (const side of [-1, 1]) box(p.paint, side * (W / 2), 1.3, z, 0, -1, 0.04, H - 1.65, 0.1, c); // window pillars
  box(p.trim, W / 2 + 0.01, 0.5, f + 1.0, 0, -1, 0.02, 1.9, 0.9, BLACK); // front door (left side = kerb in SL? doors are on the left)
  box(p.trim, -(W / 2 + 0.01), 0.5, f + 1.0, 0, -1, 0.02, 1.9, 0.9, BLACK);
  box(p.trim, 0, H - 0.75, f - 0.02, 0, -1, W - 0.5, 0.3, 0.04, 0x101010); // destination board
  for (const z of [f + 2.0, r - 2.5]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.32), z, 0.5, 0.3, 0x8a8d90);
  details(p, L, W, 0.75, 0.5, 2.0, f + 0.1);
}

function lorry(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, H = s.height, f = -L / 2, r = L / 2, cab = 1.9, c = s.color!;
  extrude(p.paint, [[f, 0.55], [f, 1.45], [f + 0.1, 1.55], [f + cab, 1.55], [f + cab, 0.55]], () => W / 2, c);
  extrude(p.glass, [[f + 0.1, 1.55], [f + 0.25, H - 0.2], [f + cab - 0.05, H - 0.2], [f + cab - 0.05, 1.55]], () => W / 2 - 0.03, 0xffffff);
  extrude(p.paint, [[f + 0.2, H - 0.2], [f + 0.3, H], [f + cab, H], [f + cab, H - 0.2]], () => W / 2 - 0.02, c);
  box(p.trim, 0, 0.75, f + cab + (L - cab) / 2, 0, -1, W - 0.3, 0.25, L - cab, 0x2a2a2a);          // chassis
  box(p.paint, 0, 1.0, f + cab + 0.1 + (L - cab - 0.2) / 2, 0, -1, W, 0.5, L - cab - 0.2, s.accent ?? 0x6a5a3a); // body sides
  box(p.trim, 0, 1.5, f + cab + 0.3 + (L - cab - 0.5) / 2, 0, -1, W - 0.05, H - 1.6, L - cab - 0.5, s.cargo ?? 0x4e5a3a); // tarpaulin load
  for (const z of [f + 1.1, r - 1.6, r - 0.6]) for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.3), z, 0.48, 0.32, 0x8a8d90);
  details(p, L, W, 0.85, 0.6, 2.1, f + 0.2);
}

function tuktuk(p: Parts, s: VehicleSpec) {
  const L = s.length, W = s.width, f = -L / 2, r = L / 2, c = s.color!;
  // Tapered front cowl with the single headlamp, wider passenger tub behind.
  extrude(p.paint, [[f + 0.05, 0.3], [f, 0.95], [f + 0.25, 1.05], [f + 0.75, 1.0], [f + 0.85, 0.3]], () => 0.42, c);
  extrude(p.paint, [[f + 0.8, 0.3], [f + 0.8, 0.85], [r - 0.15, 0.85], [r, 0.7], [r, 0.3]], taper(W / 2, 0.3, 0.85, 0.04), c);
  extrude(p.glass, [[f + 0.25, 1.05], [f + 0.5, 1.55], [f + 0.6, 1.55], [f + 0.75, 1.0]], () => W / 2 - 0.12, 0xffffff); // windscreen
  // Rounded black canvas canopy.
  extrude(p.trim, [[f + 0.45, 1.55], [f + 0.6, 1.72], [r - 0.35, 1.75], [r - 0.05, 1.6], [r, 0.95], [r - 0.08, 0.95], [r - 0.12, 1.55]], () => W / 2 + 0.02, BLACK);
  box(p.trim, 0, 0.85, 0.15, 0, -1, W - 0.2, 0.08, 0.9, 0x3a2a22);  // bench seat
  box(p.trim, 0, 0.9, -0.35, 0, -1, 0.42, 0.55, 0.32, 0x5c4030);    // driver
  box(p.trim, 0, 1.45, -0.35, 0, -1, 0.22, 0.24, 0.22, 0x2a1c14);
  box(p.trim, 0, 0.82, f - 0.01, 0, -1, 0.2, 0.18, 0.05, LAMP);
  for (const side of [-1, 1]) box(p.trim, side * (W / 2 - 0.18), 0.55, r + 0.01, 0, -1, 0.14, 0.1, 0.04, TAIL);
  box(p.trim, 0, 0.45, r + 0.02, 0, -1, 0.45, 0.13, 0.02, PLATE);
  wheel(p, 0, f + 0.42, 0.22, 0.12);
  for (const side of [-1, 1]) wheel(p, side * (W / 2 - 0.1), r - 0.45, 0.22, 0.14);
}

function motorcycle(p: Parts, s: VehicleSpec) {
  const L = s.length, f = -L / 2, r = L / 2, c = s.color!, scooter = (s.accent ?? 0) === 1;
  if (scooter) { // Dio/Activa-style: step-through with front apron and body panels
    extrude(p.paint, [[f + 0.35, 0.35], [f + 0.25, 1.0], [f + 0.45, 1.0], [f + 0.6, 0.45], [r - 0.6, 0.4], [r - 0.55, 0.8], [r - 0.15, 0.8], [r - 0.1, 0.4]], () => 0.2, c);
  } else {     // commuter / FZ / Pulsar: tank, engine, tail
    extrude(p.paint, [[f + 0.55, 0.75], [f + 0.7, 0.95], [-0.05, 0.92], [0.1, 0.78], [-0.05, 0.5], [f + 0.6, 0.55]], () => 0.17, c);
    box(p.trim, 0, 0.3, -0.05, 0, -1, 0.26, 0.35, 0.5, 0x3a3a3a); // engine
    extrude(p.paint, [[0.1, 0.8], [0.15, 0.88], [r - 0.15, 0.95], [r - 0.1, 0.85], [0.1, 0.72]], () => 0.12, c);
  }
  box(p.trim, 0, 0.86, 0.25, 0, -1, 0.26, 0.09, 0.55, BLACK);                       // seat
  box(p.trim, 0, 1.0, f + 0.32, 0, -1, 0.64, 0.04, 0.04, CHROME);                   // handlebar
  box(p.trim, 0, 0.45, f + 0.32, 0, -1, 0.06, 0.6, 0.06, CHROME);                   // forks
  box(p.trim, 0, 0.88, f + 0.22, 0, -1, 0.16, 0.14, 0.06, LAMP);
  box(p.trim, 0, 0.82, r - 0.08, 0, -1, 0.12, 0.08, 0.05, TAIL);
  wheel(p, 0, f + 0.32, 0.3, 0.1); wheel(p, 0, r - 0.32, 0.3, 0.12);
  // Rider: legs, torso, arms, helmet (helmets are compulsory in Sri Lanka).
  const shirt = s.rider ?? 0x2a3a5a;
  box(p.trim, 0, 0.6, 0.1, 0, -1, 0.36, 0.35, 0.3, 0x2a2a30);
  box(p.trim, 0, 0.95, 0.18, 0, -1, 0.4, 0.55, 0.26, shirt);
  for (const side of [-1, 1]) box(p.trim, side * 0.2, 1.05, -0.12, 0, -1, 0.09, 0.09, 0.5, shirt);
  box(p.trim, 0, 1.52, 0.14, 0, -1, 0.26, 0.28, 0.3, s.helmet ?? 0xdedede);
}

export function buildModel(spec: VehicleSpec, noWheels = false): Parts {
  const p: Parts = { paint: new GeometryBuffer(), glass: new GeometryBuffer(), trim: new GeometryBuffer(), noWheels };
  ({ tuktuk, motorcycle, car, van, bus, lorry } as Record<string, (p: Parts, s: VehicleSpec) => void>)[spec.category](p, spec);
  return p;
}

// --- paint ---------------------------------------------------------------------------------------------
// Rough Colombo street colour shares: private cars skew white/silver/grey/black.
const CAR_PAINT: [number, number][] = [
  [0xf2f2f0, 30], [0xc4c7cb, 18], [0x7e8388, 12], [0x161718, 12], [0x6b1a24, 6], [0x1f3f7a, 6], [0xa01c22, 5],
  [0x2f4a36, 3], [0x8a7a62, 3], [0x3a5a8c, 3], [0xd9c79a, 2],
];
const pickW = (r: () => number, list: [number, number][]) => { let x = r() * list.reduce((s, e) => s + e[1], 0); for (const [c, w] of list) if ((x -= w) <= 0) return c; return list[0][0]; };
/** Subtle per-vehicle variation (fading, dirt), quantised so meshes can still be shared. */
const vary = (c: number, k: number) => {
  const f = [1, 0.94, 0.88][k], ch = (s: number) => Math.round(Math.min(255, ((c >> s) & 255) * f));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

export interface Look { color: number; accent?: number; cargo?: number; rider?: number; helmet?: number }

export function randomLook(spec: VehicleSpec, r: () => number): Look {
  const k = Math.floor(r() * 3);
  const any = (l: number[]) => l[Math.floor(r() * l.length)];
  switch (spec.category) {
    case 'car': return { color: vary(pickW(r, CAR_PAINT), k) };
    case 'van': return { color: vary(r() < 0.1 ? 0xe8c21a /* school van */ : pickW(r, CAR_PAINT.slice(0, 4)), k) };
    case 'bus': {
      if (r() < 0.4) return { color: 0x9a1b1b }; // SLTB
      return { color: any([0x2a63c8, 0xe6e6e6, 0xd65a1a, 0x1f8a4a, 0x7a1f8a, 0xc81e3a, 0x1a1a1a]), accent: any([0xf2c230, 0xffffff, 0x2ab0e0, 0xe02a6a, 0x30c060]) };
    }
    case 'lorry': return { color: any([0x2a5aa8, 0xd8b21a, 0xe8e8e8, 0x2f7a3a, 0xb02020]), accent: any([0x6a5a3a, 0x3a4a6a, 0x8a2a1a]), cargo: any([0x4e5a3a, 0x2a3a6a, 0x6a6a6a, 0x8a6a3a]) };
    case 'tuktuk': return { color: vary(any([0x7a1424, 0x7a1424, 0xb0181f, 0x1d5e2a, 0x1b3f8a, 0x151515, 0xd6a417, 0x2a7a8a]), k) };
    case 'motorcycle': return { color: any([0x151515, 0x151515, 0xb0181f, 0x1b3f8a, 0xdedede, 0x5a5a5a, 0x1d6a2a]), accent: r() < 0.4 ? 1 : 0,
      rider: any([0x2a3a5a, 0xe8e8e8, 0x8a2a2a, 0x3a3a3a, 0x5a7a9a, 0x2a5a3a]), helmet: any([0xdedede, 0x151515, 0xb0181f, 0x1b3f8a, 0xd6a417]) };
  }
}

/** Mesh cache per (kind, look): each distinct model is built once and shared. */
export class ModelCache {
  private meshes = new Map<string, pc.MeshInstance[]>();
  readonly hazardMat: pc.StandardMaterial;
  private mats: { paint: pc.StandardMaterial; glass: pc.StandardMaterial; trim: pc.StandardMaterial };
  private hazardMesh: pc.Mesh;

  constructor(private device: pc.GraphicsDevice) {
    const mat = (gloss: number, metal: number) => {
      const m = new pc.StandardMaterial();
      m.diffuseVertexColor = true; m.gloss = gloss; m.useMetalness = true; m.metalness = metal; m.cull = pc.CULLFACE_NONE;
      m.update(); return m;
    };
    this.mats = { paint: mat(0.62, 0.25), glass: mat(0.92, 0.1), trim: mat(0.2, 0) };
    this.mats.glass.diffuse = new pc.Color(0.12, 0.15, 0.18); this.mats.glass.diffuseVertexColor = false; this.mats.glass.update();
    this.hazardMat = new pc.StandardMaterial();
    this.hazardMat.emissive = new pc.Color(1, 0.55, 0.05);
    this.hazardMat.update();
    const g = new GeometryBuffer();
    box(g, 0, 0, 0, 0, -1, 0.18, 0.12, 0.06, 0xffffff);
    this.hazardMesh = g.toMesh(device)!;
  }

  /** Body only (no wheels), for the player's car whose wheels steer and spin. */
  body(spec: VehicleSpec, look: Look): pc.MeshInstance[] {
    const b = buildModel({ ...spec, ...look } as VehicleSpec, true);
    return (['paint', 'glass', 'trim'] as const).flatMap(k => { const m = b[k].toMesh(this.device); return m ? [new pc.MeshInstance(m, this.mats[k])] : []; });
  }

  /** One wheel (tyre + rim) centred at the origin, rim facing +X. */
  wheel(radius: number, width: number): pc.MeshInstance {
    const p: Parts = { paint: new GeometryBuffer(), glass: new GeometryBuffer(), trim: new GeometryBuffer() };
    wheel(p, 0.0001, 0, radius, width);
    const m = p.trim.toMesh(this.device)!;
    return new pc.MeshInstance(m, this.mats.trim);
  }

  entity(spec: VehicleSpec, look: Look): { root: pc.Entity; hazard: pc.Entity } {
    const key = spec.id + JSON.stringify(look);
    let parts = this.meshes.get(key);
    if (!parts) {
      const b = buildModel({ ...spec, ...look } as VehicleSpec);
      parts = (['paint', 'glass', 'trim'] as const).flatMap(k => { const m = b[k].toMesh(this.device); return m ? [new pc.MeshInstance(m, this.mats[k])] : []; });
      this.meshes.set(key, parts);
    }
    const root = new pc.Entity(spec.id);
    root.addComponent('render', { meshInstances: parts.map(mi => new pc.MeshInstance(mi.mesh!, mi.material!)), castShadows: true });
    const hazard = new pc.Entity('hazards');
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const h = new pc.Entity();
      h.addComponent('render', { meshInstances: [new pc.MeshInstance(this.hazardMesh, this.hazardMat)], castShadows: false });
      h.setLocalPosition(x * (spec.width / 2), Math.min(spec.height * 0.45, 0.85), z * (spec.length / 2 + 0.03));
      hazard.addChild(h);
    }
    hazard.enabled = false;
    root.addChild(hazard);
    return { root, hazard };
  }
}
