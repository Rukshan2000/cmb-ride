import type { RoadNetwork } from '../map/RoadNetwork';

const RANGE = 350; // metres from centre to edge

/** Heading-up 2D mini-map of loaded roads around the car. */
export class MiniMap {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(roads: RoadNetwork, x: number, z: number, yaw: number) {
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
    ctx.fillStyle = '#ff5a1f';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8); ctx.lineTo(cx + 6, cy + 6); ctx.lineTo(cx - 6, cy + 6);
    ctx.fill();
  }
}
