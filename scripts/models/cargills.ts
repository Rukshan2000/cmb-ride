// Cargills building, York Street, Colombo Fort (OSM way 374793744).
// Reconstructed on the real OSM footprint from Mapillary photos (CC BY-SA, see records.json):
// two storeys of salmon-red render; ground-floor arcade of round arches with alternating red/white banded voussoirs;
// upper floor round-headed windows with white surrounds; white string course and cornice; balustraded parapet with
// finials; curved ornamental gables. Only street-facing sides carry the façade; the others are plain (not photographed).
// Run: node scripts/models/cargills.ts
import { readFileSync, readdirSync } from 'node:fs';
import earcut from 'earcut';
import { Model } from './glb.ts';
import { project } from '../../src/map/MapProjection.ts';

const OSM = 374793744;
const RED = 0xb4574f, RED_DARK = 0x9a463f, WHITE = 0xe9e0d2, OPENING = 0x2b2522, GLASS = 0x3a3e44, ROOF = 0x77726c;
const GROUND = 5.0, CORNICE = 9.8, PARAPET = 11.2, BAY = 4.2;

let fp: number[] = [], roads: number[][] = [];
for (const f of readdirSync('public/data/chunks')) {
  const c = JSON.parse(readFileSync(`public/data/chunks/${f}`, 'utf8'));
  const b = c.buildings.find((b: any) => b.id === OSM);
  if (b) fp = b.p;
  for (const r of c.roads) roads.push(r.p);
}
if (!fp.length) throw new Error('footprint not found');
const rec = JSON.parse(readFileSync('public/data/buildings/records.json', 'utf8')).find((r: any) => r.osm?.includes(OSM));
const [ox, oz] = project(rec.latitude, rec.longitude); // model origin = record coordinate
const P = fp.map((v, i) => v - (i % 2 ? oz : ox));
const n = P.length / 2;

const inside = (x: number, z: number) => { let c = false; for (let i = 0, j = n - 1; i < n; j = i++) if ((P[i * 2 + 1] > z) !== (P[j * 2 + 1] > z) && x < ((P[j * 2] - P[i * 2]) * (z - P[i * 2 + 1])) / (P[j * 2 + 1] - P[i * 2 + 1]) + P[i * 2]) c = !c; return c; };
const nearRoad = (x: number, z: number) => roads.some(p => { for (let i = 0; i < p.length - 2; i += 2) { const ax = p[i] - ox, az = p[i + 1] - oz, ex = p[i + 2] - p[i], ez = p[i + 3] - p[i + 1], l2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)); if (Math.hypot(ax + ex * t - x, az + ez * t - z) < 20) return true; } return false; });

const m = new Model();
// Roof
const tri = earcut(P);
m.tris(ROOF, Array.from({ length: n }, (_, i) => [P[i * 2], PARAPET - 0.6, P[i * 2 + 1]]).flat(), tri);

/** Arch (round head) as a flat shape on the façade: rect [a0,a1]x[y0,yS] + semicircle on top. */
function arch(c: number, o: number[], u: number[], nn: number[], a0: number, a1: number, y0: number, ySpring: number, d: number) {
  const r = (a1 - a0) / 2, ac = (a0 + a1) / 2, pts: number[][] = [];
  const at = (a: number, y: number) => [o[0] + u[0] * a + nn[0] * d, y, o[2] + u[2] * a + nn[2] * d];
  pts.push(at(a0, y0), at(a1, y0));
  for (let k = 0; k <= 10; k++) { const t = (k / 10) * Math.PI; pts.push(at(ac + Math.cos(t) * r, ySpring + Math.sin(t) * r)); }
  m.poly(c, pts);
}
/** Banded voussoir ring around an arch: alternating colours, like the photographed arcade. */
function voussoirs(o: number[], u: number[], nn: number[], ac: number, r: number, ySpring: number, w: number, d: number) {
  const at = (a: number, y: number) => [o[0] + u[0] * a + nn[0] * d, y, o[2] + u[2] * a + nn[2] * d];
  for (let k = 0; k < 9; k++) {
    const t0 = (k / 9) * Math.PI, t1 = ((k + 1) / 9) * Math.PI;
    m.poly(k % 2 ? RED_DARK : WHITE, [at(ac + Math.cos(t0) * r, ySpring + Math.sin(t0) * r), at(ac + Math.cos(t0) * (r + w), ySpring + Math.sin(t0) * (r + w)),
      at(ac + Math.cos(t1) * (r + w), ySpring + Math.sin(t1) * (r + w)), at(ac + Math.cos(t1) * r, ySpring + Math.sin(t1) * r)]);
  }
}

