// Sign-in, the bootstrap payload, and admin setup: people, roles, service lines, clients, projects, settings.
import crypto from 'node:crypto';
import { Router } from 'express';
import { one, many, query, tx } from '../db.js';
import { h, bad, conflict, notFound, forbidden, uuidParam, str, isUUID } from '../http.js';
import { createSession, destroySession, verifyPassword, hashPassword, requireUser, requireAdmin, throttleLogin, clearLoginThrottle, checkThrottle, recordFailure, slowDown } from '../auth.js';
import { getSettings, isAdmin, isMgr, ROLES, stepScopeSql, ENTRY_JOINS, stopTimerRow } from '../domain.js';
import { refreshAndCount } from './notifications.js';
import { isBuiltinManaged } from '../builtin-admin.js';

const r = Router();
const COLOR = /^#[0-9a-fA-F]{6}$/;
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isRole = v => typeof v === 'string' && Object.hasOwn(ROLES, v);
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword('not-a-real-password');

/* ---------- auth ---------- */
r.post('/auth/login', h(async (req, res) => {
  const email = str(req.body.email, { label: 'Email', max: 200 }).toLowerCase();
  const password = String(req.body.password || '');
  // MySQL's collation ignores accents and letter widths, so “cásey@” would find casey@. Only the exact
  // address counts, and failures are counted against the person, however the address is typed.
  const found = await one('SELECT id, email, password_hash, archived_at FROM users WHERE lower(email) = $1', [email]);
  const u = found && found.email.toLowerCase() === email ? found : null;
  const key = `${req.ip}|${u ? u.id : email}`, ipKey = `ip|${req.ip}`;
  checkThrottle(key);
  await slowDown(ipKey); // one password tried across many emails slows to a crawl
  const okPw = await verifyPassword(password, u && u.password_hash ? u.password_hash : await DUMMY_HASH);
  if (!u || u.archived_at || !u.password_hash || !okPw) {
    recordFailure(key); recordFailure(ipKey);
    throw bad('That email and password don’t match.');
  }
  clearLoginThrottle(key);
  await createSession(req, res, u.id);
  res.json({ ok: true });
}));
r.post('/auth/logout', h(async (req, res) => { await destroySession(req, res); res.json({ ok: true }); }));
/** Anyone signed in can change their own password. */
r.post('/auth/password', requireUser, h(async (req, res) => {
  const current = String(req.body.current || ''), next = String(req.body.next || '');
  if (isBuiltinManaged(req.user)) throw bad('This login’s password is set by ADMIN_PASSWORD in the server’s .env file. Change it there and restart.');
  throttleLogin(`pw|${req.user.id}`);
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, u.password_hash))) throw bad('Your current password isn’t right.', { field: 'current' });
  if (next.length < 8) throw bad('Use at least 8 characters for the new password.', { field: 'next' });
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(next), req.user.id]);
  // Sign out everywhere else; this browser stays signed in.
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.sessionHash]);
  clearLoginThrottle(`pw|${req.user.id}`);
  res.json({ ok: true });
}));

