// Friends: search by username, request / accept / remove, and invite a friend to a multiplayer room.
import type pg from 'pg';

export const FRIENDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS friendships (
  from_id int NOT NULL REFERENCES users ON DELETE CASCADE, to_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  accepted boolean NOT NULL DEFAULT false, CHECK (from_id <> to_id));
CREATE UNIQUE INDEX IF NOT EXISTS friendship_pair ON friendships (least(from_id, to_id), greatest(from_id, to_id));`;

// ponytail: invites live in memory for 2 minutes, one process; store them if invites must survive restarts.
const invites = new Map<number, Map<string, { room: string; at: number }>>();
const PAIR = '(from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)';

type Result = [number, unknown];

export async function friendsRoute(pool: pg.Pool, me: { id: number; username: string }, method: string, url: URL, b: any): Promise<Result> {
  const route = `${method} ${url.pathname}`;
  if (route === 'GET /api/friends') {
    const rows = (await pool.query(
      `SELECT u.username, f.accepted, f.from_id = $1 AS mine FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.from_id = $1 THEN f.to_id ELSE f.from_id END
       WHERE $1 IN (f.from_id, f.to_id) ORDER BY lower(u.username)`, [me.id])).rows;
    const names = (keep: (r: any) => boolean) => rows.filter(keep).map(r => r.username as string);
    const friends = names(r => r.accepted);
    const open = [...(invites.get(me.id) ?? [])].filter(([from, i]) => Date.now() - i.at < 120_000 && friends.includes(from));
    return [200, { friends, incoming: names(r => !r.accepted && !r.mine), outgoing: names(r => !r.accepted && r.mine), invites: open.map(([from, i]) => ({ from, room: i.room })) }];
  }
  if (route === 'GET /api/friends/search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return [200, { users: [] }];
    const rows = (await pool.query('SELECT username FROM users WHERE position(lower($1) in lower(username)) = 1 AND id <> $2 ORDER BY lower(username) LIMIT 8', [q, me.id])).rows;
    return [200, { users: rows.map(r => r.username) }];
  }

  const other = (await pool.query('SELECT id, username FROM users WHERE lower(username) = lower($1)', [String(b?.username ?? '')])).rows[0];
  if (!other || other.id === me.id) return [404, { error: 'No such rider' }];
  const pair = [me.id, other.id];

  if (route === 'POST /api/friends/request') {
    // If they already asked me, asking back accepts it.
    const accepted = await pool.query('UPDATE friendships SET accepted = true WHERE from_id = $2 AND to_id = $1', pair);
    if (!accepted.rowCount) await pool.query('INSERT INTO friendships (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', pair);
    return [200, {}];
  }
  if (route === 'POST /api/friends/accept') {
    const done = await pool.query('UPDATE friendships SET accepted = true WHERE from_id = $2 AND to_id = $1', pair); // only the receiver
    return done.rowCount ? [200, {}] : [404, { error: 'No such request' }];
  }
  if (route === 'POST /api/friends/remove') { // unfriend, decline or cancel
    await pool.query(`DELETE FROM friendships WHERE ${PAIR}`, pair);
    return [200, {}];
  }
  if (route === 'POST /api/friends/invite' || route === 'POST /api/friends/dismiss') {
    if (route.endsWith('dismiss')) { invites.get(me.id)?.delete(other.username); return [200, {}]; }
    if (!(await pool.query(`SELECT 1 FROM friendships WHERE accepted AND (${PAIR})`, pair)).rowCount) return [403, { error: 'Not your friend' }];
    const room = String(b.room ?? '').replace(/[^\w \-.]/g, '').slice(0, 24).trim();
    if (!room) return [400, { error: 'No room' }];
    if (!invites.has(other.id)) invites.set(other.id, new Map());
    invites.get(other.id)!.set(me.username, { room, at: Date.now() });
    return [200, {}];
  }
  return [404, { error: 'not found' }];
}
