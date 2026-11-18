// Demo data adapted from the wireframe's sample records (seed(), seedWork(), seedV6()).
// Dates are placed relative to "today" in the workspace time zone so the demo always looks current.
import { tx } from './db.js';
import { hashPassword } from './auth.js';
import { addDays, weekStart } from '../public/js/shared/time.js';

export const DEMO_USERS = [
  { key: 'morgan', name: 'Morgan Hale', email: 'morgan@fifthcolor.example', role: 'admin', dept: 'strategy' },
  { key: 'alex', name: 'Alex Rivera', email: 'alex@fifthcolor.example', role: 'ae', dept: null },
  { key: 'sam', name: 'Sam Patel', email: 'sam@fifthcolor.example', role: 'ae', dept: null },
  { key: 'jamie', name: 'Jamie Chen', email: 'jamie@fifthcolor.example', role: 'member', dept: 'creative' },
  { key: 'casey', name: 'Casey Diaz', email: 'casey@fifthcolor.example', role: 'member', dept: 'creative', capacity: [360, 360, 360, 360, 0, 0, 0] },
  { key: 'riley', name: 'Riley Brooks', email: 'riley@fifthcolor.example', role: 'member', dept: 'development' },
  { key: 'taylor', name: 'Taylor Kim', email: 'taylor@fifthcolor.example', role: 'member', dept: 'strategy' },
  { key: 'chris', name: 'Chris Ortega', email: 'chris@fifthcolor.example', role: 'member', dept: 'media' },
];

const SERVICES = [
  // keywords match Paymo task lists on import (wireframe settings.paymo.keywords)
  { key: 'creative', name: 'Creative', rate: 143, color: '#E8590C', manager: 'jamie', kw: 'Creative, Design, Copy' },
  { key: 'strategy', name: 'Strategy', rate: 187, color: '#7048E8', manager: 'morgan', kw: 'Strategy, Planning' },
  { key: 'development', name: 'Development', rate: 187, color: '#1C7ED6', manager: 'riley', kw: 'Development, Dev, Web' },
  { key: 'video', name: 'Video production', rate: 165, color: '#C2255C', manager: 'jamie', kw: 'Video, Motion, Edit' },
  { key: 'media', name: 'Media', rate: 187, color: '#2F9E44', manager: 'chris', kw: 'Media, Paid social, Ads' },
  { key: 'ux', name: 'UX/UI', rate: 187, color: '#0C8599', manager: null, kw: 'UX, UI, Wireframes' },
];

const CLIENTS = [
  { key: 'northwind', name: 'Northwind Coffee', owner: 'alex', color: '#E8590C', projects: [
    { key: 'nw-ret', name: 'Retainer', kind: 'retainer' }, { key: 'nw-video', name: 'Brand video', kind: 'project' }] },
  { key: 'harbor', name: 'Harbor Health', owner: 'sam', color: '#1971C2', projects: [
    { key: 'hh-ret', name: 'Retainer', kind: 'retainer' }, { key: 'hh-portal', name: 'Patient portal phase 2', kind: 'project' }] },
  { key: 'pine', name: 'Pine & Co.', owner: 'alex', color: '#2B8A3E', projects: [{ key: 'pine-dev', name: 'Development retainer', kind: 'retainer' }] },
  { key: 'internal', name: 'FifthColor (internal)', owner: null, color: '#495057', projects: [{ key: 'int-ops', name: 'Studio operations', kind: 'project' }] },
  { key: 'bluff', name: 'Bluff Outfitters', owner: 'sam', color: '#868E96', archived: true, projects: [{ key: 'bluff-ret', name: 'Retainer 2025', kind: 'retainer', status: 'done' }] },
];

