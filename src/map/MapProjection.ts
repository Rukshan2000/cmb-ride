// Local tangent-plane (equirectangular) projection around a fixed origin.
// Accurate to well under 1 m across the ~15 km Colombo play area.
// World axes: +X = east, -Z = north (PlayCanvas forward), Y = up. Units: metres.

export const ORIGIN = { lat: 6.9271, lon: 79.8450 }; // Galle Face Green

const R = 6378137;
const DEG = Math.PI / 180;
const cosLat0 = Math.cos(ORIGIN.lat * DEG);

export function project(lat: number, lon: number): [number, number] {
  const x = (lon - ORIGIN.lon) * DEG * R * cosLat0;
  const north = (lat - ORIGIN.lat) * DEG * R;
  return [x, -north];
}

export function unproject(x: number, z: number): [number, number] {
  return [ORIGIN.lat + -z / (R * DEG), ORIGIN.lon + x / (R * DEG * cosLat0)];
}
