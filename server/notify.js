// In-app notifications (wireframe notify(), runChecks(), bell()).
// Email delivery is a separate decision (see docs/backlog.md); nothing here sends mail.
import { hm, addDays, weekStart, weekLabel, shortDate } from '../public/js/shared/time.js';

/**
 * Notify users. Skips the person who caused it unless `self` is set, skips archived people,
 * and with `key` fires at most once per user and key (reminders and alerts).
 */
export async function notify(c, userIds, type, title, body, link, { actorId = null, key = null, self = false } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))].filter(u => self || u !== actorId);
  if (!ids.length) return;
  await c.query(
    `INSERT INTO notifications (user_id, type, title, body, link, dedupe_key)
     SELECT u.id, $2, $3, $4, $5, $6 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.archived_at IS NULL
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [ids, type, title, body || '', link || null, key]);
}
export async function adminIds(c) {
  return (await c.many(`SELECT id FROM users WHERE role = 'admin' AND archived_at IS NULL`)).map(r => r.id);
}
/** Who approves a step: the named person, or admins when nobody is set or it’s their own time. */
async function approvers(c, personId, entryUserId) {
  return personId && personId !== entryUserId ? [personId] : adminIds(c);
}
export const taskLink = (projectId, taskId) => `#/project/${projectId}?task=${taskId}`;

/* ---------- timesheets ---------- */

/** After a week is submitted: tell each client’s account owner (or admins). */
export async function notifySubmitted(c, actor, entryIds, ws) {
  const rows = await c.many(`
    SELECT e.minutes, cl.id AS client_id, cl.name AS client_name, cl.owner_id
      FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id JOIN clients cl ON cl.id = p.client_id
     WHERE e.id = ANY($1::uuid[])`, [entryIds]);
  const byClient = groupBy(rows, r => r.client_id);
  for (const list of byClient.values()) {
    const r0 = list[0], minutes = sum(list);
    await notify(c, await approvers(c, r0.owner_id, actor.id), 'time', 'Time to approve',
      `${actor.name} submitted ${hm(minutes)} on ${r0.client_name} for the week of ${weekLabel(ws)}.`, '#/time/approvals', { actorId: actor.id });
  }
}

/** After approvals and returns: next approver, or the person whose time it is. */
export async function notifyDecision(c, actor, entryIds, kind, reason) {
  const rows = await c.many(`
    SELECT e.user_id, e.minutes, e.status, e.entry_date::text AS date, cl.name AS client_name,
           sl.id AS service_line_id, sl.name AS service_line_name, sl.manager_id, u.name AS user_name
      FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id JOIN clients cl ON cl.id = p.client_id
      JOIN service_lines sl ON sl.id = e.service_line_id JOIN users u ON u.id = e.user_id
     WHERE e.id = ANY($1::uuid[])`, [entryIds]);
  if (kind === 'returned') {
    for (const list of groupBy(rows, r => `${r.user_id}|${weekStart(r.date)}`).values()) {
      const ws = weekStart(list[0].date);
      await notify(c, [list[0].user_id], 'time', 'Your time was sent back',
        `${actor.name}: ${reason}`, `#/time?week=${ws}`, { actorId: actor.id });
    }
    return;
  }
  // moved on to the department manager
  const waiting = rows.filter(r => r.status === 'ae-approved');
  for (const list of groupBy(waiting, r => `${r.user_id}|${weekStart(r.date)}|${r.service_line_id}`).values()) {
    const r0 = list[0];
    await notify(c, await approvers(c, r0.manager_id, r0.user_id), 'time', 'Time to approve',
      `${r0.user_name}’s ${r0.service_line_name} time for the week of ${weekLabel(weekStart(r0.date))} (${hm(sum(list))}) is ready for the department sign-off.`,
      '#/time/approvals', { actorId: actor.id });
  }
  // fully approved
  const done = rows.filter(r => r.status === 'approved');
  for (const list of groupBy(done, r => `${r.user_id}|${weekStart(r.date)}`).values()) {
    const ws = weekStart(list[0].date);
    await notify(c, [list[0].user_id], 'time', 'Your time was approved',
      `${hm(sum(list))} for the week of ${weekLabel(ws)} is approved.`, `#/time?week=${ws}`, { actorId: actor.id });
  }
}

/* ---------- tasks and budgets ---------- */

export async function notifyAssigned(c, actor, task, isNew) {
  if (!task.assignee_id || task.assignee_id === actor.id) return;
  const ctx = await c.one(`SELECT p.name AS project_name, cl.name AS client_name FROM projects p JOIN clients cl ON cl.id = p.client_id WHERE p.id = $1`, [task.project_id]);
  await notify(c, [task.assignee_id], 'assigned', `You’re responsible for ${task.title}`,
    `${actor.name} ${isNew ? 'added' : 'assigned'} it, due ${shortDate(task.due_date)}. ${ctx.client_name}, ${ctx.project_name}.`,
    taskLink(task.project_id, task.id), { actorId: actor.id });
}

/** After time lands on a task: alert at the budget alert percent, and when it locks at 100%. */
export async function checkBudget(c, taskId, alertPct) {
  const t = await c.one(`
    SELECT t.id, t.title, t.project_id, t.assignee_id, t.budget_minutes, cl.name AS client_name,
           COALESCE((SELECT SUM(minutes) FROM time_entries WHERE task_id = t.id), 0)::int AS logged
      FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients cl ON cl.id = p.client_id WHERE t.id = $1`, [taskId]);
  if (!t || !t.budget_minutes) return;
  const link = taskLink(t.project_id, t.id);
  if (t.logged >= t.budget_minutes) {
    await notify(c, [t.assignee_id, ...(await adminIds(c))], 'budget', `Locked: ${t.title} used its time budget`,
      `${hm(t.logged)} of ${hm(t.budget_minutes)}. Time is locked until an admin adds more. ${t.client_name}.`, link, { key: `lock:${t.id}:${t.budget_minutes}`, self: true });
  } else if (t.logged >= t.budget_minutes * (alertPct / 100)) {
    await notify(c, [t.assignee_id], 'budget', `${t.title} is at ${Math.floor((t.logged / t.budget_minutes) * 100)}% of its time budget`,
      `${hm(t.logged)} of ${hm(t.budget_minutes)}. ${t.client_name}.`, link, { key: `bud:${t.id}:${t.budget_minutes}`, self: true });
  }
}

/** Due-date reminders for one person, created when they load the app (wireframe runChecks, two days ahead). */
export async function dueReminders(c, userId, today) {
  const rows = await c.many(`
    SELECT t.id, t.title, t.project_id, t.due_date::text AS due, p.name AS project_name, cl.name AS client_name
      FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients cl ON cl.id = p.client_id
     WHERE t.assignee_id = $1 AND t.status <> 'done' AND cl.archived_at IS NULL AND t.due_date <= $2::date`, [userId, addDays(today, 2)]);
  for (const t of rows) {
    const over = t.due < today;
    await notify(c, [userId], 'due', over ? `Overdue: ${t.title}` : `Due ${t.due === today ? 'today' : shortDate(t.due)}: ${t.title}`,
      `${over ? `Was due ${shortDate(t.due)}. ` : ''}${t.client_name}, ${t.project_name}.`, taskLink(t.project_id, t.id),
      { key: `${over ? 'overdue' : 'due'}:${t.id}:${t.due}`, self: true });
  }
}

function groupBy(list, fn) { const m = new Map(); for (const x of list) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
const sum = list => list.reduce((a, r) => a + r.minutes, 0);
