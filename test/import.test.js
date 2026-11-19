// Paymo import against a mock Paymo API (shaped like https://github.com/paymoapp/api) and a CSV export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'mysql://fctime:fctime@localhost:3306/fctime_test';
const { migrate } = await import('../server/migrate.js');
const { seedDemo } = await import('../server/seed.js');
const { createApp } = await import('../server/app.js');
const { one, many, closePool } = await import('../server/db.js');
const { parseDurationCell, parseDateCell, parseTimeCell, detectColumns } = await import('../server/import/csv.js');

const PW = 'test-password-1', KEY = 'goodkey123456';
let app, paymo, base, ids, admin, member;
const calls = [];
let throttleOnce = true;

/* ---------- a small Paymo stand-in ---------- */
const P = {
  users: [
    { id: 501, name: 'Casey Diaz', email: 'casey@fifthcolor.example', type: 'Employee', active: true },
    { id: 502, name: 'Dana Fox', email: 'dana@fifthcolor.example', type: 'Employee', active: true },
    { id: 503, name: 'Old Timer', email: 'old@fifthcolor.example', type: 'Employee', active: false },
    { id: 504, name: 'Client Guest', email: 'guest@client.example', type: 'Guest', active: true },
  ],
  clients: [{ id: 701, name: 'Northwind Coffee', active: true }, { id: 702, name: 'Lakeside Brewing', active: true }],
  projects: [
    { id: 801, name: 'Retainer', client_id: 701, active: true, billable: true },
    { id: 802, name: 'Website 2026', client_id: 702, active: true, billable: true },
    { id: 803, name: 'Internal stuff', client_id: null, active: true, billable: false },
  ],
  tasklists: [{ id: 901, name: 'Design', project_id: 801 }, { id: 902, name: 'Development', project_id: 802 }, { id: 903, name: 'Admin', project_id: 803 }],
  tasks: [
    { id: 1001, name: 'Menu board refresh', project_id: 801, tasklist_id: 901, users: [501], complete: false, due_date: null, billable: true, budget_hours: null },
    { id: 1002, name: 'Homepage build', project_id: 802, tasklist_id: 902, users: [502], complete: false, due_date: '2026-12-01', billable: true, budget_hours: 20 },
    { id: 1003, name: 'Old finished thing', project_id: 802, tasklist_id: 902, users: [502], complete: true, due_date: null, billable: true, budget_hours: 5 },
    { id: 1004, name: 'Timesheets admin', project_id: 803, tasklist_id: 903, users: [], complete: false, due_date: null, billable: false, budget_hours: null },
    // archived: left out of the plain list, returned only when asked for by id
    { id: 1005, name: 'Archived banner work', project_id: 802, tasklist_id: 902, users: [502], complete: true, due_date: '2026-11-13', billable: true, budget_hours: 2, hidden: true },
  ],
  entries: [
    { id: 5001, task_id: 1002, user_id: 502, is_bulk: false, start_time: '2026-11-10T15:00:00Z', end_time: '2026-11-10T17:30:00Z', duration: 9000, description: 'Hero section' },
    { id: 5002, task_id: 1002, user_id: 502, is_bulk: true, date: '2026-11-11', duration: 5400, description: '<p>Nav</p>' },
    { id: 5003, task_id: 1001, user_id: 501, is_bulk: false, start_time: '2026-11-12T20:00:00Z', end_time: '2026-11-12T21:00:00Z', duration: 3600, description: '' },
    { id: 5004, task_id: 1004, user_id: 503, is_bulk: true, date: '2026-11-09', duration: 1800, description: 'Old' },
    { id: 5005, task_id: 1002, user_id: 502, is_bulk: false, start_time: '2026-11-13T15:00:00Z', description: 'still running' },
    { id: 5006, task_id: 1002, user_id: 502, is_bulk: true, date: '2025-06-01', duration: 3600, description: 'out of range' },
    { id: 5007, task_id: 1004, user_id: 504, is_bulk: true, date: '2026-11-12', duration: 0, description: 'zero' },
    { id: 5008, task_id: 1005, user_id: 502, is_bulk: true, date: '2026-11-13', duration: 3600, description: 'Banner' },
  ],
};
function mockPaymo() {
  const m = express();
  m.use((req, res, next) => {
    calls.push(decodeURIComponent(req.url));
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${KEY}:x`).toString('base64')) return res.status(401).json({ message: 'Unauthorized' });
    next();
  });
  m.get('/api/me', (_q, r) => r.json({ users: [{ id: 1, email: 'owner@fifthcolor.example' }] }));
  for (const k of ['users', 'clients', 'projects', 'tasklists', 'tasks']) {
    m.get(`/api/${k}`, (q, r) => {
      const ids = String(q.query.where || '').match(/^id in \(([\d,]+)\)$/);
      r.json({ [k]: ids ? P[k].filter(x => ids[1].split(',').map(Number).includes(x.id)) : P[k].filter(x => !x.hidden) });
    });
  }
  m.get('/api/entries', (req, res) => {
    if (throttleOnce) { throttleOnce = false; return res.status(429).set('Retry-After', '1').json({ message: 'slow down' }); }
    const [, a, b] = String(req.query.where).match(/time_interval in \("([^"]+)","([^"]+)"\)/);
    const inside = e => { const t = e.start_time || `${e.date}T00:00:00Z`; return t >= a && t < b; };
    res.json({ entries: P.entries.filter(inside) });
  });
  return m;
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, raw) {
    const r = await fetch(base + '/api' + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return { status: r.status, data: raw ? await r.text() : await r.json() };
  }
  async login(email, pw = PW) { const r = await this.req('POST', '/auth/login', { email, password: pw }); return r.status; }
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };

before(async () => {
  await migrate({ reset: true, log: () => {} });
  ids = await seedDemo({ password: PW, log: () => {} });
  paymo = mockPaymo().listen(0); await new Promise(r => paymo.once('listening', r));
  process.env.PAYMO_BASE_URL = `http://localhost:${paymo.address().port}/api`;
  app = createApp().listen(0); await new Promise(r => app.once('listening', r));
  base = `http://localhost:${app.address().port}`;
  admin = new Client(); assert.equal(await admin.login('morgan@fifthcolor.example'), 200);
  member = new Client(); assert.equal(await member.login('casey@fifthcolor.example'), 200);
});
after(async () => { app && app.close(); paymo && paymo.close(); await closePool(); });

test('CSV cell parsers', () => {
  assert.equal(parseDurationCell('1:30'), 90);
  assert.equal(parseDurationCell('01:30:30'), 91);
  assert.equal(parseDurationCell('1,5'), 90);
  assert.equal(parseDurationCell('2.25'), 135);
  assert.equal(parseDurationCell('1h 15m'), 75);
  assert.equal(parseDurationCell('45m'), 45);
  assert.equal(parseDurationCell('soon'), null);
  assert.equal(parseDateCell('11/16/2026'), '2026-11-16');
  assert.equal(parseDateCell('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(parseDateCell('16.11.2026'), '2026-11-16');
  assert.equal(parseDateCell('2026-02-30'), null);
  assert.equal(parseTimeCell('9:05 PM'), '21:05');
  assert.equal(parseTimeCell('2026-11-16 14:30'), '14:30');
  assert.equal(parseTimeCell('12:10 AM'), '00:10');
  const col = detectColumns(['Date', 'User', 'Client', 'Project', 'Task list', 'Task', 'Description', 'Start time', 'End time', 'Duration (h)']);
  assert.deepEqual([col.date, col.person, col.client, col.project, col.tasklist, col.task, col.note, col.start, col.end, col.duration], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('only admins can import; a wrong key is reported', async () => {
  assert.equal((await member.req('GET', '/import/runs')).status, 403);
  assert.equal((await member.req('POST', '/import/paymo/fetch', { apiKey: KEY, from: '2026-11-01', to: '2026-11-30' })).status, 403);
  const r = await admin.req('POST', '/import/paymo/fetch', { apiKey: 'wrong-key-123', from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.status, 400); assert.match(r.data.error, /didn’t accept that API key/);
});

let runId;
test('API import: preview matches, creates and skips the right things', async () => {
  const pv = ok(await admin.req('POST', '/import/paymo/fetch', { apiKey: KEY, from: '2026-11-01', to: '2026-11-30' }), 201);
  runId = pv.id;
  assert.ok(calls.some(c => c.includes('time_interval in ("2026-10-31T00:00:00Z","2026-11-01T00:00:00Z")')), 'entries fetched month by month');
  assert.ok(calls.some(c => c.includes('/tasks?where=id in (1005)')), 'archived tasks the entries need are fetched by id');
  assert.equal(pv.entries.new, 5); assert.equal(pv.entries.running, 1); assert.equal(pv.entries.zero, 1);
  assert.equal(pv.entries.minutes, 150 + 90 + 60 + 30 + 60);
  const person = n => pv.people.find(p => p.name === n);
  assert.equal(person('Casey Diaz').action, 'match'); assert.equal(person('Casey Diaz').matchedBy, 'email');
  assert.equal(person('Dana Fox').action, 'create');
  assert.equal(person('Old Timer').action, 'create');
  assert.equal(person('Client Guest'), undefined, 'guests with no time are left out');
  const svc = k => pv.serviceLines.find(x => x.key === k);
  assert.equal(svc('design').serviceLineId, ids.S.creative); assert.equal(svc('design').how, 'keyword');
  assert.equal(svc('development').serviceLineId, ids.S.development);
  assert.equal(svc('admin').how, 'default');
  assert.deepEqual(pv.clients.create, ['Internal (no client in Paymo)', 'Lakeside Brewing']); assert.equal(pv.clients.match, 1);
  assert.equal(pv.projects.match, 1, 'Northwind’s Retainer is matched by name');
  assert.equal(pv.tasks.create, 3); assert.equal(pv.tasks.match, 1, 'Menu board refresh is matched; finished tasks without time stay out, finished ones with time come in');
});

test('API import: choices in the preview, then import', async () => {
  const pv = ok(await admin.req('PATCH', `/import/runs/${runId}`, {
    userMap: { 503: 'skip' }, serviceLineMap: { admin: ids.S.strategy }, entryStatus: 'approved',
  }));
  assert.equal(pv.entries.new, 4); assert.equal(pv.entries.skippedPerson, 1);
  assert.equal(pv.serviceLines.find(x => x.key === 'admin').how, 'chosen');
  const sum = ok(await admin.req('POST', `/import/runs/${runId}/commit`, {}));
  assert.equal(sum.entriesImported, 4); assert.equal(sum.minutes, 360);
  assert.equal(sum.peopleCreated, 1); assert.equal(sum.peopleLinked, 1);
  assert.equal(sum.clientsCreated, 2); assert.equal(sum.projectsCreated, 2); assert.equal(sum.tasksCreated, 3);
  assert.equal((await one(`SELECT status FROM tasks WHERE paymo_task_id = 1005`)).status, 'done', 'finished in Paymo, finished here');
  assert.equal((await admin.req('POST', `/import/runs/${runId}/commit`, {})).status, 409, 'a run imports once');

  const dana = await one(`SELECT id, role, password_hash, paymo_user_id, archived_at FROM users WHERE email = 'dana@fifthcolor.example'`);
  assert.equal(dana.role, 'member'); assert.equal(dana.password_hash, null); assert.equal(dana.paymo_user_id, 502);
  assert.equal((await one(`SELECT paymo_user_id FROM users WHERE email = 'casey@fifthcolor.example'`)).paymo_user_id, 501);
  const e1 = await one(`SELECT entry_date AS d, TIME_FORMAT(start_time, '%H:%i') AS s, TIME_FORMAT(end_time, '%H:%i') AS e, minutes, status, source, note FROM time_entries WHERE paymo_entry_id = 5001`);
  assert.deepEqual(e1, { d: '2026-11-10', s: '09:00', e: '11:30', minutes: 150, status: 'approved', source: 'import', note: 'Hero section' }, 'UTC times land in Chicago time');
  assert.equal((await one('SELECT note FROM time_entries WHERE paymo_entry_id = 5002')).note, 'Nav', 'HTML stripped from descriptions');
  const hb = await one(`SELECT t.budget_minutes, t.due_date AS due, t.status, t.assignee_id, t.service_line_id, t.paymo_task_id, p.name AS project, c.name AS client
                          FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id WHERE t.title = 'Homepage build'`);
  assert.deepEqual(hb, { budget_minutes: 1200, due: '2026-12-01', status: 'doing', assignee_id: dana.id, service_line_id: ids.S.development, paymo_task_id: 1002, project: 'Website 2026', client: 'Lakeside Brewing' });
  const ta = await one(`SELECT service_line_id, billable, assignee_id FROM tasks WHERE title = 'Timesheets admin'`);
  assert.equal(ta.service_line_id, ids.S.strategy); assert.equal(ta.billable, false); assert.equal(ta.assignee_id, null, 'its only logger was skipped');
  assert.equal((await one(`SELECT budget_minutes FROM tasks WHERE id = $1`, [ids.T['Menu board refresh']])).budget_minutes, 360, 'matched tasks are left as they are');
  const hist = (await many(`SELECT action, detail FROM time_entry_events WHERE entry_id = (SELECT id FROM time_entries WHERE paymo_entry_id = 5003)`));
  assert.equal(hist[0].action, 'imported');
  // the imported time shows in reports, and the CSV agrees
  const rep = ok(await admin.req('GET', `/reports/time?from=2026-11-01&to=2026-11-30&clients=${(await one(`SELECT id FROM clients WHERE name = 'Lakeside Brewing'`)).id}`));
  assert.equal(rep.totals.minutes, 300);
  const csv = (await admin.req('GET', `/reports/time.csv?from=2026-11-01&to=2026-11-30&clients=${rep.filters.clients[0]}`, undefined, true)).data;
  assert.equal(csv.trim().split('\r\n').length - 1, 3);
});

test('API import again: nothing is duplicated; only what is new comes over', async () => {
  const pv = ok(await admin.req('POST', '/import/paymo/fetch', { apiKey: KEY, from: '2026-11-01', to: '2026-11-30' }), 201);
  assert.equal(pv.entries.already, 4);
  assert.equal(pv.entries.new, 1, 'only Old Timer’s entry, skipped last time');
  assert.equal(pv.tasks.create, 0); assert.equal(pv.clients.create.length, 0);
  const sum = ok(await admin.req('POST', `/import/runs/${pv.id}/commit`, {}));
  assert.equal(sum.entriesImported, 1);
  const old = await one(`SELECT archived_at FROM users WHERE email = 'old@fifthcolor.example'`);
  assert.ok(old.archived_at, 'people inactive in Paymo come in archived');
  const third = ok(await admin.req('POST', '/import/paymo/fetch', { apiKey: KEY, from: '2026-11-01', to: '2026-11-30' }), 201);
  assert.equal(third.entries.new, 0); assert.equal(third.entries.already, 5);
  assert.equal((await admin.req('POST', `/import/runs/${third.id}/commit`, {})).status, 400, 'nothing new to import');
  ok(await admin.req('POST', `/import/runs/${third.id}/discard`, {}));
  const runs = ok(await admin.req('GET', '/import/runs'));
  assert.deepEqual(runs.map(r => r.status), ['discarded', 'imported', 'imported']);
});

const CSV = [
  'Date,User,Email,Client,Project,Task list,Task,Description,Start time,End time,Duration',
  '11/16/2026,Casey Diaz,casey@fifthcolor.example,Northwind Coffee,Retainer,Design,"Social posts, November","Post set 2",9:00 AM,10:30 AM,1:30',
  '11/16/2026,Casey Diaz,casey@fifthcolor.example,Northwind Coffee,Retainer,Design,"Social posts, November","Post set 2",9:00 AM,10:30 AM,1:30',
  '11/16/2026,Riley Brooks,riley@fifthcolor.example,Pine & Co.,Development retainer,Development,Product filter rebuild,Filters,,,2.5',
  '2026-11-17,New Person,,Brand New Client,Launch,,Kickoff,"Kickoff call, with ""quotes""",,,45m',
  'soon,Casey Diaz,casey@fifthcolor.example,Northwind Coffee,Retainer,Design,Thing,,,,1',
].join('\r\n');

test('CSV import: columns, matching, duplicates and re-import', async () => {
  const pv = ok(await admin.req('POST', '/import/paymo/csv', { filename: 'paymo-time.csv', text: CSV }), 201);
  assert.equal(pv.csv.columns.start, 8); assert.equal(pv.csv.columns.duration, 10);
  assert.equal(pv.entries.new, 4, 'identical rows are kept as two entries');
  assert.equal(pv.problemCount, 1); assert.match(pv.problems[0].why, /date/);
  assert.equal(pv.people.find(p => p.name === 'Casey Diaz').action, 'match');
  assert.equal(pv.people.find(p => p.name === 'New Person').action, 'create');
  assert.equal(pv.tasks.match, 2, 'existing tasks matched by project and name');
  const sum = ok(await admin.req('POST', `/import/runs/${pv.id}/commit`, {}));
  assert.equal(sum.entriesImported, 4); assert.equal(sum.minutes, 90 + 90 + 150 + 45);
  assert.equal(sum.placeholderEmails, 1);
  const np = await one(`SELECT email, role FROM users WHERE name = 'New Person'`);
  assert.match(np.email, /@import\.invalid$/);
  assert.equal(await new Client().login(np.email, 'anything'), 400, 'imported people can’t sign in until given a password');
  const e = await many(`SELECT TIME_FORMAT(start_time, '%H:%i') AS s, TIME_FORMAT(end_time, '%H:%i') AS e, note FROM time_entries e JOIN users u ON u.id = e.user_id WHERE u.name = 'Casey Diaz' AND e.source = 'import' AND e.entry_date = '2026-11-16'`);
  assert.deepEqual(e.map(x => [x.s, x.e]), [['09:00', '10:30'], ['09:00', '10:30']]);
  assert.equal((await one(`SELECT note FROM time_entries WHERE note LIKE 'Kickoff%'`)).note, 'Kickoff call, with "quotes"');
  // the same file again adds nothing
  const again = ok(await admin.req('POST', '/import/paymo/csv', { filename: 'paymo-time.csv', text: CSV }), 201);
  assert.equal(again.entries.new, 0); assert.equal(again.entries.already, 4);
  // remapping the description column changes the preview but doesn't make old rows look new
  const remap = ok(await admin.req('PATCH', `/import/runs/${again.id}`, { columns: { ...again.csv.columns, note: -1 } }));
  assert.equal(remap.csv.columns.note, -1);
  assert.equal(remap.entries.new, 0);
  assert.equal(remap.entries.already, 4);
});
