// Browser walk-through of the first milestone with demo users, using Playwright and Chromium.
// It wipes and seeds VERIFY_DATABASE_URL (default: the fctime_test database), starts the app on a free port,
// and drives the real UI. Screenshots go to ./verify-output/.
//   npm run verify:ui
// Needs Playwright: `npm i -D playwright && npx playwright install chromium` if it isn't installed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = process.env.VERIFY_DATABASE_URL || 'postgres://fctime:fctime@localhost:5432/fctime_test';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const { ROOT } = await import('../server/env.js');
const { migrate } = await import('../server/migrate.js');
const { seedDemo } = await import('../server/seed.js');
const { createApp } = await import('../server/app.js');
const { query, closePool } = await import('../server/db.js');

const PW = 'fifthcolor-demo';
const OUT = path.join(ROOT, 'verify-output');
fs.mkdirSync(OUT, { recursive: true });
await migrate({ reset: true, log: () => {} });
const ids = await seedDemo({ password: PW, log: () => {} });
const server = createApp().listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;
const results = [];
const step = (name, detail = '') => { results.push({ name, detail }); console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${email}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(`${email}: ${m.text()}`); });
  await page.goto(BASE + '/');
  await page.fill('#f-email', email);
  await page.fill('#f-password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.fc-shell');
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
const toastText = async page => (await page.waitForSelector('.fc-toast')).innerText();
async function closeToast(page) { const x = await page.$('.fc-toast__x'); if (x) await x.click(); }

