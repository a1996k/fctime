// Timer, time entries, weekly submission, two-step approval, team week.
import crypto from 'node:crypto';
import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { h, bad, conflict, notFound, forbidden, uuidParam, str, isUUID } from '../http.js';
import { requireUser } from '../auth.js';
import {
  getSettings, taskForTime, loggedMinutes, isLocked, assertTaskOpenForTime, assertWithinBudget, findOverlaps,
  logEvent, stopTimerRow, entryById, ENTRY_COLUMNS, ENTRY_JOINS, visibleEntrySql, canSeeTimesheet,
  canActOn, stepScopeSql, assertReason, isAdmin, otherAdminExists,
} from '../domain.js';
import { parseDuration, fromHM, isISODate, addDays, dow, weekStart } from '../../public/js/shared/time.js';
import { notifySubmitted, notifyDecision, checkBudget } from '../notify.js';

const r = Router();
r.use(requireUser);

/* ---------- timer ---------- */
const timerJson = t => t && ({ id: t.id, task_id: t.task_id, note: t.note, started_at: t.started_at, started_ms: Number(t.started_ms) });
const TIMER_SQL = `SELECT id, task_id, note, started_at, (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_ms FROM timers`;

r.get('/timer', h(async (req, res) => {
  res.json({ timer: timerJson(await one(`${TIMER_SQL} WHERE user_id = $1`, [req.user.id])), server_now: Date.now() });
}));

/**
 * Start a timer. The browser sends a fresh timerId so a retried start is a no-op.
 * A running timer is stopped first and saved as a draft entry (wireframe startTimer).
 */
