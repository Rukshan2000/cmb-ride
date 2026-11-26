// Colombo Lotus Tower (Nelum Kuluna, OSM way 728831229, 356 m): podium, tapering green shaft, lotus-bud head with
// two tones of petals, white drum and red/white antenna mast. Proportions estimated from photographs.
// Run: node scripts/models/lotus.ts
import { Model } from './glb.ts';

const GREEN = 0x1f9e6e, TEAL = 0x5fc0b0, PINK = 0xb8368f, PURPLE = 0x7a2a86, WHITE = 0xe8e8e4, RED = 0xc0392b, STONE = 0xc9bfae, GLASS = 0x37505e, GOLD = 0xd8b24a;
const m = new Model(), TAU = Math.PI * 2;
const at = (r: number, a: number, y: number) => [Math.cos(a) * r, y, Math.sin(a) * r];

/** Surface of revolution through [radius, height] profile points. */
function lathe(c: number, prof: [number, number][], seg = 48) {
  for (let i = 0; i < prof.length - 1; i++) for (let k = 0; k < seg; k++) {
    const a = (k / seg) * TAU, b = ((k + 1) / seg) * TAU, [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
    m.poly(c, [at(r0, a, y0), at(r0, b, y0), at(r1, b, y1), at(r1, a, y1)]);
  }
}

/** A ring of pointed petals following a bulging profile from y0 to y1. */
function petals(c: number, n: number, y0: number, y1: number, r0: number, bulge: number, rTip: number, phase: number) {
  const STEPS = 8, W = 4;
  for (let p = 0; p < n; p++) {
    const mid = (p / n) * TAU + phase;
    const row = (i: number) => {
      const t = i / STEPS, r = r0 + (rTip - r0) * t + Math.sin(Math.PI * t) * bulge, half = (Math.PI / n) * 1.15 * Math.sqrt(Math.max(0, 1 - t ** 2.5));
      return Array.from({ length: W + 1 }, (_, k) => { const u = (k / W) * 2 - 1; return at(r + (1 - u * u) * 1.2, mid + u * half, y0 + (y1 - y0) * t); });
    };
    for (let i = 0; i < STEPS; i++) { const A = row(i), B = row(i + 1); for (let k = 0; k < W; k++) m.poly(c, [A[k], A[k + 1], B[k + 1], B[k]]); }
  }
}

// Podium (lotus throne) and entrance drum.
lathe(STONE, [[38, 0], [38, 5], [31, 6], [31, 10], [24, 11]], 64);
lathe(GLASS, [[24, 11], [23, 19]], 64);
lathe(WHITE, [[27, 19], [27, 21], [16, 23]], 64);
petals(STONE, 16, 5, 22, 30, 5, 33, 0);
// Shaft.
lathe(GREEN, [[15, 21], [11.5, 45], [9, 90], [8, 150], [7.8, 205]]);
lathe(TEAL, [[7.8, 205], [9, 214], [14, 224]]);
// Lotus head: core, then inner (upper, purple) and outer (lower, pink) petals.
lathe(GLASS, [[14, 224], [19, 234], [20, 248], [17, 262], [11, 270]]);
petals(TEAL, 10, 214, 234, 9, 6, 20, 0);
petals(PINK, 12, 224, 262, 14, 10.5, 15, 0);
petals(PURPLE, 12, 234, 278, 17, 6.5, 8, Math.PI / 12);
// White drum, decks and antenna.
lathe(WHITE, [[11, 268], [11, 288], [12.5, 288], [12.5, 290], [7, 292], [6, 300], [4, 302]]);
for (const y of [272, 276, 280, 284]) lathe(GLASS, [[11.1, y], [11.1, y + 1.6]]);
lathe(WHITE, [[2.6, 302], [2.2, 318]], 12);
for (let y = 318, i = 0; y < 350; y += 6.4, i++) lathe(i % 2 ? WHITE : RED, [[1.5 - i * 0.18, y], [1.35 - i * 0.18, y + 6.4]], 10);
lathe(GOLD, [[0.5, 350], [0.08, 356]], 8);

m.write('public/data/buildings/models/lotus-tower.glb', 0.45);
console.log('ok');
