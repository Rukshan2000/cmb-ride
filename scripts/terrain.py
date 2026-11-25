# Terrain heightmap: FABDEM V1-2 (bare-earth DEM: buildings and trees removed, ~30 m) -> public/data/terrain.json.
# FABDEM © University of Bristol, CC BY-NC-SA 4.0 (non-commercial). https://doi.org/10.5523/bris.s5hqmjcdj8yo2ibzi9b4ew3sn
# Get N06E079_FABDEM_V1-2.tif from the N00E070-N10E080 zip at that DOI, then:
#   python3 scripts/terrain.py path/to/N06E079_FABDEM_V1-2.tif
import json, sys
from PIL import Image

S, W, N, E = 6.835 - 0.01, 79.838 - 0.01, 6.958 + 0.01, 79.885 + 0.01   # map bounds (fetch-osm.ts) + margin
im = Image.open(sys.argv[1])
step = 1 / 3600                                                          # 1 arc-second; tile origin lat 7, lon 79
x0, x1 = round((W - 79) * 3600), round((E - 79) * 3600)
y0, y1 = round((7 - N) * 3600), round((7 - S) * 3600)
c = im.crop((x0, y0, x1 + 1, y1 + 1))
w, h = c.size
px = c.load()
raw = [[max(0.0, px[i, j]) if px[i, j] > -100 else 0.0 for i in range(w)] for j in range(h)]
# 3x3 box smoothing: FABDEM still has ~2-5 m pixel noise in dense cities; real relief here is broad and gentle.
sm = [[sum(raw[min(h - 1, max(0, j + b))][min(w - 1, max(0, i + a))] for a in (-1, 0, 1) for b in (-1, 0, 1)) / 9
       for i in range(w)] for j in range(h)]
out = {
    'source': 'FABDEM V1-2 (University of Bristol), CC BY-NC-SA 4.0',
    'north': 7 - y0 * step, 'west': 79 + x0 * step, 'step': step, 'w': w, 'h': h,
    'dm': [round(v * 10) for row in sm for v in row],  # decimetres, row-major from the north-west corner
}
json.dump(out, open('public/data/terrain.json', 'w'), separators=(',', ':'))
print(f'terrain {w}x{h}, max {max(out["dm"]) / 10} m')
