import { Ambience, type AmbienceState } from './Ambience';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import type { TrafficVehicle } from '../traffic/TrafficManager';
import { EngineVoice, type EngineKind } from './EngineVoice';
import { TwoStrokeVoice, loadTwoStroke } from './TwoStrokeVoice';

type Voice = { set(rpm: number, load: number, volume: number): void; stop(): void };
export type HornKind = 'car' | 'disc' | 'bus';

const TRAFFIC_VOICES = 6;   // nearest AI vehicles get their own positional engine sound
const VOICE_FOR: Record<string, EngineKind> = { tuktuk: 'twoStroke', motorcycle: 'single', bus: 'diesel6', lorry: 'diesel6', van: 'diesel6', car: 'petrol4' };

// Game audio. Real recordings are loaded from public/sounds/<name>.mp3 when present (e.g. from pixabay.com/sound-effects);
// any missing file falls back to a WebAudio synth so the game always has sound.
// Files: engine (steady idle loop), horn, city (street ambience loop), crash, skid (loop), siren (loop).
const FILES = ['engine', 'horn', 'city', 'crash', 'skid', 'siren'] as const;
type Name = (typeof FILES)[number];

export class Sound {
  private ctx = new AudioContext();
  private master = this.ctx.createGain();
  private buf: Partial<Record<Name, AudioBuffer>> = {};
  private engine!: { set: (rpm: number, load: number, kind?: EngineKind) => void };
  private loops: Partial<Record<'city' | 'skid' | 'siren', GainNode>> = {};
  private noise: AudioBuffer;
  private hornNode: (() => void) | null = null;
  private lastImpact = 0;
  private trafficHorn = 4;
  private road!: GainNode; private wind!: GainNode; private squeal!: GainNode;
  private lastGear = 1;
  private rainLoop!: GainNode;
  raining = false;
  /** Player horn: car two-tone, bike / tuk-tuk electric disc horn, bus / van deep dual horn. */
  hornKind: HornKind = 'car';
  private twoStrokeOk = false;
  private pool: { voice: Voice; panner: PannerNode; kind: EngineKind; v?: TrafficVehicle }[] = [];

  private custom?: AudioBuffer;                         // the player's uploaded horn
  private clips = new Map<string, AudioBuffer | null>(); // other riders' uploads, by id
  private remotes = new Map<string, { stop: () => void; panner: PannerNode }>();

  constructor() {
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // Browsers only start audio after a user gesture.
    const resume = () => this.ctx.resume();
    window.addEventListener('keydown', resume); window.addEventListener('pointerdown', resume);
  }

