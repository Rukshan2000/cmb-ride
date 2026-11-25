// Physically-inspired engine synthesis (no samples needed).
//
// An engine's sound is periodic over one full combustion cycle (720° crank for a 4-stroke). Its spectrum has strong
// peaks at the firing order (4 per cycle for a 4-cylinder, 6 for a 6-cylinder diesel) plus weaker "uneven" orders
// from cylinder-to-cylinder differences, which is what makes a real engine sound rough instead of like a buzzer.
// We build that spectrum as a PeriodicWave at the cycle frequency, add combustion noise amplitude-modulated at the
// firing rate, and shape it with an exhaust resonance + a load-dependent lowpass (open throttle = brighter, harder).

export type EngineKind = 'petrol4' | 'diesel6' | 'twoStroke' | 'single';

const KINDS: Record<EngineKind, { fires: number; strokes: 2 | 4; orders: number[]; noise: number; resHz: number; bright: number }> = {
  // [kind]: firing events per cycle, cycle type, harmonic amplitudes (index = order of the cycle frequency)
  petrol4:   { fires: 4, strokes: 4, orders: rough([0, .08, .22, .1, 1, .12, .3, .1, .55, .08, .2, .06, .3, .05, .1, .04, .15], 1), noise: .18, resHz: 160, bright: 1 },
  diesel6:   { fires: 6, strokes: 4, orders: rough([0, .1, .15, .3, .2, .1, 1, .2, .3, .25, .15, .1, .6, .1, .2, .1, .1, .1, .35], 2), noise: .45, resHz: 110, bright: .6 },
  twoStroke: { fires: 1, strokes: 2, orders: rough([0, 1, .75, .6, .5, .42, .36, .3, .26, .22, .2, .18, .16, .14, .12, .1], 3), noise: .5, resHz: 260, bright: 1.6 },
  single:    { fires: 1, strokes: 4, orders: rough([0, .55, 1, .5, .45, .3, .25, .2, .18, .14, .12, .1, .08], 4), noise: .3, resHz: 200, bright: 1.2 },
};

/** Deterministic ±25% jitter on the harmonic amplitudes so each engine kind has its own uneven character. */
function rough(a: number[], seed: number) { return a.map((v, i) => v * (0.75 + 0.5 * ((Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1)); }

export class EngineVoice {
  private osc: OscillatorNode;
  private am: OscillatorNode;
  private body: BiquadFilterNode;
  private exhaust: BiquadFilterNode;
  private out: GainNode;
  private noiseGain: GainNode;
  private k: (typeof KINDS)[EngineKind];

  constructor(private ctx: AudioContext, dest: AudioNode, kind: EngineKind, noise: AudioBuffer) {
    const k = (this.k = KINDS[kind]);
    const n = k.orders.length, real = new Float32Array(n), imag = new Float32Array(n);
    k.orders.forEach((a, i) => { imag[i] = a; });
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));

    // Combustion noise: band-passed noise whose loudness pulses with every firing event.
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 900 * k.bright; nb.Q.value = 0.7;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    const pulse = ctx.createGain(); pulse.gain.value = 0.5;
    this.am = ctx.createOscillator(); this.am.type = 'sawtooth';
    this.am.connect(pulse.gain);
    src.connect(nb).connect(pulse).connect(this.noiseGain);

    // Exhaust: resonance (pipe) + lowpass that opens with load and rpm.
    this.exhaust = ctx.createBiquadFilter(); this.exhaust.type = 'peaking'; this.exhaust.frequency.value = k.resHz; this.exhaust.Q.value = 2; this.exhaust.gain.value = 9;
    this.body = ctx.createBiquadFilter(); this.body.type = 'lowpass'; this.body.Q.value = 1.2;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.osc.connect(this.exhaust);
    this.noiseGain.connect(this.exhaust);
    this.exhaust.connect(this.body).connect(this.out).connect(dest);
    this.osc.start(); this.am.start(); src.start();
  }

  /** rpm, load 0..1 (throttle), volume 0..1. */
  set(rpm: number, load: number, volume: number) {
    const t = this.ctx.currentTime, k = this.k;
    const cycle = rpm / 60 / (k.strokes === 4 ? 2 : 1);          // full combustion cycles per second
    this.osc.frequency.setTargetAtTime(cycle, t, 0.03);
    this.am.frequency.setTargetAtTime(cycle * k.fires, t, 0.03);
    // Lift-off (overrun) sounds muffled and burbly; open throttle is brighter and louder.
    this.body.frequency.setTargetAtTime((350 + rpm * 0.35 + load * 1800) * k.bright, t, 0.05);
    this.noiseGain.gain.setTargetAtTime(k.noise * (0.35 + load * 0.9), t, 0.05);
    this.out.gain.setTargetAtTime(volume * (0.55 + load * 0.45) * (0.7 + Math.min(rpm / 6000, 1) * 0.5), t, 0.06);
  }

  stop() { this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); }
}
