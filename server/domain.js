// Business rules shared by the routes. Every rule that protects data is enforced here,
// on the server, regardless of what the browser shows.
import { one, many } from './db.js';
import { fromHM, rangesOverlap, roundUp } from '../public/js/shared/time.js';
import { bad, conflict, forbidden, notFound } from './http.js';

export const ROLES = { admin: 'Admin', ae: 'Manager', acct: 'Account Executive', member: 'Team Member' };
export const TASK_STATUSES = ['todo', 'doing', 'review', 'done'];
export const ENTRY_STATUSES = ['draft', 'submitted', 'ae-approved', 'approved', 'rejected'];
export const isAdmin = u => u.role === 'admin';
export const isMgr = u => u.role === 'ae' || u.role === 'acct';

/** Workspace settings plus "today" in the workspace time zone. */
export async function getSettings(c = { one }) {
  return c.one(
    `SELECT time_zone, rounding_minutes, budget_alert_pct,
            (now() AT TIME ZONE time_zone)::date::text AS today,
            to_char(now() AT TIME ZONE time_zone, 'HH24:MI') AS now_hm
       FROM settings WHERE id = 1`);
}

/* ---------- visibility ---------- */

/**
 * SQL condition: can `viewer` see time entry `e`? Expects aliases e (time_entries), eu (entry's user),
 * c (clients), sl (task's service line), ud (entry user's department). $n is the viewer id param.
 * Mirrors the wireframe's canSeeTimesheet(): yourself; admins everything; managers everyone but admins;
 * department managers their department. Plus: account owners see time on their clients, and service line
 * managers see time in their service line, because they approve it.
 */
export function visibleEntrySql(viewer, n) {
  if (isAdmin(viewer)) return 'TRUE';
  return `(e.user_id = $${n} OR c.owner_id = $${n} OR sl.manager_id = $${n} OR ud.manager_id = $${n}${isMgr(viewer) ? ` OR eu.role <> 'admin'` : ''})`;
}
export const ENTRY_JOINS = `
  JOIN users eu ON eu.id = e.user_id
  JOIN tasks t ON t.id = e.task_id
  JOIN projects p ON p.id = t.project_id
  JOIN clients c ON c.id = p.client_id
  JOIN service_lines sl ON sl.id = t.service_line_id
  LEFT JOIN service_lines ud ON ud.id = eu.dept_id`;

/** Can `viewer` open `target`’s timesheet? (wireframe canSeeTimesheet) */
export async function canSeeTimesheet(viewer, targetId) {
  if (viewer.id === targetId || isAdmin(viewer)) return true;
  const t = await one(
    `SELECT u.role, sl.manager_id FROM users u LEFT JOIN service_lines sl ON sl.id = u.dept_id WHERE u.id = $1`, [targetId]);
  if (!t) return false;
  if (isMgr(viewer) && t.role !== 'admin') return true;
  return t.manager_id === viewer.id;
}

/* ---------- tasks and budgets ---------- */

export async function taskForTime(c, taskId, { lock = false } = {}) {
  const t = await c.one(
    `SELECT t.*, cl.archived_at AS client_archived_at, cl.id AS client_id
       FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients cl ON cl.id = p.client_id
      WHERE t.id = $1 ${lock ? 'FOR UPDATE OF t' : ''}`, [taskId]);
  if (!t) throw notFound('That task doesn’t exist.');
  return t;
}
export async function loggedMinutes(c, taskId) {
  const r = await c.one('SELECT COALESCE(SUM(minutes), 0)::int AS m FROM time_entries WHERE task_id = $1', [taskId]);
  return r.m;
}
/** Wireframe isLocked(): time locks once the logged time reaches the budget. */
export const isLocked = (logged, budget) => budget > 0 && logged >= budget;

export function assertTaskOpenForTime(t) {
  if (t.client_archived_at) throw bad('This client is archived, so its tasks can’t take new time.');
  if (t.status === 'done') throw bad('This task is done. Reopen it to track more time.');
}

/** Block time that would go over the task’s budget (wireframe saveEntry2). */
export async function assertWithinBudget(c, t, addMinutes, replacedMinutes = 0) {
  const logged = await loggedMinutes(c, t.id);
  if (logged - replacedMinutes + addMinutes > t.budget_minutes) {
    throw conflict('That would go over the task’s time budget.', {
      code: 'budget_locked', taskId: t.id, logged, budget: t.budget_minutes,
    });
  }
}

/* ---------- entries ---------- */

/** Timed entries for the same person and day that overlap [start, end). Saved anyway, as in the wireframe. */
export async function findOverlaps(c, userId, date, start, end, excludeId = null) {
  if (!start || !end) return [];
  const a = fromHM(start), b0 = fromHM(end), b = b0 <= a ? 1440 : b0;
  const rows = await c.many(
    `SELECT e.id, to_char(e.start_time, 'HH24:MI') AS start, to_char(e.end_time, 'HH24:MI') AS "end", t.title AS task_title
       FROM time_entries e JOIN tasks t ON t.id = e.task_id
      WHERE e.user_id = $1 AND e.entry_date = $2 AND e.start_time IS NOT NULL AND ($3::uuid IS NULL OR e.id <> $3)`,
    [userId, date, excludeId]);
  return rows.filter(r => { const s = fromHM(r.start), e0 = fromHM(r.end), e = e0 <= s ? 1440 : e0; return rangesOverlap(a, b, s, e); });
}

