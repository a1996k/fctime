// App state, API client and lookups.
import { weekStart, addDays } from './shared/time.js';

export class ApiError extends Error { constructor(status, body) { super(body.error || `Request failed (${status})`); this.status = status; this.body = body; } }

export async function api(path, { method = 'GET', body, retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network failure: retry only calls that are safe to repeat (GETs and idempotent timer calls).
      if (attempt < retries) { await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); continue; }
      throw new ApiError(0, { error: 'Can’t reach the server. Check your connection and try again.' });
    }
    if (res.status >= 502 && attempt < retries) { await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); continue; }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
    if (!res.ok) {
      if (res.status === 401 && S.boot) { S.boot = null; window.dispatchEvent(new Event('fct:signedout')); }
      throw new ApiError(res.status, data);
    }
    return data;
  }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** S holds server data; ui holds view state. */
export const S = { boot: null, idx: null, clockSkew: 0 };
export const ui = { modal: null, data: {}, hf: null };

export async function loadBoot() {
  const b = await api('/bootstrap', { retries: 2 });
  S.boot = b;
  S.clockSkew = b.settings.server_now - Date.now();
  const by = list => Object.fromEntries(list.map(x => [x.id, x]));
  S.idx = { users: by(b.users), svc: by(b.serviceLines), clients: by(b.clients), projects: by(b.projects), tasks: by(b.tasks) };
  return b;
}

export const me = () => S.boot.me;
export const isAdmin = () => me().role === 'admin';
export const isMgr = () => ['ae', 'acct'].includes(me().role);
export const roleName = r => S.boot.roles[r] || r;
export const user = id => S.idx.users[id] || null;
export const userName = id => (user(id) || { name: 'Unassigned' }).name;
export const svc = id => S.idx.svc[id] || { id, name: 'Unknown', color: '#868E96' };
export const client = id => S.idx.clients[id] || null;
export const project = id => S.idx.projects[id] || null;
export const settings = () => S.boot.settings;
export const today = () => S.boot.settings.today;
export const thisWeek = () => weekStart(today());
export const now = () => Date.now() + S.clockSkew;
export const activeUsers = () => S.boot.users.filter(u => !u.archived_at);
export const activeServices = () => S.boot.serviceLines.filter(s => !s.archived_at);

/** Task with its project, client and service line. */
export function taskCtx(id) {
  const t = S.idx.tasks[id]; if (!t) return null;
  const p = project(t.project_id), c = p && client(p.client_id);
  return { t, p, c, sl: svc(t.service_line_id) };
}
export const isDone = t => t.status === 'done';
export const isLocked = t => t.budget_minutes > 0 && t.logged_minutes >= t.budget_minutes;
export const openForTime = t => { const x = taskCtx(t.id); return !isDone(t) && x && x.c && !x.c.archived_at; };
export function dueBucket(t) {
  if (!t.due_date) return 'none';
  const d = today();
  if (t.due_date < d) return 'past';
  if (t.due_date === d) return 'today';
  if (t.due_date <= addDays(weekStart(d), 6)) return 'week';
  return 'later';
}
/** Wireframe canSeeTimesheet, for showing UI only; the server enforces it. */
export function canSeeTimesheet(u) {
  if (!u) return false;
  if (u.id === me().id || isAdmin()) return true;
  if (isMgr() && u.role !== 'admin') return true;
  return !!(u.dept_id && svc(u.dept_id).manager_id === me().id);
}
export const teamPeople = () => activeUsers().filter(u => u.id !== me().id && canSeeTimesheet(u));
export const hasApprovals = () => isAdmin() || S.boot.clients.some(c => c.owner_id === me().id) || S.boot.serviceLines.some(s => s.manager_id === me().id) || S.boot.counts.approvals > 0;
export const capacityMinutes = (u, ws) => (u.capacity || [480, 480, 480, 480, 480, 0, 0]).reduce((a, b) => a + b, 0) + (ws ? 0 : 0);
