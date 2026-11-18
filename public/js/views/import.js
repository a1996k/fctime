// Settings → Import from Paymo: fetch with an API key or upload a CSV export, check the preview, import.
import { S, ui, api, today, isAdmin } from '../store.js';
import { esc, icon, btn, chip, field, inp, sel, seg, table, empty, alertBox, toast, hours, dlabel, stamp, selField } from '../ui.js';
import { actions, changes, render, go, run, route, handleError } from '../core.js';
import { addDays, hm } from '../shared/time.js';

const RSTATUS = { preview: ['warning', 'Waiting for review'], imported: ['success', 'Imported'], discarded: ['muted', 'Discarded'] };

export async function loadImport() {
  const id = route.parts[1];
  const [runs, cur] = await Promise.all([api('/import/runs'), id ? api(`/import/runs/${id}`) : null]);
  ui.data.importRuns = runs; ui.data.importRun = cur;
}

export function importView() {
  const cur = ui.data.importRun;
  if (cur && cur.status === 'preview') return previewView(cur);
  if (cur && cur.status === 'imported') return doneView(cur) + startView();
  return startView();
}

function startView() {
  const y = today().slice(0, 4);
  const runs = ui.data.importRuns || [];
  return `<div class="grid-2 import-start">
    <form class="fc-card stack-16" data-form="import-api" novalidate><div class="card-head"><div><h2>Connect with an API key</h2><p>Best for the first move and a final top-up at cutover. In Paymo, open My Account and create an API key. It’s used for this fetch only and isn’t saved.</p></div></div>
      <div class="fields cols">${field('Paymo API key', inp('pkey', '', { type: 'password', autocomplete: 'off', placeholder: 'Paste the key' }), { id: 'f-pkey', cls: 'span' })}
      ${field('Bring time from', inp('pfrom', `${y}-01-01`, { type: 'date' }), { id: 'f-pfrom' })}${field('To', inp('pto', today(), { type: 'date' }), { id: 'f-pto' })}</div>
      <div class="row">${btn('Fetch from Paymo', { variant: 'ink', icon: 'Download', type: 'submit' })}<span class="muted">Nothing is saved until you review it.</span></div></form>
    <form class="fc-card stack-16" data-form="import-csv" novalidate><div class="card-head"><div><h2>Upload a CSV export</h2><p>Export time entries from a Paymo report (one row per entry) with date, person, client, project, task, and duration or start and end. You can match the columns on the next step.</p></div></div>
      <input type="file" accept=".csv,text/csv,text/plain" hidden id="import-file">
      <div class="fc-drop" role="button" tabindex="0" data-action="import-pick" style="max-width:none"><span class="fc-drop__icon">${icon('Upload')}</span><span class="fc-drop__title">${ui.importFile ? esc(ui.importFile.name) : 'Choose a CSV file'}</span><span class="fc-drop__hint">${ui.importFile ? `${Math.round(ui.importFile.text.length / 1024)} KB ready` : '.csv up to 40 MB'}</span></div>
      <div class="row">${btn('Check the file', { variant: 'ink', icon: 'Check', type: 'submit', disabled: !ui.importFile })}</div></form></div>
    <section class="stack-16"><h3 class="h3">Earlier imports</h3>${runs.length ? table([
      { label: 'Import', primary: true, wrap: true, render: r => (r.status === 'preview' ? `<a href="#/settings/import/${r.id}">${esc(r.label)}</a>` : esc(r.label)) },
      { label: 'Status', render: r => chip(...RSTATUS[r.status]) },
      { label: 'Started', render: r => `${stamp(r.created_at)}<div class="muted">${esc(r.created_by_name)}</div>` },
      { label: 'Result', wrap: true, render: r => (r.summary ? `${r.summary.entriesImported} entries, ${hours(r.summary.minutes)} h; ${r.summary.peopleCreated} people, ${r.summary.clientsCreated} clients, ${r.summary.projectsCreated} projects, ${r.summary.tasksCreated} tasks added` : '') },
    ], runs, { dense: true }) : '<p class="muted">No imports yet.</p>'}</section>`;
}

