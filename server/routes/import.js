// Admin-only Paymo import: fetch (API key) or upload (CSV), preview, adjust, import.
// The API key is used for the fetch only and never stored.
import crypto from 'node:crypto';
import { Router } from 'express';
import { one, many, query, tx } from '../db.js';
import { h, bad, notFound, conflict, uuidParam, str, isUUID } from '../http.js';
import { requireAdmin } from '../auth.js';
import { getSettings } from '../domain.js';
import { isISODate, addDays } from '../../public/js/shared/time.js';
import { fetchPaymo } from '../import/paymo.js';
import { parseCSV } from '../import/csv.js';
import { normalizeRun, buildPlan, previewOf, commitPlan, splitRanges } from '../import/importer.js';

const r = Router();
r.use('/import', requireAdmin);
// One web import holds the whole batch in the live server's memory (5 years for 30 people, about
// 137,000 entries, peaked near 1 GB). Bigger batches go in smaller date ranges or through the
// command-line import, which runs in its own process and has no limit.
const WEB_MAX_ENTRIES = 50000;
const num = n => n.toLocaleString('en-US');
const tooBig = (n, advice) => bad(`That’s ${num(n)} time entries. The web import takes up to ${num(WEB_MAX_ENTRIES)} at a time, so the live server stays responsive. ${advice} Or use the command-line import (npm run import:paymo), which has no limit.`);
const db = { query, one, many };
const RUN_COLS = 'id, source, status, label, options, raw, summary, created_at, imported_at';
// The copy of Paymo's data is kept as text (a large CSV outgrows MySQL's JSON limits); parse it on the way out.
const parseRun = run => { if (run && typeof run.raw === 'string') run.raw = JSON.parse(run.raw || '{}'); return run; };
async function createRun(source, label, raw, userId) {
  const run = { id: crypto.randomUUID(), source, status: 'preview', label, options: {}, raw, summary: null, created_at: new Date(), imported_at: null };
  await query('INSERT INTO import_runs (id, source, label, raw, created_by) VALUES ($1, $2, $3, $4, $5)', [run.id, source, label, JSON.stringify(raw), userId]);
  return run;
}

async function preview(run) {
  const settings = await getSettings();
  const data = normalizeRun(run, settings);
  const plan = await buildPlan(db, data, run.options);
  return previewOf(plan, run);
}
async function loadRun(id) {
  const run = parseRun(await one(`SELECT ${RUN_COLS} FROM import_runs WHERE id = $1`, [uuidParam(id)]));
  if (!run) throw notFound('That import doesn’t exist.');
  return run;
}

r.get('/import/runs', h(async (_req, res) => {
  res.json(await many(`SELECT ir.id, ir.source, ir.status, ir.label, ir.summary, ir.created_at, ir.imported_at, u.name AS created_by_name
                         FROM import_runs ir JOIN users u ON u.id = ir.created_by ORDER BY ir.created_at DESC LIMIT 30`));
}));

r.post('/import/paymo/fetch', h(async (req, res) => {
  const { apiKey, from, to } = req.body;
  if (!isISODate(from) || !isISODate(to) || to < from) throw bad('Choose the dates to bring over.');
  if (from < addDays(to, -366 * 3)) throw bad('Bring over three years at most in one go.');
  const raw = await fetchPaymo({ apiKey: String(apiKey || '').trim(), from, to });
  if ((raw.entries || []).length > WEB_MAX_ENTRIES) {
    // Say exactly where to split, from the dates of what came back.
    const parts = splitRanges(raw.entries.map(e => e.date || String(e.start_time || '').slice(0, 10)), from, to, WEB_MAX_ENTRIES);
    throw tooBig(raw.entries.length, `Bring it over in ${parts.length} parts: ${parts.map(([a, b]) => `${a} to ${b}`).join(', then ')}.`);
  }
  const run = await createRun('paymo-api', `Paymo ${raw.account ? `(${raw.account}) ` : ''}${from} to ${to}`, raw, req.user.id);
  res.status(201).json(await preview(run));
}));

