// Clients, projects and the project task list (wireframe viewClients, viewClient, viewProjects, tasksTab).
import { S, ui, api, isAdmin, user, userName, client, project, taskCtx, isDone, activeUsers } from '../store.js';
import { esc, icon, btn, chip, field, inp, sel, seg, table, empty, dialog, cdot, crumbs, toast, alertPopup, hours, PSTATUS, TSTATUS, selField, avatar, dshort, swatch } from '../ui.js';
import { views, actions, forms, modals, changes, pageHead, openModal, closeModal, refresh, render, href, route, go } from '../core.js';
import { taskRow, budgetPill, timerButton } from './tasks.js';

const PALETTE = ['#E8590C', '#1971C2', '#2B8A3E', '#7048E8', '#C2255C', '#0C8599', '#E67700', '#495057'];
const projTasks = pid => S.boot.tasks.filter(t => t.project_id === pid);
const projChip = p => chip(...PSTATUS[p.status]);
const kindText = k => (k === 'retainer' ? 'Retainer' : 'Project');

/* ---------- clients ---------- */
views.clients = {
  render() {
    if (route.parts[0]) return clientPage();
    const q = (ui.q || '').toLowerCase(), showArch = !!ui.showArchived;
    const rows = S.boot.clients.filter(c => (showArch || !c.archived_at) && (!q || c.name.toLowerCase().includes(q)));
    const head = pageHead({ title: 'Clients', sub: 'Every client has an account owner, who gives the first approval on time logged for them.', actions: isAdmin() ? btn('Add client', { variant: 'primary', icon: 'Plus', action: 'client-new' }) : '' });
    const bar = `<div class="toolbar">${seg('carch', [['active', 'Active'], ['all', 'Include archived']], showArch ? 'all' : 'active')}${q ? `<span class="muted">Matching “${esc(ui.q)}”</span>${btn('Clear search', { size: 'sm', variant: 'ghost', action: 'clear-q' })}` : ''}</div>`;
    const cols = [
      { label: 'Client', primary: true, render: c => `<span class="row" style="gap:10px;flex-wrap:nowrap">${cdot(c.color)}<a href="${href('clients', c.id)}">${esc(c.name)}</a>${c.archived_at ? chip('muted', 'Archived') : ''}</span>` },
      { label: 'Account owner', render: c => (c.owner_id ? `<span class="row" style="gap:8px;flex-wrap:nowrap">${avatar(user(c.owner_id), 24)}${esc(userName(c.owner_id))}</span>` : '<span class="muted">None, admins approve</span>') },
      { label: 'Projects', num: true, render: c => S.boot.projects.filter(p => p.client_id === c.id).length },
      { label: 'Open tasks', num: true, render: c => S.boot.tasks.filter(t => !isDone(t) && project(t.project_id)?.client_id === c.id).length },
      { label: 'Logged', num: true, render: c => `${hours(S.boot.tasks.filter(t => project(t.project_id)?.client_id === c.id).reduce((s, t) => s + t.logged_minutes, 0))} h` },
      ...(isAdmin() ? [{ label: '', render: c => btn('Edit', { size: 'sm', variant: 'ghost', action: 'client-edit', data: { id: c.id } }) }] : []),
    ];
    return head + bar + (rows.length ? table(cols, rows) : empty('Group', 'No clients match', q ? 'Clear the search to see every client.' : 'Add your first client.', ''));
  },
};
actions['seg:carch'] = a => { ui.showArchived = a.dataset.v === 'all'; render(); };
actions['clear-q'] = () => { ui.q = ''; render(); };

