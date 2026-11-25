// Reconstruction progress for route1 -> docs/route1-progress.md (+ prints a summary).
// A section is only 'complete' after its references have been compared in-game (comparison: 'match').
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { project } from '../src/map/MapProjection.ts';

const db = JSON.parse(readFileSync('public/data/colombo/route1.json', 'utf8'));
const pts: number[] = db.route.coordinates.flatMap(([lat, lon]: number[]) => project(lat, lon));

// Street-wall coverage: share of route length with an OSM building within 25 m on at least one side.
const near = (x: number, z: number) => db.buildings.some((b: any) => { for (let i = 0; i < b.footprint.length; i += 2) if (Math.hypot(b.footprint[i] - x, b.footprint[i + 1] - z) < 25) return true; return false; });
const cov: Record<string, [number, number]> = {};
let acc = 0;
for (let i = 0; i < pts.length - 2; i += 2) {
  const l = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  for (let t = 0; t < l; t += 10) {
    const x = pts[i] + (pts[i + 2] - pts[i]) * t / l, z = pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t / l;
    const sec = db.sections.find((s: any) => acc + t <= s.to)?.id ?? db.sections.at(-1).id;
    const c = (cov[sec] ??= [0, 0]); c[1]++; if (near(x, z)) c[0]++;
  }
  acc += l;
}

const rows = db.sections.map((s: any) => {
  const B = db.buildings.filter((b: any) => b.section === s.id), R = db.roads.filter((r: any) => r.section === s.id), F = db.references.filter((r: any) => r.section === s.id);
  const recon = B.filter((b: any) => b.status !== 'generic').length, verified = B.filter((b: any) => b.status === 'verified').length;
  const compared = F.filter((r: any) => r.comparison).length, matched = F.filter((r: any) => r.comparison === 'match').length;
  const roadsOk = R.filter((r: any) => r.status === 'verified').length;
  // Confidence 0-100: equal parts building reconstruction, road verification, visual comparison, street-wall data coverage.
  const c = cov[s.id] ?? [0, 1];
  const score = Math.round(25 * (B.length ? recon / B.length : 0) + 25 * (R.length ? roadsOk / R.length : 0) + 25 * (F.length ? matched / F.length : 0) + 25 * (c[0] / c[1]));
  const complete = F.length > 0 && matched === F.length && verified === B.filter((b: any) => b.priority === 1).length;
  return { s, B, R, F, recon, verified, compared, matched, roadsOk, coverage: Math.round((100 * c[0]) / c[1]), score, complete };
});

const total = (k: string) => rows.reduce((a: number, r: any) => a + (typeof r[k] === 'number' ? r[k] : r[k].length), 0);
let md = `# Route 1 reconstruction progress\n\n${db.name} · ${(db.route.distance / 1000).toFixed(1)} km · generated ${new Date().toISOString().slice(0, 16)}\n\n`;
md += `A section is **complete** only when every reference photo has been compared in-game and marked \`match\`, and every priority-1 building is \`verified\`.\n\n`;
md += `| Section | Length | Street-wall data* | Buildings (P1) | Reconstructed | Verified | Roads verified | Refs | Compared / match | Confidence | Status |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.s.name} | ${((r.s.to - r.s.from) / 1000).toFixed(1)} km | ${r.coverage}% | ${r.B.length} (${r.B.filter((b: any) => b.priority === 1).length}) | ${r.recon} | ${r.verified} | ${r.roadsOk}/${r.R.length} | ${r.F.length} | ${r.compared} / ${r.matched} | ${r.score} | ${r.complete ? 'complete' : r.s.status} |\n`;
md += `| **Total** | ${(db.route.distance / 1000).toFixed(1)} km | | ${total('B')} | ${total('recon')} | ${total('verified')} | ${total('roadsOk')}/${total('R')} | ${total('F')} | ${total('compared')} / ${total('matched')} | | |\n\n`;
md += `\\* share of the route with an OSM building footprint within 25 m. Low values mean OSM is missing buildings here: they must be mapped (OSM, from imagery/survey) before they can be reconstructed.\n\n`;
md += `## Missing reference data\n\n`;
for (const r of rows) {
  const gaps: string[] = [];
  let last = r.s.from;
  for (const f of [...r.F, { routeDistance: r.s.to }]) { if (f.routeDistance - last > 150) gaps.push(`${last}–${f.routeDistance} m`); last = f.routeDistance; }
  md += `- **${r.s.name}**: ${gaps.length ? 'no driver-view photo for ' + gaps.join(', ') : 'photo every ≤150 m'}; ${r.R.filter((x: any) => x.widthSource.startsWith('estimated')).length} road ways with estimated width\n`;
}
md += `\n## Street-wall buildings missing in OSM (map these first)\n\n`;
for (const m of db.missingInOsm ?? []) md += `- ${m.section} @ ${m.routeDistance} m (${m.side}): ${m.description}\n`;
md += `\n## Reconstructed buildings\n\n| OSM id | Name | Section | Floors | Colour | Confidence | Facade |\n|---|---|---|---|---|---|---|\n`;
for (const b of db.buildings.filter((b: any) => b.status !== 'generic')) md += `| [${b.id}](https://www.openstreetmap.org/way/${b.id}) | ${b.name} | ${b.section} | ${b.floors ?? b.osmFloors} | ${b.colour ?? ''} | ${b.confidence} | ${b.facade} |\n`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/route1-progress.md', md);
console.log(md);