r.post('/import/paymo/csv', h(async (req, res) => {
  const text = String(req.body.text || '');
  if (!text.trim()) throw bad('Choose a CSV file, or paste its text.');
  const rows = parseCSV(text);
  if (rows.length < 2) throw bad('The file needs a header row and at least one entry.');
  if (rows.length - 1 > WEB_MAX_ENTRIES) throw tooBig(rows.length - 1, `Export shorter date ranges from Paymo, up to ${num(WEB_MAX_ENTRIES)} rows a file.`);
  const name = str(req.body.filename, { label: 'File name', max: 200 }) || 'pasted text';
  const run = await createRun('paymo-csv', `CSV: ${name}`, { rows }, req.user.id);
  res.status(201).json(await preview(run));
}));

r.get('/import/runs/:id', h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status !== 'preview') return res.json({ id: run.id, source: run.source, status: run.status, label: run.label, summary: run.summary, imported_at: run.imported_at });
  res.json(await preview(run));
}));

/** Change choices in the preview: people, service lines, CSV columns, status for history. */
function readOptions(b, prev) {
  const o = { ...prev };
  if (b.entryStatus !== undefined) { if (!['approved', 'draft'].includes(b.entryStatus)) throw bad('Imported time is either approved or not submitted.'); o.entryStatus = b.entryStatus; }
  if (b.extraOpenMinutes !== undefined) { const v = Math.round(+b.extraOpenMinutes); if (!(v >= 0 && v <= 100 * 60)) throw bad('Extra hours must be between 0 and 100.'); o.extraOpenMinutes = v; }
  if (b.defaultServiceLineId !== undefined) { if (b.defaultServiceLineId && !isUUID(b.defaultServiceLineId)) throw bad('Invalid service line.'); o.defaultServiceLineId = b.defaultServiceLineId || null; }
  if (b.dateFormat !== undefined) { if (!['mdy', 'dmy'].includes(b.dateFormat)) throw bad('Unknown date format.'); o.dateFormat = b.dateFormat; }
  for (const k of ['userMap', 'serviceLineMap']) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'object' || Array.isArray(b[k])) throw bad(`Invalid ${k}.`);
    const m = { ...(o[k] || {}) };
    for (const [key, v] of Object.entries(b[k])) {
      if (v === null || v === '') delete m[key];
      else if (k === 'userMap' && !['create', 'skip'].includes(v) && !isUUID(v)) throw bad('Choose create, skip, or a person.');
      else if (k === 'serviceLineMap' && !isUUID(v)) throw bad('Choose a service line.');
      else m[key] = v;
    }
    o[k] = m;
  }
  if (b.columns !== undefined) {
    if (typeof b.columns !== 'object') throw bad('Invalid columns.');
    o.columns = Object.fromEntries(Object.entries(b.columns).map(([k, v]) => [k, Number.isInteger(v) ? v : -1]));
  }
  return o;
}
r.patch('/import/runs/:id', h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status !== 'preview') throw conflict('This import is finished; start a new one.');
  run.options = readOptions(req.body, run.options);
  await query('UPDATE import_runs SET options = $1 WHERE id = $2', [JSON.stringify(run.options), run.id]);
  res.json(await preview(run));
}));

r.post('/import/runs/:id/commit', h(async (req, res) => {
  const id = uuidParam(req.params.id);
  const summary = await tx(async c => {
    const run = parseRun(await c.one(`SELECT ${RUN_COLS} FROM import_runs WHERE id = $1 FOR UPDATE`, [id]));
    if (!run) throw notFound('That import doesn’t exist.');
    if (run.status !== 'preview') throw conflict('This import already ran.');
    const settings = await getSettings(c);
    const plan = await buildPlan(c, normalizeRun(run, settings), run.options);
    if (!plan.newEntries.length && ![...plan.tasks.values()].some(t => t.action === 'create')) throw bad('Nothing new to import.');
    const sum = await commitPlan(c, plan, req.user, run.id, settings.today);
    // Keep the counts; drop the copy of Paymo's data now that it's in the app.
    await c.query(`UPDATE import_runs SET status = 'imported', summary = $1, imported_at = UTC_TIMESTAMP(6), raw = '{}' WHERE id = $2`, [JSON.stringify(sum), run.id]);
    return sum;
  });
  res.json(summary);
}));

r.post('/import/runs/:id/discard', h(async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status !== 'preview') throw conflict('Only an unfinished import can be discarded.');
  await query(`UPDATE import_runs SET status = 'discarded', raw = '{}' WHERE id = $1`, [run.id]);
  res.json({ ok: true });
}));

export default r;
