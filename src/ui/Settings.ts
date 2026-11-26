// Game settings popup (⚙ button or G), saved to the account. The game pauses while it is open.
import { store, signOut, username } from '../account/Store';
const KEY = 'cmb-rider-settings';
const LABELS = {
  manual: 'Manual gearbox (E = up, Q = down)',
  police: 'Police',
  traffic: 'Traffic',
  pedestrians: 'Pedestrians',
  timeFlow: 'Time passes (day/night, rush hours)',
  rain: 'Rain (wet roads: less grip, longer braking)',
} as const;
export type SettingKey = keyof typeof LABELS;
export type SettingValues = Record<SettingKey, boolean>;

export class Settings {
  values: SettingValues = { manual: false, police: true, traffic: true, pedestrians: true, timeFlow: true, rain: false };

  private overlay = document.createElement('div');
  private extra = document.createElement('div'); // non-checkbox rows
  get isOpen() { return this.overlay.style.display !== 'none'; }

  constructor(onChange: (v: SettingValues) => void) {
    try { Object.assign(this.values, JSON.parse(store.getItem(KEY) ?? '{}')); } catch { /* defaults */ }
    const o = this.overlay;
    o.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:none;place-items:center';
    o.addEventListener('pointerdown', e => { if (e.target === o) this.toggle(false); }); // click outside closes
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Settings');
    panel.style.cssText = 'background:#1c1f24;color:#f2f2f2;border-radius:14px;padding:22px 26px;min-width:320px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:500 15px system-ui';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;font:700 19px system-ui';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close settings');
    close.style.cssText = 'background:none;border:0;color:inherit;font-size:18px;cursor:pointer';
    close.onclick = () => this.toggle(false);
    head.append('Settings', close);
    const box = document.createElement('div');
    box.style.cssText = 'display:grid;gap:12px';
    for (const k of Object.keys(LABELS) as SettingKey[]) {
      const label = document.createElement('label'), input = document.createElement('input');
      label.style.cssText = 'display:flex;gap:10px;align-items:center;cursor:pointer';
      input.style.cssText = 'width:18px;height:18px;accent-color:#f2c230';
      input.type = 'checkbox';
      input.checked = this.values[k];
      input.addEventListener('change', () => {
        this.values[k] = input.checked;
        store.setItem(KEY, JSON.stringify(this.values));
        onChange(this.values);
        input.blur(); // keep keyboard for driving
      });
      label.append(input, LABELS[k]);
      box.appendChild(label);
    }
    const hint = document.createElement('small');
    hint.style.cssText = 'display:block;margin-top:16px;opacity:.6';
    hint.textContent = 'G or Esc to close · saved automatically';
    const out = document.createElement('button');
    out.textContent = `Sign out (${username})`;
    out.style.cssText = 'display:block;margin-top:14px;cursor:pointer';
    out.onclick = () => void signOut();
    panel.append(head, box, this.extra, out, hint);
    o.appendChild(panel);
    document.body.appendChild(o);

    const btn = document.createElement('button');
    btn.textContent = '⚙';
    btn.title = 'Settings (G)';
    btn.setAttribute('aria-label', 'Settings');
    btn.style.cssText = 'position:fixed;top:12px;left:12px;z-index:20;width:40px;height:40px;border-radius:10px;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:22px;cursor:pointer';
    btn.onclick = () => { btn.blur(); this.toggle(); };
    document.body.appendChild(btn);
    onChange(this.values);
  }

  add(row: HTMLElement) { this.extra.append(row); }

  toggle(open = !this.isOpen) { this.overlay.style.display = open ? 'grid' : 'none'; }
}