// [project, title, service, assignee, status, budget hours, start offset, due offset (days from this Monday), billable]
const TASKS = [
  ['nw-ret', 'Social posts, November', 'creative', 'casey', 'doing', 8, -14, 4],
  ['nw-ret', 'Menu board refresh', 'creative', 'jamie', 'review', 6, -21, -2],
  ['nw-ret', 'Monthly strategy check-in', 'strategy', 'taylor', 'todo', 2, 0, 2],
  ['nw-ret', 'Holiday campaign concepts', 'creative', 'jamie', 'todo', 10, 0, 11],
  ['nw-ret', 'October social posts', 'creative', 'casey', 'done', 8, -42, -24],
  ['nw-video', 'Script and storyboard', 'strategy', 'taylor', 'done', 4, -42, -31],
  ['nw-video', 'Edit 30-second cut', 'video', 'jamie', 'doing', 20, -21, 4],
  ['nw-video', 'Color and sound mix', 'video', 'jamie', 'todo', 8, 7, 18],
  ['nw-video', 'Cutdowns for social', 'video', 'casey', 'todo', 8, 14, 25],
  ['hh-ret', 'Portal bug fixes', 'development', 'riley', 'doing', 20, -14, 11],
  ['hh-ret', 'Appointment reminder emails', 'creative', 'casey', 'review', 10, -21, 1],
  ['hh-ret', 'Quarterly analytics review', 'strategy', 'taylor', 'todo', 6, 0, 9],
  ['hh-ret', 'Brand refresh for flu season', 'creative', 'jamie', 'todo', 12, -7, 9],
  ['hh-ret', 'Paid social plan', 'media', 'chris', 'doing', 6, -7, 4],
  ['hh-portal', 'Scheduling API', 'development', 'riley', 'doing', 40, -35, 9],
  ['hh-portal', 'UI polish', 'ux', 'jamie', 'todo', 8, 0, 18],
  ['hh-portal', 'Payments integration', 'development', 'riley', 'todo', 24, 14, 32],
  ['pine-dev', 'Product filter rebuild', 'development', 'riley', 'doing', 12, -14, 2],
  ['pine-dev', 'Checkout speed fixes', 'development', 'riley', 'todo', 8, 7, 18],
  ['int-ops', 'Team meetings', 'strategy', 'morgan', 'doing', 40, -60, 45, false],
  ['int-ops', 'Portfolio site updates', 'creative', 'casey', 'todo', 6, 0, 25, false],
];

