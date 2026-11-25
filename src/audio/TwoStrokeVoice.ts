// Bajaj RE / 2-stroke three-wheeler engine, synthesized per firing event in an AudioWorklet.
//
// What makes the tuk-tuk sound unique, and how it's modelled:
//  - fires every crank revolution (2-stroke): a sharp exhaust pulse at rpm/60 Hz;
//  - "four-stroking" at idle / light load: cylinders misfire irregularly -> the uneven "putt-putt-pa-putt";
//  - expansion-chamber exhaust: each pulse rings a resonance whose pitch rises with rpm (the nasal "ring-ding");
//  - air-cooled cylinder fins: a faint metallic ring on every pulse;
//  - overrun (throttle closed at high rpm): crackles and pops.
// Each pulse = decaying noise burst + click, fed through those resonators, then soft-clipped.

const WORKLET = /* js */ `
class TwoStroke extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'rpm', defaultValue: 1300 }, { name: 'load', defaultValue: 0 }, { name: 'gain', defaultValue: 0 }]; }
  constructor() { super(); this.ph = 0; this.env = 0; this.click = 0; this.f = [[0,0,0,0],[0,0,0,0],[0,0,0,0]]; this.g = 0; }
  bp(s, i, f, q, x) { // band-pass biquad (RBJ), state per resonator
    const w = 2 * Math.PI * f / sampleRate, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
    const b0 = a / a0, b2 = -a / a0, a1 = -2 * c / a0, a2 = (1 - a) / a0, st = s[i];
    const y = b0 * x + b2 * st[1] - a1 * st[2] - a2 * st[3];
    st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y; return y;
  }
  process(_, outputs, p) {
    const out = outputs[0][0], rpm = p.rpm[0], load = p.load[0], gain = p.gain[0];
    const fire = rpm / 60 / sampleRate, decay = Math.exp(-1 / (sampleRate * (0.004 + 0.004 * (1 - load))));
    const chamber = 160 + rpm * 0.07, misfire = rpm < 3000 ? 0.32 * (1 - load) + 0.05 : 0.02;
    const overrun = load < 0.08 && rpm > 2600;
    for (let n = 0; n < out.length; n++) {
      this.ph += fire;
      if (this.ph >= 1) {
        this.ph -= 1;
        if (Math.random() > misfire) { this.env = (0.55 + 0.45 * load) * (0.85 + Math.random() * 0.3); this.click = 1; }
        else if (overrun && Math.random() < 0.25) { this.env = 1.4; this.click = 1.5; }  // pop
      }
      const x = this.env * (Math.random() * 2 - 1) + this.click * 0.8;
      this.env *= decay; this.click *= 0.6;
      let y = this.bp(this.f, 0, chamber, 5, x) * 1.6       // expansion chamber ring
            + this.bp(this.f, 1, 2350, 28, x) * 0.12         // cooling-fin metallic ding
            + this.bp(this.f, 2, 95, 2.5, x) * 0.9;          // body / exhaust thump
      y = Math.tanh(y * 2.4) * 0.95;                      // hard-driven, loud (tuk-tuks are LOUD)
      this.g += (gain - this.g) * 0.002;
      out[n] = y * this.g;
    }
    return true;
  }
}
registerProcessor('two-stroke', TwoStroke);
`;

let loaded: Promise<void> | null = null;
export function loadTwoStroke(ctx: AudioContext) {
  loaded ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  return loaded;
}

export class TwoStrokeVoice {
  private node: AudioWorkletNode;
  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.node = new AudioWorkletNode(ctx, 'two-stroke');
    this.node.connect(dest);
  }
  set(rpm: number, load: number, volume: number) {
    const t = this.ctx.currentTime, P = this.node.parameters;
    P.get('rpm')!.setTargetAtTime(rpm, t, 0.04);
    P.get('load')!.setTargetAtTime(load, t, 0.05);
    P.get('gain')!.setTargetAtTime(volume, t, 0.05);
  }
  stop() { this.node.parameters.get('gain')!.setTargetAtTime(0, this.ctx.currentTime, 0.1); }
}
