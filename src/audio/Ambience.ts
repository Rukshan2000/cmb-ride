// Colombo street ambience, all synthesised: crows by day, distant horns, temple bells, a bread van's jingle
// (original tune), crickets at night and surf near the coast.

export interface AmbienceState { night: boolean; rain: boolean; coastDist: number }

export class Ambience {
  private next = { crow: 3, horn: 5, bell: 25, bread: 45, cricket: 1 };
  private surf?: GainNode;

  constructor(private c: AudioContext, private out: AudioNode, private noise: AudioBuffer) {}

  private tone(freq: number, at: number, dur: number, vol: number, type: OscillatorType = 'sine', pan = 0, slideTo?: number, filter?: number) {
    const c = this.c, o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    p.pan.value = pan;
    let head: AudioNode = o;
    if (filter) { const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = filter; f.Q.value = 2; o.connect(f); head = f; }
    head.connect(g).connect(p).connect(this.out);
    o.start(at); o.stop(at + dur + 0.05);
  }

  update(dt: number, s: AmbienceState) {
    const c = this.c;
    if (c.state !== 'running') return;
    const t = c.currentTime + 0.05, pan = () => Math.random() * 1.6 - 0.8;
    const due = (k: keyof Ambience['next'], gap: number, spread: number) => {
      if ((this.next[k] -= dt) > 0) return false;
      this.next[k] = gap + Math.random() * spread;
      return true;
    };
    // Surf: looped noise whose swell rises and falls, louder the nearer the shore.
    if (!this.surf) {
      const src = c.createBufferSource(), f = c.createBiquadFilter(), swell = c.createGain(), lfo = c.createOscillator(), depth = c.createGain();
      src.buffer = this.noise; src.loop = true; src.playbackRate.value = 0.5; f.type = 'lowpass'; f.frequency.value = 600;
      lfo.frequency.value = 0.11; depth.gain.value = 0.6; swell.gain.value = 0.7; lfo.connect(depth).connect(swell.gain);
      this.surf = c.createGain(); this.surf.gain.value = 0;
      src.connect(f).connect(swell).connect(this.surf).connect(this.out); src.start(); lfo.start();
    }
    this.surf.gain.setTargetAtTime(0.2 * Math.max(0, 1 - s.coastDist / 250), t, 0.5);

    if (!s.night && !s.rain && due('crow', 4, 12)) { // two or three harsh caws
      const side = pan(), n = 2 + Math.floor(Math.random() * 2), base = 520 + Math.random() * 140;
      for (let i = 0; i < n; i++) this.tone(base, t + i * 0.32, 0.22, 0.09, 'sawtooth', side, base * 0.78, 1300);
    }
    if (due('horn', s.night ? 14 : 4, s.night ? 20 : 9)) { // far-off horns
      const f = 300 + Math.random() * 220, side = pan(), n = Math.random() < 0.4 ? 2 : 1;
      for (let i = 0; i < n; i++) { this.tone(f, t + i * 0.28, 0.2, 0.025, 'square', side, undefined, 700); this.tone(f * 1.26, t + i * 0.28, 0.2, 0.018, 'square', side, undefined, 800); }
    }
    if (due('bell', 40, 60)) { // temple bell: a few slow strokes with inharmonic partials
      const side = pan();
      for (let i = 0; i < 3; i++) for (const [m, v] of [[1, 0.05], [2.76, 0.025], [5.4, 0.012]]) this.tone(430 * m, t + i * 1.6, 2.6 / Math.sqrt(m), v, 'sine', side);
    }
    if (!s.night && !s.rain && due('bread', 70, 80)) { // the bread van going round
      const side = pan();
      [659, 784, 880, 784, 659, 587, 659, 523, 587, 659].forEach((f, i) => this.tone(f, t + i * 0.24, 0.3, 0.035, 'square', side, undefined, 1500));
    }
    if (s.night && !s.rain && due('cricket', 0.5, 1.2)) { const side = pan(); for (let i = 0; i < 4; i++) this.tone(4200, t + i * 0.06, 0.035, 0.012, 'sine', side); }
  }
}
