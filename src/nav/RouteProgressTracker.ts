// Progress of the car along a route polyline in local metres. Pure logic, no rendering.

export interface Progress { along: number; offset: number; remaining: number; stepIndex: number; toStep: number; arrived: boolean; offRoute: boolean }

export class RouteProgressTracker {
  readonly cum: number[] = [0];   // cumulative distance at each vertex
  readonly stepAt: number[] = []; // route distance where each step's manoeuvre happens
  private seg = 0;
  private offTime = 0;
  private done = false;

  /** pts: flat [x,z,...]; stepDistances: routing-engine step lengths (sum = route length). */
  constructor(readonly pts: number[], stepDistances: number[]) {
    for (let i = 2; i < pts.length; i += 2) this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    const scale = this.total / (stepDistances.reduce((a, b) => a + b, 0) || 1);
    let acc = 0;
    for (const d of stepDistances) { this.stepAt.push(acc); acc += d * scale; }
  }

  get total() { return this.cum[this.cum.length - 1]; }

  /** Searches a window ahead of the last matched segment so the car can't "jump" to a parallel/later leg. */
  update(x: number, z: number, dt: number): Progress {
    const p = this.pts, n = p.length / 2;
    let best = Infinity, bestSeg = this.seg, bestT = 0;
    for (let i = Math.max(0, this.seg - 3); i < Math.min(n - 1, this.seg + 40); i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], ex = p[i * 2 + 2] - ax, ez = p[i * 2 + 3] - az, l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < best) { best = d; bestSeg = i; bestT = t; }
    }
    this.seg = bestSeg;
    const along = this.cum[bestSeg] + (this.cum[bestSeg + 1] - this.cum[bestSeg]) * bestT;
    this.offTime = best > 30 ? this.offTime + dt : 0;
    // Arrival needs route progress, not just straight-line proximity.
    if (along > this.total - 20 && best < 25) this.done = true;
    let stepIndex = this.stepAt.findIndex(s => s > along + 3);
    if (stepIndex < 0) stepIndex = this.stepAt.length - 1;
    return { along, offset: best, remaining: Math.max(0, this.total - along), stepIndex, toStep: Math.max(0, this.stepAt[stepIndex] - along), arrived: this.done, offRoute: !this.done && this.offTime > 3 };
  }
}

if (import.meta.env?.DEV) {
  // L-shaped 200 m route: 100 m east, then 100 m north (-z); turn step at 100 m.
  const t = new RouteProgressTracker([0, 0, 100, 0, 100, -100], [100, 100, 0]);
  const a = t.update(50, 2, 0.1);
  console.assert(Math.abs(a.along - 50) < 1e-6 && a.stepIndex === 1 && Math.abs(a.toStep - 50) < 1e-6 && !a.arrived, 'progress mid-leg', a);
  console.assert(!t.update(100, -50, 0.1).arrived && t.update(100, -100, 0.1).arrived, 'arrival only at route end');
  const b = new RouteProgressTracker([0, 0, 100, 0, 100, -100], [100, 100, 0]);
  let off = b.update(50, 80, 2); off = b.update(50, 80, 2);
  console.assert(off.offRoute, 'off-route after 3 s', off);
}
