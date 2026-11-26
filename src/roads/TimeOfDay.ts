import * as pc from 'playcanvas';
import type { Sky } from './Sky';
import { setNightLights } from './NightLights';
import { setVehicleLamps } from '../traffic/VehicleModels';

const PRESETS = {
  day:      { sky: [0.55, 0.74, 0.95], sun: [1, 0.93, 0.8],  sunI: 1.6,  pitch: 50, amb: [0.42, 0.45, 0.52], lamp: 0 },
  overcast: { sky: [0.66, 0.69, 0.72], sun: [0.9, 0.92, 0.95], sunI: 0.6, pitch: 70, amb: [0.55, 0.56, 0.58], lamp: 0 },
  sunset:   { sky: [1.0, 0.55, 0.38],  sun: [1, 0.55, 0.28], sunI: 1.3,  pitch: 78, amb: [0.42, 0.3, 0.36],  lamp: 2 },   // golden hour
  storm:    { sky: [0.24, 0.26, 0.3],  sun: [0.7, 0.75, 0.85], sunI: 0.25, pitch: 70, amb: [0.3, 0.31, 0.35], lamp: 2 },   // monsoon thunderstorm: lamps + headlights on
  night:    { sky: [0.09, 0.08, 0.14],  sun: [0.5, 0.6, 0.85], sunI: 0.06, pitch: 40, amb: [0.08, 0.08, 0.16], lamp: 6 },  // neon-ish glow, blooms
};
export type TimeName = keyof typeof PRESETS;
const POOL = 32; // ponytail: 32 real point lights (cheap with clustered lighting) moved to the lamps nearest the car; the rest only glow

/** Lighting presets (N key) and pooled streetlight point lights at night. */
export class TimeOfDay {
  current: TimeName = 'day';
  private pool: pc.Entity[] = [];

  constructor(private app: pc.AppBase, private sun: pc.Entity, private camera: pc.Entity, private lampMat: pc.StandardMaterial, private sky?: Sky) {
    for (let i = 0; i < POOL; i++) {
      const e = new pc.Entity('streetlight pool');
      e.addComponent('light', { type: 'omni', color: new pc.Color(1, 0.85, 0.62), intensity: 2.6, range: 30, castShadows: false });
      e.enabled = false;
      app.root.addChild(e);
      this.pool.push(e);
    }
  }

  cycle() {
    const names = Object.keys(PRESETS) as TimeName[];
    this.set(names[(names.indexOf(this.current) + 1) % names.length]);
  }

  set(name: TimeName) {
    this.current = name;
    const p = PRESETS[name], sky = new pc.Color(...(p.sky as [number, number, number]));
    const s = this.app.scene;
    s.ambientLight = new pc.Color(...(p.amb as [number, number, number]));
    s.fog.color = sky;
    this.camera.camera!.clearColor = sky;
    this.sun.light!.color = new pc.Color(...(p.sun as [number, number, number]));
    this.sun.light!.intensity = p.sunI;
    this.sun.setEulerAngles(p.pitch, 35, 0);
    this.sky?.tint(p.sky);
    this.lampMat.emissiveIntensity = p.lamp;
    this.lampMat.update();
    setVehicleLamps(p.lamp > 1); // sunset + night
    setNightLights(name === 'night' ? 1 : p.lamp > 1 ? 0.4 : 0); // windows + landmarks
  }

  /** Move pooled lights to the nearest lamp heads. Call a few times per second. */
  updatePool(lamps: Iterable<number[]>, x: number, z: number) {
    const on = PRESETS[this.current].lamp > 1;
    if (!on) { this.pool.forEach(e => (e.enabled = false)); return; }
    const near: [number, number, number, number][] = [];
    for (const list of lamps) for (let i = 0; i < list.length; i += 3) {
      const d = Math.abs(list[i] - x) + Math.abs(list[i + 2] - z);
      if (d < 260) near.push([d, list[i], list[i + 1], list[i + 2]]);
    }
    near.sort((a, b) => a[0] - b[0]);
    // Keep all pooled lights enabled: a changing light count recompiles every shader.
    this.pool.forEach((e, i) => {
      e.enabled = true;
      if (i < near.length) e.setPosition(near[i][1], near[i][2], near[i][3]);
      else e.setPosition(0, -1000, 0);
    });
  }
}
