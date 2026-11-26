// Converts the supplied low-poly OBJ into game GLBs: body (no wheels, no badge) + one wheel centred on its axle.
// Source: 75-chevrolet_camaro_ss/ (no licence file supplied). Run: node scripts/models/camaro.ts
import { readFileSync } from 'node:fs';
import { Model } from './glb.ts';

const SCALE = 0.48, GROUND = -1.37, AXLE_Y = -0.665, AXLE_FRONT = 3.21, AXLE_REAR = -2.565, TRACK = 1.7; // OBJ units
// Paint is 0xb01c22: the game recognises that colour and repaints it.
const COLOUR: Record<string, [number, number, number]> = { // material -> [colour, metallic, roughness]
  Material: [0xb01c22, 0.4, 0.25], 'Material.001': [0x1a222c, 0.5, 0.05], 'Material.002': [0x111111, 0, 0.5], 'Material.003': [0xf4f1e4, 0, 0.15],
  'Material.004': [0x8a8d90, 0.9, 0.3], 'Material.006': [0xb8babd, 0.9, 0.25], 'Material.007': [0x151515, 0, 0.9], 'Material.008': [0xc2c4c8, 0.9, 0.25],
  'Material.009': [0x55575a, 0.8, 0.4], 'Material.012': [0xa8121a, 0, 0.2], 'Material.014': [0x0b0b0b, 0, 0.8],
};
const body = new Model(), wheel = new Model(), V: number[][] = [];
let obj = '', mat = '';
for (const line of readFileSync('75-chevrolet_camaro_ss/Chevrolet_Camaro_SS_Low.obj', 'utf8').split('\n')) {
  const s = line.trim().split(/\s+/);
  if (s[0] === 'o') obj = s[1];
  else if (s[0] === 'v') V.push([+s[1], +s[2], +s[3]]);
  else if (s[0] === 'usemtl') mat = s[1];
  else if (s[0] === 'f' && !obj.startsWith('Logo')) {
    const pts = s.slice(1).map(t => V[parseInt(t) - 1]);
    const [c, metal, rough] = COLOUR[mat] ?? [0x2a2a2a, 0.2, 0.5];
    body.finish.set(c, [metal, rough]); wheel.finish.set(c, [metal, rough]);
    if (/^(Rin|Ruedas)/.test(obj)) { // take only the rear +X wheel, centred, outer face towards +X
      if (obj.includes('_Tr') && pts[0][0] > 0) wheel.poly(c, pts.map(([x, y, z]) => [(x - TRACK) * SCALE, (y - AXLE_Y) * SCALE, (z - AXLE_REAR) * SCALE]));
    } else body.poly(c, pts.map(([x, y, z]) => [-x * SCALE, (y - GROUND) * SCALE, -z * SCALE])); // source faces +Z, game faces -Z
  }
}
body.write('public/data/vehicles/camaro.glb', 0.4);
wheel.write('public/data/vehicles/camaro-wheel.glb', 0.5);
console.log('axles z', -AXLE_FRONT * SCALE, -AXLE_REAR * SCALE, 'track', 2 * TRACK * SCALE, 'wheel r', (AXLE_Y - GROUND) * SCALE);
