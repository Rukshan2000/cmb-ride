import type { RoadNetwork } from '../map/RoadNetwork';

const RANGE = 350; // metres from centre to edge

/** Heading-up 2D mini-map of loaded roads around the car. */
export class MiniMap {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(roads: RoadNetwork, x: number, z: number, yaw: number, friends: { x: number; z: number; color: string; name: string }[] = [], spots: { x: number; z: number }[] = []) {
    const { ctx, canvas } = this;
    const s = canvas.width / 2 / RANGE;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#16191d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Rotate so the car's forward (-Z rotated by yaw) points up the screen.
    ctx.setTransform(s, 0, 0, s, canvas.width / 2, canvas.height / 2 + canvas.height * 0.15);
    ctx.rotate(yaw);
    ctx.translate(-x, -z);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const r of roads.roads()) {
      const p = r.p;
      // Cheap reject: first point far outside view.
      if (Math.abs(p[0] - x) > RANGE * 2 || Math.abs(p[1] - z) > RANGE * 2) continue;
      ctx.strokeStyle = r.w >= 9 ? '#9aa0a8' : '#585e66';
      ctx.lineWidth = Math.max(r.w, 4);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cx = canvas.width / 2, cy = canvas.height / 2 + canvas.height * 0.15;
    // Police hiding spots: green rings (edge arrows when out of range).
    for (const h of spots) {
      const dx = h.x - x, dz = h.z - z, c = Math.cos(yaw), sn = Math.sin(yaw);
      let px = (dx * c - dz * sn) * s, py = (dx * sn + dz * c) * s;
      const edge = Math.max(Math.abs(px) / (canvas.width / 2 - 8), Math.abs(py) / (canvas.height / 2 - 8));
      if (edge > 1) { px /= edge; py /= edge; }
      ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx + px, cy + py, edge > 1 ? 4 : Math.max(5, 12 * s), 0, Math.PI * 2); ctx.stroke();
    }
    // Friends: dot + name inside the map, clamped arrow on the edge when out of range.
    ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
    for (const f of friends) {
      const dx = f.x - x, dz = f.z - z, c = Math.cos(yaw), sn = Math.sin(yaw);
      let px = (dx * c - dz * sn) * s, py = (dx * sn + dz * c) * s;
      const edge = Math.max(Math.abs(px) / (canvas.width / 2 - 8), Math.abs(py) / (canvas.height / 2 - 8));
      if (edge > 1) { px /= edge; py /= edge; }
      ctx.fillStyle = f.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx + px, cy + py, edge > 1 ? 4 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (edge <= 1) { ctx.fillStyle = '#fff'; ctx.fillText(f.name, cx + px, cy + py - 8); }
    }
    ctx.fillStyle = '#ff5a1f';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8); ctx.lineTo(cx + 6, cy + 6); ctx.lineTo(cx - 6, cy + 6);
    ctx.fill();
  }
}
