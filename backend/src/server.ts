// Traffic-intelligence backend: the only place GROQ_API_KEY lives. Run: npm run backend
// Node >= 22 (built-in TS stripping, fetch, loadEnvFile). No dependencies.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

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


// --- multiplayer rooms ---------------------------------------------------------------------------
// ponytail: HTTP polling (~10 Hz) relay, in memory, one process. Move to WebSockets if rooms get big or laggy.
interface MpPlayer { id: string; name: string; model: string; color: number; x: number; y: number; z: number; yaw: number; v: number; cp: number; t: number }
type MpEvent = { id: number; kind: 'race'; cps: [number, number][]; start: number; results: { id: string; name: string; ms: number }[] }
  | { id: number; kind: 'tag'; it: string; since: number; tags: number; end: number };
interface Room { players: Map<string, MpPlayer>; event: MpEvent | null }
const rooms = new Map<string, Room>();
let eventSeq = 1;
setInterval(() => { const now = Date.now(); for (const [k, r] of rooms) if ([...r.players.values()].every(p => now - p.t > 5000)) rooms.delete(k); }, 30000).unref();
const MODELS = ['sedan', 'bus', 'van', 'tuktuk', 'motorcycle'];

export function mpStep(b: any, now = Date.now()) {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[^\w \-.]/g, '').slice(0, max) : '');
  const num = (v: unknown, lim = 1e6) => (Number.isFinite(Number(v)) ? Math.max(-lim, Math.min(lim, Number(v))) : 0);
  const roomId = str(b?.room, 24).toLowerCase(), id = str(b?.id, 24);
  if (!roomId || !id) return null;
  let room = rooms.get(roomId);
  // Lobby peek: see who's in a room without joining (or creating) it.
  if (b.peek) return { now, room: roomId, id, players: room ? [...room.players.values()].filter(p => now - p.t < 5000) : [], event: room?.event ?? null };
  if (!room) rooms.set(roomId, (room = { players: new Map(), event: null }));
  const me: MpPlayer = {
    id, name: str(b.name, 16) || 'Rider', model: MODELS.includes(b.model) ? b.model : 'sedan', color: num(b.color, 0xffffff) | 0,
    x: num(b.x), y: num(b.y, 1000), z: num(b.z), yaw: num(b.yaw, 100), v: num(b.v, 200), cp: Math.max(0, num(b.cp, 99) | 0), t: now,
  };
  room.players.set(id, me);
  for (const [k, p] of room.players) if (now - p.t > 5000) room.players.delete(k); // dropped players
  const ev = room.event;
  // Start / stop events (any player may).
  if (b.action === 'race' && Array.isArray(b.cps) && b.cps.length >= 2) {
    const cps = b.cps.slice(0, 12).map((c: unknown[]) => [num(c?.[0]), num(c?.[1])] as [number, number]);
    room.event = { id: eventSeq++, kind: 'race', cps, start: now + 5000, results: [] };
  } else if (b.action === 'tag' && room.players.size >= 2) {
    room.event = { id: eventSeq++, kind: 'tag', it: id, since: now + 3000, tags: 0, end: now + 180000 };
  } else if (b.action === 'stop') room.event = null;
  // Race finish: first report wins, time measured by the server clock.
  else if (ev?.kind === 'race' && b.finished && now > ev.start && !ev.results.some(r => r.id === id) && me.cp >= ev.cps.length)
    ev.results.push({ id, name: me.name, ms: now - ev.start });
  // Tag: "it" touching anyone passes it on (3 s immunity after each tag).
  if (ev?.kind === 'tag') {
    if (now > ev.end || !room.players.has(ev.it)) room.event = null;
    else if (now > ev.since) {
      const it = room.players.get(ev.it)!;
      for (const p of room.players.values()) if (p.id !== it.id && Math.hypot(p.x - it.x, p.z - it.z) < 5) { ev.it = p.id; ev.since = now + 3000; ev.tags++; break; }
    }
  }
  return { now, room: roomId, id, players: [...room.players.values()].filter(p => p.id !== id), event: room.event };
}

export function mpLeave(roomId: string, id: string) { rooms.get(roomId)?.players.delete(id); }

// --- WebSocket transport for /api/mp (RFC 6455, text frames only; no dependencies) -----------------
// Client sends its state as JSON ~20 Hz; each message is answered with mpStep's room snapshot.
function wsFrame(text: string): Buffer {
  const data = Buffer.from(text), n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, data]);
}

function mpSocket(req: IncomingMessage, sock: Duplex) {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/api/mp' || typeof key !== 'string') return sock.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0), me: { room: string; id: string } | null = null;
  const close = () => { if (me) mpLeave(me.room, me.id); sock.destroy(); };
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 65536) return close();
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) return close();               // > 64 KiB: never legitimate here
      if (!masked) return close();                        // clients must mask (RFC 6455 5.1)
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close();                                         // close
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, len]), payload])); continue; } // ping -> pong
      if (op !== 1) continue;                                               // only text frames are used
      let r; try { r = mpStep(JSON.parse(payload.toString())); } catch { r = null; }
      if (!r) { sock.write(wsFrame(JSON.stringify({ error: 'bad message' }))); continue; }
      me = { room: r.room, id: r.id };
      sock.write(wsFrame(JSON.stringify(r)));
    }
  });
  sock.on('error', close); sock.on('end', close);
}

const server = createServer(async (req, res) => {
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
});
server.on('upgrade', mpSocket);
server.listen(PORT, () => console.log(`traffic AI backend on :${PORT} (model ${MODEL}, key ${KEY ? 'loaded' : 'MISSING'})`));
