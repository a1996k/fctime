// End-to-end API test of the first milestone against a real MySQL database.
// Uses TEST_DATABASE_URL (default mysql://fctime:fctime@localhost:3306/fctime_test), which it wipes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'mysql://fctime:fctime@localhost:3306/fctime_test';
const { migrate } = await import('../server/migrate.js');
const { seedDemo } = await import('../server/seed.js');
const { createApp } = await import('../server/app.js');
const { query, one, closePool } = await import('../server/db.js');
const { weekStart } = await import('../public/js/shared/time.js');
const { localParts } = await import('../server/domain.js');

const PW = 'test-password-1';
let server, base, ids, today, ws;

/** A timer entry written straight to the database (shapes the API can't produce on demand). */
async function rawEntry(userId, taskId, date, start, end, minutes) {
  const id = crypto.randomUUID();
  await query(`INSERT INTO time_entries (id, user_id, task_id, entry_date, start_time, end_time, minutes, source, service_line_id, billable)
    SELECT $1, $2, t.id, $4, $5, $6, $7, 'timer', t.service_line_id, t.billable FROM tasks t WHERE t.id = $3`, [id, userId, taskId, date, start, end, minutes]);
  return id;
}

class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async req(method, path, body, { raw = false } = {}) {
    const res = await fetch(base + '/api' + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const data = raw ? await res.text() : (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p, {}); }
  async login(email, password = PW) { const r = await this.post('/auth/login', { email, password }); assert.equal(r.status, 200, `${this.name} signs in`); return this; }
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
// Reviewers send back the version of each entry they looked at.
const vers = entries => Object.fromEntries(entries.map(e => [e.id, e.version]));
async function versionsVia(client, ids) {
  const m = {};
  for (const g of ok(await client.get('/approvals'))) for (const e of g.entries) if (ids.includes(e.id)) m[e.id] = e.version;
  return m;
}
const as = {};

before(async () => {
  await migrate({ reset: true, log: () => {} });
  ids = await seedDemo({ password: PW, log: () => {} });
  today = ids.today; ws = weekStart(today);
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  for (const k of ['morgan', 'alex', 'sam', 'jamie', 'casey', 'riley', 'taylor', 'chris']) as[k] = await new Client(k).login(`${k}@fifthcolor.example`);
});
after(async () => { server && server.close(); await closePool(); });

const state = {};

test('sign-in and request guards', async () => {
  const anon = new Client('anon');
  assert.equal((await anon.get('/bootstrap')).status, 401);
  assert.equal((await anon.post('/auth/login', { email: 'casey@fifthcolor.example', password: 'wrong' })).status, 400);
  const r = await fetch(base + '/api/timesheets/submit', { method: 'POST', headers: { Cookie: as.casey.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'weekStart=' + ws });
  assert.equal(r.status, 415, 'form posts are refused (CSRF guard)');
  const b = ok(await as.casey.get('/bootstrap'));
  assert.equal(b.me.name, 'Casey Diaz');
  assert.equal(b.settings.time_zone, 'America/Chicago');
  assert.ok(!('email' in b.users[0]), 'non-admins do not get everyone’s email');
});

test('1. admin sets up work; others cannot', async () => {
  // admin-only setup
  assert.equal((await as.casey.post('/clients', { name: 'Sneaky' })).status, 403);
  assert.equal((await as.alex.post('/projects', { clientId: ids.C.northwind, name: 'X' })).status, 403);
  assert.equal((await as.jamie.post('/service-lines', { name: 'Social' })).status, 403);
  assert.equal((await as.alex.patch(`/users/${ids.U.casey}`, { role: 'admin' })).status, 403);
  const c = ok(await as.morgan.post('/clients', { name: 'Lakeside Brewing', ownerId: ids.U.sam, color: '#2F9E44' }), 201);
  const p1 = ok(await as.morgan.post('/projects', { clientId: c.id, name: 'Retainer', kind: 'retainer' }), 201);
  const p2 = ok(await as.morgan.post('/projects', { clientId: c.id, name: 'Label refresh' }), 201);
  assert.notEqual(p1.id, p2.id, 'a client can have several projects');
  assert.equal((await as.morgan.post('/projects', { clientId: c.id, name: 'retainer' })).status, 409, 'project names are unique per client');
  const s = ok(await as.morgan.post('/service-lines', { name: 'Social', rate: 150, managerId: ids.U.jamie }), 201);
  const u = ok(await as.morgan.post('/users', { name: 'Pat Lee', email: 'pat@fifthcolor.example', role: 'member', deptId: s.id, password: 'longenough' }), 201);
  ok(await as.morgan.patch(`/users/${u.id}`, { role: 'acct' }));
  assert.equal((await as.morgan.patch(`/users/${ids.U.morgan}`, { role: 'member' })).status, 400, 'admins can’t demote themselves');

  // task validation: project, service line, assignee, due date, budget required
  const bad = await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'No budget', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /time budget/i);
  assert.equal((await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'No due', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, budget: '2' })).status, 400);
  const t = ok(await as.morgan.post('/tasks', {
    projectId: ids.P['nw-ret'], title: 'Holiday menu boards', serviceLineId: ids.S.creative, assigneeId: ids.U.casey,
    status: 'todo', dueDate: today, budget: '2', billable: true,
  }), 201);
  state.task = t.id;
  const boot = ok(await as.casey.get('/bootstrap'));
  const bt = boot.tasks.find(x => x.id === t.id);
  assert.equal(bt.budget_minutes, 120, 'budget stored in whole minutes');
  assert.equal(bt.assignee_id, ids.U.casey);
  // only admins change a budget after creation
  assert.equal((await as.casey.patch(`/tasks/${t.id}`, { budgetMinutes: 600 })).status, 403);
  ok(await as.casey.patch(`/tasks/${t.id}`, { status: 'doing' }));
});