/* ---------- bootstrap ---------- */
r.get('/bootstrap', requireUser, h(async (req, res) => {
  const me = req.user, admin = isAdmin(me);
  const [settings, users, serviceLines, clients, projects, tasks, timer, apprCount, reqCount] = await Promise.all([
    getSettings(),
    many(`SELECT id, name, ${admin ? 'email,' : ''} role, dept_id, capacity, archived_at FROM users ORDER BY name`),
    many('SELECT id, name, color, rate, manager_id, sort, match_keywords, archived_at FROM service_lines ORDER BY sort, name'),
    many('SELECT id, name, owner_id, color, archived_at, paymo_client_id FROM clients ORDER BY name'),
    many('SELECT id, client_id, name, kind, status, paymo_project_id FROM projects ORDER BY name'),
    many(`SELECT t.id, t.project_id, t.service_line_id, t.title, t.assignee_id, t.status, t.start_date,
                 t.due_date, t.budget_minutes, t.billable, t.notes, t.created_by, t.created_at,
                 COALESCE(l.m, 0) AS logged_minutes
            FROM tasks t LEFT JOIN (SELECT task_id, SUM(minutes) AS m FROM time_entries GROUP BY task_id) l ON l.task_id = t.id
           ORDER BY t.due_date, t.title`),
    one(`SELECT id, task_id, started_at, note FROM timers WHERE user_id = $1`, [me.id]),
    // one per approval group: person, step, week (Monday) and client or service line
    one(`SELECT COUNT(DISTINCT e.user_id, e.status, DATE_SUB(e.entry_date, INTERVAL WEEKDAY(e.entry_date) DAY), CASE WHEN e.status = 'submitted' THEN c.id ELSE sl.id END) AS n
           FROM time_entries e ${ENTRY_JOINS} WHERE ${stepScopeSql(me, 1)}`, [me.id]),
    one(`SELECT COUNT(*) AS n FROM hours_requests WHERE status = 'pending' ${admin ? '' : 'AND requested_by = $1'}`, admin ? [] : [me.id]),
  ]);
  // Bill rates are for managers and admins, as in reports.
  if (!admin && !isMgr(me)) serviceLines.forEach(s => { delete s.rate; });
  res.json({
    me, roles: ROLES, settings: { ...settings, server_now: Date.now() },
    users, serviceLines, clients, projects, tasks,
    timer: timer ? { ...timer, started_ms: new Date(timer.started_at).getTime() } : null,
    counts: { approvals: apprCount.n, hoursRequests: reqCount.n, notifications: await refreshAndCount(me.id) },
  });
}));

/* ---------- people ---------- */
async function assertAdminRemains(c, changingId, nextRole, archiving) {
  const n = await c.one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND archived_at IS NULL AND id <> $1`, [changingId]);
  const cur = await c.one('SELECT role FROM users WHERE id = $1', [changingId]);
  if (cur && cur.role === 'admin' && (nextRole !== 'admin' || archiving) && n.n === 0) throw bad('Keep at least one active admin.');
}
r.post('/users', requireAdmin, h(async (req, res) => {
  const name = str(req.body.name, { label: 'Name', required: true, max: 120 });
  const email = str(req.body.email, { label: 'Email', required: true, max: 200 }).toLowerCase();
  if (!emailOk(email)) throw bad('Enter a valid email address.', { field: 'email' });
  const role = req.body.role || 'member';
  if (!isRole(role)) throw bad('Choose a role.');
  const dept = req.body.deptId || null;
  if (dept && (!isUUID(dept) || !(await one('SELECT 1 FROM service_lines WHERE id = $1', [dept])))) throw bad('Choose a department.');
  const password = String(req.body.password || '');
  if (password.length < 8) throw bad('Set a password of at least 8 characters.', { field: 'password' });
  if (await one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) throw conflict('Someone already uses that email.');
  const id = crypto.randomUUID();
  await query(`INSERT INTO users (id, name, email, role, dept_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, email, role, dept, await hashPassword(password)]);
  res.status(201).json({ id });
}));
r.patch('/users/:id', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id);
  await tx(async c => {
    const u = await c.one('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!u) throw notFound('That person doesn’t exist.');
    const b = req.body, sets = [], vals = [];
    // .env controls the built-in admin's sign-in; only its name can change here.
    if (isBuiltinManaged(u) && ((b.email !== undefined && String(b.email).trim().toLowerCase() !== u.email) || (b.role !== undefined && b.role !== 'admin') || b.archived || b.password)) {
      throw bad('The “admin” login is set up from the server’s .env file. To change or retire it, remove ADMIN_PASSWORD there and restart.');
    }
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) set('name', str(b.name, { label: 'Name', required: true, max: 120 }));
    if (b.email !== undefined && String(b.email).trim().toLowerCase() !== u.email) {
      const e = str(b.email, { label: 'Email', required: true, max: 200 }).toLowerCase();
      if (!emailOk(e)) throw bad('Enter a valid email address.');
      if (await c.one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [e, id])) throw conflict('Someone already uses that email.');
      set('email', e);
    }
    if (b.role !== undefined && b.role !== u.role) {
      if (!isRole(b.role)) throw bad('Choose a role.');
      if (id === req.user.id) throw bad('You can’t change your own role.');
      await assertAdminRemains(c, id, b.role, false);
      set('role', b.role);
    }
    if (b.deptId !== undefined) {
      if (b.deptId && (!isUUID(b.deptId) || !(await c.one('SELECT 1 FROM service_lines WHERE id = $1', [b.deptId])))) throw bad('Choose a department.');
      set('dept_id', b.deptId || null);
    }
    if (Array.isArray(b.capacity)) {
      if (b.capacity.length !== 7 || b.capacity.some(x => !Number.isInteger(x) || x < 0 || x > 1440)) throw bad('Capacity needs 7 daily values in minutes.');
      set('capacity', JSON.stringify(b.capacity));
    }
    if (b.archived !== undefined) {
      if (id === req.user.id) throw bad('You can’t archive yourself.');
      if (b.archived) await assertAdminRemains(c, id, u.role, true);
      set('archived_at', b.archived ? new Date() : null);
      if (b.archived) {
        await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        // A running timer would be stranded: save it as a draft entry they (or an admin) can see.
        const timer = await c.one('SELECT * FROM timers WHERE user_id = $1 FOR UPDATE', [id]);
        if (timer) await stopTimerRow(c, timer, await getSettings(c), req.user.id);
      }
    }
    if (b.password) {
      if (String(b.password).length < 8) throw bad('Passwords need at least 8 characters.');
      set('password_hash', await hashPassword(String(b.password)));
      // An admin resetting someone's password signs them out everywhere.
      if (id !== req.user.id) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    if (sets.length) { vals.push(id); await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
  });
  res.json({ ok: true });
}));

