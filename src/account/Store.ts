// Player data lives in the account database. It is loaded once at sign-in, so reads stay synchronous;
// writes update the local copy at once and are sent to the server in order, retrying until they land.
const cache = new Map<string, string>();
const pending = new Map<string, string | null>();
let sending: Promise<void> | null = null;
export let username = '';

export const store = {
  /** Resolves true once every write has reached the database, false if the server can't be reached. */
  synced: async () => { await flush(); return !pending.size; },
  getItem: (key: string) => cache.get(key) ?? null,
  setItem(key: string, value: string) { if (cache.get(key) !== value) { cache.set(key, value); queue(key, value); } },
  removeItem(key: string) { cache.delete(key); queue(key, null); },
};

function queue(key: string, value: string | null) { pending.set(key, value); void flush(); }

const put = (key: string, value: string | null, keepalive = false) =>
  fetch('/api/me/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }), keepalive });

function flush(): Promise<void> {
  return (sending ??= drain().finally(() => (sending = null)));
}

async function drain() {
  while (pending.size) {
    const [key, value] = pending.entries().next().value!;
    try {
      const r = await put(key, value);
      if (r.status === 401) return location.reload();   // session expired: sign in again
      if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
      if (pending.get(key) === value) pending.delete(key);   // changed meanwhile: send again
    } catch {
      setTimeout(flush, 5000);
      break;
    }
  }
}

// Last chance on tab close (browsers cap keepalive bodies at 64 KB).
window.addEventListener('pagehide', () => { for (const [k, v] of pending) if ((v?.length ?? 0) < 60_000) void put(k, v, true); });

async function load() {
  const r = await fetch('/api/me');
  if (r.status === 401) return false;
  if (!r.ok) throw new Error('Account server unavailable. Is `npm run backend` running, and PostgreSQL up?');
  const me = await r.json() as { username: string; data: Record<string, string> };
  username = me.username;
  for (const [k, v] of Object.entries(me.data)) cache.set(k, v);
  return true;
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  location.reload();
}

/** Resolves once signed in, showing the sign-in / create-account form if needed. */
export async function signIn(): Promise<void> {
  if (await load()) return;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#101317;color:#f2f2f2;font:500 15px system-ui';
  root.innerHTML = `<form style="display:grid;gap:12px;width:min(300px,90vw)">
    <b style="font-size:24px">CMB RIDER</b>
    <label style="display:grid;gap:4px">Username<input name="username" required minlength="3" maxlength="16" autocomplete="username" style="padding:9px"></label>
    <label style="display:grid;gap:4px">Password<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="current-password" style="padding:9px"></label>
    <small role="alert" style="color:#ff8080;min-height:1.2em"></small>
    <button value="login" style="padding:10px;cursor:pointer">Sign in</button>
    <button value="register" style="padding:10px;cursor:pointer">Create account</button>
  </form>`;
  document.body.append(root);
  const form = root.querySelector('form')!, error = root.querySelector('small')!;
  await new Promise<void>(done => {
    form.onsubmit = async e => {
      e.preventDefault();
      const action = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'login';
      error.textContent = '';
      const r = await fetch(`/api/auth/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }).catch(() => null);
      if (!r?.ok) { error.textContent = (await r?.json().catch(() => null))?.error ?? 'Account server unavailable'; return; }
      await load();
      if (action === 'register') adoptBrowserSave();
      root.remove();
      done();
    };
  });
}

/** Progress saved in this browser before accounts existed moves into the first account created here. */
function adoptBrowserSave() {
  for (const key of Object.keys(localStorage).filter(k => k.startsWith('cmb-rider-') || k === 'route1-marks')) {
    store.setItem(key, localStorage.getItem(key)!);
    localStorage.removeItem(key);
  }
}
