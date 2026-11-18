// Paymo CSV exports: parse, detect columns, and turn rows into the importer's common shape.
// Paymo's export columns depend on how the report was set up, so columns are matched by name
// and the admin can correct the mapping in the preview.
import crypto from 'node:crypto';

/** RFC 4180-style CSV parser (quotes, doubled quotes, CRLF). Drops a UTF-8 BOM and blank rows. */
export function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  const delim = sniffDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = ch => first.split(ch).length - 1;
  return count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
}

/** The fields the importer understands, with the header names Paymo and spreadsheets tend to use. */
export const CSV_FIELDS = {
  date: { label: 'Date', required: true, aliases: ['date', 'day', 'entry date', 'work date'] },
  person: { label: 'Person', required: true, aliases: ['user', 'person', 'employee', 'member', 'team member', 'user name', 'worker', 'name'] },
  email: { label: 'Email', aliases: ['email', 'user email', 'e-mail'] },
  client: { label: 'Client', required: true, aliases: ['client', 'client name', 'company', 'customer'] },
  project: { label: 'Project', required: true, aliases: ['project', 'project name'] },
  tasklist: { label: 'Task list', aliases: ['task list', 'tasklist', 'list', 'task list name'] },
  task: { label: 'Task', aliases: ['task', 'task name'] },
  note: { label: 'Description', aliases: ['description', 'notes', 'note', 'comment', 'comments', 'details'] },
  start: { label: 'Start time', aliases: ['start', 'start time', 'from', 'started', 'started at', 'time start'] },
  end: { label: 'End time', aliases: ['end', 'end time', 'to', 'stopped', 'finish', 'ended at', 'time end'] },
  duration: { label: 'Duration', aliases: ['duration', 'time', 'hours', 'total time', 'time (h)', 'duration (h)', 'hours (decimal)', 'decimal hours', 'time spent', 'logged time'] },
  billable: { label: 'Billable', aliases: ['billable', 'is billable'] },
  entryId: { label: 'Entry ID', aliases: ['id', 'entry id', 'time entry id', 'entry'] },
};

/** Best guess at which column holds each field. Exact names win over partial matches. */
export function detectColumns(headers) {
  const h = headers.map(x => String(x || '').trim().toLowerCase());
  const used = new Set(), out = {};
  for (const pass of ['exact', 'partial']) {
    for (const [k, def] of Object.entries(CSV_FIELDS)) {
      if (out[k] !== undefined && out[k] >= 0) continue;
      // Short words like "name" or "time" only count as exact matches.
      const i = h.findIndex((x, j) => !used.has(j) && def.aliases.some(a => (pass === 'exact' ? x === a : x.includes(a) && a.length > 4)));
      if (i >= 0) { out[k] = i; used.add(i); } else out[k] = -1;
    }
  }
  return out;
}

/** '2026-01-15', '2026-01-15 09:00', '01/15/2026' (or day first), '15.01.2026'. */
export function parseDateCell(s, fmt = 'mdy') {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    const dayFirst = fmt === 'dmy' || s.includes('.') || a > 12;
    return dayFirst ? iso(y, b, a) : iso(y, a, b);
  }
  return null;
}
function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : null;
}
/** A clock time anywhere in the cell: '9:00', '09:00:00', '9:05 PM', '2026-01-15 14:30'. Returns 'HH:MM'. */
export function parseTimeCell(s) {
  s = String(s || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\s*$/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}
/** '1:30', '1:30:00', '1.5', '1,5', '1h 30m', '90m', '45 min'. Returns whole minutes. */
export function parseDurationCell(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) return +m[1] * 60 + +m[2] + Math.round((+m[3] || 0) / 60);
  m = s.match(/^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/);
  if (m && (m[1] || m[2])) return Math.round(parseFloat((m[1] || '0').replace(',', '.')) * 60) + (+m[2] || 0);
  m = s.match(/^(\d*[.,]?\d+)$/);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
  return null;
}
const yes = s => /^(y|yes|true|1|billable)$/i.test(String(s || '').trim());

