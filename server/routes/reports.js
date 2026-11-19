// Time reports. The JSON report and the CSV export share one query, so totals always match
// and both follow the same visibility rules.
import { Router } from 'express';
import { many } from '../db.js';
import { h, bad, isUUID } from '../http.js';
import { requireUser } from '../auth.js';
import { ENTRY_COLUMNS, ENTRY_JOINS, visibleEntrySql, ENTRY_STATUSES, isAdmin, isMgr } from '../domain.js';
import { isISODate } from '../../public/js/shared/time.js';

const r = Router();
r.use(requireUser);

export const STATUS_LABEL = {
  draft: 'Not submitted', submitted: 'Waiting for account owner', 'ae-approved': 'Waiting for department manager',
  approved: 'Approved', rejected: 'Sent back',
};
const list = v => (v == null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(','))).filter(Boolean);

function readFilters(q) {
  const f = { from: q.from, to: q.to, clients: list(q.clients), projects: list(q.projects), users: list(q.users), billable: q.billable || 'all', status: q.status || 'all' };
  if (!isISODate(f.from) || !isISODate(f.to)) throw bad('Choose a start and end date.');
  if (f.to < f.from) throw bad('The end date is before the start date.');
  for (const k of ['clients', 'projects', 'users']) if (!f[k].every(isUUID)) throw bad(`Invalid ${k} filter.`);
  if (!['all', 'bill', 'non'].includes(f.billable)) throw bad('Unknown billable filter.');
  if (!['all', 'approved', 'pending', ...ENTRY_STATUSES].includes(f.status)) throw bad('Unknown approval filter.');
  return f;
}

async function reportRows(viewer, f) {
  const p = [f.from, f.to], where = ['e.entry_date BETWEEN $1 AND $2'];
  const add = v => { p.push(v); return `$${p.length}`; };
  if (f.clients.length) where.push(`c.id IN (${add(f.clients)})`);
  if (f.projects.length) where.push(`p.id IN (${add(f.projects)})`);
  if (f.users.length) where.push(`e.user_id IN (${add(f.users)})`);
  if (f.billable === 'bill') where.push('e.billable');
  if (f.billable === 'non') where.push('NOT e.billable');
  if (f.status === 'approved') where.push(`e.status = 'approved'`);
  else if (f.status === 'pending') where.push(`e.status <> 'approved'`);
  else if (f.status !== 'all') where.push(`e.status = ${add(f.status)}`);
  if (!isAdmin(viewer)) { p.push(viewer.id); where.push(visibleEntrySql(viewer, p.length)); }
  return many(`SELECT ${ENTRY_COLUMNS}, sl.rate FROM time_entries e ${ENTRY_JOINS} WHERE ${where.join(' AND ')}
                ORDER BY e.entry_date, eu.name, e.start_time IS NULL, e.start_time, e.created_at`, p);
}
function totals(rows) {
  const t = { entries: rows.length, minutes: 0, billable: 0, nonBillable: 0 };
  for (const e of rows) { t.minutes += e.minutes; if (e.billable) t.billable += e.minutes; else t.nonBillable += e.minutes; }
  return t;
}

r.get('/reports/time', h(async (req, res) => {
  const f = readFilters(req.query);
  const rows = await reportRows(req.user, f);
  const showValue = isAdmin(req.user) || isMgr(req.user);
  // The person filter offers only people whose time this viewer can see in the range.
  const people = isAdmin(req.user) ? null : (await many(
    `SELECT DISTINCT e.user_id FROM time_entries e ${ENTRY_JOINS} WHERE e.entry_date BETWEEN $1 AND $2 AND ${visibleEntrySql(req.user, 3)}`,
    [f.from, f.to, req.user.id])).map(r => r.user_id).concat(req.user.id);
  res.json({
    filters: f, totals: totals(rows), showValue, people,
    scope: isAdmin(req.user) ? 'all' : isMgr(req.user) ? 'manager' : 'member',
    // Only what the report page groups and shows; the approval details stay out of a long range's payload.
    entries: rows.map(e => {
      const o = {};
      for (const k of REPORT_FIELDS) o[k] = e[k];
      if (showValue) o.rate = e.rate;
      return o;
    }),
  });
}));

const REPORT_FIELDS = ['date', 'minutes', 'billable', 'status', 'note', 'user_id', 'user_name', 'task_id', 'task_title',
  'project_id', 'project_name', 'client_id', 'client_name', 'client_color', 'service_line_id', 'service_line_name', 'service_line_color'];

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${(/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

r.get('/reports/time.csv', h(async (req, res) => {
  const f = readFilters(req.query);
  const rows = await reportRows(req.user, f);
  const cols = ['date', 'client', 'project', 'service_line', 'task', 'person', 'start', 'end', 'minutes', 'hours', 'billable', 'approval_status', 'source', 'note'];
  const lines = [cols.join(',')];
  for (const e of rows) {
    lines.push([e.date, e.client_name, e.project_name, e.service_line_name, e.task_title, e.user_name, e.start || '', e.end || '',
      e.minutes, (e.minutes / 60).toFixed(2), e.billable ? 'yes' : 'no', STATUS_LABEL[e.status], e.source, e.note].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fifthcolor-time-${f.from}-to-${f.to}.csv"`);
  res.send(lines.join('\r\n') + '\r\n');
}));

export default r;
