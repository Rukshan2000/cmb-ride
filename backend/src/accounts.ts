// Accounts and player data in PostgreSQL. Passwords: scrypt. Sessions: random token in an HttpOnly cookie,
// only its hash is stored. DATABASE_URL defaults to the local cmb_rider database.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { FRIENDS_SCHEMA, friendsRoute } from './friends.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY, username text NOT NULL, password_hash bytea NOT NULL, salt bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users (lower(username));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id int NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS player_data (
  user_id int NOT NULL REFERENCES users ON DELETE CASCADE, key text NOT NULL, value text NOT NULL, PRIMARY KEY (user_id, key));`;

const KEYS = new Set(['vehicle', 'paint', 'mode', 'room', 'name', 'horn', 'save', 'settings'].map(k => `cmb-rider-${k}`).concat('route1-marks'));
const DAYS = 30;
const hashPassword = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Server-only settings (DATABASE_URL) that deploys never overwrite.
try { process.loadEnvFile(new URL('../db.env', import.meta.url).pathname); } catch { /* local default */ }

let ready: Promise<pg.Pool> | undefined;
function db() { // lazy: DATABASE_URL is read after .env is loaded, and a DB that was down is retried
  return (ready ??= (async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/cmb_rider' });
    pool.on('error', e => console.warn('[db]', e.message));
    await pool.query(SCHEMA + FRIENDS_SCHEMA);
    return pool;
  })().catch(e => { ready = undefined; throw e; }));
}

function reply(res: ServerResponse, code: number, body: unknown, cookie?: string) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(cookie && { 'Set-Cookie': cookie }) });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 400_000) throw new Error('too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
}

const tries = new Map<string, number[]>();
function limited(key: string) { // 10 attempts / minute
  const now = Date.now(), list = (tries.get(key) ?? []).filter(t => now - t < 60000);
  list.push(now); tries.set(key, list);
  return list.length > 10;
}

const cookie = (req: IncomingMessage, token: string, maxAge: number) =>
  `session=${token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${maxAge}${/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host ?? '') ? '' : '; Secure'}`;
const tokenOf = (req: IncomingMessage) => /(?:^|; )session=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];

async function startSession(pool: pg.Pool, req: IncomingMessage, res: ServerResponse, userId: number, username: string) {
  const token = randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query(`INSERT INTO sessions VALUES ($1, $2, now() + interval '${DAYS} days')`, [sha(token), userId]);
  reply(res, 200, { username }, cookie(req, token, DAYS * 86400));
}

/** Who the session cookie belongs to. */
export async function userFor(req: IncomingMessage): Promise<{ id: number; username: string } | undefined> {
  const token = tokenOf(req);
  if (!token) return;
  return (await (await db()).query('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha(token)])).rows[0];
}

export async function accountRoute(req: IncomingMessage, res: ServerResponse) {
  const pool = await db(), route = `${req.method} ${req.url}`;
  // Writes must be JSON: another site can't send that cross-origin without a preflight we never answer.
  if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'JSON only' });

  if (route === 'POST /api/auth/register' || route === 'POST /api/auth/login') {
    const b = await body(req), username = String(b?.username ?? '').trim(), password = String(b?.password ?? '');
    const ip = req.headers['x-real-ip'] ?? req.socket.remoteAddress;
    const register = route.endsWith('register');
    if (limited(register ? `new:${ip}` : `login:${ip}:${username.toLowerCase()}`)) return reply(res, 429, { error: 'Too many attempts. Wait a minute.' });
    if (!/^[\w.-]{3,16}$/.test(username)) return reply(res, 400, { error: 'Username: 3-16 letters, numbers, _ . -' });
    if (password.length < 8 || password.length > 128) return reply(res, 400, { error: 'Password: 8-128 characters' });
    if (register) {
      const salt = randomBytes(16);
      const made = await pool.query('INSERT INTO users (username, password_hash, salt) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [username, await hashPassword(password, salt, 64), salt]);
      if (!made.rowCount) return reply(res, 409, { error: 'That username is taken' });
      return startSession(pool, req, res, made.rows[0].id, username);
    }
    const u = (await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username])).rows[0];
    const given = await hashPassword(password, u?.salt ?? Buffer.alloc(16), 64); // hash even for unknown names
    if (!u || !timingSafeEqual(given, u.password_hash)) return reply(res, 401, { error: 'Wrong username or password' });
    return startSession(pool, req, res, u.id, u.username);
  }

  const token = tokenOf(req), me = await userFor(req);
  if (!token || !me) return reply(res, 401, { error: 'Not signed in' });

  const url = new URL(req.url!, 'http://local');
  if (url.pathname === '/api/friends' || url.pathname.startsWith('/api/friends/')) {
    const [code, out] = await friendsRoute(pool, me, req.method!, url, req.method === 'POST' ? await body(req) : null);
    return reply(res, code, out);
  }

  if (route === 'POST /api/auth/logout') {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
    return reply(res, 200, {}, cookie(req, '', 0));
  }
  if (route === 'GET /api/me') {
    const rows = (await pool.query('SELECT key, value FROM player_data WHERE user_id = $1', [me.id])).rows;
    return reply(res, 200, { username: me.username, data: Object.fromEntries(rows.map(r => [r.key, r.value])) });
  }
  if (route === 'PUT /api/me/data') {
    const b = await body(req);
    if (!KEYS.has(b?.key) || !(b.value === null || (typeof b.value === 'string' && b.value.length <= 300_000))) return reply(res, 400, { error: 'bad request' });
    if (b.value === null) await pool.query('DELETE FROM player_data WHERE user_id = $1 AND key = $2', [me.id, b.key]);
    else await pool.query('INSERT INTO player_data VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO UPDATE SET value = $3', [me.id, b.key, b.value]);
    return reply(res, 200, {});
  }
  reply(res, 404, { error: 'not found' });
}
