import type * as pc from 'playcanvas';
import { project } from '../map/MapProjection';
import type { CameraController } from '../camera/CameraController';
import type { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { GameConfig } from './GameConfig';

// Reference comparison for route reconstruction (?compare=route1):
//   ] / [   next / previous reference: car placed at the photo's position and heading, driver's view
//   O       toggle photo overlay (full-screen, 50% opacity) vs. side panel
//   K       save a screenshot of the simulator view (named <section>_<distance>.png) for side-by-side review
//   1 / 2 / 3   mark this reference: match / partial / mismatch (copied to the console as JSON to paste into route1.json)
interface Ref { section: string; routeDistance: number; path: string; lat: number; lon: number; heading: number; captured: string | null; author: string; license: string; url: string; comparison: string | null }

export class RouteCompare {
  private refs: Ref[] = [];
  private i = -1;
  private el = document.createElement('div');
  private img = document.createElement('img');
  private cap = document.createElement('div');
  private overlay = false;
  private wantShot = false;
  private marks: Record<string, string> = JSON.parse(localStorage.getItem('route1-marks') ?? '{}');

  constructor(private app: pc.AppBase, private car: VehiclePhysics, private cam: CameraController, private canvas: HTMLCanvasElement) {
    this.el.className = 'panel refcompare';
    this.el.append(this.img, this.cap);
    document.body.append(this.el);
    app.on('frameend', () => this.shot());
  }

  async init(id: string) {
    const db = await (await fetch(`${GameConfig.dataUrl}/colombo/${id}.json`)).json();
    this.refs = db.references;
    this.cap.textContent = `${this.refs.length} references · ] next  [ prev  O overlay  K screenshot  1 match 2 partial 3 mismatch`;
  }

  key(code: string) {
    if (!this.refs.length) return;
    if (code === 'BracketRight' || code === 'BracketLeft') {
      this.i = (this.i + (code === 'BracketRight' ? 1 : -1) + this.refs.length) % this.refs.length;
      this.show();
    }
    if (code === 'KeyO') { this.overlay = !this.overlay; this.el.classList.toggle('overlay-mode', this.overlay); }
    if (code === 'KeyK') this.wantShot = true;
    const mark = { Digit1: 'match', Digit2: 'partial', Digit3: 'mismatch' }[code];
    if (mark && this.i >= 0) {
      this.marks[this.refs[this.i].path] = mark;
      localStorage.setItem('route1-marks', JSON.stringify(this.marks));
      console.log('route1 comparison marks (paste into references[].comparison):', JSON.stringify(this.marks));
      this.show();
    }
  }

  private show() {
    const r = this.refs[this.i];
    const [x, z] = project(r.lat, r.lon);
    this.car.reset(x, z, -(r.heading * Math.PI) / 180);
    if (this.cam.mode !== 'HOOD') this.cam.mode = 'HOOD'; // camera at driver height, looking along the photo bearing
    this.img.src = `${GameConfig.dataUrl}/${r.path}`;
    this.cap.innerHTML = '';
    const t = document.createElement('div');
    t.textContent = `${this.i + 1}/${this.refs.length} · ${r.section} · ${r.routeDistance} m · heading ${r.heading}° · ${r.captured ?? ''} · ${r.license}, ${r.author} · mark: ${this.marks[r.path] ?? r.comparison ?? '—'}`;
    const a = document.createElement('a'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'source';
    this.cap.append(t, a);
  }

  private shot() {
    if (!this.wantShot) return;
    this.wantShot = false;
    const r = this.refs[this.i];
    this.canvas.toBlob(b => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = r ? `${r.section}_${String(r.routeDistance).padStart(5, '0')}_sim.png` : 'sim.png';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
}
