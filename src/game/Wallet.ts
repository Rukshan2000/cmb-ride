// Player progress, kept in this browser while playing and written to the account database on Save: money (starts at Rs 30,000), taxi trips, fines, last position.
import { store, username } from '../account/Store';
const KEY = 'cmb-rider-save';
export const START_MONEY = 30000;

export interface SaveData {
  money: number; trips: number; fines: number; finesTotal: number;
  clock: number;               // game time, minutes since midnight
  pos?: { x: number; z: number; yaw: number };
  savedAt?: number;            // ms; the newer of the browser and database copies wins on load
}

export class Wallet {
  data: SaveData;
  private el = document.createElement('div');
  private localKey = `cmbdraft:${username}`; // per account; not a 'cmb-rider-' key, which sign-up adopts

  constructor() {
    let saved: Partial<SaveData> = {};
    for (const text of [store.getItem(KEY), localStorage.getItem(this.localKey)]) {
      try {
        const copy = JSON.parse(text ?? 'null') as Partial<SaveData> | null;
        if (copy && (copy.savedAt ?? 0) >= (saved.savedAt ?? 0)) saved = copy;
      } catch { /* corrupt copy: use the other */ }
    }
    this.data = { money: START_MONEY, trips: 0, fines: 0, finesTotal: 0, clock: 7 * 60, ...saved };
    if (!Number.isFinite(this.data.money)) this.data.money = START_MONEY;
    Object.assign(this.el.style, { position: 'fixed', top: '12px', right: '12px', padding: '6px 12px', borderRadius: '8px',
      background: 'rgba(0,0,0,.6)', color: '#fff', font: '600 15px system-ui', zIndex: '20' });
    document.body.appendChild(this.el);
    this.render();
  }

  pay(amount: number, _why: string) {
    this.data.money = Math.round(this.data.money + amount);
    this.save();
  }

  fine(amount: number) {
    this.data.fines++;
    this.data.finesTotal += amount;
    this.pay(-amount, 'Traffic fine');
  }

  /** Advance the game clock (1 real second = 1 game minute → a day lasts 24 min). Re-renders once per game minute. */
  tick(dt: number) {
    const before = Math.floor(this.data.clock);
    this.data.clock = (this.data.clock + dt) % 1440;
    if (Math.floor(this.data.clock) !== before) this.render();
  }

  savePosition(x: number, z: number, yaw: number) { this.data.pos = { x, z, yaw }; this.save(); }

  /** Browser only: cheap, happens while playing. */
  save() {
    this.data.savedAt = Date.now();
    localStorage.setItem(this.localKey, JSON.stringify(this.data));
    this.render();
  }

  /** The Save button: write to the account database. */
  commit() {
    this.save();
    store.setItem(KEY, JSON.stringify(this.data));
  }

  private render() {
    const m = this.data.money;
    const c = Math.floor(this.data.clock), hh = String(Math.floor(c / 60)).padStart(2, '0'), mm = String(c % 60).padStart(2, '0');
    this.el.textContent = `🕒 ${hh}:${mm}${isRush(this.data.clock) ? ' 🚦 RUSH' : ''} · Rs ${m.toLocaleString()}${this.data.fines ? ` · ${this.data.fines} fines` : ''}`;
    this.el.style.color = m < 0 ? '#ff7070' : '#fff';
  }
}

/** Colombo peak hours: 07:00–09:30 and 16:30–19:00. */
export function isRush(min: number) { const h = min / 60; return (h >= 7 && h < 9.5) || (h >= 16.5 && h < 19); }

/** Lighting preset for the hour. */
export function lightFor(min: number): 'night' | 'sunset' | 'day' {
  const h = min / 60;
  return h < 5.5 || h >= 19.25 ? 'night' : h < 6.75 || h >= 17.75 ? 'sunset' : 'day';
}
