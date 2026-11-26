// Minimal GLB writer for scripted building models: one primitive per colour (PBR baseColor), double-sided.
import { writeFileSync } from 'node:fs';

export class Model {
  private parts = new Map<number, { pos: number[]; idx: number[] }>();
  private part(c: number) { let p = this.parts.get(c); if (!p) this.parts.set(c, (p = { pos: [], idx: [] })); return p; }

  /** Polygon (convex or fan-able) from 3D points. */
  poly(c: number, pts: number[][]) {
    const p = this.part(c), b = p.pos.length / 3;
    for (const v of pts) p.pos.push(v[0], v[1], v[2]);
    for (let i = 1; i < pts.length - 1; i++) p.idx.push(b, b + i, b + i + 1);
  }
  tris(c: number, pos: number[], idx: number[]) {
    const p = this.part(c), b = p.pos.length / 3;
    p.pos.push(...pos); p.idx.push(...idx.map(i => i + b));
  }
  /** Axis box in a façade frame: origin o, along u, outward n (both unit, horizontal). s=[a0,a1], y=[y0,y1], d=[d0,d1] (out from wall). */
  fbox(c: number, o: number[], u: number[], n: number[], s: number[], y: number[], d: number[]) {
    const P = (a: number, yy: number, dd: number) => [o[0] + u[0] * a + n[0] * dd, yy, o[2] + u[2] * a + n[2] * dd];
    const [a0, a1] = s, [y0, y1] = y, [d0, d1] = d;
    this.poly(c, [P(a0, y0, d1), P(a1, y0, d1), P(a1, y1, d1), P(a0, y1, d1)]); // front
    this.poly(c, [P(a0, y1, d0), P(a0, y1, d1), P(a1, y1, d1), P(a1, y1, d0)]); // top
    this.poly(c, [P(a0, y0, d0), P(a0, y0, d1), P(a0, y1, d1), P(a0, y1, d0)]); // sides
    this.poly(c, [P(a1, y0, d0), P(a1, y0, d1), P(a1, y1, d1), P(a1, y1, d0)]);
    this.poly(c, [P(a0, y0, d0), P(a1, y0, d0), P(a1, y0, d1), P(a0, y0, d1)]); // underside
  }

  /** Optional per-colour finish: [metallic, roughness]. */
  finish = new Map<number, [number, number]>();
  /** Colours that glow after dark, with their strength (written into the material name for the game to read). */
  night = new Map<number, number>();

  write(file: string, roughness = 0.85) {
    const prims: any[] = [], materials: any[] = [], accessors: any[] = [], views: any[] = [];
    const bins: Buffer[] = []; let off = 0;
    const push = (buf: Buffer, target: number) => { views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target }); bins.push(buf); off += buf.length; while (off % 4) { bins.push(Buffer.alloc(1)); off++; } return views.length - 1; };
    for (const [c, p] of this.parts) {
      const pos = new Float32Array(p.pos), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]); }
      // Flat normals per triangle need unshared verts; emit them de-indexed.
      const flat: number[] = [], nrm: number[] = [];
      for (let t = 0; t < p.idx.length; t += 3) {
        const [a, b, d] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]].map(i => [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...n) || 1;
        for (const v of [a, b, d]) { flat.push(...v); nrm.push(n[0] / l, n[1] / l, n[2] / l); }
      }
      const pv = push(Buffer.from(new Float32Array(flat).buffer), 34962), nv = push(Buffer.from(new Float32Array(nrm).buffer), 34962);
      accessors.push({ bufferView: pv, componentType: 5126, count: flat.length / 3, type: 'VEC3', min, max });
      accessors.push({ bufferView: nv, componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
      const srgb = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      materials.push({ name: this.night.size ? `night:${this.night.get(c) ?? 0}` : undefined, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [srgb((c >> 16) & 255), srgb((c >> 8) & 255), srgb(c & 255), 1], metallicFactor: this.finish.get(c)?.[0] ?? 0, roughnessFactor: this.finish.get(c)?.[1] ?? roughness } });
      prims.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: materials.length - 1 });
    }
    const bin = Buffer.concat(bins);
    const json = { asset: { version: '2.0', generator: 'cmb-rider scripts/models' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: prims }], materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
    let js = Buffer.from(JSON.stringify(json)); if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
    const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    writeFileSync(file, Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
  }
}
