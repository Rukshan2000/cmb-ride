import * as pc from 'playcanvas';
import { groundAt } from './Terrain';

/** Growable vertex/index buffers with per-vertex colour, turned into one pc.Mesh. */
export class GeometryBuffer {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  get vertexCount() { return this.pos.length / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push((c >> 16) & 255, (c >> 8) & 255, c & 255, 255);
  }

  /** Quad from the last 4 vertices added (a,b,c,d in winding order). */
  quad(a: number) { this.idx.push(a, a + 1, a + 2, a, a + 2, a + 3); }

  /** onGround: world-space geometry; every vertex is lifted by the terrain height under it (gentle hills). */
  toMesh(device: pc.GraphicsDevice, onGround = false): pc.Mesh | null {
    if (!this.idx.length) return null;
    const mesh = new pc.Mesh(device);
    let pos = this.pos;
    if (onGround) { pos = pos.slice(); for (let i = 0; i < pos.length; i += 3) pos[i + 1] += groundAt(pos[i], pos[i + 2]); }
    mesh.setPositions(pos);
    mesh.setNormals(this.nrm);
    mesh.setColors32(this.col);
    // Box mapping, 7 m tiles: floors/roofs use XZ, walls run along their facing axis with V = height.
    const uv: number[] = [];
    for (let i = 0; i < this.pos.length; i += 3) {
      const [x, y, z] = [this.pos[i], this.pos[i + 1], this.pos[i + 2]], [nx, ny, nz] = [this.nrm[i], this.nrm[i + 1], this.nrm[i + 2]];
      if (Math.abs(ny) > 0.7) uv.push(x / 7, z / 7);
      else uv.push((Math.abs(nx) > Math.abs(nz) ? z : x) / 7, y / 7);
    }
    mesh.setUvs(0, uv);
    mesh.setIndices(this.vertexCount > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx));
    mesh.update();
    return mesh;
  }
}

export function vertexColorMaterial(doubleSided = false): pc.StandardMaterial {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(1, 1, 1);
  m.diffuseVertexColor = true;
  m.gloss = 0.15;
  if (doubleSided) m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}
