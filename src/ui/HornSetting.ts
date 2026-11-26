import { store } from '../account/Store';
import type { Settings } from './Settings';

// Upload your own horn (a short audio clip, kept in the account as a data URL).
const KEY = 'cmb-rider-horn';
const MAX = 200_000; // bytes; the backend enforces the same limit

export function hornSetting(settings: Settings, apply: (clip?: ArrayBuffer) => Promise<void>) {
  const row = document.createElement('div'), file = document.createElement('input'), reset = document.createElement('button'), note = document.createElement('small');
  row.style.cssText = 'display:grid;gap:8px;margin-top:16px';
  file.type = 'file'; file.accept = 'audio/*';
  reset.textContent = 'Use stock horn'; reset.style.cssText = 'justify-self:start;cursor:pointer';
  const idle = 'Short audio clip, up to 200 KB. Hold H to honk.';
  note.textContent = idle; note.style.opacity = '.7';
  row.append('Your horn', file, reset, note);
  settings.add(row);

  const load = async (url: string) => apply(await (await fetch(url)).arrayBuffer());
  file.onchange = async () => {
    const f = file.files?.[0];
    file.blur();
    if (!f) return;
    if (f.size > MAX) { note.textContent = 'Too big: pick a clip under 200 KB.'; return; }
    const url = await new Promise<string>(done => { const r = new FileReader(); r.onload = () => done(r.result as string); r.readAsDataURL(f); });
    try { await load(url); } catch { note.textContent = "Can't play that file. Try an MP3 or WAV."; return; }
    note.textContent = `Using ${f.name}`;
    store.setItem(KEY, url);
  };
  reset.onclick = () => { reset.blur(); store.removeItem(KEY); file.value = ''; note.textContent = idle; void apply(); };

  const saved = store.getItem(KEY);
  if (saved) void load(saved).then(() => (note.textContent = 'Using your saved horn'), () => store.removeItem(KEY));
}