/* ---------- service lines ---------- */
async function readServiceLine(b, partial) {
  const o = {};
  if (!partial || b.name !== undefined) o.name = str(b.name, { label: 'Service line name', required: true, max: 80 });
  if (b.color !== undefined) { if (!COLOR.test(b.color)) throw bad('Pick a color.'); o.color = b.color; }
  if (b.rate !== undefined) { const v = Number(b.rate); if (!(v >= 0) || v > 100000) throw bad('Enter a bill rate of 0 or more.'); o.rate = v; }
  if (b.managerId !== undefined) {
    if (b.managerId && !isUUID(b.managerId)) throw bad('Invalid manager.');
    if (b.managerId && !(await one('SELECT 1 FROM users WHERE id = $1 AND archived_at IS NULL', [b.managerId]))) throw bad('Choose an active person as manager.');
    o.manager_id = b.managerId || null;
  }
  if (b.matchKeywords !== undefined) {
    o.match_keywords = str(b.matchKeywords, { label: 'Keywords', max: 300 }).split(',').map(w => w.trim()).filter(Boolean).join(', ');
  }
  return o;
}
r.post('/service-lines', requireAdmin, h(async (req, res) => {
  const o = await readServiceLine(req.body, false);
  if (await one('SELECT 1 FROM service_lines WHERE lower(name) = lower($1)', [o.name])) throw conflict('A service line with that name exists.');
  const id = crypto.randomUUID();
  const { next } = await one('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM service_lines');
  await query(`INSERT INTO service_lines (id, name, color, rate, manager_id, match_keywords, sort)
    VALUES ($1, $2, COALESCE($3, '#868E96'), COALESCE($4, 0), $5, COALESCE($6, ''), $7)`,
    [id, o.name, o.color || null, o.rate ?? null, o.manager_id || null, o.match_keywords ?? null, next]);
  res.status(201).json({ id });
}));
r.patch('/service-lines/:id', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id);
  if (!(await one('SELECT 1 FROM service_lines WHERE id = $1', [id]))) throw notFound();
  const o = await readServiceLine(req.body, true);
  if (o.name && await one('SELECT 1 FROM service_lines WHERE lower(name) = lower($1) AND id <> $2', [o.name, id])) throw conflict('A service line with that name exists.');
  if (req.body.archived !== undefined) o.archived_at = req.body.archived ? new Date() : null;
  await update('service_lines', id, o);
  res.json({ ok: true });
}));

