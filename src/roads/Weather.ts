import * as pc from 'playcanvas';
import { GeometryBuffer } from '../map/MeshUtil';

// Monsoon rain: falling streaks around the camera, wet asphalt (darker, glossy, reflective), lower tyre grip.
// ponytail: wet look is a material change (no puddles / screen droplets / splashes); add when needed.
const BOX = 50, HEIGHT = 28, DROPS = 3500, FALL = 14; // m, m, count, m/s

export class Weather {
  raining = false;
  private rain = new pc.Entity('rain');
  private layers: pc.Entity[] = [];
  private dry: { gloss: number; specular: pc.Color; diffuse: pc.Color }[];
  private t = 0;

  constructor(app: pc.AppBase, private wetMats: pc.StandardMaterial[]) {
    // Each drop: two crossed thin quads (visible from any side), 0.7 m streak.
    const g = new GeometryBuffer(), C = 0xbfcad6;
    for (let i = 0; i < DROPS; i++) {
      const x = (Math.random() - 0.5) * BOX, y = Math.random() * HEIGHT, z = (Math.random() - 0.5) * BOX;
      for (const [ax, az] of [[0.012, 0], [0, 0.012]]) {
        const v = g.vertexCount;
        g.vertex(x - ax, y, z - az, 0, 0, 1, C); g.vertex(x + ax, y, z + az, 0, 0, 1, C);
        g.vertex(x + ax + 0.05, y + 0.7, z + az, 0, 0, 1, C); g.vertex(x - ax + 0.05, y + 0.7, z - az, 0, 0, 1, C); // slight wind slant
        g.quad(v);
      }
    }
    const m = new pc.StandardMaterial();
    m.emissive = new pc.Color(0.75, 0.8, 0.88); m.diffuse = new pc.Color(0, 0, 0);
    m.useLighting = false; m.opacity = 0.32; m.blendType = pc.BLEND_NORMAL; m.depthWrite = false; m.cull = pc.CULLFACE_NONE;
    m.update();
    const mesh = g.toMesh(app.graphicsDevice)!;
    for (let k = 0; k < 2; k++) { // two stacked copies scroll down for a seamless loop
      const e = new pc.Entity();
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, m)], castShadows: false });
      this.rain.addChild(e); this.layers.push(e);
    }
    this.rain.enabled = false;
    app.root.addChild(this.rain);
    this.dry = wetMats.map(w => ({ gloss: w.gloss, specular: w.specular.clone(), diffuse: w.diffuse.clone() }));
  }

  set(rain: boolean) {
    if (rain === this.raining) return;
    this.raining = rain;
    this.rain.enabled = rain;
    this.wetMats.forEach((w, i) => {
      const d = this.dry[i];
      w.gloss = rain ? 0.82 : d.gloss;
      w.specular = rain ? new pc.Color(0.35, 0.36, 0.38) : d.specular;
      w.diffuse = rain ? new pc.Color(d.diffuse.r * 0.62, d.diffuse.g * 0.62, d.diffuse.b * 0.64) : d.diffuse; // wet asphalt darkens
      w.update();
    });
  }

  /** Keep the rain volume centred on the camera and scroll the streaks down. */
  update(dt: number, cam: pc.Vec3) {
    if (!this.raining) return;
    this.t = (this.t + dt * FALL) % HEIGHT;
    this.rain.setPosition(Math.round(cam.x / 4) * 4, cam.y - HEIGHT / 2, Math.round(cam.z / 4) * 4);
    this.layers[0].setLocalPosition(0, -this.t, 0);
    this.layers[1].setLocalPosition(0, HEIGHT - this.t, 0);
  }
}
