// Time Reports (wireframe round 8 report builder, trimmed to the first milestone).
import { S, ui, api, isAdmin, today, activeUsers, user } from '../store.js';
import { esc, icon, btn, seg, selField, field, inp, toggle, empty, dlabel, dshort, fh, cdot, swatch, avatar, ESTATUS, MON, DOW } from '../ui.js';
import { views, actions, changes, inputs, pageHead, render, handleError, route } from '../core.js';
import { addDays, weekStart, dow } from '../shared/time.js';

const RPRE = [['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'], ['last-month', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['custom', 'Custom']];
const GB = { client: 'Client', project: 'Project', service: 'Service line', task: 'Task', user: 'Person', month: 'Month', week: 'Week', day: 'Day', billtype: 'Billable', status: 'Approval status' };
const STATUS_OPTS = [['all', 'All time, approved or not'], ['approved', 'Approved time only'], ['pending', 'Time not yet approved'], ...Object.entries(ESTATUS).filter(([k]) => k !== 'approved').map(([k, v]) => [k, `Only: ${v[1].toLowerCase()}`])];

function presetRange(k) {
  const t = today(), [y, m] = t.split('-').map(Number), pad = n => String(n).padStart(2, '0');
  const monthEnd = (yy, mm) => `${yy}-${pad(mm)}-${pad(new Date(Date.UTC(yy, mm, 0)).getUTCDate())}`;
  if (k === 'this-week') return [weekStart(t), addDays(weekStart(t), 6)];
  if (k === 'last-week') return [addDays(weekStart(t), -7), addDays(weekStart(t), -1)];
  if (k === 'this-month') return [`${y}-${pad(m)}-01`, monthEnd(y, m)];
  if (k === 'last-month') { const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; return [`${yy}-${pad(mm)}-01`, monthEnd(yy, mm)]; }
  if (k === 'quarter') { const q0 = Math.floor((m - 1) / 3) * 3 + 1; return [`${y}-${pad(q0)}-01`, monthEnd(y, q0 + 2)]; }
  if (k === 'year') return [`${y}-01-01`, `${y}-12-31`];
  return null;
}
function cfg() {
  const c = ui.rb || (ui.rb = { preset: 'this-month', clients: [], projects: [], users: [], billable: 'all', status: 'all', groups: ['client', 'project'], entries: false });
  if (c.preset !== 'custom') [c.from, c.to] = presetRange(c.preset);
  return c;
}
const qs = c => new URLSearchParams({ from: c.from, to: c.to, clients: c.clients.join(','), projects: c.projects.join(','), users: c.users.join(','), billable: c.billable, status: c.status }).toString();

views.reports = {
  async load() { const c = cfg(); ui.data.report = await api(`/reports/time?${qs(c)}`); ui.data.reportQs = qs(c); },
  render() {
    const c = cfg(), rep = ui.data.report, es = rep ? rep.entries : [], tot = rep ? rep.totals : { minutes: 0, billable: 0, nonBillable: 0, entries: 0 };
    const H = m => fh(Math.round((m / 60) * 100) / 100);
    const head = pageHead({ title: 'Time Reports', sub: 'Filter logged time, then group it up to three levels deep. The CSV has the same rows as the report.', actions: `<a class="fc-btn fc-btn--secondary fc-btn--md" href="/api/reports/time.csv?${ui.data.reportQs || qs(c)}" download data-test="csv">${icon('Download')}<span class="fc-btn__label">Download CSV</span></a>` });
    const scopeNote = rep && rep.scope !== 'all' ? `<p class="muted rb-help">${icon('Info')} <span>${rep.scope === 'manager' ? 'You see time logged by everyone except admins, plus any time on your clients and in your departments.' : 'You see your own time, plus time on clients you own and in departments you manage.'}</span></p>` : '';
    const projOpts = S.boot.projects.filter(p => !c.clients.length || c.clients.includes(p.client_id)).map(p => [p.id, `${p.name}, ${S.idx.clients[p.client_id].name}`]);
    const gsel = (i, v) => `<div class="rb-group"><span class="muted">${i ? 'Then group by' : 'Group by'}</span>${selField('rb-g-' + i, [...(i ? [['', 'Select a group']] : []), ...Object.entries(GB).filter(([k]) => k === v || !c.groups.includes(k))], v || '', { change: 'rb-g' })}${i ? `<button type="button" class="fc-btn fc-btn--ghost fc-iconbtn fc-iconbtn--sm" aria-label="Remove level" data-action="rb-g-rm" data-i="${i}">${icon('X')}</button>` : ''}</div>`;
    const conf = `<section class="fc-card rb-cfg">
      <div class="rb-sec"><span class="overline">Get time from</span><div class="toolbar">${seg('rbp', RPRE, c.preset)}${c.preset === 'custom' ? `<div class="fc-field date-f"><div class="fc-field__box">${inp('rb-from', c.from, { type: 'date' })}</div></div><span class="muted">to</span><div class="fc-field date-f"><div class="fc-field__box">${inp('rb-to', c.to, { type: 'date' })}</div></div>` : `<span class="muted">${dlabel(c.from)} to ${dlabel(c.to)}</span>`}</div>
        <div class="toolbar">${msel('clients', 'clients', S.boot.clients.map(x => [x.id, x.name + (x.archived_at ? ' (archived)' : '')]), c.clients)}${msel('projects', 'projects', projOpts, c.projects)}${msel('users', 'people', S.boot.users.filter(u => !rep || !rep.people || rep.people.includes(u.id) || c.users.includes(u.id)).map(u => [u.id, u.name + (u.archived_at ? ' (archived)' : '')]), c.users)}
          ${selField('rb-billable', [['all', 'Billable and non-billable'], ['bill', 'Billable only'], ['non', 'Non-billable only']], c.billable, { change: 'rb-f' })}
          ${selField('rb-status', STATUS_OPTS, c.status, { change: 'rb-f' })}</div></div>
      <div class="rb-sec"><p class="muted rb-help">${icon('Info')} <span><b>Approved</b> time has been signed off by the client’s account owner and then the department manager. <b>Not yet approved</b> covers entries that haven’t been submitted, are waiting on either approval, or were sent back.</span></p>${scopeNote}</div>
      <div class="rb-sec"><span class="overline">Display</span><div class="rb-groups">${c.groups.map((g, i) => gsel(i, g)).join('')}${c.groups.length < 3 ? `<button type="button" class="fc-linkbtn" data-action="rb-g-add">${icon('Plus')} Add another level</button>` : ''}</div>
        ${toggle('rb-entries', 'Show individual time entries under the last level', c.entries, null, { action: 'rb-entries' })}</div></section>`;
    const kpis = `<div class="grid-4">
      <div class="fc-card fc-kpi kpi-c" style="--k:#1971C2"><span class="fc-kpi__label">Total hours</span><span class="fc-kpi__value" data-test="total">${H(tot.minutes)}</span><span class="muted">${tot.entries} time ${tot.entries === 1 ? 'entry' : 'entries'}</span></div>
      <div class="fc-card fc-kpi kpi-c" style="--k:#2B8A3E"><span class="fc-kpi__label">Billable hours</span><span class="fc-kpi__value" data-test="billable">${H(tot.billable)}</span><span class="muted">${tot.minutes ? Math.round((tot.billable / tot.minutes) * 100) : 0}% of the total</span></div>
      <div class="fc-card fc-kpi kpi-c" style="--k:#868E96"><span class="fc-kpi__label">Non-billable hours</span><span class="fc-kpi__value" data-test="nonbillable">${H(tot.nonBillable)}</span><span class="muted">Tracked, not billed</span></div>
      ${rep && rep.showValue ? `<div class="fc-card fc-kpi kpi-c" style="--k:#E67700"><span class="fc-kpi__label">Billable value</span><span class="fc-kpi__value">${money(es.filter(e => e.billable).reduce((s, e) => s + (e.minutes / 60) * +e.rate, 0))}</span><span class="muted">At service line rates. Managers and admins only.</span></div>` : ''}</div>`;
    return head + conf + kpis + (es.length ? tree(c, es) : empty('Row Height', 'No time matches', 'Widen the dates or remove a filter.', ''));
  },
};
const money = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

function gkey(g, e) {
  switch (g) {
    case 'client': return [e.client_id, e.client_name, { color: e.client_color }];
    case 'project': return [e.project_id, e.project_name, { sub: e.client_name }];
    case 'service': return [e.service_line_id, e.service_line_name, { svc: e.service_line_color }];
    case 'task': return [e.task_id, e.task_title, { sub: `${e.client_name}, ${e.project_name}` }];
    case 'user': return [e.user_id, e.user_name, { u: e.user_name }];
    case 'month': { const [y, m] = e.date.split('-'); return [`${y}-${m}`, `${MON[+m - 1]} ${y}`]; }
    case 'week': { const w = weekStart(e.date); return [w, `Week of ${dlabel(w)}`]; }
    case 'day': return [e.date, `${DOW[dow(e.date)]}, ${dlabel(e.date)}`];
    case 'billtype': return e.billable ? ['bill', 'Billable'] : ['non', 'Non-billable'];
    case 'status': return [e.status, ESTATUS[e.status][1]];
  }
  return ['', ''];
}
function build(es, groups, lvl = 0) {
  if (lvl >= groups.length) return null;
  const map = new Map();
  es.forEach(e => { const [k, label, meta] = gkey(groups[lvl], e); if (!map.has(k)) map.set(k, { k, label, meta: meta || {}, es: [] }); map.get(k).es.push(e); });
  const time = ['month', 'week', 'day'].includes(groups[lvl]);
  return [...map.values()].map(n => ({ ...n, ...sum(n.es), kids: build(n.es, groups, lvl + 1) })).sort((a, b) => (time ? (a.k < b.k ? -1 : 1) : b.m - a.m));
}
const sum = es => es.reduce((a, e) => { a.m += e.minutes; if (e.billable) a.b += e.minutes; else a.n += e.minutes; return a; }, { m: 0, b: 0, n: 0 });
function tree(c, es) {
  const open = ui.rbOpen || (ui.rbOpen = {}), H = m => fh(Math.round((m / 60) * 100) / 100), rows = [];
  const cells = n => `<td class="is-num"><b>${H(n.m)}</b></td><td class="is-num">${H(n.b)}</td><td class="is-num">${H(n.n)}</td><td class="is-num">${n.m ? Math.round((n.b / n.m) * 100) + '%' : ''}</td>`;
  const walk = (nodes, lvl, path) => nodes.forEach(n => {
    const id = path + '/' + n.k, isOpen = open[id] !== undefined ? open[id] : lvl === 0, has = n.kids || c.entries;
    const lab = n.meta.color ? `${cdot(n.meta.color)}${esc(n.label)}` : n.meta.svc ? `<span class="svc-name">${swatch(n.meta.svc)}${esc(n.label)}</span>` : n.meta.u ? `<span class="row" style="gap:8px;flex-wrap:nowrap">${avatar({ name: n.meta.u }, 24)}${esc(n.label)}</span>` : `${esc(n.label)}${n.meta.sub ? ` <span class="muted">${esc(n.meta.sub)}</span>` : ''}`;
    rows.push(`<tr class="lvl lvl${lvl}"><th scope="row" style="padding-left:${16 + lvl * 24}px">${has ? `<button type="button" class="tree-tg" data-action="rb-tg" data-id="${esc(id)}" aria-expanded="${isOpen}">${icon(isOpen ? 'Chevron Down' : 'Chevron Right')}</button>` : '<span class="tree-sp"></span>'}${lab}<span class="muted"> (${n.es.length} ${n.es.length === 1 ? 'entry' : 'entries'})</span></th>${cells(n)}</tr>`);
    if (!isOpen) return;
    if (n.kids) walk(n.kids, lvl + 1, id);
    else if (c.entries) n.es.forEach(e => rows.push(`<tr class="entry-row"><th scope="row" style="padding-left:${40 + (lvl + 1) * 24}px"><span class="muted">${dshort(e.date)}</span> ${esc(e.user_name)}, ${esc(e.task_title)} <span class="muted">${ESTATUS[e.status][1]}</span>${e.note ? ` <span class="muted">“${esc(e.note)}”</span>` : ''}</th>${cells(sum([e]))}</tr>`));
  });
  walk(build(es, c.groups) || [], 0, '');
  const t = sum(es);
  return `<section class="fc-card flush"><div class="ledger-scroll"><table class="rb-table"><thead><tr><th scope="col">${c.groups.map(g => GB[g]).join(' › ')}</th><th scope="col" class="is-num">Hours</th><th scope="col" class="is-num">Billable</th><th scope="col" class="is-num">Non-billable</th><th scope="col" class="is-num">Billable %</th></tr></thead><tbody>${rows.join('')}</tbody>
    <tfoot><tr class="tot"><th scope="row">Total</th>${cells(t)}</tr></tfoot></table></div><div class="legend"><span>Durations are stored in whole minutes. The CSV lists each entry with its minutes, so its totals match these to the minute.</span></div></section>`;
}

/* multi-select with checkboxes */
function msel(key, noun, opts, vals) {
  const label = !vals.length ? `All ${noun}` : vals.length === 1 ? esc((opts.find(o => o[0] === vals[0]) || [, '1 selected'])[1]) : `${vals.length} ${noun}`;
  const isOpen = ui.mselOpen === key;
  return `<div class="msel${isOpen ? ' is-open' : ''}"><button type="button" class="fc-btn fc-btn--secondary fc-btn--sm msel-btn" data-action="msel-toggle" data-k="${key}" aria-expanded="${isOpen}"><span class="fc-btn__label">${label}</span>${icon('Chevron Down')}</button>
    ${isOpen ? `<div class="msel-pop" role="listbox" aria-multiselectable="true">${vals.length ? `<button type="button" class="fc-linkbtn" data-action="msel-clear" data-k="${key}">Clear</button>` : ''}${opts.map(([v, l]) => `<label class="msel-opt"><input type="checkbox" data-msel="${key}" value="${esc(v)}"${vals.includes(v) ? ' checked' : ''}> <span>${esc(l)}</span></label>`).join('') || '<span class="muted">Nothing to choose</span>'}</div>` : ''}</div>`;
}
async function reload() { try { await views.reports.load(); } catch (e) { handleError(e); } render(); }
actions['msel-toggle'] = a => { ui.mselOpen = ui.mselOpen === a.dataset.k ? null : a.dataset.k; render(); };
actions['msel-clear'] = a => { const c = cfg(); c[a.dataset.k] = []; if (a.dataset.k === 'clients') c.projects = []; reload(); };
document.addEventListener('change', e => {
  const t = e.target; if (!t.dataset || !t.dataset.msel) return;
  const c = cfg(), k = t.dataset.msel;
  c[k] = t.checked ? [...c[k], t.value] : c[k].filter(v => v !== t.value);
  if (k === 'clients' && c.clients.length) c.projects = c.projects.filter(pid => c.clients.includes(S.idx.projects[pid].client_id));
  reload();
});
document.addEventListener('click', e => { if (ui.mselOpen && !e.target.closest('.msel')) { ui.mselOpen = null; render(); } });
actions['seg:rbp'] = a => { const c = cfg(); c.preset = a.dataset.v; if (c.preset === 'custom') { c.from = c.from || today(); c.to = c.to || today(); } reload(); };
changes['rb-f'] = el => { cfg()[el.name.slice(3)] = el.value; reload(); };
changes['rb-g'] = el => { const c = cfg(), i = +el.name.slice(5); if (el.value) c.groups[i] = el.value; else c.groups.splice(i, 1); render(); };
actions['rb-g-add'] = () => { const c = cfg(); const next = Object.keys(GB).find(k => !c.groups.includes(k)); if (next) c.groups.push(next); render(); };
actions['rb-g-rm'] = a => { cfg().groups.splice(+a.dataset.i, 1); render(); };
actions['rb-tg'] = a => { const open = ui.rbOpen, id = a.dataset.id, cur = a.getAttribute('aria-expanded') === 'true'; open[id] = !cur; render(); };
actions['rb-entries'] = a => { cfg().entries = a.checked; render(); };
document.addEventListener('change', e => {
  if (e.target.id === 'f-rb-from' || e.target.id === 'f-rb-to') {
    const c = cfg(), f = document.getElementById('f-rb-from').value, t = document.getElementById('f-rb-to').value;
    if (f && t && f <= t) { c.from = f; c.to = t; reload(); }
  }
});
