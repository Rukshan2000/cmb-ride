import type { TrafficManager } from './TrafficManager';
import type { Category } from './VehicleCatalog';

// Periodic, high-level traffic planning via the backend (/api/traffic-scenario -> Groq).
// The browser never sees the key. Output is re-validated here and only nudges local AI knobs;
// the simulation enforces physics, signals and safety itself. Any failure => keep local AI.

export interface Scenario {
  trafficCondition: string; densityMultiplier: number; description: string;
  incident: { type: string; durationSeconds: number; vehicleType: string };
  trafficResponse: { reduceSpeed: boolean; increaseFollowingDistance: boolean; allowSafePassing: boolean };
}

const INTERVAL = 60; // s between snapshots
const CATS: Category[] = ['tuktuk', 'motorcycle', 'car', 'van', 'bus', 'lorry'];

export class TrafficIntelligenceService {
  enabled = true;
  last: Scenario | null = null;
  status = 'waiting';
  private timer = 10;
  private busy = false;
  private responseLeft = 0;

  constructor(private traffic: TrafficManager, private context: () => { road: string; timeOfDay: string; signal: string }, private onEvent: (msg: string) => void) {}

  update(dt: number) {
    if (this.responseLeft > 0 && (this.responseLeft -= dt) <= 0) { this.traffic.speedScale = 1; this.traffic.headwayScale = 1; }
    if (!this.enabled || this.busy || (this.timer -= dt) > 0) return;
    this.timer = INTERVAL;
    this.request();
  }

  async request() {
    this.busy = true;
    const t = this.traffic, ctx = this.context();
    const snapshot = {
      road: ctx.road, timeOfDay: ctx.timeOfDay, weather: ctx.timeOfDay === 'overcast' ? 'overcast' : 'clear', signal: ctx.signal,
      vehicles: t.counts(), incidents: t.incidents.length, avgSpeedKmh: Math.round(t.avgSpeed() * 3.6),
    };
    try {
      const res = await fetch('/api/traffic-scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = sanitize(await res.json());
      if (!s) throw new Error('invalid scenario');
      this.apply(s);
      this.last = s;
      this.status = 'ok ' + new Date().toLocaleTimeString();
    } catch (e) {
      this.status = `offline (${(e as Error).message}) — local AI only`;
    } finally {
      this.busy = false;
    }
  }

  private apply(s: Scenario) {
    const t = this.traffic;
    t.densityScale = s.densityMultiplier;
    if (s.trafficResponse.reduceSpeed) t.speedScale = 0.85;
    if (s.trafficResponse.increaseFollowingDistance) t.headwayScale = 1.3;
    this.responseLeft = INTERVAL;
    if (s.incident.type !== 'none' && t.incidents.length < 2) {
      // Collisions are never scripted; AI-requested 'minor_collision' becomes a vehicle left disabled at the roadside.
      const cat = s.incident.type === 'bus_breakdown' ? 'bus' : (CATS.includes(s.incident.vehicleType as Category) ? s.incident.vehicleType as Category : undefined);
      const v = t.breakdown(cat, s.incident.durationSeconds) ?? t.breakdown(undefined, s.incident.durationSeconds);
      if (v) this.onEvent(s.description || `${v.spec.label} broken down ahead`);
    }
  }
}

/** Second validation layer (backend already validates): clamp everything we act on. */
function sanitize(o: any): Scenario | null {
  if (!o || typeof o !== 'object' || !o.incident || !o.trafficResponse) return null;
  const n = Number(o.densityMultiplier);
  return {
    trafficCondition: String(o.trafficCondition ?? 'moderate').slice(0, 16),
    densityMultiplier: Number.isFinite(n) ? Math.max(0.3, Math.min(1.5, n)) : 1,
    description: String(o.description ?? '').slice(0, 200),
    incident: { type: String(o.incident.type ?? 'none'), durationSeconds: Math.max(20, Math.min(180, Number(o.incident.durationSeconds) || 45)), vehicleType: String(o.incident.vehicleType ?? '') },
    trafficResponse: { reduceSpeed: !!o.trafficResponse.reduceSpeed, increaseFollowingDistance: !!o.trafficResponse.increaseFollowingDistance, allowSafePassing: o.trafficResponse.allowSafePassing !== false },
  };
}