/* client page: its projects */
function clientPage() {
  {
    const c = client(route.parts[0]);
    if (!c) return pageHead({ title: 'Client not found' }) + empty('Group', 'That client doesn’t exist', '', btn('All clients', { action: 'go', data: { href: '#/clients' } }));
    const ps = S.boot.projects.filter(p => p.client_id === c.id);
    const head = pageHead({
      crumbs: crumbs([{ label: 'Clients', href: '#/clients' }, { label: c.name }]),
      title: `${cdot(c.color)} ${esc(c.name)}`, status: c.archived_at ? chip('muted', 'Archived') : '',
      sub: `Account owner: ${c.owner_id ? esc(userName(c.owner_id)) : 'none, so admins give the first approval'}.`,
      actions: isAdmin() ? btn('Edit client', { action: 'client-edit', data: { id: c.id } }) + btn('Add project', { variant: 'primary', icon: 'Plus', action: 'project-new', data: { client: c.id }, disabled: !!c.archived_at }) : '',
    });
    return head + (ps.length ? projectTable(ps, false) : empty('Kanban View', 'No projects yet', 'A client can have several projects, like a retainer and one-off jobs.', isAdmin() ? btn('Add project', { variant: 'ink', icon: 'Plus', action: 'project-new', data: { client: c.id } }) : ''));
  }
}
function projectTable(ps, showClient) {
  return table([
    { label: 'Project', primary: true, wrap: true, render: p => { const c = client(p.client_id); return `<div class="row" style="gap:12px;flex-wrap:nowrap">${cdot(c.color)}<div class="client-cell"><a href="${href('project', p.id)}">${esc(p.name)}</a>${showClient ? `<span class="muted">${esc(c.name)}</span>` : ''}</div></div>`; } },
    { label: 'Status', render: projChip }, { label: 'Kind', render: p => kindText(p.kind) },
    { label: 'Open tasks', num: true, render: p => { const ts = projTasks(p.id).filter(t => !isDone(t)); const late = ts.filter(t => t.due_date < S.boot.settings.today).length; return `${ts.length}${late ? `<div class="state over" style="font-size:16px">${late} overdue</div>` : ''}`; } },
    { label: 'Logged of budget', num: true, render: p => { const ts = projTasks(p.id); return `${hours(ts.reduce((s, t) => s + t.logged_minutes, 0))} / ${hours(ts.reduce((s, t) => s + t.budget_minutes, 0))} h`; } },
    ...(showClient ? [{ label: 'Account owner', render: p => esc(userName(client(p.client_id).owner_id)) }] : []),
    ...(isAdmin() ? [{ label: '', render: p => btn('Edit', { size: 'sm', variant: 'ghost', action: 'project-edit', data: { id: p.id } }) }] : []),
  ], ps);
}

/* ---------- projects ---------- */
views.projects = {
  render() {
    const f = ui.pf || (ui.pf = { status: 'open', client: 'all' });
    const ps = S.boot.projects.filter(p => { const c = client(p.client_id); if (c.archived_at && f.status !== 'all') return false; if (f.status === 'open' && p.status === 'done') return false; if (f.client !== 'all' && p.client_id !== f.client) return false; return true; })
      .sort((a, b) => client(a.client_id).name.localeCompare(client(b.client_id).name) || a.name.localeCompare(b.name));
    const head = pageHead({ title: 'Projects', sub: 'Every project across clients. Open one to see and add its tasks.', actions: isAdmin() ? btn('Add project', { variant: 'primary', icon: 'Plus', action: 'project-new' }) : '' });
    const bar = `<div class="toolbar">${seg('pstatus', [['open', 'Not completed'], ['all', 'All, with archived clients']], f.status)}${selField('pf-client', [['all', 'All clients'], ...S.boot.clients.filter(c => !c.archived_at).map(c => [c.id, c.name])], f.client, { change: 'pf-client' })}<span class="muted">${ps.length} ${ps.length === 1 ? 'project' : 'projects'}</span></div>`;
    return head + bar + (ps.length ? projectTable(ps, true) : empty('Kanban View', 'No projects match', 'Change the filters.', ''));
  },
};
actions['seg:pstatus'] = a => { ui.pf.status = a.dataset.v; render(); };
changes['pf-client'] = el => { ui.pf.client = el.value; render(); };