try {
  /* 1. Admin creates a task */
  const morgan = await signIn('morgan@fifthcolor.example');
  await morgan.goto(`${BASE}/#/project/${ids.P['nw-ret']}`);
  await morgan.click('button[data-action="task-new"]');
  await morgan.fill('#f-ttitle', 'Holiday window posters');
  await morgan.selectOption('#f-tassignee', ids.U.casey);
  await morgan.selectOption('#f-tsvc', ids.S.creative);
  await morgan.fill('#f-tbudget', '3');
  await morgan.fill('#f-tdue', ids.today);
  await shot(morgan, '01-admin-new-task');
  await morgan.click('form[data-form="task"] button[type=submit]');
  await morgan.waitForSelector('.trow:has-text("Holiday window posters")');
  const { rows: [task] } = await query(`SELECT id, budget_minutes FROM tasks WHERE title = 'Holiday window posters'`);
  step('Admin created a task on Northwind Coffee, Retainer', `budget stored as ${task.budget_minutes} minutes, assigned to Casey`);

  /* 2. Team member starts a timer from Home, refreshes, stops from the sidebar */
  const casey = await signIn('casey@fifthcolor.example');
  await casey.hover(`.trow[data-task="${task.id}"]`); // quick actions show on hover, as in the wireframe
  await casey.click(`.trow[data-task="${task.id}"] button[data-action="timer-go"]`);
  await casey.waitForSelector('.timer-card .big-timer');
  step('Started the timer from the task row on Home');
  await query(`UPDATE timers SET started_at = now() - interval '52 minutes' WHERE task_id = $1`, [task.id]); // let it "run" for 52 minutes
  await casey.reload();
  await casey.waitForSelector('.timer-card .big-timer');
  const shown = await casey.innerText('.timer-card .big-timer');
  if (!/^0:5[23]:/.test(shown)) throw new Error(`timer did not restore after refresh, showed ${shown}`);
  await shot(casey, '02-timer-restored-after-refresh');
  step('Refreshed the page; the timer was restored from the server', `showing ${shown}`);
  await casey.click('.nav-timer__stop');
  const stopMsg = await toastText(casey);
  const { rows: [te] } = await query(`SELECT id, minutes, start_time, end_time, status FROM time_entries WHERE task_id = $1 AND source = 'timer'`, [task.id]);
  if (te.minutes !== 52) throw new Error(`expected 52 minutes, got ${te.minutes}`);
  step('Stopped it from the sidebar', `${stopMsg.split('\n')[0]}; one draft entry, ${te.minutes} min, ${te.start_time.slice(0, 5)}–${te.end_time.slice(0, 5)}`);
  await closeToast(casey);

  /* 3. Manual entry by dragging on the calendar, overlapping the timer entry */
  await casey.goto(`${BASE}/#/time`);
  const col = casey.locator(`.cal-body[data-cal-date="${ids.today}"]`);
  await col.scrollIntoViewIfNeeded();
  const box = await col.boundingBox();
  // Start in the empty half hour above the timer entry and drag down across it, so the new range overlaps it.
  const timerStart = (+te.start_time.slice(0, 2)) * 60 + (+te.start_time.slice(3, 5));
  const from = Math.max(7 * 60, Math.min(18 * 60, Math.floor(timerStart / 15) * 15 - 30)), to = from + 60;
  const yFor = m => box.y + ((m - 7 * 60) / 60) * 52;
  await casey.mouse.move(box.x + box.width / 2, yFor(from) + 2);
  await casey.mouse.down();
  await casey.mouse.move(box.x + box.width / 2, yFor(from + 30), { steps: 8 });
  await casey.mouse.move(box.x + box.width / 2, yFor(to) + 2, { steps: 8 });
  await casey.mouse.up();
  await casey.waitForSelector('#f-etask');
  const s = await casey.inputValue('#f-estart'), e = await casey.inputValue('#f-eend');
  await shot(casey, '03-drag-opens-form');
  step('Dragged on the calendar; the form opened with the range filled in', `${s} – ${e}`);
  await casey.selectOption('#f-etask', task.id);
  await casey.fill('#f-enote', 'Poster layouts');
  await casey.click('form[data-form="entry"] button[type=submit]');
  const ov = await toastText(casey);
  const expectOverlap = from < timerStart + te.minutes && timerStart < to;
  if (expectOverlap && !/overlaps/i.test(ov)) throw new Error('expected an overlap warning, got: ' + ov);
  step(expectOverlap ? 'Saved it; the overlap warning showed and the entry was kept' : 'Saved it (timer ran outside calendar hours, so no overlap to show)', ov.split('\n')[0]);
  await closeToast(casey);
  // and one entered as a total
  await casey.click('button[data-action="entry-new"]');
  await casey.click('button[data-action="seg-emode"][data-v="total"]');
  await casey.selectOption('#f-etask', task.id);
  await casey.fill('#f-edur', '0:30');
  await casey.fill('#f-enote', 'Print specs');
  await casey.click('form[data-form="entry"] button[type=submit]');
  await toastText(casey); await closeToast(casey);
  step('Added 0:30 as a total duration');
  await shot(casey, '04-week-calendar');

  /* 4. Submit, return, correct, resubmit, approve twice */
  await casey.click('button[data-action="submit-week"]');
  step('Submitted the week', (await toastText(casey)).split('\n')[0]);
  await closeToast(casey);

  const alex = await signIn('alex@fifthcolor.example');
  await alex.goto(`${BASE}/#/time/approvals`);
  const card = alex.locator('.appr', { hasText: 'Casey Diaz' }).filter({ hasText: 'Step 1 of 2' }).filter({ hasText: 'Holiday window posters' });
  await card.locator('button[data-action="reject-time"]').click();
  await alex.fill('#f-rreason', 'Please split the poster layouts from the print specs note.');
  await shot(alex, '05-send-back');
  await alex.click('form[data-form="reject"] button[type=submit]');
  await toastText(alex); await closeToast(alex);
  step('Account owner (Alex) sent it back with a reason');

  await casey.reload();
  await casey.waitForSelector('.fc-alert--danger');
  await casey.click('button[data-action="seg-tsview"][data-v="list"]');
  await shot(casey, '06-sent-back-on-timesheet');
  const editBtn = casey.locator('.entry', { hasText: 'Print specs' }).locator('button[data-action="entry-edit"]');
  await editBtn.click();
  if (!(await casey.$('#f-edur'))) throw new Error('editing a total-time entry should open in Total time mode');
  await casey.fill('#f-enote', 'Print specs for the window posters');
  await casey.click('form[data-form="entry"] button[type=submit]');
  await toastText(casey); await closeToast(casey);
  await casey.click('button[data-action="submit-week"]');
  await toastText(casey); await closeToast(casey);
  const { rows: [fixed] } = await query(`SELECT start_time, minutes FROM time_entries WHERE note = 'Print specs for the window posters'`);
  if (fixed.start_time !== null || fixed.minutes !== 30) throw new Error('the corrected entry changed format: ' + JSON.stringify(fixed));
  step('Team member corrected the entry (it stayed a 0:30 total) and resubmitted');

  await alex.reload();
  await alex.locator('.appr', { hasText: 'Casey Diaz' }).filter({ hasText: 'Step 1 of 2' }).filter({ hasText: 'Holiday window posters' }).locator('button[data-action="approve-time"]').click();
  step('Step 1: account owner approved', (await toastText(alex)).split('\n').join(' '));

  const jamie = await signIn('jamie@fifthcolor.example');
  await jamie.goto(`${BASE}/#/time/approvals`);
  const dcard = jamie.locator('.appr', { hasText: 'Casey Diaz' }).filter({ hasText: 'Step 2 of 2' }).filter({ hasText: 'Holiday window posters' });
  await shot(jamie, '07-manager-approval');
  await dcard.locator('button[data-action="approve-time"]').click();
  step('Step 2: Creative department manager (Jamie) approved', (await toastText(jamie)).split('\n').join(' '));
  const { rows: st } = await query(`SELECT e.status, a.name AS ae, d.name AS dept FROM time_entries e LEFT JOIN users a ON a.id = e.ae_by LEFT JOIN users d ON d.id = e.dept_by WHERE e.task_id = $1`, [task.id]);
  if (!st.every(r => r.status === 'approved' && r.ae === 'Alex Rivera' && r.dept === 'Jamie Chen')) throw new Error('entries not fully approved: ' + JSON.stringify(st));
  step('All three entries are approved with both approvers recorded', st.map(r => `${r.status} (${r.ae}, ${r.dept})`).join('; '));

  /* 5. Report and CSV reconcile */
  await morgan.goto(`${BASE}/#/reports`);
  await morgan.click('button[data-action="seg-rbp"][data-v="this-week"]');
  await morgan.waitForTimeout(400);
  await morgan.click('button[data-action="msel-toggle"][data-k="users"]');
  await morgan.check(`input[data-msel="users"][value="${ids.U.casey}"]`);
  await morgan.waitForTimeout(400);
  await morgan.click('h1');
  await morgan.waitForTimeout(300);
  const total = await morgan.innerText('[data-test="total"]'), bill = await morgan.innerText('[data-test="billable"]'), non = await morgan.innerText('[data-test="nonbillable"]');
  await shot(morgan, '08-report');
  const [dl] = await Promise.all([morgan.waitForEvent('download'), morgan.click('a[data-test="csv"]')]);
  const csvPath = path.join(OUT, 'report.csv'); await dl.saveAs(csvPath);
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r\n/); const head = lines.shift().split(',');
  const mi = head.indexOf('minutes'), bi = head.indexOf('billable');
  const rows = lines.map(l => l.split(','));
  const csvMin = rows.reduce((a, r) => a + +r[mi], 0), csvBill = rows.filter(r => r[bi] === 'yes').reduce((a, r) => a + +r[mi], 0);
  const h = m => String(Math.round((m / 60) * 100) / 100);
  if (h(csvMin) !== total || h(csvBill) !== bill) throw new Error(`report ${total}/${bill} vs CSV ${h(csvMin)}/${h(csvBill)}`);
  step('Report and CSV reconcile for Casey this week', `report ${total} h total, ${bill} h billable, ${non} h non-billable; CSV ${rows.length} rows, ${csvMin} min = ${h(csvMin)} h, billable ${csvBill} min`);

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  step('No browser errors');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), today: ids.today, steps: results }, null, 2));
  console.log(`\nAll ${results.length} checks passed. Screenshots in ${OUT}`);
} catch (err) {
  console.error('\n✘ ' + err.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  await closePool();
}
