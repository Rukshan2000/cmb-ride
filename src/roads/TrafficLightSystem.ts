import * as pc from 'playcanvas';

// One fixed-time controller shared by every junction: two conflicting phase groups.
// ponytail: all junctions run in sync; per-junction offsets/green waves when traffic AI exists.
const GREEN = 22, AMBER = 3, ALL_RED = 2, CYCLE = 2 * (GREEN + AMBER + ALL_RED);
export type Aspect = 'red' | 'amber' | 'green';
const COLORS = [new pc.Color(1, 0.12, 0.08), new pc.Color(1, 0.62, 0.05), new pc.Color(0.1, 1, 0.45)];

export class TrafficLightSystem {
  /** [group*3 + aspect] shared lens materials; lit by toggling emissive. */
  readonly materials = Array.from({ length: 6 }, (_, i) => {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(0.05, 0.05, 0.05);
    m.emissive = COLORS[i % 3];
    m.useLighting = false;
    m.update();
    return m;
  });
  private t = 0;

  static aspectAt(group: number, t: number): Aspect {
    const local = ((t - group * (GREEN + AMBER + ALL_RED)) % CYCLE + CYCLE) % CYCLE;
    return local < GREEN ? 'green' : local < GREEN + AMBER ? 'amber' : 'red';
  }

  aspect(group: number) { return TrafficLightSystem.aspectAt(group, this.t); }

  /** Debug: jump to the next phase boundary. */
  skip() { const p = GREEN + AMBER + ALL_RED, l = ((this.t % CYCLE) + CYCLE) % CYCLE; this.t += (l < GREEN ? GREEN : l < GREEN + AMBER ? GREEN + AMBER : p) - (l % p) + 0.01; }

  private shown = ['', ''];

  update(dt: number) {
    this.t += dt;
    for (let g = 0; g < 2; g++) {
      const a = this.aspect(g);
      if (a === this.shown[g]) continue; // material.update() is costly: only on phase change
      this.shown[g] = a;
      ['red', 'amber', 'green'].forEach((name, k) => {
        const m = this.materials[g * 3 + k], on = name === a;
        m.emissiveIntensity = on ? 2.2 : 0.06;
        m.update();
      });
    }
  }
}

// Self-check: groups never both green; each cycles through all aspects.
if (import.meta.env?.DEV) {
  for (let t = 0; t < CYCLE; t += 0.5)
    console.assert(!(TrafficLightSystem.aspectAt(0, t) === 'green' && TrafficLightSystem.aspectAt(1, t) === 'green'), 'signal conflict at', t);
}
