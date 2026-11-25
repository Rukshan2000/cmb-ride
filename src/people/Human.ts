import * as pc from 'playcanvas';
import { GeometryBuffer, vertexColorMaterial } from '../map/MeshUtil';
import { box } from '../roads/StreetFurniture';
import { groundAt } from '../map/Terrain';

// Articulated low-poly person: pelvis/torso/neck/head with face details, jointed arms and legs (pivot at
// shoulder / hip) so they can walk. Sri Lankan street clothing: shirt + trousers, sarong, saree, dress,
// white school uniform, police khaki. Model faces -Z; ~1.55–1.8 m tall.

const SKIN = [0x5c3e2a, 0x6b4a32, 0x7a5638, 0x8a6444, 0x4e3424];
const HAIR = [0x141010, 0x1a1410, 0x2a221c, 0x6a6a6a];
const SHIRT = [0xf2f2ee, 0x2a5aa8, 0x9ab8d8, 0xd8b21a, 0xb0181f, 0x3a8a5a, 0x6a3a8a, 0xe8d8c0, 0x404850];
const TROUSER = [0x2a2a3a, 0x3a4a6a, 0x4a4036, 0x1e1e22, 0x6a6458];
const SAREE = [0xe07aa0, 0xd04a2a, 0xe8c040, 0x2a8a8a, 0x8a2a6a, 0x3a5ac8, 0xf0a040];
const SARONG = [0x2a4a7a, 0x5a2a3a, 0x3a5a3a, 0x6a5a3a];
const SHOE = [0x1a1410, 0x3a2a1a, 0x5a4030];

export type Outfit = 'shirt' | 'sarong' | 'saree' | 'dress' | 'school' | 'police';

export interface Human {
  root: pc.Entity;
  lArm: pc.Entity; rArm: pc.Entity; lLeg: pc.Entity; rLeg: pc.Entity;
  phase: number;
}

const mat = (() => { let m: pc.StandardMaterial | null = null; return () => (m ??= vertexColorMaterial()); })();

export function randomOutfit(r = Math.random): Outfit {
  const x = r();
  return x < 0.38 ? 'shirt' : x < 0.5 ? 'sarong' : x < 0.72 ? 'saree' : x < 0.88 ? 'dress' : 'school';
}