function previewView(p) {
  const e = p.entries;
  const opt = (k, v) => `data-k="${k}" data-v="${esc(v)}"`;
  const head = `<section class="fc-card stack-16"><div class="card-head"><div><h2>Check before importing</h2><p>${esc(p.label)}.${p.range ? ` Paymo time from ${dlabel(p.range.from)} to ${dlabel(p.range.to)}.` : ''} Nothing has been added yet. Records already in the app are matched and left as they are; only new ones are added, so running an import again won’t duplicate anything.</p></div></div>
    <div class="grid-4">
      <div class="fc-kpi"><span class="fc-kpi__label">Time entries to add</span><span class="fc-kpi__value">${e.new}</span><span class="muted">${hours(e.minutes)} h${e.from ? `, ${dlabel(e.from)} to ${dlabel(e.to)}` : ''}</span></div>
      <div class="fc-kpi"><span class="fc-kpi__label">Already here</span><span class="fc-kpi__value">${e.already}</span><span class="muted">Skipped as duplicates</span></div>
      <div class="fc-kpi"><span class="fc-kpi__label">People</span><span class="fc-kpi__value">${p.people.filter(x => x.action === 'create').length} new</span><span class="muted">${p.people.filter(x => x.action === 'match').length} matched, ${p.people.filter(x => x.action === 'skip').length} skipped</span></div>
      <div class="fc-kpi"><span class="fc-kpi__label">Tasks</span><span class="fc-kpi__value">${p.tasks.create} new</span><span class="muted">${p.tasks.match} already here</span></div></div></section>`;
  const skipped = [[e.skippedPerson, 'belong to people you chose to skip'], [e.unknownTask, 'are on tasks Paymo didn’t return'], [e.zero, 'have no duration'], [e.running, 'are timers still running in Paymo'], [e.capped, 'ran over 24 hours and were cut to 24:00']].filter(x => x[0]);
  const warn = (skipped.length ? alertBox('warning', 'Some time won’t come over', skipped.map(([n, t]) => `${n} ${n === 1 ? 'entry' : 'entries'} ${t}.`).join('<br>')) : '')
    + (p.problemCount ? alertBox('danger', `${p.problemCount} ${p.problemCount === 1 ? 'row' : 'rows'} can’t be read`, `<ul class="ul">${p.problems.map(x => `<li>${esc(String(x.line))}: ${esc(x.why)}</li>`).join('')}</ul>${p.problemCount > p.problems.length ? `<p>…and ${p.problemCount - p.problems.length} more.</p>` : ''}`) : '');
  const options = `<section class="fc-card stack-16"><div class="card-head"><div><h2>How it comes in</h2></div></div>
    <div class="fields cols">
      <div class="span"><span class="fc-field__label">Imported time arrives as</span><div style="margin-top:8px">${seg('imp-status', [['approved', 'Approved (history)'], ['draft', 'Not submitted']], p.options.entryStatus)}</div><div class="fc-field__msg"><span>Approved keeps old weeks out of everyone’s approval queue. Not submitted puts them back on each person’s timesheet.</span></div></div>
      ${field('Default service line', sel('imp-default', p.services.map(s => [s.id, s.name]), p.options.defaultServiceLineId, { change: 'imp-opt' }), { id: 'f-imp-default', select: true, msg: 'For task lists that match no keywords.' })}
      ${field('Extra hours on open tasks without a Paymo budget', inp('imp-extra', String(p.options.extraOpenMinutes / 60), { type: 'number', min: 0, max: 100, step: 0.5, data: { change: 'imp-opt' } }), { id: 'f-imp-extra', suffix: 'h', msg: `${p.tasks.noBudget} new ${p.tasks.noBudget === 1 ? 'task has' : 'tasks have'} no budget in Paymo, ${p.tasks.noBudgetOpen} of them open. Their budget becomes the time imported plus these hours; with 0 they lock until an admin adds hours.` })}
    </div></section>`;
  const csv = p.csv ? `<section class="fc-card stack-16"><div class="card-head"><div><h2>Match the columns</h2><p>${p.csv.rows} rows. Pick which column holds each field. Required: date, person, client, project, and a duration or start and end times.</p></div></div>
    <div class="fields cols">${Object.entries(p.csv.fields).map(([k, f]) => field(`${f.label}${f.required ? ' *' : ''}`, sel(`col-${k}`, [['-1', 'Not in the file'], ...p.csv.headers.map((h, i) => [String(i), h || `Column ${i + 1}`])], String(p.csv.columns[k] ?? -1), { change: 'imp-col' }), { id: `f-col-${k}`, select: true })).join('')}
      <div class="span"><span class="fc-field__label">Dates like 03/04/2026 mean</span><div style="margin-top:8px">${seg('imp-datefmt', [['mdy', 'March 4 (MM/DD/YYYY)'], ['dmy', '3 April (DD/MM/YYYY)']], p.csv.dateFormat)}</div></div></div>
    <div class="fc-table fc-table--dense"><div class="fc-table__scroll"><table><thead><tr>${p.csv.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${p.csv.sample.map(r => `<tr>${p.csv.headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div></section>` : '';
  const personOpts = x => [['create', 'Add as a new Team Member'], ['skip', 'Skip their time'], ...p.existingPeople.map(u => [u.id, `${u.name} (${u.email})`])];
  const people = `<section class="fc-card flush"><div class="card-head"><div><h2>People</h2><p>Matched by Paymo id, then email, then name. New people come in as Team Members with no password: set roles, departments and passwords in Settings → People before they sign in.</p></div></div>
    ${p.people.length ? table([
      { label: 'In Paymo', primary: true, wrap: true, render: x => `<div class="client-cell"><b>${esc(x.name)}</b><span class="muted">${esc(x.email || 'no email')}${x.type ? `, ${esc(x.type)}` : ''}${x.active ? '' : ', inactive'}</span></div>` },
      { label: 'Entries', num: true, render: x => x.entries },
      { label: 'Hours', num: true, render: x => hours(x.minutes) },
      // Field names use the row number: names from Paymo or a CSV never go into markup attributes.
      { label: 'In the app', render: x => `${selField(`imp-user-${p.people.indexOf(x)}`, personOpts(x), x.action === 'match' ? x.userId : x.action, { change: 'imp-user' })}${x.matchedBy ? `<div class="muted small">Matched by ${esc(x.matchedBy)}</div>` : ''}` },
    ], p.people, { dense: true }) : '<p class="muted" style="padding:0 24px 24px">No people in this data.</p>'}</section>`;
  const how = { keyword: 'Keyword match', default: 'Default', chosen: 'Your choice' };
  const svcs = `<section class="fc-card flush"><div class="card-head"><div><h2>Task lists to service lines</h2><p>Every task needs a service line, which decides its department manager. Paymo task lists match by the keywords on each service line (Settings → Service lines). Tasks without a task list match by task name, otherwise the default.</p></div></div>
    ${p.serviceLines.length ? table([
      { label: 'Paymo task list', primary: true, render: x => esc(x.name) },
      { label: 'Tasks', num: true, render: x => x.tasks }, { label: 'Entries', num: true, render: x => x.entries },
      { label: 'Service line', render: x => selField(`imp-svc-${p.serviceLines.indexOf(x)}`, p.services.map(s => [s.id, s.name]), x.serviceLineId, { change: 'imp-svc' }) },
      { label: 'Why', render: x => `<span class="muted">${how[x.how]}</span>` },
    ], p.serviceLines, { dense: true }) : '<p class="muted" style="padding:0 24px 24px">No task lists; tasks are matched by name or go to the default service line.</p>'}</section>`;
  const list = (items, n = 12) => `${items.slice(0, n).map(esc).join(', ')}${items.length > n ? `, and ${items.length - n} more` : ''}`;
  const work = `<section class="fc-card stack-16"><div class="card-head"><div><h2>Clients, projects and tasks</h2></div></div>
    <p>${p.clients.create.length ? `<b>${p.clients.create.length} new ${p.clients.create.length === 1 ? 'client' : 'clients'}:</b> ${list(p.clients.create)}. They have no account owner yet, so admins approve their time until you set one.` : 'No new clients.'} ${p.clients.match ? `${p.clients.match} already here.` : ''}</p>
    <p>${p.projects.create.length ? `<b>${p.projects.create.length} new ${p.projects.create.length === 1 ? 'project' : 'projects'}:</b> ${list(p.projects.create.map(x => `${x.name} (${x.client})`))}.` : 'No new projects.'} ${p.projects.match ? `${p.projects.match} already here.` : ''}</p>
    <p><b>Tasks:</b> ${p.tasks.create} new, ${p.tasks.match} already here. Open tasks and any with time in the range come over; finished tasks without time don’t.${p.tasks.noDue ? ` ${p.tasks.noDue} new ${p.tasks.noDue === 1 ? 'task has' : 'tasks have'} no due date in Paymo and get their last day of logged time.` : ''}</p></section>`;
  const foot = `<div class="row">${btn(`Import ${e.new} ${e.new === 1 ? 'entry' : 'entries'}`, { variant: 'primary', icon: 'Check', action: 'imp-commit', disabled: !e.new && !p.tasks.create })}${btn('Discard', { action: 'imp-discard' })}${btn('Back', { variant: 'ghost', action: 'go', data: { href: '#/settings/import' } })}</div>`;
  return head + warn + csv + options + people + svcs + work + foot;
}

function doneView(r) {
  const s = r.summary || {};
  return alertBox('success', 'Import finished', `${s.entriesImported} time entries (${hours(s.minutes)} h) came over. Added ${s.peopleCreated} people, ${s.clientsCreated} clients, ${s.projectsCreated} projects and ${s.tasksCreated} tasks.${s.placeholderEmails ? ` ${s.placeholderEmails} new ${s.placeholderEmails === 1 ? 'person has' : 'people have'} a placeholder email; update it in Settings → People.` : ''} Next: set account owners on new clients, and roles and passwords for new people.`,
    btn('People', { size: 'sm', action: 'go', data: { href: '#/settings/people' } }) + btn('Clients', { size: 'sm', action: 'go', data: { href: '#/clients' } }));
}

/* ---------- actions ---------- */
async function patch(body) {
  const id = ui.data.importRun.id;
  try { ui.data.importRun = await api(`/import/runs/${id}`, { method: 'PATCH', body }); } catch (e) { handleError(e); }
  const y = window.scrollY; render(); window.scrollTo(0, y);
}
actions['import-pick'] = () => document.getElementById('import-file').click();
document.addEventListener('change', e => {
  if (e.target.id !== 'import-file' || !e.target.files[0]) return;
  const f = e.target.files[0];
  if (f.size > 40 * 1024 * 1024) { toast('That file is over 40 MB', 'Export a shorter date range and import it in parts.', 'danger'); return; }
  const reader = new FileReader();
  reader.onload = () => { ui.importFile = { name: f.name, text: String(reader.result) }; render(); };
  reader.readAsText(f);
});
export const importForms = {
  'import-api': async f => {
    const fd = new FormData(f);
    const out = await api('/import/paymo/fetch', { method: 'POST', body: { apiKey: fd.get('pkey'), from: fd.get('pfrom'), to: fd.get('pto') } });
    go(`#/settings/import/${out.id}`);
  },
  'import-csv': async () => {
    if (!ui.importFile) return;
    const out = await api('/import/paymo/csv', { method: 'POST', body: { filename: ui.importFile.name, text: ui.importFile.text } });
    ui.importFile = null;
    go(`#/settings/import/${out.id}`);
  },
};
actions['seg:imp-status'] = a => patch({ entryStatus: a.dataset.v });
actions['seg:imp-datefmt'] = a => patch({ dateFormat: a.dataset.v });
changes['imp-opt'] = el => (el.name === 'imp-extra' ? patch({ extraOpenMinutes: Math.round((+el.value || 0) * 60) }) : patch({ defaultServiceLineId: el.value }));
changes['imp-user'] = el => patch({ userMap: { [ui.data.importRun.people[+el.name.slice('imp-user-'.length)].pid]: el.value } });
changes['imp-svc'] = el => patch({ serviceLineMap: { [ui.data.importRun.serviceLines[+el.name.slice('imp-svc-'.length)].key]: el.value } });
changes['imp-col'] = el => patch({ columns: { ...ui.data.importRun.csv.columns, [el.name.slice(4)]: +el.value } });
actions['imp-commit'] = a => run(a, async () => {
  const r = ui.data.importRun;
  if (!confirm(`Import ${r.entries.new} time entries now? Matched records are left as they are.`)) return;
  const sum = await api(`/import/runs/${r.id}/commit`, { method: 'POST', body: {} });
  toast('Import finished', `${sum.entriesImported} entries, ${hours(sum.minutes)} h.`);
  go(`#/settings/import/${r.id}`);
});
actions['imp-discard'] = a => run(a, async () => {
  await api(`/import/runs/${ui.data.importRun.id}/discard`, { method: 'POST', body: {} });
  go('#/settings/import');
});
export { isAdmin };