r.post('/timer/start', h(async (req, res) => {
  const taskId = uuidParam(req.body.taskId, 'task');
  const timerId = req.body.timerId ? uuidParam(req.body.timerId, 'timer') : crypto.randomUUID();
  const note = str(req.body.note, { label: 'Note', max: 1000 });
  const out = await tx(async c => {
    const settings = await getSettings(c);
    // Serialize start/stop for this person.
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    // A retried start returns the same timer, but only to its owner.
    const same = await c.one(`${TIMER_SQL} WHERE id = $1 AND user_id = $2`, [timerId, req.user.id]);
    if (same) {
      if (same.task_id !== taskId) throw conflict('That timer is already running on another task.');
      return { timer: timerJson(same), stopped: null, repeated: true };
    }
    if (await c.one('SELECT 1 FROM timers WHERE id = $1', [timerId]) || await c.one('SELECT 1 FROM time_entries WHERE source_timer_id = $1', [timerId])) {
      throw conflict('That timer id was already used. Try again.');
    }
    const t = await taskForTime(c, taskId, { lock: true });
    assertTaskOpenForTime(t);
    const logged = await loggedMinutes(c, taskId);
    if (isLocked(logged, t.budget_minutes)) {
      throw conflict('This task is over its time budget.', { code: 'budget_locked', taskId, logged, budget: t.budget_minutes });
    }
    let stopped = null;
    const prev = await c.one('SELECT * FROM timers WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (prev) { stopped = await stopTimerRow(c, prev, settings, req.user.id); await checkBudget(c, prev.task_id, settings.budget_alert_pct); }
    await c.query('INSERT INTO timers (id, user_id, task_id, note) VALUES ($1, $2, $3, $4)', [timerId, req.user.id, taskId, note]);
    return { timer: timerJson(await c.one(`${TIMER_SQL} WHERE id = $1`, [timerId])), stopped };
  });
  if (out.stopped) out.stopped.entry = await entryById({ one }, out.stopped.entryId);
  res.status(out.repeated ? 200 : 201).json(out);
}));

/**
 * Stop a timer. Safe to retry: the first call creates the entry; later calls with the same timerId
 * return that same entry with alreadyStopped: true.
 */
r.post('/timer/stop', h(async (req, res) => {
  const timerId = uuidParam(req.body.timerId, 'timer');
  const out = await tx(async c => {
    const settings = await getSettings(c);
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const timer = await c.one('SELECT * FROM timers WHERE id = $1 FOR UPDATE', [timerId]);
    if (!timer) {
      const e = await c.one('SELECT id, minutes FROM time_entries WHERE source_timer_id = $1 AND user_id = $2', [timerId, req.user.id]);
      if (!e) throw notFound('No timer is running.');
      return { entryId: e.id, minutes: e.minutes, alreadyStopped: true, overlaps: [] };
    }
    if (timer.user_id !== req.user.id) throw notFound('No timer is running.');
    const out = { ...(await stopTimerRow(c, timer, settings, req.user.id)), alreadyStopped: false };
    await checkBudget(c, timer.task_id, settings.budget_alert_pct);
    return out;
  });
  out.entry = await entryById({ one }, out.entryId);
  res.json(out);
}));

/* ---------- entries ---------- */
r.get('/entries', h(async (req, res) => {
  const userId = req.query.user ? uuidParam(req.query.user, 'user') : req.user.id;
  const from = req.query.from, to = req.query.to;
  if (!isISODate(from) || !isISODate(to) || to < from) throw bad('Give a valid date range.');
  if (!(await canSeeTimesheet(req.user, userId))) throw forbidden('You can’t see that timesheet.');
  const rows = await many(`SELECT ${ENTRY_COLUMNS}, au.name AS ae_by_name, du.name AS dept_by_name, ru.name AS rejected_by_name
      FROM time_entries e ${ENTRY_JOINS}
      LEFT JOIN users au ON au.id = e.ae_by LEFT JOIN users du ON du.id = e.dept_by LEFT JOIN users ru ON ru.id = e.rejected_by
     WHERE e.user_id = $1 AND e.entry_date BETWEEN $2 AND $3
     ORDER BY e.entry_date, e.start_time NULLS LAST, e.created_at`, [userId, from, to]);
  res.json(rows);
}));

/** Live overlap check for the entry form: warns before saving; saving is still allowed. */
r.get('/entries/overlaps', h(async (req, res) => {
  const { date, start, end, exclude } = req.query;
  if (!isISODate(date) || fromHM(start) == null || fromHM(end) == null) throw bad('Give a date, start and end.');
  if (exclude && !isUUID(exclude)) throw bad('Invalid entry.');
  const a = fromHM(start), b = fromHM(end);
  res.json(b > a ? await findOverlaps({ many }, req.user.id, date, start, end, b - a, exclude || null) : []);
}));

r.get('/entries/:id/history', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const e = await one(`SELECT e.user_id FROM time_entries e ${ENTRY_JOINS} WHERE e.id = $1 AND ${visibleEntrySql(req.user, 2)}`, isAdmin(req.user) ? [id] : [id, req.user.id]);
  if (!e) throw notFound();
  res.json(await many(`SELECT v.action, v.step, v.at, v.reason, v.detail, u.name AS actor_name FROM time_entry_events v JOIN users u ON u.id = v.actor_id WHERE v.entry_id = $1 ORDER BY v.at, v.id`, [id]));
}));

/**
 * Validate the entry form. Start and end, or a total like 1:30 / 1.5 (wireframe saveEntry2).
 * When editing and the start and end are unchanged, the stored minutes stand: that keeps a timer
 * entry's rounding, and lets timer entries that crossed midnight or lasted under a minute be re-saved.
 */
function readEntry(b, today, existing = null) {
  const out = { date: b.date, note: str(b.note, { label: 'Note', max: 1000 }), start: null, end: null };
  if (!isISODate(b.date)) throw bad('Pick a date.', { field: 'date' });
  if (b.date > addDays(today, 7)) throw bad('Time can’t be logged more than a week ahead.', { field: 'date' });
  if (b.date < '2000-01-01') throw bad('Pick a date from this century.', { field: 'date' });
  if (!isUUID(b.taskId)) throw bad('Pick the task the time goes on.', { field: 'taskId' });
  out.taskId = b.taskId;
  if (b.start || b.end) {
    const a = fromHM(b.start), z = fromHM(b.end);
    if (a == null) throw bad('Enter when you started.', { field: 'start' });
    if (z == null) throw bad('Enter when you stopped.', { field: 'end' });
    out.start = b.start.slice(0, 5); out.end = b.end.slice(0, 5);
    if (existing && existing.start === out.start && existing.end === out.end) { out.minutes = existing.minutes; return out; }
    if (z <= a) throw bad('The end time has to be later than the start time.', { field: 'end' });
    out.minutes = z - a;
  } else {
    const m = Number.isInteger(b.minutes) ? b.minutes : parseDuration(b.duration);
    if (!m || m < 1 || m > 1440) throw bad('Enter the time as 1:30 or 1.5 hours.', { field: 'duration' });
    out.minutes = m;
  }
  return out;
}

