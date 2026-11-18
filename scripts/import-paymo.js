// Import from Paymo on the command line: the same importer as Settings → Import from Paymo.
// Previews by default; writes only with --commit. The API key comes from PAYMO_API_KEY.
//
//   PAYMO_API_KEY=... npm run import:paymo -- --from 2026-01-01 --to 2026-11-30 --as morgan@fifthcolor.example
//   PAYMO_API_KEY=... npm run import:paymo -- --from 2026-01-01 --to 2026-11-30 --as morgan@fifthcolor.example --commit
//   npm run import:paymo -- --csv ./paymo-time.csv --as morgan@fifthcolor.example [--date-format dmy] [--commit]
//
// Options: --status approved|draft (default approved), --extra-hours N (open tasks without a Paymo budget),
//          --default-service "Creative" (service line for task lists that match no keywords).
import fs from 'node:fs';
import '../server/env.js';
import { one, tx, closePool, query, many } from '../server/db.js';
import { migrate } from '../server/migrate.js';
import { getSettings } from '../server/domain.js';
import { fetchPaymo } from '../server/import/paymo.js';
import { parseCSV } from '../server/import/csv.js';
import { normalizeRun, buildPlan, previewOf, commitPlan } from '../server/import/importer.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const die = msg => { console.error(msg); process.exit(1); };
const h = m => (m / 60).toFixed(2);

try {
  await migrate({ log: () => {} });
  const actor = await one(`SELECT id, name, role FROM users WHERE lower(email) = lower($1) AND archived_at IS NULL`, [String(args.as || '')]);
  if (!actor || actor.role !== 'admin') die('Give an active admin with --as you@fifthcolor.com (imports are recorded against them).');
  const options = { entryStatus: args.status === 'draft' ? 'draft' : 'approved', extraOpenMinutes: Math.round((+args['extra-hours'] || 0) * 60), dateFormat: args['date-format'] === 'dmy' ? 'dmy' : 'mdy' };
  if (args['default-service']) {
    const s = await one('SELECT id FROM service_lines WHERE lower(name) = lower($1) AND archived_at IS NULL', [args['default-service']]);
    if (!s) die(`No active service line named “${args['default-service']}”.`);
    options.defaultServiceLineId = s.id;
  }
  let run;
  if (args.csv) {
    const rows = parseCSV(fs.readFileSync(args.csv, 'utf8'));
    if (rows.length < 2) die('The CSV needs a header row and at least one entry.');
    run = { source: 'paymo-csv', raw: { rows }, options, label: `CSV: ${args.csv}` };
  } else {
    if (!process.env.PAYMO_API_KEY) die('Set PAYMO_API_KEY (from My Account in Paymo), or use --csv file.csv.');
    if (!args.from || !args.to) die('Give --from and --to dates (YYYY-MM-DD).');
    console.log(`Fetching Paymo time from ${args.from} to ${args.to}…`);
    const raw = await fetchPaymo({ apiKey: process.env.PAYMO_API_KEY, from: args.from, to: args.to, log: m => console.log(`  ${m}`) });
    run = { source: 'paymo-api', raw, options, label: `Paymo ${args.from} to ${args.to}` };
  }
  const settings = await getSettings();
  const db = { query, one, many };
  const p = previewOf(await buildPlan(db, normalizeRun(run, settings), options), { ...run, id: null, status: 'preview' });
  const e = p.entries;
  console.log(`\n${run.label}`);
  console.log(`Time entries: ${e.new} to add (${h(e.minutes)} h${e.from ? `, ${e.from} to ${e.to}` : ''}), ${e.already} already here.`);
  const skipped = [[e.skippedPerson, 'skipped people'], [e.unknownTask, 'tasks missing from Paymo’s data'], [e.zero, 'no duration'], [e.running, 'still running in Paymo'], [e.capped, 'over 24 h, cut to 24:00']].filter(x => x[0]);
  if (skipped.length) console.log(`Not coming over: ${skipped.map(([n, t]) => `${n} (${t})`).join(', ')}.`);
  console.log(`\nPeople:`);
  for (const x of p.people) console.log(`  ${x.action === 'match' ? 'match ' : x.action === 'create' ? 'add   ' : 'skip  '} ${x.name}${x.email ? ` <${x.email}>` : ''}${x.matchedBy ? ` (by ${x.matchedBy})` : ''}: ${x.entries} entries, ${h(x.minutes)} h`);
  console.log(`\nTask lists → service lines:`);
  const svcName = id => (p.services.find(s => s.id === id) || {}).name || '(none)';
  for (const x of p.serviceLines) console.log(`  ${x.name} → ${svcName(x.serviceLineId)} (${x.how}; ${x.tasks} tasks, ${x.entries} entries)`);
  console.log(`\nClients: ${p.clients.create.length} new${p.clients.create.length ? ` (${p.clients.create.join(', ')})` : ''}, ${p.clients.match} matched.`);
  console.log(`Projects: ${p.projects.create.length} new, ${p.projects.match} matched. Tasks: ${p.tasks.create} new, ${p.tasks.match} matched; ${p.tasks.noBudget} new without a Paymo budget.`);
  if (p.problemCount) console.log(`\n${p.problemCount} rows can’t be read, for example:\n${p.problems.slice(0, 8).map(x => `  ${x.line}: ${x.why}`).join('\n')}`);
  if (!args.commit) { console.log('\nPreview only. Add --commit to import.'); }
  else {
    const sum = await tx(async c => commitPlan(c, await buildPlan(c, normalizeRun(run, settings), options), actor, null, settings.today));
    await query(`INSERT INTO import_runs (source, status, label, options, raw, summary, created_by, imported_at) VALUES ($1, 'imported', $2, $3, '{}'::jsonb, $4, $5, now())`,
      [run.source, `${run.label} (command line)`, JSON.stringify(options), JSON.stringify(sum), actor.id]);
    console.log(`\nImported ${sum.entriesImported} entries (${h(sum.minutes)} h). Added ${sum.peopleCreated} people, ${sum.clientsCreated} clients, ${sum.projectsCreated} projects, ${sum.tasksCreated} tasks.`);
  }
} catch (e) {
  console.error(e.status ? e.message : e);
  process.exitCode = 1;
} finally {
  await closePool();
}
