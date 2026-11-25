import type { Place } from './GeoServices';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
export const fmtTime = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);
const ARROW: Record<string, string> = { left: '↰', 'sharp left': '↰', 'slight left': '↖', right: '↱', 'sharp right': '↱', 'slight right': '↗', uturn: '⤺', straight: '↑' };

/** DOM side of navigation: search box + suggestions, destination panel, turn banner, toasts. */
export class NavigationHUD {
  readonly input = $<HTMLInputElement>('nav-q');
  private results = $('nav-results');
  private dest = $('nav-dest');
  private banner = $('nav-banner');
  private toastTimer = 0;

  onQuery: (q: string) => void = () => {};
  onPick: (p: Place) => void = () => {};
  onStart = () => {};
  onCancel = () => {};
  private places: Place[] = [];

  constructor() {
    let t = 0;
    this.input.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => this.onQuery(this.input.value), 350); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        clearTimeout(t);
        // Only auto-pick an unambiguous result; otherwise the list stays open for the player to choose.
        if (this.places.length === 1) this.onPick(this.places[0]); else this.onQuery(this.input.value);
      }
      if (e.key === 'Escape') this.input.blur();
    });
    $('nav-start').onclick = () => this.onStart();
    $('nav-cancel').onclick = () => this.onCancel();
  }

  showResults(places: Place[], message = '') {
    this.places = places;
    this.results.innerHTML = '';
    if (message) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = message; this.results.append(li); }
    for (const p of places) {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = p.name;
      const s = document.createElement('small'); s.textContent = [p.kind, p.address].filter(Boolean).join(' · ');
      li.append(b, s);
      li.onclick = () => this.onPick(p);
      this.results.append(li);
    }
  }

  showDestination(p: Place | null, route?: string, canStart = false) {
    this.dest.hidden = !p;
    if (!p) return;
    $('dest-name').textContent = p.name;
    $('dest-addr').textContent = p.address;
    $('dest-route').textContent = route ?? 'Calculating road route…';
    $<HTMLButtonElement>('nav-start').disabled = !canStart;
  }

  showBanner(on: boolean) { this.banner.hidden = !on; }

  updateBanner(text: string, modifier: string | undefined, type: string, toStep: number, remaining: number, remainingTime: number, road: string) {
    const arrow = type === 'arrive' ? '⚑' : /roundabout|rotary/.test(type) ? '⟳' : ARROW[modifier ?? 'straight'] ?? '↑';
    $('nav-arrow').textContent = arrow;
    $('nav-turn').textContent = text;
    $('nav-dist').textContent = fmtDist(toStep);
    const eta = new Date(Date.now() + remainingTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('nav-meta').textContent = `${fmtDist(remaining)} · ${fmtTime(remainingTime)} · ETA ${eta}${road ? ' · on ' + road : ''}`;
  }

  toast(msg: string, ms = 3000) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (el.hidden = true), ms);
  }
}