r.post('/entries', h(async (req, res) => {
  const o = readEntry(req.body, (await getSettings()).today);
  const out = await tx(async c => {
    const t = await taskForTime(c, o.taskId, { lock: true });
    assertTaskOpenForTime(t);
    await assertWithinBudget(c, t, o.minutes);
    const overlaps = await findOverlaps(c, req.user.id, o.date, o.start, o.end, o.minutes);
    const e = await c.one(`INSERT INTO time_entries (user_id, task_id, entry_date, start_time, end_time, minutes, note, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual') RETURNING id`, [req.user.id, o.taskId, o.date, o.start, o.end, o.minutes, o.note]);
    await logEvent(c, e.id, 'created', req.user.id, { detail: { source: 'manual', minutes: o.minutes } });
    await checkBudget(c, o.taskId, (await getSettings(c)).budget_alert_pct);
    return { id: e.id, overlaps };
  });
  res.status(201).json({ ...out, entry: await entryById({ one }, out.id) });
}));

/** Only the person who logged it changes it, and only while it’s a draft or sent back. */
async function ownEditable(c, id, userId) {
  const e = await c.one('SELECT * FROM time_entries WHERE id = $1 FOR UPDATE', [id]);
  if (!e) throw notFound('That entry doesn’t exist.');
  if (e.user_id !== userId) throw forbidden('Only the person who logged this time can change it.');
  if (!['draft', 'rejected'].includes(e.status)) throw forbidden('Submitted time can’t be changed unless it’s sent back.');
  return e;
}

r.patch('/entries/:id', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const today = (await getSettings()).today;
  const out = await tx(async c => {
    const e = await ownEditable(c, id, req.user.id);
    const o = readEntry(req.body, today, e.start_time ? { start: e.start_time.slice(0, 5), end: e.end_time.slice(0, 5), minutes: e.minutes } : null);
    const t = await taskForTime(c, o.taskId, { lock: true });
    if (o.taskId !== e.task_id) assertTaskOpenForTime(t);
    // Only added minutes count against the budget, so time already over it can still be corrected.
    await assertWithinBudget(c, t, o.minutes, o.taskId === e.task_id ? e.minutes : 0);
    const overlaps = await findOverlaps(c, req.user.id, o.date, o.start, o.end, o.minutes, id);
    // Editing returns a sent-back entry to draft; the reason stays on record until it’s resubmitted.
    await c.query(`UPDATE time_entries SET task_id = $1, entry_date = $2, start_time = $3, end_time = $4, minutes = $5, note = $6,
                   status = 'draft', updated_at = now() WHERE id = $7`, [o.taskId, o.date, o.start, o.end, o.minutes, o.note, id]);
    await checkBudget(c, o.taskId, (await getSettings(c)).budget_alert_pct);
    await logEvent(c, id, 'updated', req.user.id, {
      detail: { from: { taskId: e.task_id, date: e.entry_date, minutes: e.minutes, status: e.status }, to: { taskId: o.taskId, date: o.date, minutes: o.minutes } },
    });
    return { id, overlaps };
  });
  res.json({ ...out, entry: await entryById({ one }, id) });
}));

r.delete('/entries/:id', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  await tx(async c => {
    const e = await ownEditable(c, id, req.user.id);
    await c.query('DELETE FROM time_entries WHERE id = $1', [id]);
    await logEvent(c, id, 'deleted', req.user.id, { detail: { taskId: e.task_id, date: e.entry_date, minutes: e.minutes } });
  });
  res.json({ ok: true });
}));