let streetEdges = 0;
for (let i = 0; i < n; i++) {
  const j = (i + 1) % n, x0 = P[i * 2], z0 = P[i * 2 + 1], x1 = P[j * 2], z1 = P[j * 2 + 1];
  const L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.3) continue;
  const u = [(x1 - x0) / L, 0, (z1 - z0) / L];
  let nn = [u[2], 0, -u[0]];
  if (inside((x0 + x1) / 2 + nn[0] * 0.5, (z0 + z1) / 2 + nn[2] * 0.5)) nn = [-nn[0], 0, -nn[2]]; // outward
  const o = [x0, 0, z0];
  m.fbox(RED, o, u, nn, [0, L], [0, PARAPET], [-0.01, 0]); // wall plane
  m.fbox(WHITE, o, u, nn, [0, L], [PARAPET, PARAPET + 0.25], [-0.2, 0.15]); // coping
  const street = L > 4 && nearRoad((x0 + x1) / 2 + nn[0] * 3, (z0 + z1) / 2 + nn[2] * 3);
  if (!street) continue;
  streetEdges++;
  const bays = Math.max(1, Math.floor(L / BAY)), bw = L / bays;
  m.fbox(WHITE, o, u, nn, [0, L], [GROUND - 0.15, GROUND + 0.2], [0, 0.18]);  // string course
  m.fbox(RED_DARK, o, u, nn, [0, L], [CORNICE - 0.7, CORNICE], [0, 0.08]);    // frieze
  m.fbox(WHITE, o, u, nn, [0, L], [CORNICE, CORNICE + 0.35], [0, 0.4]);       // cornice
  for (let k = 0; k < bays; k++) {
    const a0 = k * bw, ac = a0 + bw / 2;
    m.fbox(RED, o, u, nn, [a0, a0 + 0.45], [0, CORNICE - 0.7], [0, 0.12]);   // pilaster
    // Ground floor arcade
    const r = Math.min(1.3, bw / 2 - 0.5);
    arch(OPENING, o, u, nn, ac - r, ac + r, 0, 3.2, 0.02);
    voussoirs(o, u, nn, ac, r, 3.2, 0.38, 0.03);
    // Upper floor round-headed window with white surround and small balustrade below
    arch(WHITE, o, u, nn, ac - 0.75, ac + 0.75, 5.75, 7.75, 0.02);
    arch(GLASS, o, u, nn, ac - 0.55, ac + 0.55, 5.95, 7.75, 0.03);
    m.fbox(WHITE, o, u, nn, [ac - 0.85, ac + 0.85], [5.5, 5.75], [0, 0.25]);
    // Parapet balustrade + finials
    for (let b = a0 + 0.6; b < a0 + bw - 0.3; b += 0.35) m.fbox(WHITE, o, u, nn, [b, b + 0.12], [CORNICE + 0.35, PARAPET], [0, 0.1]);
    m.fbox(RED, o, u, nn, [a0, a0 + 0.45], [CORNICE + 0.35, PARAPET + 0.9], [0, 0.3]);
    m.fbox(WHITE, o, u, nn, [a0 + 0.12, a0 + 0.33], [PARAPET + 0.9, PARAPET + 1.4], [0.05, 0.25]);
  }
  // Curved ornamental gable at the middle of long frontages
  if (L > 18) {
    const ac = L / 2, gr = 2.4;
    arch(RED, o, u, nn, ac - gr, ac + gr, PARAPET, PARAPET + 0.3, 0.05);
    voussoirs(o, u, nn, ac, gr, PARAPET + 0.3, 0.2, 0.06);
    arch(WHITE, o, u, nn, ac - 0.7, ac + 0.7, PARAPET + 0.6, PARAPET + 1.2, 0.07); // crest medallion
  }
}
m.write('public/data/buildings/models/cargills.glb');
console.log(`cargills.glb written: ${n} footprint vertices, ${streetEdges} street façades`);
