const $ = (id: string) => document.getElementById(id)!;

export class HUD {
  private speed = $('speed');
  private gear = $('gear');
  private rpm = $('rpm');
  private street = $('street');
  private cam = $('cam');

  show() { $('hud').hidden = false; $('loading').hidden = true; }
  setLoading(fraction: number) { $('load-bar').style.width = `${Math.round(fraction * 100)}%`; }
  setPaused(p: boolean) { $('pause').hidden = !p; }
  setTime(t: string) { $('cam').dataset.time = t; this.cam.textContent = t.toUpperCase(); }

  update(kmh: number, gear: string, rpm: number, redline: number, street: string, cam: string) {
    this.speed.textContent = String(Math.round(kmh));
    this.gear.textContent = gear;
    this.rpm.style.width = `${Math.min(100, (rpm / redline) * 100)}%`;
    if (this.street.textContent !== street) this.street.textContent = street;
    this.cam.textContent = cam;
  }
}
