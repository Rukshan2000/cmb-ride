import { IMPORTED, glbEntity } from './ImportedModels';
import * as pc from 'playcanvas';
import type { DriveInput } from '../input/InputManager';
import type { CollisionWorld } from '../map/CollisionWorld';
import type { VehicleConfig } from './VehicleConfig';
import { VehiclePhysics } from './VehiclePhysics';
import { CATALOG } from '../traffic/VehicleCatalog';
import { ModelCache, lampsOn } from '../traffic/VehicleModels';

const RAD = 180 / Math.PI;

/** Owns a vehicle's physics state and its visual entity (profile-modelled sedan, animated wheels). */
export class VehicleController {
  readonly physics: VehiclePhysics;
  readonly entity = new pc.Entity('vehicle');
  private body = new pc.Entity('body');
  private wheels: { pivot: pc.Entity; spin: pc.Entity; front: boolean }[] = [];
  private lean = 0;

  constructor(private app: pc.AppBase, readonly cfg: VehicleConfig) {
    this.physics = new VehiclePhysics(cfg);
    this.buildModel();
    this.addHeadlight();
    app.root.addChild(this.entity);
  }

  update(dt: number, input: DriveInput, walls: CollisionWorld | null) {
    this.physics.step(dt, input, walls);
    const p = this.physics;
    this.entity.setPosition(p.x, p.y, p.z);
    // Two-wheelers lean into the turn: lean angle = atan(lateral acceleration / g), eased.
    if (this.cfg.bike) this.lean += (Math.atan(Math.max(-8, Math.min(8, p.accelW)) / 9.81) - this.lean) * Math.min(1, dt * 8);
    this.entity.setEulerAngles(p.slope * RAD, p.yaw * RAD, this.lean * RAD);
    this.body.setLocalEulerAngles(p.pitch * RAD, 0, p.roll * RAD);
    this.headlight.enabled = lampsOn;
    for (const w of this.wheels) {
      w.pivot.setLocalEulerAngles(0, w.front ? p.steer * RAD : 0, 0);
      w.spin.setLocalEulerAngles(-p.wheelSpin * RAD, 0, 0);
    }
  }

  /** Real headlight beam: one wide spot from the nose, on whenever it's dark (sunset, storm, night). */
  private headlight = new pc.Entity('headlight');
  private addHeadlight() {
    const c = this.cfg;
    this.headlight.addComponent('light', { type: 'spot', color: new pc.Color(1, 0.95, 0.84), intensity: 5, range: 60, innerConeAngle: 14, outerConeAngle: 36, castShadows: false });
    this.headlight.setLocalPosition(0, Math.max(0.7, c.height * 0.5), -c.length / 2 - 0.1);
    this.headlight.setLocalEulerAngles(84, 0, 0); // spots shine down -Y: tip forward, dipped slightly towards the road
    this.headlight.enabled = false;
    this.entity.addChild(this.headlight);
  }

  private buildModel() {
    const c = this.cfg;
    // Same profile-built sedan as the traffic (Axio/Corolla-style), painted with the config colour.
    const models = new ModelCache(this.app.graphicsDevice);
    const hex = (Math.round(c.color[0] * 255) << 16) | (Math.round(c.color[1] * 255) << 8) | Math.round(c.color[2] * 255);
    const spec = { ...CATALOG.find(s => s.id === (c.model ?? 'sedan'))!, length: c.length, width: c.width, height: c.height, rider: 0x2a3a5a, helmet: 0x151515, axles: [-c.cgToFront, c.cgToRear] as [number, number] };
    const imp = IMPORTED[c.model ?? ''];
    if (imp) this.body.addChild(glbEntity(this.app, imp.file, imp.yaw, imp.paint ? c.color : undefined));
    else this.body.addComponent('render', { meshInstances: models.body(spec, { color: hex, accent: c.accent }), castShadows: true });
    this.body.setLocalPosition(0, 0, 0);
    this.entity.addChild(this.body);

    const xs = c.trackWidth / 2, r = c.wheelRadius;
    // Wheel layout: motorcycle 1+1 on the centreline, tuk-tuk 1 front + 2 rear, everything else 2+2.
    const layout: [number, number, boolean][] = c.model === 'motorcycle' ? [[0.001, -c.cgToFront, true], [0.001, c.cgToRear, false]]
      : c.model === 'tuktuk' ? [[0.001, -c.cgToFront, true], [xs, c.cgToRear, false], [-xs, c.cgToRear, false]]
      : [[xs, -c.cgToFront, true], [-xs, -c.cgToFront, true], [xs, c.cgToRear, false], [-xs, c.cgToRear, false]];
    const width = c.model === 'bus' ? 0.32 : c.model === 'motorcycle' ? 0.11 : c.model === 'tuktuk' ? 0.13 : 0.2;
    if (imp && !imp.wheel) return; // wheels are part of the model
    for (const [x, z, front] of layout) {
      const pivot = new pc.Entity();
      pivot.setLocalPosition(x, r, z);
      const spin = new pc.Entity();
      const tyre = new pc.Entity();
      if (imp?.wheel) tyre.addChild(glbEntity(this.app, imp.wheel));   // centred on its axle
      else {
        tyre.addComponent('render', { meshInstances: [models.wheel(r, width)], castShadows: true });
        tyre.setLocalPosition(0, -r, 0);     // wheel mesh sits on y=0; pivot is at the axle
      }
      tyre.setLocalScale(x > 0 ? 1 : -1, 1, 1); // rim faces outwards on both sides
      spin.addChild(tyre);
      pivot.addChild(spin);
      this.entity.addChild(pivot);
      this.wheels.push({ pivot, spin, front });
    }
  }
}

