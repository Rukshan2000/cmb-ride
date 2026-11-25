import * as pc from 'playcanvas';
import type { DriveInput } from '../input/InputManager';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehicleConfig } from './VehicleConfig';
import { VehiclePhysics } from './VehiclePhysics';
import { CATALOG } from '../traffic/VehicleCatalog';
import { ModelCache } from '../traffic/VehicleModels';

const RAD = 180 / Math.PI;

/** Owns a vehicle's physics state and its visual entity (profile-modelled sedan, animated wheels). */
export class VehicleController {
  readonly physics: VehiclePhysics;
  readonly entity = new pc.Entity('vehicle');
  private body = new pc.Entity('body');
  private wheels: { pivot: pc.Entity; spin: pc.Entity; front: boolean }[] = [];

  constructor(private app: pc.AppBase, readonly cfg: VehicleConfig) {
    this.physics = new VehiclePhysics(cfg);
    this.buildModel();
    app.root.addChild(this.entity);
  }

  update(dt: number, input: DriveInput, walls: CollisionWorld | null) {
    this.physics.step(dt, input, walls);
    const p = this.physics;
    this.entity.setPosition(p.x, 0, p.z);
    this.entity.setEulerAngles(0, p.yaw * RAD, 0);
    this.body.setLocalEulerAngles(p.pitch * RAD, 0, p.roll * RAD);
    for (const w of this.wheels) {
      w.pivot.setLocalEulerAngles(0, w.front ? p.steer * RAD : 0, 0);
      w.spin.setLocalEulerAngles(-p.wheelSpin * RAD, 0, 0);
    }
  }

  private buildModel() {
    const c = this.cfg;
    // Same profile-built sedan as the traffic (Axio/Corolla-style), painted with the config colour.
    const models = new ModelCache(this.app.graphicsDevice);
    const hex = (Math.round(c.color[0] * 255) << 16) | (Math.round(c.color[1] * 255) << 8) | Math.round(c.color[2] * 255);
    const spec = { ...CATALOG.find(s => s.id === (c.model ?? 'sedan'))!, length: c.length, width: c.width, height: c.height };
    this.body.addComponent('render', { meshInstances: models.body(spec, { color: hex, accent: c.accent }), castShadows: true });
    this.body.setLocalPosition(0, 0, 0);
    this.entity.addChild(this.body);

    const xs = c.trackWidth / 2, r = c.wheelRadius;
    for (const [x, z, front] of [[xs, -c.cgToFront, true], [-xs, -c.cgToFront, true], [xs, c.cgToRear, false], [-xs, c.cgToRear, false]] as const) {
      const pivot = new pc.Entity();
      pivot.setLocalPosition(x, r, z);
      const spin = new pc.Entity();
      const tyre = new pc.Entity();
      tyre.addComponent('render', { meshInstances: [models.wheel(r, c.model === 'bus' ? 0.32 : 0.2)], castShadows: true });
      tyre.setLocalPosition(0, -r, 0);       // wheel mesh sits on y=0; pivot is at the axle
      tyre.setLocalScale(x > 0 ? 1 : -1, 1, 1); // rim faces outwards on both sides
      spin.addChild(tyre);
      pivot.addChild(spin);
      this.entity.addChild(pivot);
      this.wheels.push({ pivot, spin, front });
    }
  }
}