  async init() {
    await Promise.all(FILES.map(async n => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}sounds/${n}.mp3`);
        if (r.ok && r.headers.get('content-type')?.includes('audio')) this.buf[n] = await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch { /* missing / undecodable: synth fallback */ }
    }));
    try { await loadTwoStroke(this.ctx); this.twoStrokeOk = true; } catch (e) { console.warn('2-stroke worklet unavailable:', e); }
    this.engine = this.buf.engine ? this.sampleEngine(this.buf.engine) : this.synthEngine();
    this.road = this.loop(undefined, 0, 500, 'bandpass');        // tyre roar on asphalt
    this.wind = this.loop(undefined, 0, 900);                    // wind rush
    this.rainLoop = this.loop(undefined, 0, 3200, 'highpass');    // rain on the roof / road
    const sq = this.ctx.createOscillator(); sq.frequency.value = 2900; this.squeal = this.ctx.createGain(); this.squeal.gain.value = 0;
    sq.connect(this.squeal).connect(this.master); sq.start();     // brake squeal near standstill
    // Positional engine voices for nearby traffic (two per common kind, re-assigned to the nearest vehicles).
    for (const kind of ['twoStroke', 'twoStroke', 'petrol4', 'single', 'diesel6', 'diesel6'] as EngineKind[]) {
      const panner = this.ctx.createPanner();
      Object.assign(panner, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 4, maxDistance: 80, rolloffFactor: 1.4 });
      panner.connect(this.master);
      this.pool.push({ voice: this.voice(panner, kind), panner, kind });
    }
    this.loops.city = this.loop(this.buf.city, 0, 600);
    this.loops.skid = this.loop(this.buf.skid, 0, 1800, 'bandpass');
    this.loops.siren = this.buf.siren ? this.loop(this.buf.siren, 0) : this.synthSiren();
  }

  /** Per frame. rush: 0..1 extra street ambience + other drivers' horns. */
  update(dt: number, car: VehiclePhysics, throttle: number, horn: boolean, rush: number, siren: boolean, brake = 0, traffic: TrafficVehicle[] = []) {
    if (!this.engine) return;
    const t = this.ctx.currentTime, speed = Math.hypot(car.vx, car.vz);
    this.road.gain.setTargetAtTime(Math.min(0.22, speed * (this.raining ? 0.014 : 0.009)), t, 0.1); // wet tyres hiss louder
    this.rainLoop.gain.setTargetAtTime(this.raining ? 0.18 : 0, t, 0.8);
    this.wind.gain.setTargetAtTime(Math.min(0.35, (speed / 35) ** 2 * 0.3), t, 0.2);
    this.squeal.gain.setTargetAtTime(brake && speed > 0.6 && speed < 4 ? 0.012 * (1 + Math.sin(t * 31)) : 0, t, 0.05);
    if (car.gear !== this.lastGear) { this.clunk(); this.lastGear = car.gear; }
    this.traffic(car, traffic);
    this.engine.set(car.rpm, throttle, car.cfg.engine ?? 'petrol4');
    const lateral = Math.abs(car.vx * -Math.cos(car.yaw) + car.vz * Math.sin(car.yaw));
    this.loops.skid!.gain.setTargetAtTime(lateral > 3 ? Math.min(0.5, (lateral - 3) * 0.08) : 0, t, 0.05);
    this.loops.city!.gain.setTargetAtTime(0.12 + rush * 0.18, t, 0.5);
    this.loops.siren!.gain.setTargetAtTime(siren ? 0.25 : 0, t, 0.2);
    if (horn && !this.hornNode) this.hornNode = this.horn(1, 0.5, this.hornKind, this.custom);
    if (!horn && this.hornNode) { this.hornNode(); this.hornNode = null; }
    if (car.impact > this.lastImpact + 2) this.crash(Math.min(1, car.impact / 12));
    this.lastImpact = car.impact;
    // Rush hour: impatient horns from the jam around you.
    if (rush > 0 && (this.trafficHorn -= dt) <= 0) {
      this.trafficHorn = 1.5 + Math.random() * 5 / rush;
      const r = Math.random(), kind: HornKind = r < 0.5 ? 'disc' : r < 0.8 ? 'car' : 'bus'; // tuk-tuks & bikes honk most
      const stop = this.horn(0.85 + Math.random() * 0.3, 0.06 + Math.random() * 0.08, kind);
      setTimeout(stop, 150 + Math.random() * 600);
    }
  }

  /** Use an uploaded clip as the player's horn (undefined = stock). Throws if it isn't decodable audio. */
  async setHorn(data?: ArrayBuffer) {
    this.custom = data && await this.ctx.decodeAudioData(data.slice(0));
  }

  /** Another rider's horn, positioned in the world. Call every frame with whether they're holding it. */
  remoteHorn(id: string, on: boolean, x: number, z: number, kind: HornKind, clip = '') {
    if (clip && !this.clips.has(clip)) {
      this.clips.set(clip, null);
      fetch(`/api/horn/${clip}`).then(r => (r.ok ? r.arrayBuffer() : Promise.reject())).then(b => this.ctx.decodeAudioData(b))
        .then(b => this.clips.set(clip, b)).catch(() => {}); // stock horn stays
    }
    let h = this.remotes.get(id);
    if (!on) { h?.stop(); this.remotes.delete(id); return; }
    if (!h) {
      const panner = this.ctx.createPanner();
      Object.assign(panner, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 8, maxDistance: 200 });
      panner.connect(this.master);
      this.remotes.set(id, h = { panner, stop: this.horn(1, 0.5, kind, this.clips.get(clip) ?? undefined, panner) });
    }
    h.panner.positionX.value = x; h.panner.positionY.value = 1; h.panner.positionZ.value = z;
  }

  // --- building blocks ---------------------------------------------------------------------------------

  private loop(b: AudioBuffer | undefined, gain: number, filterHz?: number, type: BiquadFilterType = 'lowpass') {
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = b ?? this.noise; src.loop = true;
    g.gain.value = gain;
    if (!b && filterHz) { const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = filterHz; src.connect(f).connect(g); }
    else src.connect(g);
    g.connect(this.master); src.start();
    return g;
  }

  /** Recorded idle loop, pitched up with rpm. */
  private sampleEngine(b: AudioBuffer) {
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = b; src.loop = true; src.connect(g).connect(this.master); src.start();
    return { set: (rpm: number, load: number) => {
      const t = this.ctx.currentTime;
      src.playbackRate.setTargetAtTime(0.7 + rpm / 3000, t, 0.05);
      g.gain.setTargetAtTime(0.25 + load * 0.35, t, 0.08);
    } };
  }

  /** Player engine: synthesized (EngineVoice); a bus gets the 6-cylinder diesel. */
  private synthEngine() {
    let voice: Voice | null = null;
    return { set: (rpm: number, load: number, kind: EngineKind = 'petrol4') => {
      voice ??= this.voice(this.master, kind);
      voice.set(rpm, load, kind === 'twoStroke' ? 1.0 : 0.5);
    } };
  }

  /** Nearest AI vehicles get an engine voice of their kind, positioned around the listener (the player car). */
  private traffic(car: VehiclePhysics, list: TrafficVehicle[]) {
    const L = this.ctx.listener, fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    if (L.positionX) { L.positionX.value = car.x; L.positionY.value = 1; L.positionZ.value = car.z; L.forwardX.value = fx; L.forwardY.value = 0; L.forwardZ.value = fz; }
    const near = list.map(v => ({ v, d: Math.hypot(v.x - car.x, v.z - car.z) })).filter(o => o.d < 70).sort((a, b) => a.d - b.d);
    for (const slot of this.pool) {
      if (slot.v && !near.some(o => o.v === slot.v)) slot.v = undefined;
      if (!slot.v) slot.v = near.find(o => VOICE_FOR[o.v.spec.category] === slot.kind && !this.pool.some(p => p.v === o.v))?.v;
      const v = slot.v;
      if (!v) { slot.voice.stop(); continue; }
      slot.panner.positionX.value = v.x; slot.panner.positionY.value = 1; slot.panner.positionZ.value = v.z;
      const idle = slot.kind === 'diesel6' ? 650 : slot.kind === 'twoStroke' ? 1400 : 900;
      const rpm = idle + v.v * (slot.kind === 'diesel6' ? 120 : slot.kind === 'twoStroke' ? 380 : 220);
      slot.voice.set(rpm, v.v > 0.5 ? 0.5 : 0.1, slot.kind === 'twoStroke' ? 1.2 : slot.kind === 'diesel6' ? 0.9 : 0.6);
    }
  }

  /** Gear change: short driveline clunk. */
  private clunk() {
    const c = this.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.15);
  }

  private synthSiren() {
    const c = this.ctx, o = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = 750; lfo.frequency.value = 0.6; depth.gain.value = 250;
    lfo.connect(depth).connect(o.frequency); g.gain.value = 0;
    const f = c.createBiquadFilter(); f.frequency.value = 2000;
    o.connect(f).connect(g).connect(this.master); o.start(); lfo.start();
    return g;
  }

  /** 2-stroke worklet for tuk-tuks (falls back to the periodic-wave voice). */
  private voice(dest: AudioNode, kind: EngineKind): Voice {
    return kind === 'twoStroke' && this.twoStrokeOk ? new TwoStrokeVoice(this.ctx, dest) : new EngineVoice(this.ctx, dest, kind, this.noise);
  }

  /**
   * Starts a horn; returns stop(). Pitch varies for other vehicles.
   *  car:  two-tone electric horns (~415 + 500 Hz)
   *  disc: the small 12 V disc horn on motorcycles / tuk-tuks: one buzzy, nasal tone (~470 Hz), diaphragm rattle
   *  bus:  deep dual horn (~280 + 350 Hz), louder, with an air-horn edge
   */
  private horn(pitch: number, gain: number, kind: HornKind = 'car', clip?: AudioBuffer, dest: AudioNode = this.master): () => void {
    const c = this.ctx, g = c.createGain(), t = c.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.connect(dest);
    const srcs: AudioScheduledSourceNode[] = [];
    const sample = clip ?? (kind === 'car' ? this.buf.horn : undefined);
    if (sample) {
      const s = c.createBufferSource(); s.buffer = sample; s.loop = true; s.playbackRate.value = pitch; s.connect(g); srcs.push(s);
    } else {
      const f = c.createBiquadFilter(), tones = kind === 'disc' ? [470] : kind === 'bus' ? [280, 350] : [415, 500];
      f.type = kind === 'disc' ? 'bandpass' : 'lowpass';
      f.frequency.value = kind === 'disc' ? 1900 : 2500; f.Q.value = kind === 'disc' ? 0.9 : 0.7;
      f.connect(g);
      for (const hz of tones) {
        const o = c.createOscillator(); o.type = kind === 'bus' ? 'sawtooth' : 'square'; o.frequency.value = hz * pitch; o.connect(f); srcs.push(o);
      }
      if (kind === 'disc') { // diaphragm rattle: fast amplitude flutter
        const lfo = c.createOscillator(), depth = c.createGain(), amp = c.createGain();
        lfo.frequency.value = 55; depth.gain.value = 0.35; amp.gain.value = 0.75;
        lfo.connect(depth).connect(amp.gain);
        f.disconnect(); f.connect(amp).connect(g); srcs.push(lfo);
      }
    }
    srcs.forEach(s => s.start());
    return () => { const e = c.currentTime; g.gain.setTargetAtTime(0, e, 0.03); srcs.forEach(s => s.stop(e + 0.2)); };
  }

  /** Thunder: a crack (close strikes) then a long lowpassed rumble; dist 0 = overhead, 1 = far away. */
  thunder(dist: number) {
    const c = this.ctx, t = c.currentTime;
    for (const [hz, peak, dur, at] of [[2200, 0.5 * (1 - dist), 0.35, 0], [160, 0.7 - dist * 0.3, 4 + dist * 3, 0.05]] as const) {
      if (peak <= 0.02) continue;
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noise; s.loop = true; s.playbackRate.value = hz > 1000 ? 1 : 0.5;
      f.type = 'lowpass'; f.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(peak, t + at + 0.08 + dist * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      s.connect(f).connect(g).connect(this.master); s.start(t + at); s.stop(t + at + dur + 0.1);
    }
  }

  /** Splash through a puddle (strength 0..1). */
  splash(strength: number) {
    const c = this.ctx, t = c.currentTime, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.7;
    g.gain.setValueAtTime(0.15 + strength * 0.45, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5 + strength * 0.4);
    s.connect(f).connect(g).connect(this.master); s.start(t); s.stop(t + 1);
  }

  /** A gust through the trees: band-passed noise swelling and dying away. */
  gust(strength: number, seconds: number) {
    const c = this.ctx, t = c.currentTime, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; s.loop = true; s.playbackRate.value = 0.6;
    f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(280, t); f.frequency.linearRampToValueAtTime(700, t + seconds / 2); f.frequency.linearRampToValueAtTime(260, t + seconds);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(strength * 0.22, t + seconds / 2); g.gain.linearRampToValueAtTime(0.0001, t + seconds);
    s.connect(f).connect(g).connect(this.master); s.start(t); s.stop(t + seconds + 0.1);
  }

  private street?: Ambience;
  ambience(dt: number, state: AmbienceState) {
    (this.street ??= new Ambience(this.ctx, this.master, this.noise)).update(dt, state);
  }

  private crash(strength: number) {
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain(), t = c.currentTime;
    s.buffer = this.buf.crash ?? this.noise;
    g.gain.setValueAtTime(0.3 + strength * 0.7, t);
    if (!this.buf.crash) { // thump + crunch: lowpassed noise with a fast decay
      const f = c.createBiquadFilter(); f.frequency.value = 400 + strength * 2500;
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + strength * 0.5);
      s.connect(f).connect(g);
    } else s.connect(g);
    g.connect(this.master); s.start(); s.stop(t + 3);
  }
}
