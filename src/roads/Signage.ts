import * as pc from 'playcanvas';
import { GeometryBuffer } from '../map/MeshUtil';
import type { ChunkData, MapIndex } from '../map/MapTypes';
import { isElevated } from '../map/RoadNetwork';
import { nightLight } from './NightLights';
import { rankOf } from './RoadMarkingGenerator';
import { occupancy, roadMask } from './RoadsideEnvironment';
import { box } from './StreetFurniture';

// Green direction boards (real place names from the map), advertising hoardings, animated LED screens and wall
// posters. Every advertiser is invented; swap the lists for licensed artwork if you have it.

type Place = MapIndex['places'][number];
/** [x, z, ux, uz (along wall), side] of each garden wall panel, collected by buildRoadside. */
export type WallPanel = [number, number, number, number, number];

const ADS: [string, string, string, string][] = [ // headline, line, background, text
  ['සිංහ තේ', 'LION PEAK CEYLON TEA', '#6b1f14', '#ffd873'], ['ISLAND MOBILE', 'වේගවත් 5G • Rs 999', '#0d3b8c', '#ffffff'],
  ['කිරි සුවඳ', 'Golden Meadow Milk Powder', '#f4d23a', '#1a2a6a'], ['SERENDIB BANK', 'உங்கள் வீட்டுக் கனவு • Home Loans', '#0c5a44', '#ffffff'],
  ['SUNRISE PAINTS', 'වර්ණවත් නිවසක්', '#e8521e', '#ffffff'], ['PEARL AIR', 'Colombo ✈ Singapore', '#1a8fb8', '#ffffff'],
  ['රස රස', 'Rasa Rasa Biscuits', '#b8142e', '#ffe9a0'], ['LANKA SOLAR', 'சூரிய சக்தி • Switch today', '#14202e', '#ffd21e'],
];
const POSTERS: [string, string, string, string][] = [
  ['A/L PHYSICS', '2027 අලුත් පන්තිය', '#f2e63a', '#111'], ['සංගීත සන්ධ්‍යාව', 'LIVE • Saturday 7pm', '#1a1030', '#ff4fa0'],
  ['SPOKEN ENGLISH', 'මාස 3කින්', '#ffffff', '#c01c1c'], ['ICT CLASS', 'Grade 6 – 11', '#1f6ad0', '#ffffff'],
  ['අවුරුදු උළෙල', 'Avurudu Festival', '#f08a1a', '#3a1000'], ['ROOMS FOR RENT', 'කාමර කුලියට', '#e8f4e0', '#0f4a1a'],
  ['JOB VACANCIES', 'Drivers • Riders', '#d8202a', '#ffffff'], ['BLOOD CAMP', 'ලේ දන් දෙන්න', '#ffffff', '#b00018'],
];