export async function logEvent(c, entryId, action, actorId, extra = {}) {
  await c.query(
    `INSERT INTO time_entry_events (entry_id, action, step, actor_id, reason, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [entryId, action, extra.step || null, actorId, extra.reason || null, extra.detail ? JSON.stringify(extra.detail) : null]);
}

export const ENTRY_COLUMNS = `
  e.id, e.user_id, e.task_id, e.entry_date::text AS date,
  to_char(e.start_time, 'HH24:MI') AS start, to_char(e.end_time, 'HH24:MI') AS "end",
  e.minutes, e.note, e.status, e.source, e.submitted_at,
  e.ae_by, e.ae_at, e.dept_by, e.dept_at, e.rejected_by, e.rejected_at, e.rejected_reason, e.rejected_step,
  e.created_at, e.updated_at,
  t.title AS task_title, t.billable, t.service_line_id, sl.name AS service_line_name, sl.color AS service_line_color,
  p.id AS project_id, p.name AS project_name, c.id AS client_id, c.name AS client_name, c.color AS client_color,
  eu.name AS user_name`;

/* ---------- timer ---------- */

/**
 * Stop the timer row `timer` (already locked FOR UPDATE) and turn it into exactly one draft entry.
 * The UNIQUE source_timer_id makes a retried stop return the same entry instead of a second one.
 */
export async function stopTimerRow(c, timer, settings, actorId) {
  const t = await c.one(
    `SELECT (started_at AT TIME ZONE $2)::date::text AS date,
            to_char(started_at AT TIME ZONE $2, 'HH24:MI') AS start,
            to_char(now() AT TIME ZONE $2, 'HH24:MI') AS "end",
            EXTRACT(EPOCH FROM now() - started_at)::float AS secs
       FROM timers WHERE id = $1`, [timer.id, settings.time_zone]);
  const raw = Math.max(1, Math.round(t.secs / 60));
  let minutes = roundUp(raw, settings.rounding_minutes);
  const capped = minutes > 1440;
  if (capped) minutes = 1440;
  const ins = await c.one(
    `INSERT INTO time_entries (user_id, task_id, entry_date, start_time, end_time, minutes, note, status, source, source_timer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'timer', $8)
     ON CONFLICT (source_timer_id) DO NOTHING RETURNING id`,
    [timer.user_id, timer.task_id, t.date, t.start, t.end, minutes, timer.note || '', timer.id]);
  await c.query('DELETE FROM timers WHERE id = $1', [timer.id]);
  const entryId = ins ? ins.id : (await c.one('SELECT id FROM time_entries WHERE source_timer_id = $1', [timer.id])).id;
  if (ins) await logEvent(c, entryId, 'created', actorId, { detail: { source: 'timer', rawMinutes: raw, rounding: settings.rounding_minutes, capped } });
  const overlaps = await findOverlaps(c, timer.user_id, t.date, t.start, t.end, entryId);
  return { entryId, minutes, rawMinutes: raw, capped, overlaps };
}

export async function entryById(c, id) {
  return c.one(`SELECT ${ENTRY_COLUMNS} FROM time_entries e ${ENTRY_JOINS} WHERE e.id = $1`, [id]);
}

/* ---------- approvals ---------- */

/**
 * Wireframe routing: submitted time goes to the client’s account owner (step "ae"), then to the
 * department manager of the task’s service line (step "dept"). Exceptions, from the wireframe:
 *  - admins can act at either step; a missing owner or manager means admins approve;
 *  - when the person approving step 1 is also the step-2 approver (or there is no manager and an admin
 *    approves step 1), both steps complete together.
 * Added rule (open decision, see docs/requirements-map.md): non-admins never approve their own time.
 */
export function canActOn(viewer, row, step) {
  if (step === 'ae' && row.status !== 'submitted') return false;
  if (step === 'dept' && row.status !== 'ae-approved') return false;
  if (isAdmin(viewer)) return true;
  if (row.user_id === viewer.id) return false;
  return step === 'ae' ? row.owner_id === viewer.id : row.manager_id === viewer.id;
}
export function stepScopeSql(viewer, n) {
  if (isAdmin(viewer)) return `e.status IN ('submitted', 'ae-approved')`;
  return `e.user_id <> $${n} AND ((e.status = 'submitted' AND c.owner_id = $${n}) OR (e.status = 'ae-approved' AND sl.manager_id = $${n}))`;
}
export function assertReason(reason) {
  const r = String(reason || '').trim();
  if (!r) throw bad('Say why you’re sending it back, so they know what to fix.', { field: 'reason' });
  if (r.length > 1000) throw bad('Keep the reason under 1000 characters.');
  return r;
}
export { forbidden };
