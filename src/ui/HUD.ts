const $ = (id: string) => document.getElementById(id)!;

export class HUD {
  private speed = $('speed');
  private tacho = ($('tacho') as HTMLCanvasElement).getContext('2d')!;
  private hint = $('shift-hint');
  private blink = 0;
  private street = $('street');
  private cam = $('cam');

  show() { $('hud').hidden = false; $('loading').hidden = true; }
  setLoading(fraction: number) { $('load-bar').style.width = `${Math.round(fraction * 100)}%`; }
  setPaused(p: boolean) { $('pause').hidden = !p; }
  setTime(t: string) { $('cam').dataset.time = t; this.cam.textContent = t.toUpperCase(); }

  /** shift: 1 = change up now, -1 = change down, 0 = fine (manual gearbox only). */
  update(kmh: number, gear: string, rpm: number, redline: number, street: string, cam: string, shift = 0) {
    this.speed.textContent = String(Math.round(kmh));
    this.blink++;
    this.drawTacho(gear, rpm, redline, shift);
    const msg = shift > 0 ? '▲ SHIFT UP — press E' : shift < 0 ? '▼ SHIFT DOWN — press Q' : '';
    if (this.hint.textContent !== msg) this.hint.textContent = msg;
    this.hint.style.cssText = `text-align:center;font:800 14px system-ui;letter-spacing:.05em;min-height:18px;color:${shift > 0 ? '#ff5a4a' : '#5ab0ff'};opacity:${shift && this.blink % 30 < 18 ? 1 : shift ? 0.35 : 0}`;
    if (this.street.textContent !== street) this.street.textContent = street;
    this.cam.textContent = cam;
  }

  /** Analogue rev counter: 0..redline+ over a 240° arc, red zone, needle, big gear in the middle, shift light. */
  private drawTacho(gear: string, rpm: number, redline: number, shift: number) {
    const g = this.tacho, W = 180, H = 150, cx = W / 2, cy = 88, R = 66;
    const max = Math.ceil((redline * 1.1) / 1000) * 1000, a0 = Math.PI * 0.75, span = Math.PI * 1.5;
    const ang = (r: number) => a0 + (Math.min(r, max) / max) * span;
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round';
    g.lineWidth = 9; g.strokeStyle = 'rgba(255,255,255,.15)';
    g.beginPath(); g.arc(cx, cy, R, a0, a0 + span); g.stroke();
    g.strokeStyle = '#d83a2e';
    g.beginPath(); g.arc(cx, cy, R, ang(redline * 0.92), a0 + span); g.stroke();       // red zone
    g.strokeStyle = rpm > redline * 0.92 ? '#ff5a4a' : '#f2c230';
    g.beginPath(); g.arc(cx, cy, R, a0, ang(rpm)); g.stroke();                          // filled to current rpm
    g.fillStyle = 'rgba(255,255,255,.75)'; g.font = '600 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 0; k <= max; k += 1000) {                                              // ×1000 labels
      const a = ang(k); g.fillText(String(k / 1000), cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18));
    }
    const a = ang(rpm);                                                                 // needle
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke();
    g.fillStyle = shift > 0 && this.blink % 20 < 10 ? '#ff5a4a' : '#20242a';             // hub doubles as shift light
    g.beginPath(); g.arc(cx, cy, 24, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = '800 26px system-ui'; g.fillText(gear, cx, cy + 1);
    g.font = '600 10px system-ui'; g.fillStyle = 'rgba(255,255,255,.7)';
    g.fillText(`${Math.round(rpm).toLocaleString()} rpm`, cx, cy + 48);
  }
}