test('2. timer: one per person, survives refresh, stop is idempotent, rounding applies', async () => {
  ok(await as.morgan.patch('/settings', { roundingMinutes: 15 }));
  const timerId = crypto.randomUUID();
  const s1 = ok(await as.casey.post('/timer/start', { taskId: state.task, timerId }), 201);
  assert.equal(s1.timer.id, timerId);
  const s2 = ok(await as.casey.post('/timer/start', { taskId: state.task, timerId }), 200);
  assert.equal(s2.repeated, true, 'retrying a start does not restart the timer');
  // "refresh the page": a new session load still finds the running timer
  const fresh = await new Client('casey-2').login('casey@fifthcolor.example');
  assert.equal(ok(await fresh.get('/bootstrap')).timer.id, timerId);
  assert.equal(ok(await fresh.get('/timer')).timer.task_id, state.task);
  // pretend it has run for 47 minutes
  await query(`UPDATE timers SET started_at = UTC_TIMESTAMP(6) - INTERVAL 47 MINUTE WHERE id = $1`, [timerId]);
  // two stops at once, then a late retry: exactly one entry
  const [a, b] = await Promise.all([as.casey.post('/timer/stop', { timerId }), fresh.post('/timer/stop', { timerId })]);
  const c = await as.casey.post('/timer/stop', { timerId });
  for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(new Set([a.data.entryId, b.data.entryId, c.data.entryId]).size, 1, 'every stop returns the same entry');
  assert.equal([a.data, b.data].filter(x => !x.alreadyStopped).length, 1, 'only one stop created it');
  assert.equal(c.data.alreadyStopped, true);
  const n = await one('SELECT COUNT(*) AS n FROM time_entries WHERE source_timer_id = $1', [timerId]);
  assert.equal(n.n, 1);
  const e = a.data.entry;
  assert.equal(e.minutes, 60, '47 minutes rounds up to 60 with 15-minute rounding');
  assert.equal(e.status, 'draft'); assert.equal(e.source, 'timer'); assert.equal(e.date, today);
  assert.ok(e.start && e.end, 'timer entries keep start and end');
  state.timerEntry = e.id;
  assert.equal(ok(await as.casey.get('/timer')).timer, null);
  ok(await as.morgan.patch('/settings', { roundingMinutes: 0 }));
});