/* project page: tasks as a list or board */
views.project = {
  render() {
    const p = project(route.parts[0]);
    if (!p) return pageHead({ title: 'Project not found' }) + empty('Kanban View', 'That project doesn’t exist', '', btn('All projects', { action: 'go', data: { href: '#/projects' } }));
    const c = client(p.client_id), view = ui.taskView || 'list', fa = ui.taskAssignee || 'all';
    const all = projTasks(p.id), ts = all.filter(t => fa === 'all' || t.assignee_id === fa);
    const logged = all.reduce((s, t) => s + t.logged_minutes, 0), budget = all.reduce((s, t) => s + t.budget_minutes, 0);
    const head = pageHead({
      crumbs: crumbs([{ label: 'Clients', href: '#/clients' }, { label: c.name, href: href('clients', c.id) }, { label: p.name }]),
      eyebrow: `${esc(c.name)} · ${kindText(p.kind)}`, title: esc(p.name), status: projChip(p),
      sub: `${all.filter(t => !isDone(t)).length} open tasks. ${hours(logged)} of ${hours(budget)} budgeted hours logged.`,
      actions: (isAdmin() ? btn('Edit project', { action: 'project-edit', data: { id: p.id } }) : '') + btn('Add task', { variant: 'primary', icon: 'Plus', action: 'task-new', data: { project: p.id }, disabled: !!c.archived_at }),
    });
    const bar = `<div class="toolbar">${seg('taskview', [['list', 'List'], ['board', 'Board']], view)}${selField('task-assignee', [['all', 'Everyone'], ...activeUsers().map(u => [u.id, u.name])], fa, { change: 'task-assignee', style: 'min-width:220px' })}</div>`;
    if (!all.length) return head + empty('Kanban View', 'No tasks yet', 'Break the work into tasks. Each one needs a service line, a time budget and a due date.', btn('Add task', { variant: 'ink', icon: 'Plus', action: 'task-new', data: { project: p.id }, disabled: !!c.archived_at }));
    if (view === 'board') return head + bar + board(ts);
    return head + bar + `<div class="tlist">${Object.entries(TSTATUS).map(([k, l]) => { const items = ts.filter(t => t.status === k); if (!items.length) return ''; return `<div class="tgroup" style="--g:${k === 'done' ? '#2B8A3E' : '#495057'}"><div class="tgroup-head"><b>${l}</b><span class="muted">${items.length}</span></div><div class="trows">${items.map(t => taskRow(t)).join('')}</div></div>`; }).join('')}</div>`;
  },
};
function board(ts) {
  return `<div class="board" role="list">${Object.entries(TSTATUS).map(([k, l]) => {
    const items = ts.filter(t => t.status === k);
    return `<section class="board-col" role="listitem" aria-label="${l}"><div class="board-col__head"><span>${l}</span><span class="fc-tabs__count">${items.length}</span>${k === 'done' ? `<span class="muted">${icon('Check Circle')}</span>` : ''}</div>
      <div class="board-col__body">${items.map(t => { const x = taskCtx(t.id), late = t.due_date < S.boot.settings.today && !isDone(t);
        return `<article class="fc-boardcard task-card${S.boot.timer && S.boot.timer.task_id === t.id ? ' is-running' : ''}" tabindex="0" data-action="task-open" data-id="${t.id}">
        <div class="fc-boardcard__top"><span class="svc-name small">${swatch(x.sl.color)}${esc(x.sl.name)}</span><span class="fc-chip fc-boardcard__due ${late ? 'fc-status--danger' : 'fc-status--neutral'}">${icon(late ? 'Alert' : 'Calendar')}${dshort(t.due_date)}</span></div>
        <div class="task-title">${esc(t.title)}${t.billable ? '' : ' <span class="nb-tag">Non-billable</span>'}</div>
        <div class="fc-boardcard__foot"><span class="fc-boardcard__stats">${budgetPill(t)}</span><span class="row" style="gap:6px">${timerButton(t, 'fc-btn fc-btn--ghost fc-iconbtn fc-iconbtn--sm')}${avatar(user(t.assignee_id), 28)}</span></div></article>`; }).join('') || '<div class="board-empty">No tasks</div>'}</div></section>`;
  }).join('')}</div>`;
}
actions['seg:taskview'] = a => { ui.taskView = a.dataset.v; render(); };
changes['task-assignee'] = el => { ui.taskAssignee = el.value; render(); };

