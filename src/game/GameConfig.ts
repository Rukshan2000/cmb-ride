export const GameConfig = {
  dataUrl: import.meta.env.VITE_MAP_DATA_URL ?? '/data',
  loadDistance: 1100,     // m: load chunks whose centre is within this distance
  unloadDistance: 1600,
  buildingDetailDistance: 300, // m from chunk edge: windows/shopfronts/balconies within, plain shells beyond   // m: unload beyond this (hysteresis)
  fogStart: 350,
  fogEnd: 1050,
  // Start location: ?spawn=pettah|fort|galleface|bambalapitiya|borella|wellawatte (default pettah). Snapped to the nearest road.
  spawnPoints: {
    pettah: { lat: 6.93705, lon: 79.85215, road: 'Main Street' },
    galleface: { lat: 6.9225, lon: 79.8487, road: 'Galle Road' },
    fort: { lat: 6.9329, lon: 79.8454, road: 'York Street' },
    bambalapitiya: { lat: 6.8930, lon: 79.8557, road: 'Galle Road' },
    borella: { lat: 6.9147, lon: 79.8778, road: '' },
    wellawatte: { lat: 6.8740, lon: 79.8590, road: 'Galle Road' },
  } as Record<string, { lat: number; lon: number; road: string }>,
  get spawn() { return this.spawnPoints[new URLSearchParams(location.search).get('spawn') ?? ''] ?? this.spawnPoints.pettah; },
  shadows: true,
};