/**
 * CSV rows → common shape. There are no Paymo ids in a CSV, so records are keyed by name and
 * entries by a hash of the row (plus how many identical rows came before it), which keeps a second
 * import of the same file from adding anything.
 */
export function normalizeCsv(raw, options = {}) {
  const [headers, ...rows] = raw.rows;
  const col = { ...detectColumns(headers), ...(options.columns || {}) };
  const get = (row, k) => (col[k] >= 0 ? String(row[col[k]] ?? '').trim() : '');
  const out = { users: new Map(), clients: new Map(), projects: new Map(), tasklists: new Map(), tasks: new Map(), entries: [], problems: [] };
  const lower = s => s.toLowerCase();
  const seen = new Map();
  rows.forEach((row, i) => {
    const line = i + 2;
    const date = parseDateCell(get(row, 'date'), options.dateFormat);
    const person = get(row, 'person'), email = get(row, 'email').toLowerCase();
    const clientName = get(row, 'client'), projectName = get(row, 'project');
    const tasklistName = get(row, 'tasklist'), taskName = get(row, 'task') || tasklistName || 'General';
    if (!date) return out.problems.push({ line, why: `the date “${get(row, 'date')}” isn’t readable` });
    if (!person && !email) return out.problems.push({ line, why: 'no person' });
    if (!clientName || !projectName) return out.problems.push({ line, why: 'no client or project' });
    const start = col.start >= 0 ? parseTimeCell(get(row, 'start')) : null, end = col.end >= 0 ? parseTimeCell(get(row, 'end')) : null;
    let minutes = parseDurationCell(get(row, 'duration'));
    if (minutes == null && start && end) { const a = toMin(start), b = toMin(end); minutes = b > a ? b - a : b + 1440 - a; }
    if (minutes == null) return out.problems.push({ line, why: `the duration “${get(row, 'duration')}” isn’t readable` });
    const userPid = 'u:' + lower(email || person);
    if (!out.users.has(userPid)) out.users.set(userPid, { pid: userPid, paymoId: null, name: person || email, email: email || null, active: true, type: null });
    const clientPid = 'c:' + lower(clientName);
    if (!out.clients.has(clientPid)) out.clients.set(clientPid, { pid: clientPid, paymoId: null, name: clientName, active: true });
    const projectPid = `p:${lower(clientName)}|${lower(projectName)}`;
    if (!out.projects.has(projectPid)) out.projects.set(projectPid, { pid: projectPid, paymoId: null, clientPid, name: projectName, active: true });
    const tasklistPid = tasklistName ? `l:${projectPid}|${lower(tasklistName)}` : null;
    if (tasklistPid && !out.tasklists.has(tasklistPid)) out.tasklists.set(tasklistPid, { pid: tasklistPid, paymoId: null, projectPid, name: tasklistName });
    const taskPid = `t:${projectPid}|${lower(tasklistName)}|${lower(taskName)}`;
    if (!out.tasks.has(taskPid)) {
      out.tasks.set(taskPid, { pid: taskPid, paymoId: null, projectPid, tasklistPid, tasklistName: tasklistName || '', name: taskName, complete: false, dueDate: null, assigneePids: [], billable: col.billable >= 0 ? yes(get(row, 'billable')) : true, budgetMinutes: null });
    }
    const note = get(row, 'note');
    const id = get(row, 'entryId');
    let key;
    if (id) key = `csv:id:${id}`;
    else {
      // Identity is who, what, when and how long. The description is left out so remapping or
      // editing it doesn't make the same time look new; identical rows stay apart by their count.
      const base = [date, userPid, taskPid, start || '', end || '', minutes].join('|');
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      key = 'csv:' + crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
    }
    out.entries.push({ key, paymoId: null, taskPid, userPid, date, start: start && end ? start : null, end: start && end ? end : null, minutes, note, line });
  });
  return { users: [...out.users.values()], clients: [...out.clients.values()], projects: [...out.projects.values()], tasklists: [...out.tasklists.values()], tasks: [...out.tasks.values()], entries: out.entries, problems: out.problems, skippedRunning: 0, columns: col, headers };
}
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
