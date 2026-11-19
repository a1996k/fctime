// Turn normalized Paymo data into a plan (what will be matched, created or skipped), preview it,
// and apply it in one transaction. Matched records are never changed; only new records are added,
// so running the same import again adds nothing, and a later run tops up what's new.
import crypto from 'node:crypto';
import { normalizeCsv, CSV_FIELDS } from './csv.js';
import { normalizePaymo } from './paymo.js';

const lower = s => String(s || '').trim().toLowerCase();
const PALETTE = ['#E8590C', '#1971C2', '#2B8A3E', '#7048E8', '#C2255C', '#0C8599', '#E67700', '#495057'];
const NO_CLIENT = '__none';
const isUUID = s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
function* chunks(list, size) { for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size); }

/** Link a matched record to its Paymo id, unless another record already has that id. */
async function linkPaymoId(c, table, column, paymoId, id) {
  if (await c.one(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [paymoId])) return 0;
  return (await c.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2 AND ${column} IS NULL`, [paymoId, id])).rowCount;
}

export function normalizeRun(run, settings) {
  if (run.source === 'paymo-csv') return normalizeCsv(run.raw, run.options || {});
  return normalizePaymo(run.raw, { timeZone: settings.time_zone, from: run.raw.from, to: run.raw.to });
}

/** Keyword match: the service line whose name or keywords appear as whole words in the text. Longest keyword wins. */
export function matchServiceLine(text, services) {
  const t = ` ${lower(text).replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null, bestLen = 0;
  for (const s of services) {
    const words = [s.name, ...String(s.match_keywords || '').split(',')].map(w => lower(w).replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
    for (const w of words) if (t.includes(` ${w} `) && w.length > bestLen) { best = s; bestLen = w.length; }
  }
  return best;
}

export async function buildPlan(c, data, options = {}) {
  // One query at a time: inside the import transaction these share a single connection.
  const dbUsers = await c.many('SELECT id, name, email, role, paymo_user_id, archived_at FROM users');
  const dbClients = await c.many('SELECT id, name, paymo_client_id, archived_at FROM clients');
  const dbProjects = await c.many('SELECT id, client_id, name, paymo_project_id FROM projects');
  const dbTasks = await c.many('SELECT id, project_id, title, paymo_task_id, budget_minutes FROM tasks');
  const services = await c.many('SELECT id, name, match_keywords, sort FROM service_lines WHERE archived_at IS NULL ORDER BY sort, name');
  const paymoIds = data.entries.filter(e => e.paymoId != null).map(e => e.paymoId);
  const keys = data.entries.filter(e => e.paymoId == null).map(e => e.key);
  const existing = new Set();
  for (const part of chunks(paymoIds, 5000)) {
    for (const r of await c.many('SELECT paymo_entry_id AS k FROM time_entries WHERE paymo_entry_id IN ($1)', [part])) existing.add(`paymo:${r.k}`);
  }
  for (const part of chunks(keys, 5000)) {
    for (const r of await c.many('SELECT import_key AS k FROM time_entries WHERE import_key IN ($1)', [part])) existing.add(r.k);
  }
  // Time imported earlier from the other source (a CSV, then the API at cutover, or the reverse)
  // shares no key with this run. Count it by person, task, date and minutes instead, so each
  // existing entry stands in for one incoming entry and the same time doesn't come in twice.
  const fromApi = new Map(), fromCsv = new Map();
  const dates = data.entries.map(e => e.date).filter(Boolean).sort();
  if (dates.length) {
    const rows = await c.many(`SELECT user_id, task_id, entry_date AS d, minutes, paymo_entry_id IS NOT NULL AS api FROM time_entries
                                WHERE source = 'import' AND entry_date BETWEEN $1 AND $2`, [dates[0], dates[dates.length - 1]]);
    for (const r of rows) { const m = r.api ? fromApi : fromCsv, k = `${r.user_id}|${r.task_id}|${r.d}|${r.minutes}`; m.set(k, (m.get(k) || 0) + 1); }
  }
  const entryStatus = options.entryStatus === 'draft' ? 'draft' : 'approved';
  const extraOpen = Math.max(0, Math.round(+options.extraOpenMinutes || 0));
  const defaultSvc = services.find(s => s.id === options.defaultServiceLineId) || services[0] || null;

  /* which tasks come in: open ones, and any with time in the range */
  const entriesByTask = new Map();
  for (const e of data.entries) { if (!entriesByTask.has(e.taskPid)) entriesByTask.set(e.taskPid, []); entriesByTask.get(e.taskPid).push(e); }
  const taskByPid = new Map(data.tasks.map(t => [t.pid, t]));
  const wantedTasks = data.tasks.filter(t => !t.complete || entriesByTask.has(t.pid));
  const projectByPid = new Map(data.projects.map(p => [p.pid, p]));
  const clientByPid = new Map(data.clients.map(x => [x.pid, x]));
  const userByPid = new Map(data.users.map(u => [u.pid, u]));

  /* people */
  const people = new Map();
  const personFor = pid => {
    if (people.has(pid)) return people.get(pid);
    const u = userByPid.get(pid) || { pid, paymoId: /^\d+$/.test(pid) ? +pid : null, name: `Paymo user ${pid}`, email: null, active: false, type: null };
    const m = (u.paymoId != null && dbUsers.find(x => x.paymo_user_id === u.paymoId)) || (u.email && dbUsers.find(x => lower(x.email) === u.email)) || dbUsers.find(x => lower(x.name) === lower(u.name));
    const choice = (options.userMap || {})[pid];
    let action, userId = null;
    if (choice === 'skip') action = 'skip';
    else if (choice === 'create') action = 'create';
    else if (isUUID(choice) && dbUsers.some(x => x.id === choice)) { action = 'match'; userId = choice; }
    else if (m) { action = 'match'; userId = m.id; }
    else action = 'create';
    const p = { ...u, action, userId, matchedBy: m && userId === m.id ? (u.paymoId != null && m.paymo_user_id === u.paymoId ? 'Paymo id' : u.email && lower(m.email) === u.email ? 'email' : 'name') : null, entries: 0, minutes: 0 };
    people.set(pid, p); return p;
  };

  /* clients, projects, tasks */
  const clients = new Map(), projects = new Map(), tasks = new Map();
  const clientFor = cpid => {
    const key = cpid && clientByPid.has(cpid) ? cpid : NO_CLIENT;
    if (clients.has(key)) return clients.get(key);
    const src = clientByPid.get(key) || { pid: NO_CLIENT, paymoId: null, name: 'Internal (no client in Paymo)', active: true };
    const m = (src.paymoId != null && dbClients.find(x => x.paymo_client_id === src.paymoId)) || dbClients.find(x => lower(x.name) === lower(src.name));
    const cl = { ...src, action: m ? 'match' : 'create', clientId: m ? m.id : null };
    clients.set(key, cl); return cl;
  };
  const projectFor = ppid => {
    if (projects.has(ppid)) return projects.get(ppid);
    const src = projectByPid.get(ppid); if (!src) return null;
    const cl = clientFor(src.clientPid);
    const m = (src.paymoId != null && dbProjects.find(x => x.paymo_project_id === src.paymoId)) || (cl.clientId && dbProjects.find(x => x.client_id === cl.clientId && lower(x.name) === lower(src.name)));
    const p = { ...src, client: cl, action: m ? 'match' : 'create', projectId: m ? m.id : null };
    projects.set(ppid, p); return p;
  };
  const svcMap = new Map(); // task list name -> decision
  const svcFor = t => {
    const key = lower(t.tasklistName);
    if (key) {
      if (!svcMap.has(key)) {
        const saved = (options.serviceLineMap || {})[key];
        const savedSvc = services.find(s => s.id === saved);
        const kw = matchServiceLine(t.tasklistName, services);
        svcMap.set(key, { key, name: t.tasklistName, serviceLineId: (savedSvc || kw || defaultSvc || {}).id || null, how: savedSvc ? 'chosen' : kw ? 'keyword' : 'default', tasks: 0, entries: 0 });
      }
      const d = svcMap.get(key); d.tasks++; d.entries += (entriesByTask.get(t.pid) || []).length;
      return d.serviceLineId;
    }
    const kw = matchServiceLine(t.name, services);
    return (kw || defaultSvc || {}).id || null;
  };
  const problems = [...(data.problems || [])];
  for (const t of wantedTasks) {
    const p = projectFor(t.projectPid);
    if (!p) { problems.push({ line: `task ${t.name}`, why: 'its project is missing from Paymo’s data' }); continue; }
    const m = (t.paymoId != null && dbTasks.find(x => x.paymo_task_id === t.paymoId)) || (p.projectId && dbTasks.find(x => x.project_id === p.projectId && lower(x.title) === lower(t.name)));
    const es = entriesByTask.get(t.pid) || [];
    const imported = es.filter(e => !existing.has(e.key)).reduce((a, e) => a + Math.min(1440, Math.max(0, e.minutes)), 0);
    const lastDate = es.reduce((a, e) => (e.date > a ? e.date : a), '');
    // Responsible person: Paymo's first assignee, else whoever logged the most time on it. Never a Paymo guest.
    const notGuest = u => !userByPid.has(u) || userByPid.get(u).type !== 'Guest';
    const counts = new Map(); es.filter(e => e.minutes >= 1 && notGuest(e.userPid)).forEach(e => counts.set(e.userPid, (counts.get(e.userPid) || 0) + e.minutes));
    const assigneePid = t.assigneePids.find(u => userByPid.has(u) && notGuest(u)) || [...counts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || null;
    if (assigneePid) personFor(assigneePid);
    tasks.set(t.pid, {
      ...t, project: p, action: m ? 'match' : 'create', taskId: m ? m.id : null, serviceLineId: svcFor(t), assigneePid,
      due: t.dueDate || lastDate || null, budget: t.budgetMinutes || Math.max(15, imported) + (t.complete ? 0 : extraOpen), budgetFromPaymo: !!t.budgetMinutes,
      status: t.complete ? 'done' : es.length ? 'doing' : 'todo',
    });
  }

  /* entries */
  const counts = { new: 0, minutes: 0, already: 0, skippedPerson: 0, unknownTask: 0, zero: 0, capped: 0, running: data.skippedRunning || 0, from: null, to: null };
  const newEntries = [];
  for (const e of data.entries) {
    if (existing.has(e.key)) { counts.already++; continue; }
    const t = tasks.get(e.taskPid);
    if (!t) { counts.unknownTask++; if (!taskByPid.has(e.taskPid)) problems.push({ line: e.line, why: 'its task isn’t in Paymo’s data' }); continue; }
    if (!(e.minutes >= 1)) { counts.zero++; continue; }
    const person = personFor(e.userPid);
    if (person.action === 'skip') { counts.skippedPerson++; continue; }
    const minutes = Math.min(1440, e.minutes);
    if (t.taskId && person.userId) {
      const other = e.paymoId != null ? fromCsv : fromApi, k = `${person.userId}|${t.taskId}|${e.date}|${minutes}`;
      if (other.get(k) > 0) { other.set(k, other.get(k) - 1); counts.already++; continue; }
    }
    if (minutes < e.minutes) counts.capped++;
    person.entries++; person.minutes += minutes;
    counts.new++; counts.minutes += minutes;
    if (!counts.from || e.date < counts.from) counts.from = e.date;
    if (!counts.to || e.date > counts.to) counts.to = e.date;
    newEntries.push({ ...e, minutes, task: t, person });
  }
  return { people, clients, projects, tasks, svcMap, newEntries, counts, problems, entryStatus, extraOpen, defaultSvc, services, dbUsers, columns: data.columns || null };
}

/** What the admin sees before importing. */
export function previewOf(plan, run) {
  const list = m => [...m.values()];
  const tasks = list(plan.tasks);
  const csv = run.source === 'paymo-csv' ? {
    headers: run.raw.rows[0], columns: { ...plan.columns }, dateFormat: run.options.dateFormat || 'mdy',
    fields: Object.fromEntries(Object.entries(CSV_FIELDS).map(([k, v]) => [k, { label: v.label, required: !!v.required }])),
    sample: run.raw.rows.slice(1, 6), rows: run.raw.rows.length - 1,
  } : null;
  return {
    id: run.id, source: run.source, label: run.label, status: run.status, created_at: run.created_at, csv,
    range: run.source === 'paymo-api' ? { from: run.raw.from, to: run.raw.to, account: run.raw.account } : null,
    options: { entryStatus: plan.entryStatus, extraOpenMinutes: plan.extraOpen, defaultServiceLineId: plan.defaultSvc ? plan.defaultSvc.id : null },
    people: list(plan.people).filter(p => p.entries || p.action !== 'skip' || (run.options.userMap || {})[p.pid]).map(p => ({ pid: p.pid, name: p.name, email: p.email, type: p.type, active: p.active, action: p.action, userId: p.userId, matchedBy: p.matchedBy, entries: p.entries, minutes: p.minutes }))
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    serviceLines: list(plan.svcMap).sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name)),
    clients: { create: list(plan.clients).filter(x => x.action === 'create').map(x => x.name).sort(), match: list(plan.clients).filter(x => x.action === 'match').length },
    projects: { create: list(plan.projects).filter(x => x.action === 'create').map(x => ({ name: x.name, client: x.client.name })), match: list(plan.projects).filter(x => x.action === 'match').length },
    tasks: { create: tasks.filter(t => t.action === 'create').length, match: tasks.filter(t => t.action === 'match').length,
      noBudget: tasks.filter(t => t.action === 'create' && !t.budgetFromPaymo).length, noBudgetOpen: tasks.filter(t => t.action === 'create' && !t.budgetFromPaymo && !t.complete).length,
      noDue: tasks.filter(t => t.action === 'create' && !t.dueDate).length },
    entries: plan.counts,
    problems: plan.problems.slice(0, 25), problemCount: plan.problems.length,
    services: plan.services.map(s => ({ id: s.id, name: s.name })),
    existingPeople: plan.dbUsers.filter(u => !u.archived_at).map(u => ({ id: u.id, name: u.name, email: u.email })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Apply a plan. Call inside a transaction with a fresh plan. */
export async function commitPlan(c, plan, actor, runId, today) {
  const sum = { peopleCreated: 0, peopleLinked: 0, clientsCreated: 0, projectsCreated: 0, tasksCreated: 0, entriesImported: 0, minutes: 0, placeholderEmails: 0 };
  /* people */
  const userIdOf = new Map();
  for (const p of plan.people.values()) {
    if (p.action === 'skip') continue;
    if (p.action === 'match') {
      userIdOf.set(p.pid, p.userId);
      if (p.paymoId != null) sum.peopleLinked += await linkPaymoId(c, 'users', 'paymo_user_id', p.paymoId, p.userId);
      continue;
    }
    if (!p.entries && !(plan.tasks.size && [...plan.tasks.values()].some(t => t.assigneePid === p.pid))) continue;
    let email = p.email;
    if (!email || await c.one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) {
      email = `${lower(p.name).replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'person'}.${crypto.randomBytes(3).toString('hex')}@import.invalid`;
      sum.placeholderEmails++;
    }
    const id = crypto.randomUUID();
    await c.query(`INSERT INTO users (id, name, email, role, paymo_user_id, archived_at) VALUES ($1, $2, $3, 'member', $4, $5)`,
      [id, p.name, email, p.paymoId, p.active ? null : new Date()]);
    userIdOf.set(p.pid, id); sum.peopleCreated++;
  }
  /* clients */
  let color = (await c.one('SELECT COUNT(*) AS n FROM clients')).n;
  for (const cl of plan.clients.values()) {
    if (cl.action === 'match') {
      if (cl.paymoId != null) await linkPaymoId(c, 'clients', 'paymo_client_id', cl.paymoId, cl.clientId);
      continue;
    }
    // Paymo allows two clients whose names differ only in case; here names are unique, so they share one.
    const same = await c.one('SELECT id FROM clients WHERE lower(name) = lower($1)', [cl.name]);
    if (same) { cl.clientId = same.id; continue; }
    cl.clientId = crypto.randomUUID();
    await c.query(`INSERT INTO clients (id, name, color, paymo_client_id, archived_at) VALUES ($1, $2, $3, $4, $5)`,
      [cl.clientId, cl.name, PALETTE[color++ % PALETTE.length], cl.paymoId, cl.active ? null : new Date()]);
    sum.clientsCreated++;
  }
  /* projects */
  for (const p of plan.projects.values()) {
    if (p.action === 'match') {
      if (p.paymoId != null) await linkPaymoId(c, 'projects', 'paymo_project_id', p.paymoId, p.projectId);
      continue;
    }
    // Two Paymo projects can share a name under one client; keep both by numbering the second.
    let name = p.name, n = 1;
    while (await c.one('SELECT 1 FROM projects WHERE client_id = $1 AND lower(name) = lower($2)', [p.client.clientId, name])) name = `${p.name} (${++n})`;
    p.projectId = crypto.randomUUID();
    await c.query(`INSERT INTO projects (id, client_id, name, kind, status, paymo_project_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.projectId, p.client.clientId, name, /retainer/i.test(p.name) ? 'retainer' : 'project', p.active ? 'active' : 'done', p.paymoId]);
    sum.projectsCreated++;
  }
  /* tasks */
  for (const t of plan.tasks.values()) {
    if (t.action === 'match') {
      if (t.paymoId != null) await linkPaymoId(c, 'tasks', 'paymo_task_id', t.paymoId, t.taskId);
      continue;
    }
    if (!t.serviceLineId) throw new Error('No service line to put imported tasks on. Add a service line first.');
    t.taskId = crypto.randomUUID();
    await c.query(`INSERT INTO tasks (id, project_id, service_line_id, title, assignee_id, status, due_date, budget_minutes, billable, notes, paymo_task_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [t.taskId, t.project.projectId, t.serviceLineId, t.name.slice(0, 200), userIdOf.get(t.assigneePid) || null, t.status, t.due || today, t.budget, t.billable !== false,
      t.tasklistName ? `Imported from Paymo, task list “${t.tasklistName}”.` : 'Imported from Paymo.', t.paymoId, actor.id]);
    sum.tasksCreated++;
  }
  /* entries, in batches; each takes its task's service line and billable flag */
  const rows = plan.newEntries.filter(e => userIdOf.get(e.person.pid) && e.task.taskId);
  const taskInfo = new Map();
  for (const part of chunks([...new Set(rows.map(e => e.task.taskId))], 5000)) {
    for (const t of await c.many('SELECT id, service_line_id, billable FROM tasks WHERE id IN ($1)', [part])) taskInfo.set(t.id, t);
  }
  const submittedAt = plan.entryStatus === 'approved' ? new Date() : null;
  const detail = JSON.stringify({ runId, status: plan.entryStatus });
  for (const part of chunks(rows, 1000)) {
    const b = part.map(e => ({ id: crypto.randomUUID(), e, t: taskInfo.get(e.task.taskId) }));
    // A row whose Paymo id or CSV key is already here is left alone (the import is safe to run twice).
    await c.query(`INSERT INTO time_entries (id, user_id, task_id, entry_date, start_time, end_time, minutes, note, status, source,
        paymo_entry_id, import_key, submitted_at, service_line_id, billable) VALUES $1 ON DUPLICATE KEY UPDATE id = id`,
    [b.map(({ id, e, t }) => [id, userIdOf.get(e.person.pid), e.task.taskId, e.date, e.start || null, e.end || null, e.minutes, e.note || '',
      plan.entryStatus, 'import', e.paymoId ?? null, e.paymoId == null ? e.key : null, submittedAt, t.service_line_id, t.billable])]);
    const ins = await c.many('SELECT id, minutes FROM time_entries WHERE id IN ($1)', [b.map(x => x.id)]);
    if (ins.length) {
      await c.query('INSERT INTO time_entry_events (entry_id, action, actor_id, detail) VALUES $1', [ins.map(r => [r.id, 'imported', actor.id, detail])]);
    }
    sum.entriesImported += ins.length; sum.minutes += ins.reduce((a, r) => a + r.minutes, 0);
  }
  return sum;
}
