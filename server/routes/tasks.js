// Tasks, time budgets, and requests for more hours.
import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { h, bad, notFound, forbidden, uuidParam, str, isUUID } from '../http.js';
import { requireUser, requireAdmin } from '../auth.js';
import { isAdmin, TASK_STATUSES, loggedMinutes, visibleEntrySql, ENTRY_JOINS } from '../domain.js';
import { isISODate, parseDuration } from '../../public/js/shared/time.js';

const r = Router();
r.use(requireUser);

/** Budget input: '12', '12.5', '1:30' hours, or budgetMinutes. */
function budgetMinutes(b) {
  if (b.budgetMinutes !== undefined) return Number.isInteger(b.budgetMinutes) ? b.budgetMinutes : NaN;
  if (b.budget === undefined || b.budget === '' || b.budget === null) return null;
  return parseDuration(String(b.budget));
}

async function readTask(b, existing) {
  const o = {};
  const want = k => !existing || b[k] !== undefined;
  if (want('title')) o.title = str(b.title, { label: 'Task name', required: true, max: 200 });
  if (want('serviceLineId')) {
    if (!isUUID(b.serviceLineId)) throw bad('Choose a service line.', { field: 'serviceLineId' });
    const sl = await one('SELECT archived_at FROM service_lines WHERE id = $1', [b.serviceLineId]);
    if (!sl) throw bad('Choose a service line.', { field: 'serviceLineId' });
    if (sl.archived_at && (!existing || existing.service_line_id !== b.serviceLineId)) throw bad('That service line is archived.');
    o.service_line_id = b.serviceLineId;
  }
  if (want('assigneeId')) {
    if (!isUUID(b.assigneeId)) throw bad('Choose who is responsible.', { field: 'assigneeId' });
    const u = await one('SELECT archived_at FROM users WHERE id = $1', [b.assigneeId]);
    if (!u || (u.archived_at && (!existing || existing.assignee_id !== b.assigneeId))) throw bad('Choose an active person.', { field: 'assigneeId' });
    o.assignee_id = b.assigneeId;
  }
  if (want('status')) { const s = b.status ?? 'todo'; if (!TASK_STATUSES.includes(s)) throw bad('Choose a status.'); o.status = s; }
  if (want('dueDate')) { if (!isISODate(b.dueDate)) throw bad('Set a due date.', { field: 'dueDate' }); o.due_date = b.dueDate; }
  if (b.startDate !== undefined) { if (b.startDate && !isISODate(b.startDate)) throw bad('Start date isn’t valid.'); o.start_date = b.startDate || null; }
  if (b.billable !== undefined) o.billable = !!b.billable;
  if (b.notes !== undefined) o.notes = str(b.notes, { label: 'Notes', max: 5000 });
  return o;
}

r.post('/tasks', h(async (req, res) => {
  const projectId = uuidParam(req.body.projectId, 'project');
  const p = await one('SELECT p.id, c.archived_at FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = $1', [projectId]);
  if (!p) throw bad('Choose a project.');
  if (p.archived_at) throw bad('This client is archived. Restore it to add tasks.');
  const o = await readTask(req.body, null);
  const bm = budgetMinutes(req.body);
  if (!(bm > 0)) throw bad('Set a time budget, like 4 or 1:30 hours.', { field: 'budget' });
  if (o.start_date && o.start_date > o.due_date) throw bad('The due date is before the start date.');
  const row = await one(`INSERT INTO tasks (project_id, service_line_id, title, assignee_id, status, start_date, due_date, budget_minutes, billable, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, true), COALESCE($10, ''), $11) RETURNING id`,
  [projectId, o.service_line_id, o.title, o.assignee_id, o.status, o.start_date || null, o.due_date, bm, o.billable ?? null, o.notes ?? null, req.user.id]);
  res.status(201).json({ id: row.id });
}));

r.patch('/tasks/:id', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  await tx(async c => {
    const t = await c.one('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('That task doesn’t exist.');
    const o = await readTask(req.body, t);
    const bm = budgetMinutes(req.body);
    if (bm !== null && bm !== t.budget_minutes) {
      // Only admins change a budget after the task exists; everyone else asks for more hours.
      if (!isAdmin(req.user)) throw forbidden('Only admins change a task’s time budget. Ask for more time instead.');
      if (!(bm > 0)) throw bad('Set a time budget, like 4 or 1:30 hours.');
      o.budget_minutes = bm;
      await c.query('INSERT INTO task_budget_log (task_id, minutes, reason, actor_id) VALUES ($1, $2, $3, $4)',
        [id, bm - t.budget_minutes, 'Edited on the task', req.user.id]);
    }
    const start = o.start_date !== undefined ? o.start_date : t.start_date, due = o.due_date || t.due_date;
    if (start && start > due) throw bad('The due date is before the start date.');
    const keys = Object.keys(o);
    if (keys.length) {
      await c.query(`UPDATE tasks SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`, [...keys.map(k => o[k]), id]);
    }
  });
  res.json({ ok: true });
}));