/* ---------- submit the week ---------- */
r.post('/timesheets/submit', h(async (req, res) => {
  const ws = req.body.weekStart;
  if (!isISODate(ws) || dow(ws) !== 0) throw bad('Give the Monday that starts the week.');
  const we = addDays(ws, 6);
  const out = await tx(async c => {
    const s = await getSettings(c);
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    // A running timer's time lands on the day it started; block only the week it will land in.
    const running = await c.one('SELECT (started_at AT TIME ZONE $2)::date::text AS d FROM timers WHERE user_id = $1', [req.user.id, s.time_zone]);
    if (running && running.d >= ws && running.d <= we) {
      throw conflict('Stop your timer first. A running timer would leave time out of this week.', { code: 'timer_running' });
    }
    const rows = await c.many(`UPDATE time_entries SET status = 'submitted', submitted_at = now(), updated_at = now(),
              ae_by = NULL, ae_at = NULL, dept_by = NULL, dept_at = NULL,
              rejected_by = NULL, rejected_at = NULL, rejected_reason = NULL, rejected_step = NULL
         WHERE user_id = $1 AND entry_date BETWEEN $2 AND $3 AND status IN ('draft', 'rejected') RETURNING id, minutes`, [req.user.id, ws, we]);
    if (!rows.length) throw bad('Nothing to submit for this week.');
    for (const e of rows) await logEvent(c, e.id, 'submitted', req.user.id, { detail: { weekStart: ws } });
    await notifySubmitted(c, req.user, rows.map(e => e.id), ws);
    return { count: rows.length, minutes: rows.reduce((a, e) => a + e.minutes, 0) };
  });
  res.json(out);
}));

/* ---------- approvals ---------- */
const APPROVAL_SQL = (viewer, extra = '') => `
  SELECT ${ENTRY_COLUMNS}, c.owner_id, sl.manager_id, ou.name AS owner_name, mu.name AS manager_name, au.name AS ae_by_name
    FROM time_entries e ${ENTRY_JOINS}
    LEFT JOIN users ou ON ou.id = c.owner_id LEFT JOIN users mu ON mu.id = sl.manager_id LEFT JOIN users au ON au.id = e.ae_by
   WHERE ${stepScopeSql(viewer, 1)} ${extra}
   ORDER BY e.entry_date, e.start_time NULLS LAST, e.created_at`;

/** Who approves this step, in words: the named person, or admins and why. */
function approverLabel(e, step) {
  const [id, name, none] = step === 'ae' ? [e.owner_id, e.owner_name, 'no account owner'] : [e.manager_id, e.manager_name, 'no department manager'];
  if (!id) return `Admins (${none})`;
  if (id === e.user_id) return `Admins (${name}’s own time)`;
  return name;
}
r.get('/approvals', h(async (req, res) => {
  const rows = await many(APPROVAL_SQL(req.user), [req.user.id]);
  const groups = new Map();
  for (const e of rows) {
    const step = e.status === 'submitted' ? 'ae' : 'dept';
    const ws = weekStart(e.date), scopeId = step === 'ae' ? e.client_id : e.service_line_id;
    const key = [step, e.user_id, ws, scopeId].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        key, step, userId: e.user_id, userName: e.user_name, weekStart: ws, scopeId,
        scope: step === 'ae' ? e.client_name : `${e.service_line_name} department`,
        approver: approverLabel(e, step),
        entries: [],
      });
    }
    groups.get(key).entries.push(e);
  }
  const list = [...groups.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : a.step < b.step ? -1 : 1));
  res.json(list.map(g => ({ ...g, minutes: g.entries.reduce((s, e) => s + e.minutes, 0) })));
}));

/**
 * Lock the entries a reviewer is deciding on, in id order (so two reviewers can't deadlock), and check
 * each is still the version they looked at: an entry edited and resubmitted since then is refused.
 */
async function lockForDecision(c, viewer, step, ids, versions) {
  if (!['ae', 'dept'].includes(step)) throw bad('Unknown approval step.');
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(isUUID)) throw bad('Choose the time to act on.');
  if (!versions || typeof versions !== 'object') throw bad('Refresh the page and try again.');
  const stale = () => conflict('Some of this time changed since you opened it. Refresh and try again.');
  const rows = await c.many(`SELECT e.id, e.user_id, e.status, c.owner_id, sl.manager_id,
           (EXTRACT(EPOCH FROM e.updated_at) * 1000000)::bigint::text AS version
      FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
      JOIN clients c ON c.id = p.client_id JOIN service_lines sl ON sl.id = e.service_line_id
     WHERE e.id = ANY($1::uuid[]) ORDER BY e.id FOR UPDATE OF e`, [ids]);
  if (rows.length !== new Set(ids).size) throw stale();
  const otherAdmin = isAdmin(viewer) ? await otherAdminExists(c, viewer.id) : true;
  for (const row of rows) {
    if (!canActOn(viewer, row, step, { otherAdmin })) {
      if (row.status !== (step === 'ae' ? 'submitted' : 'ae-approved')) throw stale();
      throw forbidden(row.user_id === viewer.id ? (isAdmin(viewer) ? 'Another admin approves your own time.' : 'You can’t approve your own time. An admin will.') : 'You aren’t the approver for some of this time.');
    }
  }
  if (rows.some(row => versions[row.id] !== row.version)) throw stale();
  return rows;
}

