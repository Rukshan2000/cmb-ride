// Processed-map chunk format produced by scripts/fetch-osm.ts.
// Coordinates are local metres (see MapProjection), flat [x0,z0,x1,z1,...] arrays.

export interface RoadData {
  id: number;     // OSM way id
  n: string;      // name ('' if unnamed)
  h: string;      // highway class
  w: number;      // carriageway width (m)
  o: boolean;     // oneway
  l?: number;     // OSM lanes tag (total, both directions)
  p: number[];    // polyline
}

export interface BuildingData {
  id: number;
  h: number;      // height (m)
  e: boolean;     // true = height estimated (no OSM height/levels tag)
  k: BuildingKind; // architectural class derived from OSM tags (see fetch-osm classify())
  l: number;      // floor count (from building:levels, else derived from h)
  r?: string;     // OSM roof:shape if tagged (flat, hipped, gabled, ...)
  c?: number;     // OSM building:colour as 0xRRGGBB, if tagged
  rc?: number;    // OSM roof:colour as 0xRRGGBB, if tagged
  n?: string;     // OSM name (name:en preferred), if tagged
  p: number[];    // outer ring, not closed
}

export type BuildingKind = 'house' | 'apartments' | 'shop' | 'commercial' | 'office' | 'industrial' | 'religious' | 'civic' | 'hut';

export interface ChunkData {
  roads: RoadData[];
  buildings: BuildingData[];
  junctions: number[]; // [x,z,radius,...] for nodes shared by 3+ road ends
  // OSM node features. Heading a = atan2(dx,dz) of the travel direction; hw = road half-width.
  sig?: number[];  // traffic-signal stop positions [x,z,a,hw,oneway,...], one per incoming direction
  cr?: number[];   // marked pedestrian crossings [x,z,a(road),hw,signalled,...]
  lamp?: number[]; // OSM street_lamp [x,z,...]
  sign?: number[]; // [x,z,a,hw,kind(0 stop,1 give way),...]
  bus?: number[];  // bus stops [x,z,...]
}

export interface MapIndex {
  chunkSize: number;
  bounds: { south: number; west: number; north: number; east: number };
  chunks: string[];          // "i_j" keys that exist
  coast: number[][];         // coastline polylines (OSM convention: land on the left, sea on the right)
  places: { name: string; x: number; z: number }[];
  fetched: string;
  attribution: string;
}
