// Paymo REST API v3 client and normalizer.
// Docs: https://github.com/paymoapp/api — Basic auth with the API key as the username and any password;
// list responses are wrapped in a plural key ({"users":[...]}); datetimes are UTC; entry durations are seconds.
import { bad } from '../http.js';
import { addDays } from '../../public/js/shared/time.js';

const baseUrl = () => (process.env.PAYMO_BASE_URL || 'https://app.paymoapp.com/api').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(apiKey, path, { log } = {}) {
  const url = baseUrl() + path;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(`${apiKey}:x`).toString('base64') } });
    } catch (e) {
      if (attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      throw bad(`Couldn’t reach Paymo (${e.cause?.code || e.message}). Check the network, or import a CSV export instead.`);
    }
    if (res.status === 429 && attempt < 6) {
      const wait = Math.min(60, +res.headers.get('retry-after') || 5);
      log && log(`Paymo rate limit reached; waiting ${wait}s`);
      await sleep(wait * 1000); continue;
    }
    if (res.status >= 500 && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
    if (res.status === 401 || res.status === 403) throw bad('Paymo didn’t accept that API key. Create one under My Account in Paymo and paste it again.');
    if (!res.ok) throw bad(`Paymo answered ${res.status} for ${path.split('?')[0]}.`);
    return res.json();
  }
}

/** Month-sized windows between two dates, as Paymo time_interval filters (UTC, widened a day each side). */
function windows(from, to) {
  const out = []; let a = addDays(from, -1);
  const end = addDays(to, 2);
  while (a < end) {
    const [y, m] = a.split('-').map(Number);
    let b = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    if (b > end) b = end;
    out.push([a, b]); a = b;
  }
  return out;
}

/** Pull everything the importer needs. Entries come month by month to keep each response small. */
export async function fetchPaymo({ apiKey, from, to, log }) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) throw bad('Paste a Paymo API key.');
  // /me names the account; it isn't essential, and a bad key fails on the next call anyway.
  const me = await get(apiKey, '/me', { log }).catch(e => { if (/API key/.test(e.message)) throw e; return {}; });
  const [users, clients, projects, tasklists, tasks] = await Promise.all(
    ['users', 'clients', 'projects', 'tasklists', 'tasks'].map(k => get(apiKey, `/${k}`, { log }).then(r => r[k] || [])));
  const entries = [];
  for (const [a, b] of windows(from, to)) {
    const where = encodeURIComponent(`time_interval in ("${a}T00:00:00Z","${b}T00:00:00Z")`);
    const r = await get(apiKey, `/entries?where=${where}`, { log });
    entries.push(...(r.entries || []));
  }
  const byId = new Map(entries.map(e => [e.id, e]));
  return { account: (me.users && me.users[0] && me.users[0].email) || null, fetchedAt: new Date().toISOString(), from, to, users, clients, projects, tasklists, tasks, entries: [...byId.values()] };
}

/** A UTC timestamp as a date and clock time in the workspace time zone. */
export function localParts(isoUtc, timeZone) {
  const d = new Date(isoUtc);
  if (isNaN(d)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
const hours = h => (h == null || h === '' || !(+h > 0) ? null : Math.round(+h * 60));

/** Paymo records → the importer's common shape. */
export function normalizePaymo(raw, { timeZone, from, to }) {
  const pid = x => String(x);
  const users = raw.users.map(u => ({ pid: pid(u.id), paymoId: u.id, name: u.name || u.email, email: (u.email || '').toLowerCase() || null, active: u.active !== false, type: u.type || null }));
  const clients = raw.clients.map(c => ({ pid: pid(c.id), paymoId: c.id, name: c.name, active: c.active !== false }));
  const projects = raw.projects.map(p => ({ pid: pid(p.id), paymoId: p.id, clientPid: p.client_id != null ? pid(p.client_id) : null, name: p.name, active: p.active !== false, billable: p.billable }));
  const tasklists = raw.tasklists.map(l => ({ pid: pid(l.id), paymoId: l.id, projectPid: pid(l.project_id), name: l.name }));
  const listName = new Map(tasklists.map(l => [l.pid, l.name]));
  const projBillable = new Map(projects.map(p => [p.pid, p.billable]));
  const tasks = raw.tasks.map(t => ({
    pid: pid(t.id), paymoId: t.id, projectPid: pid(t.project_id), tasklistPid: t.tasklist_id != null ? pid(t.tasklist_id) : null,
    tasklistName: listName.get(pid(t.tasklist_id)) || '', name: t.name, complete: !!t.complete, dueDate: t.due_date || null,
    assigneePids: (t.users || []).map(pid), billable: t.billable ?? projBillable.get(pid(t.project_id)) ?? true, budgetMinutes: hours(t.budget_hours),
  }));
  const entries = [], problems = [];
  let skippedRunning = 0;
  for (const e of raw.entries) {
    let date, start = null, end = null, minutes;
    if (e.is_bulk || (e.date && !e.start_time)) {
      date = e.date; minutes = Math.round((+e.duration || 0) / 60);
    } else if (e.start_time && e.end_time) {
      const a = localParts(e.start_time, timeZone), b = localParts(e.end_time, timeZone);
      if (!a || !b) { problems.push({ line: `entry ${e.id}`, why: 'unreadable start or end time' }); continue; }
      date = a.date; start = a.hm; end = b.hm;
      minutes = Math.round((e.duration != null ? +e.duration : (Date.parse(e.end_time) - Date.parse(e.start_time)) / 1000) / 60);
      if (b.date !== a.date) end = '23:59'; // keep the entry on the day it started
    } else if (e.start_time && !e.end_time) { skippedRunning++; continue; }
    else { problems.push({ line: `entry ${e.id}`, why: 'no date or times' }); continue; }
    if (!date || date < from || date > to) continue;
    entries.push({ key: `paymo:${e.id}`, paymoId: e.id, taskPid: pid(e.task_id), userPid: pid(e.user_id), date, start, end, minutes, note: (e.description || '').replace(/<[^>]+>/g, '').trim(), line: `entry ${e.id}` });
  }
  return { users, clients, projects, tasklists, tasks, entries, problems, skippedRunning };
}