r.post('/approvals/approve', h(async (req, res) => {
  const { step, entryIds, versions } = req.body;
  const out = await tx(async c => {
    const rows = await lockForDecision(c, req.user, step, entryIds, versions);
    let finished = 0;
    for (const row of rows) {
      if (step === 'ae') {
        // Same person (or an admin with no manager set) covers both steps at once.
        const both = row.manager_id === req.user.id || (!row.manager_id && isAdmin(req.user));
        await c.query(`UPDATE time_entries SET status = $1, ae_by = $2, ae_at = now(), dept_by = CASE WHEN $3 THEN $2::uuid END,
                       dept_at = CASE WHEN $3 THEN now() END, updated_at = now() WHERE id = $4`, [both ? 'approved' : 'ae-approved', req.user.id, both, row.id]);
        await logEvent(c, row.id, 'approved', req.user.id, { step: 'ae' });
        if (both) { await logEvent(c, row.id, 'approved', req.user.id, { step: 'dept', detail: { auto: true } }); finished++; }
      } else {
        await c.query(`UPDATE time_entries SET status = 'approved', dept_by = $1, dept_at = now(), updated_at = now() WHERE id = $2`, [req.user.id, row.id]);
        await logEvent(c, row.id, 'approved', req.user.id, { step: 'dept' });
        finished++;
      }
    }
    await notifyDecision(c, req.user, rows.map(r => r.id), 'approved');
    return { count: rows.length, fullyApproved: finished };
  });
  res.json(out);
}));

r.post('/approvals/return', h(async (req, res) => {
  const { step, entryIds, versions } = req.body;
  const reason = assertReason(req.body.reason);
  const out = await tx(async c => {
    const rows = await lockForDecision(c, req.user, step, entryIds, versions);
    for (const row of rows) {
      await c.query(`UPDATE time_entries SET status = 'rejected', rejected_by = $1, rejected_at = now(), rejected_reason = $2, rejected_step = $3, updated_at = now() WHERE id = $4`,
        [req.user.id, reason, step, row.id]);
      await logEvent(c, row.id, 'returned', req.user.id, { step, reason });
    }
    await notifyDecision(c, req.user, rows.map(r => r.id), 'returned', reason);
    return { count: rows.length };
  });
  res.json(out);
}));

/* ---------- team week ---------- */
r.get('/team', h(async (req, res) => {
  const ws = req.query.weekStart;
  if (!isISODate(ws) || dow(ws) !== 0) throw bad('Give the Monday that starts the week.');
  const me = req.user, admin = isAdmin(me), mgr = me.role === 'ae' || me.role === 'acct';
  const people = await many(`SELECT u.id, u.name, u.role, u.dept_id, u.capacity FROM users u LEFT JOIN service_lines sl ON sl.id = u.dept_id
     WHERE u.archived_at IS NULL AND u.id <> $1 AND (${admin ? 'TRUE' : `sl.manager_id = $1${mgr ? ` OR u.role <> 'admin'` : ''}`}) ORDER BY u.name`, [me.id]);
  if (!people.length) return res.json([]);
  const rows = await many(`SELECT user_id, entry_date::text AS date, status, SUM(minutes)::int AS minutes, COUNT(*)::int AS n FROM time_entries
     WHERE user_id = ANY($1::uuid[]) AND entry_date BETWEEN $2 AND $3 GROUP BY 1, 2, 3`, [people.map(p => p.id), ws, addDays(ws, 6)]);
  res.json(people.map(p => ({ ...p, days: rows.filter(x => x.user_id === p.id) })));
}));

export default r;
