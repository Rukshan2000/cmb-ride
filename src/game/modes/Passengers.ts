import * as pc from 'playcanvas';
import { GeometryBuffer, vertexColorMaterial } from '../../map/MeshUtil';
import { box } from '../../roads/StreetFurniture';

// Waiting-passenger figures (Sri Lankan street clothes: sarongs, saris, shirts) and a beacon so they're visible from afar.
const SKIN = [0x6b4a32, 0x7a5638, 0x5c3e2a, 0x8a6444];
const TOPS = [0xf2f2ee, 0x2a5aa8, 0xd8b21a, 0xb0181f, 0x3a8a5a, 0xe07aa0, 0x6a3a8a];
const LOWER = [0x2a2a3a, 0x3a4a6a, 0x8a5a2a, 0x5a2a4a, 0x2a5a4a];

export class PassengerFactory {
  private mat = vertexColorMaterial();
  private beaconMat: pc.StandardMaterial;

  constructor(private app: pc.AppBase) {
    this.beaconMat = new pc.StandardMaterial();
    this.beaconMat.emissive = new pc.Color(1, 0.8, 0.1);
    this.beaconMat.opacity = 0.35;
    this.beaconMat.blendType = pc.BLEND_NORMAL;
    this.beaconMat.depthWrite = false;
    this.beaconMat.update();
  }

  /** A person (optionally waving) standing at (x,z), facing (fx,fz). Beacon optional. */
  person(x: number, z: number, fx: number, fz: number, beacon: boolean, seed = Math.random()): pc.Entity {
    const r = (k: number) => ((Math.sin(seed * 9301 + k * 49297) + 1) / 2) % 1;
    const pick = (a: number[], k: number) => a[Math.floor(r(k) * a.length) % a.length];
    const g = new GeometryBuffer(), skin = pick(SKIN, 1), top = pick(TOPS, 2), low = pick(LOWER, 3), saree = r(4) < 0.35;
    if (saree) box(g, 0, 0, 0, 0, -1, 0.46, 1.05, 0.34, top);        // sari drape to the ground
    else box(g, 0, 0, 0, 0, -1, 0.4, 0.9, 0.28, low);                // sarong / trousers
    box(g, 0, 0.9, 0, 0, -1, 0.46, 0.62, 0.28, top);                 // shirt / blouse
    box(g, 0, 1.52, 0, 0, -1, 0.22, 0.24, 0.24, skin);               // head
    box(g, 0, 1.74, 0, 0, -1, 0.24, 0.08, 0.25, 0x1a1410);           // hair
    box(g, -0.3, 0.95, 0, 0, -1, 0.12, 0.55, 0.12, skin);            // arm down
    box(g, 0.3, 1.45, 0, 0, -1, 0.12, 0.55, 0.12, skin);             // arm raised (hailing)
    const e = new pc.Entity('passenger');
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(g.toMesh(this.app.graphicsDevice)!, this.mat)], castShadows: true });
    e.setPosition(x, 0.03, z);
    e.setEulerAngles(0, (Math.atan2(-fx, -fz) * 180) / Math.PI, 0);
    if (beacon) {
      const b = new pc.Entity('beacon');
      b.addComponent('render', { type: 'cylinder', material: this.beaconMat, castShadows: false });
      b.setLocalScale(1.6, 40, 1.6);
      b.setLocalPosition(0, 20, 0);
      e.addChild(b);
    }
    this.app.root.addChild(e);
    return e;
  }
}
