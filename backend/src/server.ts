// Traffic-intelligence backend: the only place GROQ_API_KEY lives. Run: npm run backend
// Node >= 22 (built-in TS stripping, fetch, loadEnvFile). No dependencies.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

try { process.loadEnvFile(new URL('../.env', import.meta.url).pathname); } catch { /* env may come from the host */ }
const KEY = process.env.GROQ_API_KEY ?? '';
const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b';
const TOKEN = process.env.TRAFFIC_API_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8787);

// --- request schema (what the browser may send) -------------------------------------------------
const CONDITIONS = ['light', 'moderate', 'heavy', 'gridlock'] as const;
const INCIDENTS = ['none', 'vehicle_breakdown', 'bus_breakdown', 'minor_collision', 'road_obstruction'] as const;
const TYPES = ['tuktuk', 'motorcycle', 'car', 'van', 'bus', 'lorry'] as const;

interface Snapshot { road: string; timeOfDay: string; weather: string; vehicles: Record<string, number>; signal: string; incidents: number; avgSpeedKmh: number }

export function validateSnapshot(b: any): Snapshot | null {
  if (!b || typeof b !== 'object') return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const vehicles: Record<string, number> = {};
  for (const t of TYPES) vehicles[t] = Math.max(0, Math.min(500, Math.floor(Number(b.vehicles?.[t]) || 0)));
  return {
    road: str(b.road, 80), timeOfDay: str(b.timeOfDay, 16), weather: str(b.weather, 16), signal: str(b.signal, 16),
    vehicles, incidents: Math.max(0, Math.min(50, Math.floor(Number(b.incidents) || 0))),
    avgSpeedKmh: Math.max(0, Math.min(200, Number(b.avgSpeedKmh) || 0)),
  };
}

// --- response schema (what the game will accept) -------------------------------------------------
export interface Scenario {
  trafficCondition: typeof CONDITIONS[number];
  densityMultiplier: number;
  incident: { type: typeof INCIDENTS[number]; severity: 'minor' | 'moderate'; location: 'near_intersection' | 'mid_block'; durationSeconds: number; vehicleType: typeof TYPES[number] };
  trafficResponse: { reduceSpeed: boolean; increaseFollowingDistance: boolean; allowSafePassing: boolean };
  description: string;
}

/** Never trust model output: whitelist enums, clamp numbers, default everything. */
export function validateScenario(o: any): Scenario | null {
  if (!o || typeof o !== 'object') return null;
  const pick = <T extends readonly string[]>(v: unknown, list: T, d: T[number]): T[number] => (list.includes(v as string) ? (v as T[number]) : d);
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const i = o.incident ?? {}, r = o.trafficResponse ?? {};
  return {
    trafficCondition: pick(o.trafficCondition, CONDITIONS, 'moderate'),
    densityMultiplier: clamp(o.densityMultiplier, 0.3, 1.5, 1),
    incident: {
      type: pick(i.type, INCIDENTS, 'none'),
      severity: i.severity === 'moderate' ? 'moderate' : 'minor',
      location: i.location === 'mid_block' ? 'mid_block' : 'near_intersection',
      durationSeconds: clamp(i.durationSeconds, 20, 180, 45),
      vehicleType: pick(i.vehicleType, TYPES, 'car'),
    },
    trafficResponse: { reduceSpeed: !!r.reduceSpeed, increaseFollowingDistance: !!r.increaseFollowingDistance, allowSafePassing: r.allowSafePassing !== false },
    description: typeof o.description === 'string' ? o.description.slice(0, 200) : '',
  };
}

const SYSTEM = `You plan high-level traffic conditions for a Colombo, Sri Lanka driving simulator (left-hand traffic; tuk-tuks, motorcycles, private and SLTB buses, vans, lorries).
Given a traffic snapshot, return ONLY a JSON object:
{"trafficCondition":"light|moderate|heavy|gridlock","densityMultiplier":0.3-1.5,
 "incident":{"type":"none|vehicle_breakdown|bus_breakdown|minor_collision|road_obstruction","severity":"minor|moderate","location":"near_intersection|mid_block","durationSeconds":20-180,"vehicleType":"tuktuk|motorcycle|car|van|bus|lorry"},
 "trafficResponse":{"reduceSpeed":bool,"increaseFollowingDistance":bool,"allowSafePassing":bool},
 "description":"one short sentence"}
Incidents must be uncommon: choose "none" most of the time, and never when 2 or more incidents already exist. Rain and peak hours raise density and caution.`;

async function askGroq(s: Snapshot): Promise<Scenario> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0.7, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(s) }] }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`groq HTTP ${res.status}`);
  const json = await res.json();
  const scenario = validateScenario(JSON.parse(json.choices?.[0]?.message?.content ?? 'null'));
  if (!scenario) throw new Error('invalid model output');
  return scenario;
}

// --- middleware: rate limit + small cache --------------------------------------------------------
const hits = new Map<string, number[]>();
function rateLimited(ip: string) { // 6 requests / minute / IP
  const now = Date.now(), list = (hits.get(ip) ?? []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 6;
}
const cache = new Map<string, { at: number; s: Scenario }>();

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = 8192): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || 'null');
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/traffic-scenario') return send(res, 404, { error: 'not found' });
  if (TOKEN && req.headers['x-traffic-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });
  const ip = req.socket.remoteAddress ?? '?';
  if (rateLimited(ip)) return send(res, 429, { error: 'rate limited' });
  if (!KEY) return send(res, 503, { error: 'AI disabled (no GROQ_API_KEY)' });
  let snap: Snapshot | null;
  try { snap = validateSnapshot(await readBody(req)); } catch { return send(res, 400, { error: 'bad request' }); }
  if (!snap) return send(res, 400, { error: 'bad request' });
  const key = `${snap.road}|${snap.timeOfDay}|${snap.weather}|${Math.round(snap.avgSpeedKmh / 10)}|${snap.incidents}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return send(res, 200, hit.s);
  try {
    const s = await askGroq(snap);
    cache.set(key, { at: Date.now(), s });
    console.log(`[traffic-ai] ${snap.road}: ${s.trafficCondition}, incident=${s.incident.type}`);
    send(res, 200, s);
  } catch (e) {
    console.warn('[traffic-ai] upstream failure:', (e as Error).message); // never log the key or headers
    send(res, 502, { error: 'AI unavailable' });
  }
}).listen(PORT, () => console.log(`traffic AI backend on :${PORT} (model ${MODEL}, key ${KEY ? 'loaded' : 'MISSING'})`));