/* ---------- client and project dialogs (admins) ---------- */
const owners = () => activeUsers().filter(u => u.role !== 'member');
modals['client'] = m => {
  const c = m.id ? client(m.id) : { name: '', owner_id: '', color: PALETTE[S.boot.clients.length % PALETTE.length] };
  return `<form data-form="client" novalidate>${dialog(m.id ? 'Edit client' : 'Add client', 'The account owner approves time logged for this client first. With no owner, admins approve.', `<div class="fields cols">
    ${field('Client name', inp('cname', c.name, { required: true, placeholder: 'For example, Northwind Coffee' }), { id: 'f-cname', cls: 'span' })}
    ${field('Account owner', sel('cowner', [['', 'No owner, admins approve'], ...owners().map(u => [u.id, `${u.name}, ${S.boot.roles[u.role]}`])], c.owner_id || ''), { id: 'f-cowner', select: true })}
    ${field('Color', `<input type="color" class="color-in" id="f-ccolor" name="ccolor" value="${esc(c.color)}">`, { id: 'f-ccolor' })}
    ${m.id ? `<div class="span">${toggleArchive(c)}</div>` : ''}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn(m.id ? 'Save client' : 'Add client', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
};
const toggleArchive = c => `<label class="inform-chip"><input type="checkbox" name="carchived"${c.archived_at ? ' checked' : ''}> <span>Archived. Its tasks stop taking new time; reports keep the history.</span></label>`;
actions['client-new'] = () => openModal({ type: 'client' });
actions['client-edit'] = a => openModal({ type: 'client', id: a.dataset.id });
forms['client'] = async f => {
  const fd = new FormData(f), m = ui.modal, body = { name: String(fd.get('cname') || '').trim(), ownerId: fd.get('cowner') || null, color: fd.get('ccolor') };
  if (!body.name) return alertPopup('Name the client', [['f-cname', 'Client name', 'How the client shows across the app.']]);
  if (m.id) { body.archived = !!fd.get('carchived'); await api(`/clients/${m.id}`, { method: 'PATCH', body }); }
  else { const r = await api('/clients', { method: 'POST', body }); closeModal(); await refresh(); go(href('clients', r.id)); toast('Client added', 'Add its first project next.'); return; }
  closeModal(); await refresh(); toast('Client saved');
};
modals['project'] = m => {
  const p = m.id ? project(m.id) : { name: '', client_id: m.clientId || '', kind: 'project', status: 'active' };
  return `<form data-form="project" novalidate>${dialog(m.id ? 'Edit project' : 'Add project', 'A client can have several projects. Tasks and time live on a project.', `<div class="fields cols">
    ${m.id ? '' : field('Client', sel('pclient', [['', 'Choose a client'], ...S.boot.clients.filter(c => !c.archived_at).map(c => [c.id, c.name])], p.client_id, { required: true }), { id: 'f-pclient', select: true, cls: 'span' })}
    ${field('Project name', inp('pname', p.name, { required: true, placeholder: 'For example, Retainer 2027' }), { id: 'f-pname', cls: 'span' })}
    ${field('Kind', sel('pkind', [['project', 'Project'], ['retainer', 'Retainer']], p.kind), { id: 'f-pkind', select: true, msg: 'Retainer hour accounting comes in a later milestone.' })}
    ${field('Status', sel('pstatus', Object.entries(PSTATUS).map(([k, v]) => [k, v[1]]), p.status), { id: 'f-pstatus', select: true })}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn(m.id ? 'Save project' : 'Add project', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
};
actions['project-new'] = a => openModal({ type: 'project', clientId: a.dataset.client || '' });
actions['project-edit'] = a => openModal({ type: 'project', id: a.dataset.id });
forms['project'] = async f => {
  const fd = new FormData(f), m = ui.modal, body = { name: String(fd.get('pname') || '').trim(), kind: fd.get('pkind'), status: fd.get('pstatus') };
  const miss = [];
  if (!m.id && !fd.get('pclient')) miss.push(['f-pclient', 'Client', 'Who the project is for.']);
  if (!body.name) miss.push(['f-pname', 'Project name', 'How the project shows across the app.']);
  if (miss.length) return alertPopup('Fill these in', miss);
  if (m.id) { await api(`/projects/${m.id}`, { method: 'PATCH', body }); closeModal(); await refresh(); toast('Project saved'); return; }
  const r = await api('/projects', { method: 'POST', body: { ...body, clientId: fd.get('pclient') } });
  closeModal(); await refresh(); go(href('project', r.id)); toast('Project added', 'Add tasks so people can track time on it.');
};
