// Land-use zone lookup from the Colombo City Development Plan 2022-2031 map
// (scripts/data/cdp-landuse-2022.png, from team-watchdog/colombo-skylines, MIT).
// The image is a Web-Mercator render; the transform below was fitted by maximising how many OSM
// building centroids land on zoned (coloured) plots. Covers the CMC area only (~6.86-6.98 N).
// ponytail: decodes the PNG with macOS `sips`; swap for a PNG decoder if this runs on Linux CI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export type Zone = 'residential' | 'commercial' | 'education' | 'institutional' | 'health' | 'industrial' | 'religious' | 'socio';

const ZONES: [Zone, number][] = [
  ['residential', 0xffdc9a], ['commercial', 0x337dea], ['education', 0xff33d2], ['institutional', 0xff3334],
  ['health', 0xf795c4], ['industrial', 0xba32ea], ['religious', 0xffff8f], ['socio', 0xfecbec],
];
const W = 2560;
const SCALE = 16325, X0 = 996, Y0 = 1820, LON0 = 79.86, LAT0 = 6.9; // pixel = X0 + SCALE*(lon-LON0), Y0 - SCALE*(mercY-LAT0)
const PNG = 'scripts/data/cdp-landuse-2022.png', BMP = 'scripts/.cache/cdp-landuse.bmp';

let grid: Uint8Array | undefined; // zone index + 1 per pixel, 0 = unzoned

function load(): Uint8Array {
  if (!existsSync(BMP)) execFileSync('sips', ['-s', 'format', 'bmp', PNG, '--out', BMP], { stdio: 'ignore' });
  const b = readFileSync(BMP), off = b.readUInt32LE(10); // 32bpp top-down BGRA
  const g = new Uint8Array(W * W);
  for (let i = 0; i < W * W; i++) {
    const o = off + i * 4;
    for (let z = 0; z < ZONES.length; z++) {
      const c = ZONES[z][1];
      if (Math.abs(b[o + 2] - (c >> 16)) + Math.abs(b[o + 1] - ((c >> 8) & 255)) + Math.abs(b[o] - (c & 255)) < 45) { g[i] = z + 1; break; }
    }
  }
  return g;
}

// Majority zone in a 7x7 px (~50 m) window, so centroids on white road gaps still resolve.
export function zoneAt(lat: number, lon: number): Zone | undefined {
  grid ??= load();
  const my = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;
  const px = Math.round(X0 + SCALE * (lon - LON0)), py = Math.round(Y0 - SCALE * (my - LAT0));
  const votes = new Array(ZONES.length + 1).fill(0);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = px + dx, y = py + dy;
    if (x >= 0 && y >= 0 && x < W && y < W) votes[grid[y * W + x]] += dx === 0 && dy === 0 ? 3 : 1;
  }
  let best = 0;
  for (let z = 1; z < votes.length; z++) if (votes[z] > votes[best] || best === 0 && votes[z] > 0) best = z;
  return best ? ZONES[best - 1][0] : undefined;
}
