import type { TrafficLightSystem } from '../roads/TrafficLightSystem';
import type { TimeOfDay } from '../roads/TimeOfDay';
import type { TrafficIntelligenceService } from './TrafficIntelligenceService';
import type { TrafficManager } from './TrafficManager';
import type { Category } from './VehicleCatalog';

/** Developer panel (dev builds only, toggle with the ` key). */
export class TrafficDebugPanel {
  private el = document.createElement('div');
  private info = document.createElement('pre');

  constructor(private t: TrafficManager, private ai: TrafficIntelligenceService, signals: TrafficLightSystem, time: TimeOfDay, private player: { x: number; z: number }) {
    this.el.className = 'panel debug';
    this.el.hidden = true;
    const btn = (label: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; this.el.append(b); };
    const cats: Category[] = ['tuktuk', 'motorcycle', 'car', 'van', 'bus', 'lorry'];
    for (const c of cats) btn(`+${c}`, () => t.spawn(c, true));
    btn('density −', () => (t.target = Math.max(0, t.target - 10)));
    btn('density +', () => (t.target += 10));
    btn('breakdown', () => t.breakdown());
    btn('bus breakdown', () => t.breakdown('bus'));
    btn('next signal phase', () => signals.skip());
    btn('time/weather', () => time.cycle());
    btn('Groq on/off', () => (ai.enabled = !ai.enabled));
    btn('ask Groq now', () => ai.request());
    this.el.append(this.info);
    document.body.append(this.el);
    window.addEventListener('keydown', e => { if (e.code === 'Backquote' && !(e.target instanceof HTMLInputElement)) this.el.hidden = !this.el.hidden; });
  }

  update() {
    if (this.el.hidden) return;
    const t = this.t, P = this.player, ai = this.ai;
    const near = [...t.vehicles].sort((a, b) => Math.hypot(a.x - P.x, a.z - P.z) - Math.hypot(b.x - P.x, b.z - P.z))[0];
    const inc = t.incidents.map(v => `  ${v.spec.id} @ ${Math.round(Math.hypot(v.x - P.x, v.z - P.z))} m, ${Math.round(v.broken)} s left`).join('\n');
    this.info.textContent =
      `vehicles ${t.vehicles.length}/${Math.round(t.target * t.densityScale)}  avg ${Math.round(t.avgSpeed() * 3.6)} km/h\n` +
      `counts ${JSON.stringify(t.counts())}\n` +
      (near ? `nearest: ${near.spec.label} (${near.profile}) ${Math.round(near.v * 3.6)} km/h on ${near.road.n || 'unnamed'}, lane ${near.lane.toFixed(1)} m left\n` : '') +
      `incidents ${t.incidents.length}\n${inc}\n` +
      `last collision: ${t.lastCollision || '—'}\n` +
      `perf: ${t.perf || 'no slow frames'}\n` +
      `Groq: ${ai.enabled ? ai.status : 'disabled'}\n` +
      (ai.last ? `AI: ${ai.last.trafficCondition} ×${ai.last.densityMultiplier} incident=${ai.last.incident.type}\n  "${ai.last.description}"` : '');
  }
}