r.delete('/tasks/:id', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  await tx(async c => {
    const t = await c.one('SELECT created_by FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound();
    if (!isAdmin(req.user) && t.created_by !== req.user.id) throw forbidden('Only admins and the person who added the task can delete it.');
    if (await c.one('SELECT 1 FROM time_entries WHERE task_id = $1 LIMIT 1', [id])) throw bad('Tasks with logged time can’t be deleted. Move it to Done instead.');
    if (await c.one('SELECT 1 FROM timers WHERE task_id = $1', [id])) throw bad('Someone has a timer running on this task.');
    await c.query('DELETE FROM hours_requests WHERE task_id = $1', [id]);
    await c.query('DELETE FROM task_budget_log WHERE task_id = $1', [id]);
    await c.query('DELETE FROM tasks WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

r.get('/tasks/:id/time', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const t = await one('SELECT id, budget_minutes FROM tasks WHERE id = $1', [id]);
  if (!t) throw notFound();
  const [entries, budgetLog, requests] = await Promise.all([
    // Same visibility as reports: team members see their own entries here; the logged total still counts everyone.
    many(`SELECT e.id, e.user_id, eu.name AS user_name, e.entry_date::text AS date, e.minutes, e.note, e.status
            FROM time_entries e ${ENTRY_JOINS} WHERE e.task_id = $1 AND ${visibleEntrySql(req.user, 2)}
           ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 50`, isAdmin(req.user) ? [id] : [id, req.user.id]),
    many(`SELECT b.minutes, b.reason, b.at, u.name AS actor_name FROM task_budget_log b JOIN users u ON u.id = b.actor_id WHERE b.task_id = $1 ORDER BY b.at DESC`, [id]),
    many(`SELECT q.id, q.minutes, q.reason, q.status, q.created_at, u.name AS requested_by_name FROM hours_requests q JOIN users u ON u.id = q.requested_by
           WHERE q.task_id = $1 ${isAdmin(req.user) ? '' : 'AND q.requested_by = $2'} ORDER BY q.created_at DESC`, isAdmin(req.user) ? [id] : [id, req.user.id]),
  ]);
  res.json({ logged: await loggedMinutes({ one }, id), budget: t.budget_minutes, entries, budgetLog, requests });
}));

/* ---------- more time ---------- */
function readExtra(b) {
  const m = b.minutes !== undefined ? b.minutes : parseDuration(String(b.hours ?? ''));
  if (!Number.isInteger(m) || m < 1 || m > 1000 * 60) throw bad('Enter the extra hours, like 2 or 1:30.', { field: 'hours' });
  const reason = str(b.reason, { label: 'Reason', required: true, max: 1000 });
  return { minutes: m, reason };
}
// Admins add hours straight to the budget (wireframe "Add to the time budget").
r.post('/tasks/:id/budget', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const { minutes, reason } = readExtra(req.body);
  const out = await tx(async c => {
    const t = await c.one('SELECT budget_minutes FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound();
    await c.query('UPDATE tasks SET budget_minutes = budget_minutes + $1, updated_at = now() WHERE id = $2', [minutes, id]);
    await c.query('INSERT INTO task_budget_log (task_id, minutes, reason, actor_id) VALUES ($1, $2, $3, $4)', [id, minutes, reason, req.user.id]);
    return { budget: t.budget_minutes + minutes };
  });
  res.json(out);
}));
// Everyone else asks; an admin approves.
r.post('/tasks/:id/hours-requests', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const { minutes, reason } = readExtra(req.body);
  if (!(await one('SELECT 1 FROM tasks WHERE id = $1', [id]))) throw notFound();
  if (await one(`SELECT 1 FROM hours_requests WHERE task_id = $1 AND requested_by = $2 AND status = 'pending'`, [id, req.user.id])) {
    throw bad('You already have a request waiting on this task.');
  }
  const q = await one('INSERT INTO hours_requests (task_id, requested_by, minutes, reason) VALUES ($1, $2, $3, $4) RETURNING id', [id, req.user.id, minutes, reason]);
  res.status(201).json({ id: q.id });
}));
r.get('/hours-requests', h(async (req, res) => {
  const admin = isAdmin(req.user);
  const rows = await many(`
    SELECT q.id, q.task_id, q.minutes, q.reason, q.status, q.created_at, q.decided_at, q.decision_note,
           q.requested_by, ru.name AS requested_by_name, du.name AS decided_by_name,
           t.title AS task_title, t.budget_minutes, COALESCE(l.m, 0)::int AS logged_minutes,
           p.name AS project_name, c.name AS client_name
      FROM hours_requests q
      JOIN tasks t ON t.id = q.task_id JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id
      JOIN users ru ON ru.id = q.requested_by LEFT JOIN users du ON du.id = q.decided_by
      LEFT JOIN (SELECT task_id, SUM(minutes) AS m FROM time_entries GROUP BY task_id) l ON l.task_id = t.id
     ${admin ? '' : 'WHERE q.requested_by = $1'}
     ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT 200`, admin ? [] : [req.user.id]);
  res.json(rows);
}));
r.post('/hours-requests/:id/:decision', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id), d = req.params.decision;
  if (!['approve', 'decline'].includes(d)) throw notFound();
  const note = str(req.body.note, { label: 'Note', max: 1000 });
  if (d === 'decline' && !note) throw bad('Say why you’re declining.', { field: 'note' });
  await tx(async c => {
    const q = await c.one('SELECT * FROM hours_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!q) throw notFound();
    if (q.status !== 'pending') throw bad('That request was already decided.');
    await c.query(`UPDATE hours_requests SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4`,
      [d === 'approve' ? 'approved' : 'declined', req.user.id, note || null, id]);
    if (d === 'approve') {
      await c.query('UPDATE tasks SET budget_minutes = budget_minutes + $1, updated_at = now() WHERE id = $2', [q.minutes, q.task_id]);
      await c.query('INSERT INTO task_budget_log (task_id, minutes, reason, actor_id, request_id) VALUES ($1, $2, $3, $4, $5)',
        [q.task_id, q.minutes, q.reason, req.user.id, id]);
    }
  });
  res.json({ ok: true });
}));

export default r;
