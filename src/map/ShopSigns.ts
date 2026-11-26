import * as pc from 'playcanvas';
import { nightLight } from '../roads/NightLights';

// Trilingual shop signboards (Sinhala / Tamil / English; generic trades, no real businesses) in one canvas atlas.

const SIGNS: [string, string, string][] = [
  ['ඖෂධ හල', 'மருந்தகம்', 'PHARMACY'], ['හෝටලය', 'உணவகம்', 'HOTEL & BAKERY'], ['බේකරිය', 'வெதுப்பகம்', 'BAKERY'],
  ['සිල්ලර වෙළඳසැල', 'பலசரக்கு', 'GROCERY'], ['රෙදිපිළි', 'புடவையகம்', 'TEXTILES'], ['ආභරණ', 'நகை மாளிகை', 'JEWELLERS'],
  ['දුරකථන', 'கைபேசி', 'PHONE SHOP'], ['පොත් හල', 'புத்தகசாலை', 'BOOK SHOP'], ['දෘඩාංග', 'வன்பொருள்', 'HARDWARE'],
  ['සැලෝන්', 'சலூன்', 'SALON'], ['පලතුරු', 'பழக்கடை', 'FRUIT STALL'], ['විදුලි උපකරණ', 'மின்சாதனம்', 'ELECTRICALS'],
  ['පාවහන්', 'காலணி', 'FOOTWEAR'], ['තේ කඩය', 'தேநீர் கடை', 'TEA SHOP'], ['උපැස් යුවල', 'கண்ணாடி', 'OPTICIANS'], ['මුද්‍රණාලය', 'அச்சகம்', 'PRINTERS'],
];
const COLORS = [['#c8202a', '#fff'], ['#f2c230', '#1a1a1a'], ['#1b4f9c', '#fff'], ['#12784a', '#fff'], ['#f4f1e8', '#b01c22'], ['#e8641e', '#fff'], ['#5a2a82', '#ffe36a'], ['#141414', '#f2c230']];
export const SIGN_COUNT = SIGNS.length;

/** Atlas cell k as [u0, vBottom, u1, vTop] (2 columns × 8 rows). Canvas textures: v = 0 is the TOP row. */
export function signUv(k: number): [number, number, number, number] {
  const col = k % 2, row = Math.floor(k / 2);
  return [col / 2 + 0.002, (row + 1) / 8 - 0.002, (col + 1) / 2 - 0.002, row / 8 + 0.002];
}

export function signMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  SIGNS.forEach(([si, ta, en], k) => {
    const x = (k % 2) * 512, y = Math.floor(k / 2) * 128, [bg, fg] = COLORS[(k * 3) % COLORS.length];
    g.fillStyle = bg; g.fillRect(x, y, 512, 128);
    g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(x + 6, y + 6, 500, 116);
    g.fillStyle = fg;
    g.font = 'bold 44px system-ui, sans-serif'; g.fillText(si, x + 256, y + 38, 480);
    g.font = 'bold 30px system-ui, sans-serif'; g.fillText(`${ta}  •  ${en}`, x + 256, y + 94, 480);
  });
  const tex = new pc.Texture(device, { width: 1024, height: 1024, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, anisotropy: 8, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
  tex.setSource(c);
  const m = new pc.StandardMaterial();
  m.diffuseMap = tex; m.emissiveMap = tex; m.emissive = new pc.Color(1, 1, 1); m.gloss = 0.3;
  m.cull = pc.CULLFACE_NONE;
  nightLight(m, 0.9); // lit signboards after dark
  return m;
}
