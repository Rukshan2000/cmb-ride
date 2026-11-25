import * as pc from 'playcanvas';
import { face, makeHuman, randomOutfit } from '../../people/Human';

// Waiting passengers (people/Human) and a beacon so they're visible from afar.

export class PassengerFactory {
  private beaconMat: pc.StandardMaterial;

  constructor(private app: pc.AppBase) {
    this.beaconMat = new pc.StandardMaterial();
    this.beaconMat.emissive = new pc.Color(1, 0.8, 0.1);
    this.beaconMat.opacity = 0.35;
    this.beaconMat.blendType = pc.BLEND_NORMAL;
    this.beaconMat.depthWrite = false;
    this.beaconMat.update();
  }

  /** A person (waving if beacon) standing at (x,z), facing (fx,fz). Beacon optional. */
  person(x: number, z: number, fx: number, fz: number, beacon: boolean): pc.Entity {
    const h = makeHuman(this.app, randomOutfit());
    face(h, x, z, fx, fz);
    if (beacon) h.rArm.setLocalEulerAngles(0, 0, -150); // arm raised, hailing
    const e = h.root;
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
