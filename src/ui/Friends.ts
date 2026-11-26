import { username } from '../account/Store';

// 👥 Friends panel (lobby and in game): search riders, requests, and invites to a multiplayer room.
interface State { friends: string[]; incoming: string[]; outgoing: string[]; invites: { from: string; room: string }[] }

const api = async (path: string, body?: unknown) => {
  const r = await fetch(`/api/friends${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Server unavailable');
  return r.json();
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = '') => Object.assign(document.createElement(tag), { textContent: text, style: css });
const BTN = 'border:0;border-radius:8px;background:#2f3540;color:#fff;font:600 13px system-ui;padding:6px 10px;cursor:pointer';

export class Friends {
  /** The room to invite friends into: the one I'm in, else my own. */
  room = `${username}-room`.slice(0, 24).toLowerCase();
  inRoom = false;
  readonly button = el('button', `position:fixed;top:50px;right:12px;z-index:30;${BTN};background:rgba(0,0,0,.7)`, '👥 Friends');
  private panel = el('div', 'position:fixed;top:90px;right:12px;z-index:40;width:280px;max-height:70vh;overflow:auto;display:none;background:#1c1f24;color:#f2f2f2;border-radius:12px;padding:14px;font:500 14px system-ui;box-shadow:0 12px 40px rgba(0,0,0,.5)');
  private note = el('small', 'display:block;color:#ffb35c;min-height:1.2em');
  private found = el('div');
  private lists = el('div');
  private shown = ''; // last rendered state: rebuilding unchanged buttons would swallow clicks
  private search = el('input', 'width:100%;box-sizing:border-box;padding:7px;border-radius:8px;border:0');

  constructor() {
    this.search.placeholder = 'Search riders by username';
    this.search.setAttribute('aria-label', 'Search riders by username');
    this.search.maxLength = 16;
    this.panel.append(el('b', 'display:block;margin-bottom:8px', `Signed in as ${username}`), this.search, this.found, this.note, this.lists);
    document.body.append(this.button, this.panel);
    this.panel.addEventListener('keydown', e => e.stopPropagation()); // typing here must not drive or start the game
    this.button.onclick = () => { this.button.blur(); this.panel.style.display = this.panel.style.display === 'none' ? 'block' : 'none'; void this.refresh(); };
    let timer = 0;
    this.search.oninput = () => { clearTimeout(timer); timer = window.setTimeout(() => void this.find(), 300); };
    setInterval(() => void this.refresh(), 5000);
    void this.refresh();
  }

  private row(label: string, ...actions: [string, () => unknown][]) {
    const row = el('div', 'display:flex;gap:6px;align-items:center;margin-top:6px');
    row.append(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis', label));
    for (const [text, run] of actions) {
      const b = el('button', BTN, text);
      b.onclick = async () => {
        b.blur(); b.disabled = true; this.note.textContent = '';
        try { await run(); } catch (e) { this.note.textContent = (e as Error).message; }
        await this.refresh();
        b.disabled = false;
      };
      row.append(b);
    }
    return row;
  }

  private join(room: string) { location.href = `${location.pathname}?room=${encodeURIComponent(room)}`; }

  private async find() {
    const q = this.search.value.trim();
    try {
      const { users } = await api(`/search?q=${encodeURIComponent(q)}`) as { users: string[] };
      this.found.replaceChildren(...users.map(u => this.row(u, ['Add', async () => { await api('/request', { username: u }); this.note.textContent = `Request sent to ${u}`; this.found.replaceChildren(); }])));
      if (q.length >= 2 && !users.length) this.found.replaceChildren(el('small', 'opacity:.6', 'No riders found'));
    } catch (e) { this.note.textContent = (e as Error).message; }
  }

  private async refresh() {
    let s: State;
    try { s = await api('') as State; } catch { return; }
    const waiting = s.incoming.length + s.invites.length;
    this.button.textContent = waiting ? `👥 Friends (${waiting} new)` : '👥 Friends';
    const key = JSON.stringify([s, this.inRoom]);
    if (this.panel.style.display === 'none' || key === this.shown) return;
    this.shown = key;
    const head = (text: string) => el('small', 'display:block;margin-top:12px;opacity:.6', text);
    this.lists.replaceChildren(
      ...(s.invites.length ? [head('INVITES'), ...s.invites.map(i => this.row(`${i.from} · ${i.room}`,
        ['Join', async () => { await api('/dismiss', { username: i.from }); this.join(i.room); }], ['✕', () => api('/dismiss', { username: i.from })]))] : []),
      ...(s.incoming.length ? [head('FRIEND REQUESTS'), ...s.incoming.map(u => this.row(u, ['Accept', () => api('/accept', { username: u })], ['✕', () => api('/remove', { username: u })]))] : []),
      head(`FRIENDS (${s.friends.length})`),
      ...s.friends.map(u => this.row(u,
        ['Invite', async () => { await api('/invite', { username: u, room: this.room }); this.note.textContent = `Invited ${u} to "${this.room}"`; }],
        ['✕', () => api('/remove', { username: u })])),
      ...(this.inRoom || !s.friends.length ? [] : [this.row(`Your room: ${this.room}`, ['Go', () => this.join(this.room)])]),
      ...(s.outgoing.length ? [head('SENT'), ...s.outgoing.map(u => this.row(u, ['Cancel', () => api('/remove', { username: u })]))] : []),
    );
  }
}