/* ---------- clients ---------- */
async function readClient(b, partial) {
  const o = {};
  if (!partial || b.name !== undefined) o.name = str(b.name, { label: 'Client name', required: true, max: 120 });
  if (b.color !== undefined) { if (!COLOR.test(b.color)) throw bad('Pick a color.'); o.color = b.color; }
  if (b.ownerId !== undefined) {
    if (b.ownerId && !isUUID(b.ownerId)) throw bad('Invalid account owner.');
    if (b.ownerId && !(await one('SELECT 1 FROM users WHERE id = $1 AND archived_at IS NULL', [b.ownerId]))) throw bad('Choose an active person as account owner.');
    o.owner_id = b.ownerId || null;
  }
  return o;
}
r.post('/clients', requireAdmin, h(async (req, res) => {
  const o = await readClient(req.body, false);
  if (await one('SELECT 1 FROM clients WHERE lower(name) = lower($1)', [o.name])) throw conflict('A client with that name exists.');
  const id = crypto.randomUUID();
  await query(`INSERT INTO clients (id, name, owner_id, color) VALUES ($1, $2, $3, COALESCE($4, '#868E96'))`, [id, o.name, o.owner_id || null, o.color || null]);
  res.status(201).json({ id });
}));
r.patch('/clients/:id', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id);
  if (!(await one('SELECT 1 FROM clients WHERE id = $1', [id]))) throw notFound();
  const o = await readClient(req.body, true);
  if (o.name && await one('SELECT 1 FROM clients WHERE lower(name) = lower($1) AND id <> $2', [o.name, id])) throw conflict('A client with that name exists.');
  if (req.body.archived !== undefined) o.archived_at = req.body.archived ? new Date() : null;
  await update('clients', id, o);
  res.json({ ok: true });
}));

/* ---------- projects ---------- */
const KINDS = ['retainer', 'project'], PSTATUS = ['active', 'waiting', 'hold', 'done'];
function readProject(b, partial) {
  const o = {};
  if (!partial || b.name !== undefined) o.name = str(b.name, { label: 'Project name', required: true, max: 120 });
  if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw bad('Choose retainer or project.'); o.kind = b.kind; }
  if (b.status !== undefined) { if (!PSTATUS.includes(b.status)) throw bad('Choose a project status.'); o.status = b.status; }
  return o;
}
r.post('/projects', requireAdmin, h(async (req, res) => {
  const clientId = uuidParam(req.body.clientId, 'client');
  const cl = await one('SELECT archived_at FROM clients WHERE id = $1', [clientId]);
  if (!cl) throw bad('Choose a client.');
  if (cl.archived_at) throw bad('That client is archived. Restore it first.');
  const o = readProject(req.body, false);
  if (await one('SELECT 1 FROM projects WHERE client_id = $1 AND lower(name) = lower($2)', [clientId, o.name])) throw conflict('This client already has a project with that name.');
  const id = crypto.randomUUID();
  await query(`INSERT INTO projects (id, client_id, name, kind, status) VALUES ($1, $2, $3, COALESCE($4, 'project'), COALESCE($5, 'active'))`,
    [id, clientId, o.name, o.kind || null, o.status || null]);
  res.status(201).json({ id });
}));
r.patch('/projects/:id', requireAdmin, h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const p = await one('SELECT client_id FROM projects WHERE id = $1', [id]);
  if (!p) throw notFound();
  const o = readProject(req.body, true);
  if (o.name && await one('SELECT 1 FROM projects WHERE client_id = $1 AND lower(name) = lower($2) AND id <> $3', [p.client_id, o.name, id])) throw conflict('This client already has a project with that name.');
  await update('projects', id, o);
  res.json({ ok: true });
}));

/* ---------- settings ---------- */
r.patch('/settings', requireAdmin, h(async (req, res) => {
  const b = req.body, o = {};
  if (b.roundingMinutes !== undefined) { const v = +b.roundingMinutes; if (![0, 6, 15].includes(v)) throw bad('Rounding is none, 6 or 15 minutes.'); o.rounding_minutes = v; }
  if (b.budgetAlertPct !== undefined) { const v = +b.budgetAlertPct; if (!(v >= 10 && v <= 100)) throw bad('Budget alert is between 10% and 100%.'); o.budget_alert_pct = Math.round(v); }
  if (b.timeZone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timeZone }); } catch { throw bad('Choose a valid time zone.'); }
    o.time_zone = b.timeZone;
  }
  o.updated_at = new Date(); o.updated_by = req.user.id;
  await update('settings', 1, o);
  res.json({ ok: true });
}));

async function update(table, id, o) {
  const keys = Object.keys(o);
  if (!keys.length) return;
  await query(`UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map(k => o[k]), id]);
}

export default r;
export { forbidden };