test('2b. starting another timer saves the running one as a draft', async () => {
  const other = ok(await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Quick fix', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today, budget: '1:00' }), 201);
  const t1 = crypto.randomUUID(), t2 = crypto.randomUUID();
  ok(await as.casey.post('/timer/start', { taskId: other.id, timerId: t1 }), 201);
  await query(`UPDATE timers SET started_at = UTC_TIMESTAMP(6) - INTERVAL 10 MINUTE WHERE id = $1`, [t1]);
  const r = ok(await as.casey.post('/timer/start', { taskId: state.task, timerId: t2 }), 201);
  assert.ok(r.stopped, 'previous timer was stopped');
  assert.equal(r.stopped.entry.task_id, other.id);
  assert.equal(r.stopped.entry.status, 'draft');
  assert.equal(r.stopped.minutes, 10);
  assert.equal((await one('SELECT COUNT(*) AS n FROM timers WHERE user_id = $1', [ids.U.casey])).n, 1, 'one active timer per person');
  // can't submit a week with the timer running in it
  const sub = await as.casey.post('/timesheets/submit', { weekStart: ws });
  assert.equal(sub.status, 409); assert.equal(sub.data.code, 'timer_running');
  // stop it but keep the entry tiny, then delete it so budgets stay simple
  const st = ok(await as.casey.post('/timer/stop', { timerId: t2 }));
  ok(await as.casey.del(`/entries/${st.entryId}`));
  state.quickEntry = r.stopped.entryId;
});

test('3. manual entries: duration formats, start and end, overlap warning', async () => {
  const bad = await as.casey.post('/entries', { taskId: state.task, date: today, duration: 'soon' });
  assert.equal(bad.status, 400);
  assert.equal((await as.casey.post('/entries', { taskId: state.task, date: today, start: '10:00', end: '09:00' })).status, 400, 'end after start');
  const e1 = ok(await as.casey.post('/entries', { taskId: state.task, date: today, duration: '0:30', note: 'Sketches' }), 201);
  assert.equal(e1.entry.minutes, 30); assert.equal(e1.entry.start, null);
  const timerEntry = ok(await as.casey.get(`/entries?from=${today}&to=${today}`)).find(x => x.id === state.timerEntry);
  // a range that overlaps the timer entry is saved, with a warning
  const e2 = ok(await as.casey.post('/entries', { taskId: state.task, date: today, start: timerEntry.start, end: addMin(timerEntry.start, 15), note: 'Overlap on purpose' }), 201);
  assert.equal(e2.entry.minutes, 15);
  assert.ok(e2.overlaps.some(o => o.id === state.timerEntry), 'overlap reported');
  state.manual = [e1.id, e2.id];
  // decimal hours
  const quick = (await as.casey.post('/entries', { taskId: state.task, date: today, duration: '1.5' }));
  assert.equal(quick.status, 409, '1.5 h would exceed the 2 h budget (60 + 30 + 15 used)');
  assert.equal(quick.data.code, 'budget_locked');
});

test('2c. budget lock and request for more hours', async () => {
  // 105 of 120 minutes used; 15 more locks the task
  ok(await as.casey.post('/entries', { taskId: state.task, date: today, duration: '15m' }), 201);
  const locked = await as.casey.post('/timer/start', { taskId: state.task, timerId: crypto.randomUUID() });
  assert.equal(locked.status, 409); assert.equal(locked.data.code, 'budget_locked');
  assert.equal((await as.casey.post(`/tasks/${state.task}/budget`, { hours: '2', reason: 'self-serve' })).status, 403, 'only admins add hours directly');
  const q = ok(await as.casey.post(`/tasks/${state.task}/hours-requests`, { hours: '1:30', reason: 'Client added two more boards' }), 201);
  assert.equal((await as.casey.post(`/hours-requests/${q.id}/approve`)).status, 403);
  const list = ok(await as.morgan.get('/hours-requests'));
  assert.ok(list.some(x => x.id === q.id && x.status === 'pending'));
  ok(await as.morgan.post(`/hours-requests/${q.id}/approve`));
  const t = ok(await as.casey.get(`/tasks/${state.task}/time`));
  assert.equal(t.budget, 210); assert.equal(t.logged, 120);
  assert.equal(t.budgetLog[0].minutes, 90);
  // Riley logs on the same task; Casey sees the total but not Riley's entry
  ok(await as.morgan.patch(`/tasks/${state.task}`, { budgetMinutes: 300 }));
  const rid = ok(await as.riley.post('/entries', { taskId: state.task, date: today, duration: '0:20', note: 'Riley private note' }), 201).id;
  const seen = ok(await as.casey.get(`/tasks/${state.task}/time`));
  assert.equal(seen.logged, 140);
  assert.ok(!seen.entries.some(e => e.note === 'Riley private note'));
  assert.ok(ok(await as.morgan.get(`/tasks/${state.task}/time`)).entries.some(e => e.id === rid));
  ok(await as.riley.del(`/entries/${rid}`));
  ok(await as.morgan.patch(`/tasks/${state.task}`, { budgetMinutes: 210 }));
});

test('4. submit, return with a reason, correct, resubmit, approve both steps', async () => {
  const sub = ok(await as.casey.post('/timesheets/submit', { weekStart: ws }));
  assert.ok(sub.count >= 4);
  const mine = ok(await as.casey.get(`/entries?from=${ws}&to=${today}`)).filter(e => e.task_id === state.task);
  assert.ok(mine.every(e => e.status === 'submitted'));
  // submitted time is locked for its owner and invisible to non-owners
  assert.equal((await as.casey.patch(`/entries/${state.timerEntry}`, { taskId: state.task, date: today, duration: '1' })).status, 403);
  assert.equal((await as.riley.patch(`/entries/${state.manual[0]}`, { taskId: state.task, date: today, duration: '1' })).status, 403);

  // routing: step 1 is Northwind’s account owner, Alex
  const groupFor = async (who, step) => ok(await as[who].get('/approvals')).find(g => g.userId === ids.U.casey && g.weekStart === ws && g.step === step && g.entries.some(e => e.task_id === state.task));
  assert.ok(await groupFor('alex', 'ae'), 'Alex sees it as account owner');
  assert.equal(await groupFor('jamie', 'ae'), undefined, 'the department manager waits for step 1');
  assert.equal(await groupFor('sam', 'ae'), undefined, 'other owners do not see it');
  const g1 = await groupFor('alex', 'ae'), entryIds = g1.entries.map(e => e.id), versions = vers(g1.entries);
  assert.equal((await as.casey.post('/approvals/approve', { step: 'ae', entryIds, versions })).status, 403, 'no approving your own time');
  assert.equal((await as.jamie.post('/approvals/approve', { step: 'ae', entryIds, versions })).status, 403, 'manager can’t do step 1');
  assert.equal((await as.alex.post('/approvals/return', { step: 'ae', entryIds, versions, reason: '   ' })).status, 400, 'a reason is required');
  ok(await as.alex.post('/approvals/return', { step: 'ae', entryIds, versions, reason: 'Split the overlap entry into its own task note' }));
  let es = ok(await as.casey.get(`/entries?from=${ws}&to=${today}`)).filter(e => entryIds.includes(e.id));
  assert.ok(es.every(e => e.status === 'rejected' && e.rejected_by === ids.U.alex && e.rejected_step === 'ae' && e.rejected_at));
  assert.match(es[0].rejected_reason, /Split the overlap/);

  // Casey corrects one entry and resubmits
  const fix = ok(await as.casey.patch(`/entries/${state.manual[1]}`, { taskId: state.task, date: today, duration: '0:15', note: 'Board revisions (fixed)' }));
  assert.equal(fix.entry.status, 'draft');
  ok(await as.casey.post('/timesheets/submit', { weekStart: ws }));
  es = ok(await as.casey.get(`/entries?from=${ws}&to=${today}`)).filter(e => entryIds.includes(e.id));
  assert.ok(es.every(e => e.status === 'submitted' && !e.rejected_reason));

  // step 1: Alex approves; step 2: Jamie, the Creative manager
  const g2 = await groupFor('alex', 'ae');
  // approving with the versions from before the correction is refused (the content changed)
  assert.equal((await as.alex.post('/approvals/approve', { step: 'ae', entryIds: g2.entries.map(e => e.id), versions })).status, 409, 'stale versions are refused');
  ok(await as.alex.post('/approvals/approve', { step: 'ae', entryIds: g2.entries.map(e => e.id), versions: vers(g2.entries) }));
  assert.equal((await as.alex.post('/approvals/approve', { step: 'ae', entryIds: g2.entries.map(e => e.id), versions: vers(g2.entries) })).status, 409, 'repeating a decision is refused');
  const g3 = await groupFor('jamie', 'dept');
  assert.ok(g3, 'Jamie sees it as department manager');
  assert.equal(g3.scope, 'Creative department');
  ok(await as.jamie.post('/approvals/approve', { step: 'dept', entryIds: g3.entries.map(e => e.id), versions: vers(g3.entries) }));
  es = ok(await as.casey.get(`/entries?from=${ws}&to=${today}`)).filter(e => entryIds.includes(e.id));
  assert.ok(es.every(e => e.status === 'approved' && e.ae_by === ids.U.alex && e.dept_by === ids.U.jamie && e.ae_at && e.dept_at));
  // audit trail records who did what
  const h = ok(await as.casey.get(`/entries/${state.manual[1]}/history`)).map(x => `${x.action}:${x.step || ''}:${x.actor_name}`);
  assert.deepEqual(h, ['created::Casey Diaz', 'submitted::Casey Diaz', 'returned:ae:Alex Rivera', 'updated::Casey Diaz', 'submitted::Casey Diaz', 'approved:ae:Alex Rivera', 'approved:dept:Jamie Chen']);
});

test('4b. reviewer exceptions from the wireframe', async () => {
  // Internal client has no account owner, so admins approve step 1; Morgan also manages Strategy, so both steps complete together.
  const t = ok(await as.taylor.post('/entries', { taskId: ids.T['Team meetings'], date: today, duration: '1' }), 201);
  ok(await as.taylor.post('/timesheets/submit', { weekStart: ws }));
  const g = ok(await as.morgan.get('/approvals')).find(x => x.entries.some(e => e.id === t.id));
  assert.equal(g.step, 'ae'); assert.match(g.approver, /Admins/);
  assert.equal(ok(await as.alex.get('/approvals')).find(x => x.entries.some(e => e.id === t.id)), undefined);
  const r = ok(await as.morgan.post('/approvals/approve', { step: 'ae', entryIds: g.entries.map(e => e.id), versions: vers(g.entries) }));
  assert.equal(r.fullyApproved, r.count, 'one approval covered both steps');
  // A department manager can’t approve their own time at step 2; an admin can, and sees why it came to admins.
  const j = ok(await as.jamie.post('/entries', { taskId: ids.T['Holiday campaign concepts'], date: today, duration: '0:45' }), 201);
  ok(await as.jamie.post('/timesheets/submit', { weekStart: ws }));
  ok(await as.alex.post('/approvals/approve', { step: 'ae', entryIds: [j.id], versions: await versionsVia(as.alex, [j.id]) }));
  assert.equal(ok(await as.jamie.get('/approvals')).find(x => x.entries.some(e => e.id === j.id)), undefined, 'not offered to Jamie');
  assert.equal((await as.jamie.post('/approvals/approve', { step: 'dept', entryIds: [j.id], versions: {} })).status, 403);
  const jg = ok(await as.morgan.get('/approvals')).find(x => x.entries.some(e => e.id === j.id));
  assert.equal(jg.approver, 'Admins (Jamie Chen’s own time)');
  ok(await as.morgan.post('/approvals/approve', { step: 'dept', entryIds: [j.id], versions: vers(jg.entries) }));
  // An admin's own time goes to another admin while there is one.
  ok(await as.morgan.post('/users', { name: 'Avery Stone', email: 'avery@fifthcolor.example', role: 'admin', password: PW }), 201);
  const mine = ok(await as.morgan.post('/entries', { taskId: ids.T['Team meetings'], date: today, duration: '0:30' }), 201);
  ok(await as.morgan.post('/timesheets/submit', { weekStart: ws }));
  assert.equal(ok(await as.morgan.get('/approvals')).find(x => x.entries.some(e => e.id === mine.id)), undefined, 'not offered to Morgan');
  assert.equal((await as.morgan.post('/approvals/approve', { step: 'ae', entryIds: [mine.id], versions: {} })).status, 403);
  const avery = await new Client('avery').login('avery@fifthcolor.example');
  assert.ok(ok(await avery.get('/approvals')).some(x => x.entries.some(e => e.id === mine.id)), 'the other admin gets it');
});

test('5. report totals and CSV reconcile, and follow permissions', async () => {
  const q = `from=${ws}&to=${addDays(ws, 6)}`;
  const csvTotals = text => {
    const [head, ...lines] = text.trim().split('\r\n'); const cols = head.split(',');
    const mi = cols.indexOf('minutes'), bi = cols.indexOf('billable'), pi = cols.indexOf('person');
    const rows = lines.map(l => parseCsvLine(l));
    return { n: rows.length, minutes: rows.reduce((s, r) => s + +r[mi], 0), billable: rows.filter(r => r[bi] === 'yes').reduce((s, r) => s + +r[mi], 0), people: new Set(rows.map(r => r[pi])) };
  };
  for (const [who, extra] of [['morgan', ''], ['morgan', `&users=${ids.U.casey}&status=approved`], ['morgan', `&clients=${ids.C.northwind}&billable=bill`], ['casey', ''], ['jamie', ''], ['alex', `&projects=${ids.P['nw-ret']}`]]) {
    const rep = ok(await as[who].get(`/reports/time?${q}${extra}`));
    const csv = await as[who].get(`/reports/time.csv?${q}${extra}`, { raw: true });
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
    const t = csvTotals(csv.data);
    assert.equal(t.n, rep.totals.entries, `${who}${extra}: same rows`);
    assert.equal(t.minutes, rep.totals.minutes, `${who}${extra}: same minutes`);
    assert.equal(t.billable, rep.totals.billable, `${who}${extra}: same billable minutes`);
    assert.equal(rep.totals.billable + rep.totals.nonBillable, rep.totals.minutes);
  }
  // Casey’s approved Northwind retainer time this week: 60 (timer) + 10 (quick fix) + 30 + 15 + 15 = 130 minutes
  const mine = ok(await as.morgan.get(`/reports/time?${q}&users=${ids.U.casey}&status=approved&projects=${ids.P['nw-ret']}`));
  assert.equal(mine.totals.minutes, 130);
  // visibility: a team member sees only their own time (no clients or departments of their own)
  const caseyCsv = csvTotals((await as.casey.get(`/reports/time.csv?${q}`, { raw: true })).data);
  assert.deepEqual([...caseyCsv.people], ['Casey Diaz']);
  // filtering for someone else’s time returns nothing rather than leaking it
  assert.equal(ok(await as.casey.get(`/reports/time?${q}&users=${ids.U.taylor}`)).totals.entries, 0);
  // the Creative manager sees their department’s time, but not other departments’
  const jamie = ok(await as.jamie.get(`/reports/time?${q}`));
  assert.ok(jamie.entries.some(e => e.user_id === ids.U.casey));
  assert.ok(!jamie.entries.some(e => e.user_id === ids.U.taylor));
  assert.equal(ok(await as.casey.get(`/reports/time?${q}`)).showValue, false);
  // timesheet access mirrors the wireframe
  assert.equal((await as.casey.get(`/entries?user=${ids.U.riley}&from=${ws}&to=${today}`)).status, 403);
  assert.equal((await as.alex.get(`/entries?user=${ids.U.casey}&from=${ws}&to=${today}`)).status, 200, 'managers see team timesheets');
  assert.equal((await as.alex.get(`/entries?user=${ids.U.morgan}&from=${ws}&to=${today}`)).status, 403, '…but not admins’');
  assert.equal((await as.jamie.get(`/entries?user=${ids.U.casey}&from=${ws}&to=${today}`)).status, 200, 'department managers see their department');
});

test('6. notifications reach the right people, once', async () => {
  const titles = async who => ok(await as[who].get('/notifications')).items.map(n => `${n.type}|${n.title}|${n.body}`);
  const casey = await titles('casey'), alex = await titles('alex'), jamie = await titles('jamie'), morgan = await titles('morgan'), sam = await titles('sam');
  const has = (list, re, msg) => assert.ok(list.some(t => re.test(t)), `${msg}\n${list.join('\n')}`);
  const lacks = (list, re, msg) => assert.ok(!list.some(t => re.test(t)), msg);
  has(casey, /^assigned\|You’re responsible for Holiday menu boards\|Morgan Hale added it/, 'Casey hears about the task Morgan gave her');
  has(alex, /^time\|Time to approve\|Casey Diaz submitted .* on Northwind Coffee/, 'the account owner hears about submitted time');
  lacks(sam, /Casey Diaz submitted/, 'other owners hear nothing');
  has(casey, /^time\|Your time was sent back\|Alex Rivera: Split the overlap/, 'Casey hears why it came back');
  has(jamie, /^time\|Time to approve\|Casey Diaz’s Creative time .* ready for the department sign-off/, 'the department manager hears after step 1');
  has(casey, /^time\|Your time was approved\|/, 'Casey hears when it is fully approved');
  has(morgan, /^hours\|Casey Diaz asked for more time\|1:30 on “Holiday menu boards”, Northwind Coffee/, 'admins hear about hours requests');
  has(casey, /^hours\|More time approved: Holiday menu boards\|Morgan Hale added 1:30/, 'the requester hears the decision');
  has(casey, /^budget\|Locked: Holiday menu boards used its time budget/, 'locking at 100% is announced');
  has(morgan, /^budget\|Locked: Holiday menu boards/, 'admins hear about locks too');
  // Internal client has no owner, so Taylor’s submission went to admins (not to Taylor)
  has(morgan, /^time\|Time to approve\|Taylor Kim submitted .* on FifthColor \(internal\)/, 'no owner means admins are told');
  // Jamie’s own Creative time skipped Jamie at step 2 and went to admins
  has(morgan, /^time\|Time to approve\|Jamie Chen’s Creative time/, 'a manager’s own time goes to admins');
  lacks(jamie, /Jamie Chen’s Creative time/, 'not to the manager themself');
  // due-date reminders are created once, for the assignee
  const due = (await titles('casey')).filter(t => /^due\|Due today: Holiday menu boards/.test(t));
  assert.equal(due.length, 1, 'one reminder, even after reloading');
  // marking read is per person; someone else’s ids are ignored
  const alexItems = ok(await as.alex.get('/notifications')).items;
  const before = ok(await as.alex.get('/notifications?count=1')).unread;
  ok(await as.casey.post('/notifications/read', { ids: alexItems.map(n => n.id) }));
  assert.equal(ok(await as.alex.get('/notifications?count=1')).unread, before, 'Casey can’t mark Alex’s notifications');
  const r = ok(await as.alex.post('/notifications/read', { all: true }));
  assert.equal(r.unread, 0);
  assert.equal(ok(await as.alex.get('/bootstrap')).counts.notifications, 0);
});

test('7. review fixes: task permissions and frozen routing', async () => {
  const mk = async (who, extra = {}) => ok(await as[who].post('/tasks', { projectId: ids.P['nw-ret'], title: `Review task ${Math.random().toString(36).slice(2, 7)}`, serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today, budget: '5', ...extra }), 201).id;
  assert.equal((await as.casey.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Overflow', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today, budget: '500' })).status, 403, 'team members can’t create tasks (or budgets)');
  const tid = await mk('alex');
  assert.equal((await as.riley.patch(`/tasks/${tid}`, { serviceLineId: ids.S.development })).status, 403, 'others can’t edit');
  assert.equal((await as.riley.patch(`/tasks/${tid}`, { status: 'done' })).status, 403, 'others can’t mark it done');
  ok(await as.casey.patch(`/tasks/${tid}`, { status: 'review', notes: 'Ready for a look' }), 200);
  assert.equal((await as.casey.patch(`/tasks/${tid}`, { billable: false })).status, 403, 'the person responsible can’t flip billable');
  // Hijack attempt from the review: submitted Creative time stays with the Creative manager even if the task moves.
  const e = ok(await as.casey.post('/entries', { taskId: tid, date: today, duration: '0:20' }), 201).entry;
  ok(await as.casey.post('/timesheets/submit', { weekStart: ws }));
  ok(await as.alex.patch(`/tasks/${tid}`, { serviceLineId: ids.S.development }));
  ok(await as.alex.post('/approvals/approve', { step: 'ae', entryIds: [e.id], versions: await versionsVia(as.alex, [e.id]) }));
  assert.equal(ok(await as.riley.get('/approvals')).find(g => g.entries.some(x => x.id === e.id)), undefined, 'not routed to the Development manager');
  assert.ok(ok(await as.jamie.get('/approvals')).some(g => g.entries.some(x => x.id === e.id)), 'still with the Creative manager');
  // Sent back, it is open again and follows the task to Development.
  ok(await as.jamie.post('/approvals/return', { step: 'dept', entryIds: [e.id], versions: await versionsVia(as.jamie, [e.id]), reason: 'This is Development work now' }));
  assert.equal((await one('SELECT service_line_id FROM time_entries WHERE id = $1', [e.id])).service_line_id, ids.S.development, 'sent-back time follows the task again');
  // Approved billable time keeps its billable flag when the task changes later.
  const before = ok(await as.morgan.get(`/reports/time?from=${ws}&to=${addDays(ws, 6)}&status=approved`)).totals;
  ok(await as.morgan.patch(`/tasks/${state.task}`, { billable: false }));
  const after = ok(await as.morgan.get(`/reports/time?from=${ws}&to=${addDays(ws, 6)}&status=approved`)).totals;
  assert.deepEqual(after, before, 'approved totals unchanged');
  ok(await as.morgan.patch(`/tasks/${state.task}`, { billable: true }));
  // Time not yet submitted follows the task's service line and billable flag (the app keeps this in step, not the database).
  const snapEntry = async id => ({ ...(await one('SELECT service_line_id, billable FROM time_entries WHERE id = $1', [id])) });
  const moving = ok(await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Moving job', serviceLineId: ids.S.creative, assigneeId: ids.U.riley, dueDate: today, budget: '2' }), 201).id;
  const draft = ok(await as.riley.post('/entries', { taskId: moving, date: today, duration: '0:15' }), 201).entry;
  assert.deepEqual(await snapEntry(draft.id), { service_line_id: ids.S.creative, billable: true }, 'a new entry takes its task’s service line');
  ok(await as.morgan.patch(`/tasks/${moving}`, { serviceLineId: ids.S.strategy, billable: false }));
  assert.deepEqual(await snapEntry(draft.id), { service_line_id: ids.S.strategy, billable: false }, 'a draft moves with its task');
  ok(await as.morgan.patch(`/tasks/${moving}`, { serviceLineId: ids.S.creative, billable: true }));
  assert.equal((await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Huge', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today, budgetMinutes: 2 ** 40 })).status, 400, 'budget cap');
});

test('8. review fixes: entries, timers and approvals', async () => {
  // admins can read an entry's history
  assert.equal(ok(await as.morgan.get(`/entries/${state.timerEntry}/history`))[0].action, 'created');
  // over-budget time can still be corrected; only added minutes are blocked
  const tid = ok(await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Small job', serviceLineId: ids.S.creative, assigneeId: ids.U.riley, dueDate: today, budget: '1' }), 201).id;
  const tmr = crypto.randomUUID();
  ok(await as.riley.post('/timer/start', { taskId: tid, timerId: tmr }), 201);
  assert.equal((await as.casey.post('/timer/start', { taskId: tid, timerId: tmr })).status, 409, 'someone else’s timer id reveals nothing');
  await query(`UPDATE timers SET started_at = UTC_TIMESTAMP(6) - INTERVAL 75 MINUTE WHERE id = $1`, [tmr]);
  const over = ok(await as.riley.post('/timer/stop', { timerId: tmr })).entry;
  assert.equal(over.minutes, 75);
  ok(await as.riley.patch(`/entries/${over.id}`, { taskId: tid, date: over.date, start: over.start, end: over.end, note: 'Note added' }));
  ok(await as.riley.patch(`/entries/${over.id}`, { taskId: tid, date: over.date, duration: '1:05' }));
  assert.equal((await as.riley.patch(`/entries/${over.id}`, { taskId: tid, date: over.date, duration: '1:30' })).status, 409, 'adding minutes is still blocked');
  // timer rounding survives a note-only edit
  ok(await as.morgan.patch('/settings', { roundingMinutes: 15 }));
  const t2 = crypto.randomUUID(), big = ok(await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Rounded job', serviceLineId: ids.S.creative, assigneeId: ids.U.riley, dueDate: today, budget: '5' }), 201).id;
  ok(await as.riley.post('/timer/start', { taskId: big, timerId: t2 }), 201);
  await query(`UPDATE timers SET started_at = UTC_TIMESTAMP(6) - INTERVAL 47 MINUTE WHERE id = $1`, [t2]);
  const rounded = ok(await as.riley.post('/timer/stop', { timerId: t2 })).entry;
  ok(await as.morgan.patch('/settings', { roundingMinutes: 0 }));
  assert.equal(rounded.minutes, 60);
  const kept = ok(await as.riley.patch(`/entries/${rounded.id}`, { taskId: big, date: rounded.date, start: rounded.start, end: rounded.end, note: 'Just a note' })).entry;
  assert.equal(kept.minutes, 60, 'unchanged times keep the rounded minutes');
  // zero-length and past-midnight timer entries: no false overlaps, and they can be saved again
  const z = await rawEntry(ids.U.riley, big, addDays(today, -1), '23:50', '00:10', 20);
  const late = ok(await as.riley.post('/entries', { taskId: big, date: addDays(today, -1), start: '22:00', end: '23:30' }), 201);
  assert.equal(late.overlaps.length, 0, 'an entry crossing midnight doesn’t cover the whole evening');
  ok(await as.riley.patch(`/entries/${z}`, { taskId: big, date: addDays(today, -1), start: '23:50', end: '00:10', note: 'Late fix' }));
  assert.equal((await one('SELECT minutes FROM time_entries WHERE id = $1', [z])).minutes, 20);
  // no logging far into the future
  assert.equal((await as.riley.post('/entries', { taskId: big, date: addDays(today, 40), duration: '1' })).status, 400);
  // a running timer blocks only the week it will land in
  const t3 = crypto.randomUUID();
  ok(await as.chris.post('/timer/start', { taskId: ids.T['Paid social plan'], timerId: t3 }), 201);
  // started at 23:00 last Sunday, workspace time (05:00 UTC in winter, 04:00 in summer)
  const sundayLate = [5, 4].map(hr => new Date(`${ws}T0${hr}:00:00Z`)).find(d => { const p = localParts(d, 'America/Chicago'); return p.date === addDays(ws, -1) && p.hm === '23:00'; });
  await query('UPDATE timers SET started_at = $2 WHERE id = $1', [t3, sundayLate]);
  const lastWeek = await as.chris.post('/timesheets/submit', { weekStart: addDays(ws, -7) });
  assert.equal(lastWeek.status, 409); assert.equal(lastWeek.data.code, 'timer_running');
  ok(await as.chris.post('/entries', { taskId: ids.T['Paid social plan'], date: today, duration: '0:30' }), 201);
  ok(await as.chris.post('/timesheets/submit', { weekStart: ws }), 200);
  // two requests for more hours at once: one gets through
  const pair = await Promise.all([1, 2].map(() => as.riley.post(`/tasks/${tid}/hours-requests`, { hours: '1', reason: 'More boards' })));
  assert.deepEqual(pair.map(p => p.status).sort(), [201, 400]);
});

test('9. review fixes: people, sign-in and data hygiene', async () => {
  assert.equal((await as.morgan.post('/users', { name: 'X', email: 'x@fifthcolor.example', role: 'constructor', password: 'longenough' })).status, 400);
  assert.equal((await as.morgan.post('/users', { name: 'X', email: 'x@fifthcolor.example', role: 'member', deptId: crypto.randomUUID(), password: 'longenough' })).status, 400);
  // bill rates are for managers and admins
  assert.equal(ok(await as.casey.get('/bootstrap')).serviceLines[0].rate, undefined);
  assert.ok(ok(await as.alex.get('/bootstrap')).serviceLines[0].rate !== undefined);
  // people change their own password, which signs them out everywhere else
  const elsewhere = await new Client('casey-phone').login('casey@fifthcolor.example');
  assert.equal((await as.casey.post('/auth/password', { current: 'wrong', next: 'new-password-1' })).status, 400);
  ok(await as.casey.post('/auth/password', { current: PW, next: 'new-password-1' }));
  assert.equal((await elsewhere.get('/bootstrap')).status, 401, 'other sessions end');
  assert.equal((await as.casey.get('/bootstrap')).status, 200, 'this one stays');
  assert.equal((await new Client('c').req('POST', '/auth/login', { email: 'casey@fifthcolor.example', password: PW })).status, 400);
  await new Client('c2').login('casey@fifthcolor.example', 'new-password-1');
  // archiving someone saves their running timer instead of stranding it
  ok(await as.taylor.post('/timer/start', { taskId: ids.T['Quarterly analytics review'], timerId: crypto.randomUUID() }), 201);
  ok(await as.morgan.patch(`/users/${ids.U.taylor}`, { archived: true }));
  assert.equal((await one('SELECT COUNT(*) AS n FROM timers WHERE user_id = $1', [ids.U.taylor])).n, 0);
  assert.ok(await one(`SELECT 1 FROM time_entries WHERE user_id = $1 AND source = 'timer' AND status = 'draft'`, [ids.U.taylor]));
  assert.equal((await as.taylor.get('/bootstrap')).status, 401, 'their sessions end');
});

test('10. re-check fixes: upload limit, overlaps with rounding, sign-in slowdown', async () => {
  // Only a signed-in admin's CSV upload may be large; anyone else is refused before the body is read.
  const big = JSON.stringify({ filename: 'x.csv', text: 'Date,User\n' + 'x'.repeat(1024 * 1024) });
  const anon = await fetch(base + '/api/import/paymo/csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(anon.status, 413);
  const memberUp = await fetch(base + '/api/import/paymo/csv', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: as.riley.cookie }, body: big });
  assert.equal(memberUp.status, 413);
  const adminUp = await fetch(base + '/api/import/paymo/csv', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: as.morgan.cookie }, body: big });
  assert.notEqual(adminUp.status, 413, 'admins can upload large files');
  // A rounded timer entry (15:52–16:39 recorded, 60 minutes counted) doesn't overlap what comes after it.
  const task = ids.T['Portal bug fixes'];
  await rawEntry(ids.U.riley, task, addDays(today, -2), '15:52', '16:39', 60);
  assert.equal(ok(await as.riley.post('/entries', { taskId: task, date: addDays(today, -2), start: '16:41', end: '16:51' }), 201).overlaps.length, 0);
  assert.equal(ok(await as.riley.post('/entries', { taskId: task, date: addDays(today, -2), start: '16:30', end: '16:40' }), 201).overlaps.length, 1, 'real overlaps are still caught');
  // Many failed sign-ins from one address slow things down but never lock out a correct password.
  for (let i = 0; i < 32; i++) await new Client('spray').req('POST', '/auth/login', { email: `nobody${i}@example.com`, password: 'Summer2026!' });
  const t0 = Date.now();
  await new Client('jamie-again').login('jamie@fifthcolor.example');
  assert.ok(Date.now() - t0 >= 250, 'it was slowed down');
});

test('11. pre-launch review fixes: exact sign-in email, deletes, input types, id case', async () => {
  // MySQL's collation would let “chrís@” or a full-width “ｃhris@” find Chris, each with its own allowance of tries.
  // Only the exact address signs in (letter case aside). These come from another address so test 10's count is untouched.
  const login = (email, password = PW) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ email, password }) });
  for (const v of ['chrís@fifthcolor.example', 'ｃhris@fifthcolor.example', 'chris@ﬁfthcolor.example']) assert.equal((await login(v)).status, 400, `${v} is not Chris`);
  assert.equal((await login('CHRIS@fifthcolor.example')).status, 200, 'letter case still doesn’t matter');

  // The app deletes with no body and no JSON header.
  const del = (client, path) => fetch(base + '/api' + path, { method: 'DELETE', headers: { Cookie: client.cookie } });
  const task = ids.T['Portal bug fixes'];
  const made = ok(await as.riley.post('/entries', { taskId: task, date: addDays(today, -3), duration: '0:15', note: 'to delete' }), 201);
  assert.equal((await del(as.riley, `/entries/${made.id}`)).status, 200);
  assert.equal(await one('SELECT id FROM time_entries WHERE id = $1', [made.id]), null, 'the entry is gone');
  const t = ok(await as.morgan.post('/tasks', { projectId: ids.P['nw-ret'], title: 'Delete me', serviceLineId: ids.S.creative, assigneeId: ids.U.casey, dueDate: today, budget: '1' }), 201);

  // Ids are lowercase, as the app makes them; an uppercase copy would fail later text comparisons.
  assert.equal((await as.alex.patch(`/tasks/${t.id}`, { assigneeId: ids.U.chris.toUpperCase() })).status, 400);
  assert.equal((await as.riley.get(`/entries?user=${ids.U.riley.toUpperCase()}&from=${today}&to=${today}`)).status, 400);
  assert.equal((await del(as.morgan, `/tasks/${t.id}`)).status, 200);

  // Lists where text is expected are bad input, not server errors.
  assert.equal((await as.riley.post('/entries', { taskId: task, date: today, start: ['09:00'], end: '10:00' })).status, 400);
  assert.equal((await as.riley.get(`/entries/overlaps?date=${today}&start=09:00&start=10:00&end=11:00`)).status, 400);
});

function addMin(hm, n) { const [h, m] = hm.split(':').map(Number), t = h * 60 + m + n; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function parseCsvLine(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