/** Insert demo data. Expects an empty, migrated database. Returns lookup maps for tests. */
export async function seedDemo({ password, log = console.log } = {}) {
  const pwHash = await hashPassword(password);
  return tx(async c => {
    if (await c.one('SELECT 1 FROM users LIMIT 1')) throw new Error('The database already has users. Run `npm run db:reset` to start over.');
    const { today, time_zone: tz } = await c.one(`SELECT (now() AT TIME ZONE time_zone)::date::text AS today, time_zone FROM settings WHERE id = 1`);
    const ws = weekStart(today);
    const S = {}, U = {}, C = {}, P = {}, T = {};
    let sort = 0;
    for (const s of SERVICES) S[s.key] = (await c.one('INSERT INTO service_lines (name, rate, color, sort, match_keywords) VALUES ($1, $2, $3, $4, $5) RETURNING id', [s.name, s.rate, s.color, ++sort, s.kw])).id;
    for (const u of DEMO_USERS) {
      U[u.key] = (await c.one('INSERT INTO users (name, email, role, dept_id, password_hash, capacity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [u.name, u.email, u.role, u.dept ? S[u.dept] : null, pwHash, u.capacity || [480, 480, 480, 480, 480, 0, 0]])).id;
    }
    for (const s of SERVICES) if (s.manager) await c.query('UPDATE service_lines SET manager_id = $1 WHERE id = $2', [U[s.manager], S[s.key]]);
    for (const cl of CLIENTS) {
      C[cl.key] = (await c.one('INSERT INTO clients (name, owner_id, color, archived_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [cl.name, cl.owner ? U[cl.owner] : null, cl.color, cl.archived ? addDays(today, -120) : null])).id;
      for (const p of cl.projects) {
        P[p.key] = (await c.one('INSERT INTO projects (client_id, name, kind, status) VALUES ($1, $2, $3, $4) RETURNING id', [C[cl.key], p.name, p.kind, p.status || 'active'])).id;
      }
    }
    for (const [pk, title, sk, uk, status, hours, so, dueo, billable = true] of TASKS) {
      T[title] = (await c.one(`INSERT INTO tasks (project_id, service_line_id, title, assignee_id, status, budget_minutes, start_date, due_date, billable, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [P[pk], S[sk], title, U[uk], status, hours * 60, addDays(ws, so), addDays(ws, dueo), billable, U.morgan])).id;
    }
    // Earlier weeks of time: approved two weeks back, partly through approval last week.
    const E = [
      // [weeks back, weekday, user, task, minutes, note]
      [2, 0, 'casey', 'October social posts', 180, 'Final round of edits'],
      [2, 1, 'jamie', 'Menu board refresh', 150, 'Layout options'],
      [2, 1, 'riley', 'Scheduling API', 300, 'Availability endpoint'],
      [2, 2, 'riley', 'Product filter rebuild', 240, ''],
      [2, 2, 'taylor', 'Script and storyboard', 120, ''],
      [2, 3, 'jamie', 'Edit 30-second cut', 240, 'Assembly edit'],
      [2, 3, 'morgan', 'Team meetings', 60, 'Studio weekly'],
      [2, 4, 'casey', 'Appointment reminder emails', 120, 'First drafts'],
      [1, 0, 'riley', 'Portal bug fixes', 210, 'Login timeout fix'],
      [1, 0, 'casey', 'Social posts, November', 150, 'Week one posts'],
      [1, 1, 'jamie', 'Edit 30-second cut', 270, 'Rough cut'],
      [1, 1, 'riley', 'Scheduling API', 330, 'Booking flow'],
      [1, 2, 'chris', 'Paid social plan', 120, 'Audience sizing'],
      [1, 2, 'taylor', 'Monthly strategy check-in', 45, 'Prep'],
      [1, 3, 'jamie', 'Brand refresh for flu season', 120, 'Moodboards'],
      [1, 3, 'morgan', 'Team meetings', 60, 'Studio weekly'],
      [1, 4, 'casey', 'Portfolio site updates', 90, 'Case study images'],
    ];
    const ownerOf = { 'nw-ret': 'alex', 'nw-video': 'alex', 'hh-ret': 'sam', 'hh-portal': 'sam', 'pine-dev': 'alex', 'int-ops': null };
    const taskMeta = Object.fromEntries(TASKS.map(t => [t[1], { pk: t[0], sk: t[2] }]));
    let i = 0;
    for (const [wb, d, uk, title, minutes, note] of E) {
      const date = addDays(ws, -7 * wb + d), m = taskMeta[title];
      const owner = ownerOf[m.pk] ? U[ownerOf[m.pk]] : U.morgan;
      const mgrKey = SERVICES.find(s => s.key === m.sk).manager, mgr = mgrKey ? U[mgrKey] : U.morgan;
      // two weeks back: approved; last week: alternate between waiting on the owner and on the manager
      const status = wb === 2 ? 'approved' : (i++ % 2 ? 'ae-approved' : 'submitted');
      const start = `${String(9 + (d % 3)).padStart(2, '0')}:00`;
      const endMin = (9 + (d % 3)) * 60 + minutes, end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      const row = await c.one(`INSERT INTO time_entries (user_id, task_id, entry_date, start_time, end_time, minutes, note, status, source, submitted_at, ae_by, ae_at, dept_by, dept_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9::date + time '17:00', $10, $11::timestamptz, $12, $13::timestamptz) RETURNING id`,
      [U[uk], T[title], date, start, end, minutes, note, status, addDays(ws, -7 * wb + 4),
        status === 'submitted' ? null : owner, status === 'submitted' ? null : addDays(ws, -7 * wb + 7),
        status === 'approved' ? mgr : null, status === 'approved' ? addDays(ws, -7 * wb + 8) : null]);
      await c.query(`INSERT INTO time_entry_events (entry_id, action, actor_id, detail) VALUES ($1, 'created', $2, '{"source":"seed"}')`, [row.id, U[uk]]);
    }
    log(`Seeded ${DEMO_USERS.length} people, ${SERVICES.length} service lines, ${CLIENTS.length} clients, ${TASKS.length} tasks, ${E.length} time entries. Workspace time zone ${tz}, today ${today}.`);
    return { S, U, C, P, T, today, weekStart: ws };
  });
}