export function makeHuman(app: pc.AppBase, outfit: Outfit = randomOutfit(), r = Math.random): Human {
  const pick = (a: number[]) => a[Math.floor(r() * a.length)];
  const skin = pick(SKIN), hair = pick(HAIR), shoe = pick(SHOE);
  const female = outfit === 'saree' || outfit === 'dress' || (outfit === 'school' && r() < 0.5);
  const top = outfit === 'school' ? 0xf4f4f0 : outfit === 'police' ? 0x9a8a5a : outfit === 'saree' ? pick(SAREE) : pick(SHIRT);
  const lower = outfit === 'school' ? (female ? 0xf4f4f0 : 0x2a3a5a) : outfit === 'police' ? 0x9a8a5a
    : outfit === 'sarong' ? pick(SARONG) : outfit === 'saree' ? top : outfit === 'dress' ? top : pick(TROUSER);
  const sleeve = outfit === 'police' ? 0xf2f2f0 : top;
  const scale = (outfit === 'school' ? 0.82 : female ? 0.94 : 1) * (0.96 + r() * 0.08);

  const mesh = (g: GeometryBuffer) => new pc.MeshInstance(g.toMesh(app.graphicsDevice)!, mat());
  const part = (name: string, g: GeometryBuffer, x: number, y: number, parent: pc.Entity) => {
    const e = new pc.Entity(name);
    e.addComponent('render', { meshInstances: [mesh(g)], castShadows: true });
    e.setLocalPosition(x, y, 0);
    parent.addChild(e);
    return e;
  };

  const root = new pc.Entity('human');
  const body = new pc.Entity('body');
  body.setLocalScale(scale, scale, scale);
  root.addChild(body);

  // --- torso, neck, head (static)
  const t = new GeometryBuffer();
  box(t, 0, 0.86, 0, 0, -1, 0.32, 0.16, 0.2, lower);                       // pelvis
  box(t, 0, 1.0, 0, 0, -1, female ? 0.3 : 0.33, 0.2, 0.19, top);           // waist
  box(t, 0, 1.18, 0, 0, -1, female ? 0.34 : 0.4, 0.26, 0.22, top);         // chest / shoulders
  box(t, 0, 1.44, 0, 0, -1, 0.09, 0.07, 0.09, skin);                       // neck
  box(t, 0, 1.5, 0, 0, -1, 0.19, 0.23, 0.21, skin);                        // head
  box(t, 0, 1.68, 0.01, 0, -1, 0.21, 0.07, 0.23, hair);                    // hair top
  box(t, 0, 1.55, 0.06, 0, -1, 0.21, 0.13, 0.1, hair);                     // back of hair
  if (female && outfit !== 'school') box(t, 0, 1.38, 0.12, 0, -1, 0.12, 0.18, 0.07, hair); // bun / plait
  for (const ex of [-0.045, 0.045]) box(t, ex, 1.6, -0.106, 0, -1, 0.035, 0.022, 0.01, 0x1a1210); // eyes
  box(t, 0, 1.535, -0.106, 0, -1, 0.06, 0.012, 0.01, 0x4a2a22);            // mouth
  box(t, 0, 1.56, -0.115, 0, -1, 0.03, 0.05, 0.02, skin);                  // nose
  if (outfit === 'saree') {                                                // pleated skirt + pallu over the left shoulder
    box(t, 0, 0.06, 0, 0, -1, 0.42, 0.86, 0.3, top);
    box(t, -0.12, 0.9, -0.005, 0, -1, 0.16, 0.5, 0.23, darker(top));
    box(t, 0, 0.85, 0.0, 0, -1, 0.35, 0.06, 0.23, 0xe8c040);               // border band
  } else if (outfit === 'sarong' || outfit === 'dress' || (outfit === 'school' && female)) {
    box(t, 0, outfit === 'sarong' ? 0.1 : 0.42, 0, 0, -1, 0.38, outfit === 'sarong' ? 0.82 : 0.5, 0.27, lower);
  }
  if (outfit === 'police') {
    box(t, 0, 0.94, 0, 0, -1, 0.35, 0.05, 0.21, 0x3a2a1a);                 // belt
    box(t, 0, 1.73, 0, 0, -1, 0.24, 0.07, 0.27, 0xf2f2f0);                 // white cap
    box(t, 0, 1.72, -0.14, 0, -1, 0.2, 0.02, 0.08, 0x1a1a1a);              // peak
  }
  part('torso', t, 0, 0, body);

  // --- legs (pivot at hip)
  const legs = [-1, 1].map(s => {
    const g = new GeometryBuffer(), covered = outfit === 'saree' || outfit === 'sarong';
    const bare = covered || outfit === 'dress' || (outfit === 'school' && female); // skirt / sarong / saree: legs show skin
    box(g, 0, -0.84, 0, 0, -1, 0.13, 0.84, 0.15, bare ? skin : lower);
    box(g, 0, -0.88, -0.04, 0, -1, 0.11, 0.07, 0.25, outfit === 'school' ? 0xf4f4f0 : shoe); // shoe / slipper
    return part(s < 0 ? 'lLeg' : 'rLeg', g, s * 0.085, 0.88, body);
  });

  // --- arms (pivot at shoulder)
  const arms = [-1, 1].map(s => {
    const g = new GeometryBuffer(), short = outfit !== 'police' && r() < 0.6;
    box(g, 0, -0.3, 0, 0, -1, 0.1, 0.3, 0.1, sleeve);                     // upper arm / sleeve
    box(g, 0, -0.58, 0, 0, -1, 0.085, 0.28, 0.085, short ? skin : sleeve); // forearm
    box(g, 0, -0.68, 0, 0, -1, 0.08, 0.1, 0.06, outfit === 'police' ? 0xf2f2f0 : skin); // hand / gauntlet
    return part(s < 0 ? 'lArm' : 'rArm', g, s * (female ? 0.21 : 0.245), 1.4, body);
  });

  return { root, lLeg: legs[0], rLeg: legs[1], lArm: arms[0], rArm: arms[1], phase: r() * 6.28 };
}

/** Walk cycle. speed in m/s (0 = stand). Arms swing opposite to legs. */
export function animate(h: Human, dt: number, speed: number) {
  h.phase += dt * speed * 4.2;
  const a = speed > 0.05 ? Math.sin(h.phase) * Math.min(32, 18 + speed * 8) : 0;
  h.lLeg.setLocalEulerAngles(a, 0, 0); h.rLeg.setLocalEulerAngles(-a, 0, 0);
  h.lArm.setLocalEulerAngles(-a * 0.7, 0, 3); h.rArm.setLocalEulerAngles(a * 0.7, 0, -3);
  h.root.children[0].setLocalPosition(0, speed > 0.05 ? Math.abs(Math.cos(h.phase)) * 0.035 : 0, 0); // bob
}

export function face(h: Human, x: number, z: number, fx: number, fz: number) {
  h.root.setPosition(x, 0.03 + groundAt(x, z), z);
  h.root.setEulerAngles(0, (Math.atan2(-fx, -fz) * 180) / Math.PI, 0);
}

function darker(c: number) {
  return (((c >> 16) & 255) * 0.75 << 16) | ((((c >> 8) & 255) * 0.75) << 8) | ((c & 255) * 0.75);
}