function canvasMaterial(device: pc.GraphicsDevice, c: HTMLCanvasElement, glow: number) {
  const tex = new pc.Texture(device, { width: c.width, height: c.height, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, anisotropy: 8, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
  tex.setSource(c);
  const m = new pc.StandardMaterial();
  m.diffuseMap = tex; m.emissiveMap = tex; m.emissive = new pc.Color(1, 1, 1); m.gloss = 0.25; m.cull = pc.CULLFACE_NONE;
  nightLight(m, glow);
  return { m, tex };
}

function atlas(w: number, h: number, cols: number, cw: number, ch: number, items: [string, string, string, string][], big: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  items.forEach(([head, line, bg, fg], k) => {
    const x = (k % cols) * cw, y = Math.floor(k / cols) * ch;
    g.fillStyle = bg; g.fillRect(x, y, cw, ch);
    g.fillStyle = fg;
    g.globalAlpha = 0.14; g.beginPath(); g.arc(x + cw * 0.82, y + ch * 0.2, Math.min(cw, ch) * 0.45, 0, 7); g.fill(); g.globalAlpha = 1;
    g.font = `900 ${big}px system-ui, sans-serif`; g.fillText(head, x + cw / 2, y + ch * 0.4, cw * 0.9);
    g.font = `700 ${Math.round(big * 0.5)}px system-ui, sans-serif`; g.fillText(line, x + cw / 2, y + ch * 0.7, cw * 0.9);
    g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(x + 8, y + 8, cw - 16, ch - 16);
  });
  return c;
}

/** Upright textured quad facing (nx,nz), uv = [u0, vBottom, u1, vTop] (canvas textures: v = 0 is the top). */
function panel(g: GeometryBuffer, x: number, z: number, nx: number, nz: number, w: number, y0: number, y1: number, uv: number[]) {
  const rx = nz * w / 2, rz = -nx * w / 2, v = g.vertexCount; // viewer's right
  g.vertex(x - rx, y0, z - rz, nx, 0, nz, 0xffffff); g.vertex(x + rx, y0, z + rz, nx, 0, nz, 0xffffff);
  g.vertex(x + rx, y1, z + rz, nx, 0, nz, 0xffffff); g.vertex(x - rx, y1, z - rz, nx, 0, nz, 0xffffff);
  g.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
  g.quad(v);
}
const cell = (k: number, cols: number, rows: number) => {
  const c = k % cols, r = Math.floor(k / cols) % rows;
  return [c / cols + 0.002, (r + 1) / rows - 0.002, (c + 1) / cols - 0.002, r / rows + 0.002];
};

export class Signage {
  private ads: pc.StandardMaterial;
  private posters: pc.StandardMaterial;
  private led: { m: pc.StandardMaterial; tex: pc.Texture };
  private ledCanvas = document.createElement('canvas');
  private boards = new Map<string, pc.StandardMaterial>();
  private t = 0;
  private slide = 0;

  constructor(private device: pc.GraphicsDevice, private places: Place[]) {
    this.ads = canvasMaterial(device, atlas(1024, 1024, 2, 512, 256, ADS, 62), 0.8).m;
    this.posters = canvasMaterial(device, atlas(1024, 1024, 4, 256, 512, POSTERS, 40), 0.15).m;
    this.ledCanvas.width = 512; this.ledCanvas.height = 256;
    this.draw();
    this.led = canvasMaterial(device, this.ledCanvas, 1);
    this.led.m.diffuse = new pc.Color(0, 0, 0);
    this.led.m.update();
  }

  /** LED screen content: rotating adverts with a clock ticker. */
  private draw() {
    const g = this.ledCanvas.getContext('2d')!, [head, line, bg, fg] = ADS[this.slide % ADS.length];
    g.fillStyle = bg; g.fillRect(0, 0, 512, 256);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 66px system-ui, sans-serif'; g.fillText(head, 256, 80, 480);
    g.font = '700 34px system-ui, sans-serif'; g.fillText(line, 256, 150, 480);
    g.fillStyle = '#000'; g.fillRect(0, 200, 512, 56);
    g.fillStyle = '#ffb000'; g.font = 'bold 30px monospace';
    g.fillText(`COLOMBO ${new Date().toTimeString().slice(0, 5)}  •  ආයුබෝවන්  •  வணக்கம்`, 256, 229, 496);
    g.fillStyle = 'rgba(0,0,0,0.28)'; for (let y = 0; y < 200; y += 4) g.fillRect(0, y, 512, 1); // LED rows
  }

  /** Next advert every few seconds. LED screens glow day and night. */
  update(dt: number) {
    if ((this.t += dt) < 4) return;
    this.t = 0; this.slide++;
    this.draw();
    this.led.tex.setSource(this.ledCanvas);
    this.led.m.emissiveIntensity = Math.max(this.led.m.emissiveIntensity, 0.9);
    this.led.m.update();
  }

  /** Green destination board for traffic heading (ux,uz) from (x,z); null if no known place lies ahead. */
  private board(x: number, z: number, ux: number, uz: number) {
    const ahead = this.places.map(p => ({ n: p.name, d: Math.hypot(p.x - x, p.z - z), dot: 0, side: 0, p }))
      .filter(a => a.d > 250 && a.d < 4000)
      .map(a => ({ ...a, dot: ((a.p.x - x) * ux + (a.p.z - z) * uz) / a.d, side: ((a.p.x - x) * -uz + (a.p.z - z) * ux) / a.d }))
      .filter(a => a.dot > 0.5).sort((a, b) => a.d - b.d).slice(0, 3);
    if (!ahead.length) return null;
    const rows = ahead.map(a => [a.side > 0.4 ? '↱' : a.side < -0.4 ? '↰' : '↑', a.n, `${(a.d / 1000).toFixed(1)} km`]);
    const key = rows.join('|');
    let m = this.boards.get(key);
    if (!m) {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = '#0b6b3a'; g.fillRect(0, 0, 512, 256);
      g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(10, 10, 492, 236);
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.font = 'bold 40px system-ui, sans-serif';
      rows.forEach(([arrow, name, km], i) => {
        const y = 56 + i * 72;
        g.textAlign = 'left'; g.fillText(arrow, 28, y); g.fillText(name, 80, y, 300);
        g.textAlign = 'right'; g.fillText(km, 484, y);
      });
      this.boards.set(key, (m = canvasMaterial(this.device, c, 0.35).m));
    }
    return m;
  }

  /** All signage for one chunk. posts gets collision squares. */
  build(c: ChunkData, around: ChunkData, solid: GeometryBuffer, walls: WallPanel[], posts: number[]): pc.Entity | undefined {
    const inBuilding = occupancy(around), onRoad = roadMask(around);
    const ads = new GeometryBuffer(), led = new GeometryBuffer(), posters = new GeometryBuffer();
    const instances: pc.MeshInstance[] = [];
    const add = (g: GeometryBuffer, m: pc.Material) => { const mesh = g.toMesh(this.device, true); if (mesh) instances.push(new pc.MeshInstance(mesh, m)); };
    const free = (x: number, z: number, ux: number, uz: number, half: number) =>
      [-half, 0, half].every(d => !onRoad(x - uz * d, z + ux * d, 0.4) && !inBuilding(x - uz * d, z + ux * d, 0.4))
      && !posts.some((v, i) => i % 3 === 0 && Math.abs(v - x) < 2.5 && Math.abs(posts[i + 1] - z) < 2.5);

    for (const r of c.roads) {
      if (rankOf(r) < 1 || isElevated(r)) continue;
      let acc = (r.id % 97) * 3, k = r.id % 7;
      for (let i = 0; i < r.p.length - 2; i += 2) {
        const dx = r.p[i + 2] - r.p[i], dz = r.p[i + 3] - r.p[i + 1], len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        const ux = dx / len, uz = dz / len;
        for (let t = 90 - (acc % 90); t < len; t += 90) {
          k++;
          const flip = !r.o && k % 4 >= 2 ? -1 : 1, fx = ux * flip, fz = uz * flip; // travel direction it serves
          const off = r.w / 2 + 2.4, x = r.p[i] + ux * t + fz * off, z = r.p[i + 1] + uz * t - fx * off; // left kerb
          const direction = k % 3 === 0, half = direction ? 1.7 : 2.2;
          if (!free(x, z, fx, fz, half)) continue;
          const board = direction ? this.board(x, z, fx, fz) : null;
          if (direction && !board) continue;
          const w = half * 2 - 0.2, y0 = 3.2, y1 = y0 + (direction ? 1.7 : 2.2);
          for (const s of [-w / 2 + 0.25, w / 2 - 0.25]) { box(solid, x - fz * s, 0, z + fx * s, fx, fz, 0.14, y0 + 0.1, 0.14, 0x6a6e72); posts.push(x - fz * s, z + fx * s, 0.1); }
          box(solid, x + fx * 0.06, y0 - 0.06, z + fz * 0.06, fx, fz, w + 0.12, y1 - y0 + 0.12, 0.08, 0x2c2f33);
          if (board) {
            const g = new GeometryBuffer();
            panel(g, x, z, -fx, -fz, w, y0, y1, [0, 1, 1, 0]);
            add(g, board);
          } else if (k % 5 === 1) panel(led, x, z, -fx, -fz, w, y0, y1, [0, 1, 1, 0]);
          else panel(ads, x, z, -fx, -fz, w, y0, y1, cell(k, 2, 4));
        }
        acc += len;
      }
    }
    // Posters pasted on some garden walls, often two or three side by side.
    walls.forEach(([x, z, ux, uz, side], n) => {
      if ((n * 7) % 5 !== 0) return;
      const nx = -uz * side, nz = ux * side; // towards the road
      const count = 1 + (n % 3), kind = n % 8;
      for (let i = 0; i < count; i++) {
        const d = (i - (count - 1) / 2) * 0.72;
        panel(posters, x + ux * d + nx * 0.11, z + uz * d + nz * 0.11, nx, nz, 0.66, 0.35, 1.25, cell((kind + (i % 2)) % 8, 4, 2));
      }
    });
    add(ads, this.ads); add(led, this.led.m); add(posters, this.posters);
    if (!instances.length) return;
    const e = new pc.Entity('signage');
    e.addComponent('render', { meshInstances: instances, castShadows: false });
    return e;
  }
}
