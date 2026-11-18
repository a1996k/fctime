// Task rows, the task dialog, the timer picker, and asking for more time (wireframe round 6).
import { S, ui, api, me, isAdmin, user, userName, svc, client, project, taskCtx, isDone, isLocked, openForTime, dueBucket, activeUsers, activeServices, today, settings, canSetUp, canWorkOn } from '../store.js';
import { esc, icon, btn, iconBtn, chip, alertBox, field, inp, sel, textarea, toggle, dialog, avatar, swatch, cdot, dshort, dlabel, hours, fh, toast, alertPopup, TSTATUS, ESTATUS, stamp } from '../ui.js';
import { actions, forms, modals, openModal, closeModal, refresh, run, startTimer, renderModal, handleError } from '../core.js';
import { hm, parseDuration } from '../shared/time.js';

/** Logged-of-budget pill: warns at the alert percent, locks at 100%. */
export function budgetPill(t) {
  const lock = isLocked(t) && !isDone(t), warn = t.logged_minutes >= t.budget_minutes * (settings().budget_alert_pct / 100);
  return `<span class="tpill${lock ? ' is-lock' : warn ? ' is-warn' : ''}" title="Logged of time budget">${lock ? icon('Lock') : ''}${hours(t.logged_minutes)} / ${hours(t.budget_minutes)} h</span>`;
}
export function timerButton(t, cls = 'qb') {
  const tm = S.boot.timer;
  if (tm && tm.task_id === t.id) return `<button type="button" class="${cls} is-on" data-action="timer-stop" title="Stop timer" aria-label="Stop timer">${icon('Stop')}</button>`;
  const lock = isLocked(t), open = openForTime(t);
  return `<button type="button" class="${cls}" data-action="${lock ? 'more-time' : 'timer-go'}" data-id="${t.id}" title="${!open ? 'Done tasks can’t take time' : lock ? 'Over its time budget. Ask for more time' : 'Start timer'}" aria-label="Start timer on ${esc(t.title)}"${!open ? ' disabled' : ''}>${icon(lock ? 'Lock' : 'Play')}</button>`;
}

/** Wireframe taskRow(): check, title, quick actions, budget, due, assignee. */
export function taskRow(t, o = {}) {
  const x = taskCtx(t.id), done = isDone(t), b = dueBucket(t);
  const dueCls = done ? '' : b === 'past' ? 'is-past' : b === 'today' ? 'is-today' : '';
  return `<div class="trow${done ? ' is-done' : ''}" data-task="${t.id}">
    <button type="button" class="tcheck" data-action="task-done" data-id="${t.id}" aria-label="${done ? 'Reopen' : 'Mark done'}: ${esc(t.title)}" title="${!canWorkOn(t) ? 'Only the person responsible or a manager can change this' : done ? 'Reopen' : 'Mark done'}"${canWorkOn(t) ? '' : ' disabled'}>${done ? icon('Check') : ''}</button>
    <button type="button" class="ttitle" data-action="task-open" data-id="${t.id}"><span class="tname">${esc(t.title)}</span>${o.showProject ? `<span class="tproj">${cdot(x.c.color)}${esc(x.c.name)}, ${esc(x.p.name)}</span>` : `<span class="tproj"><span class="svc-name small">${swatch(x.sl.color)}${esc(x.sl.name)}</span>${o.showStatus ? ` <span class="muted">· ${TSTATUS[t.status]}</span>` : ''}</span>`}</button>
    <span class="tbar" role="toolbar" aria-label="Quick actions for ${esc(t.title)}">
      ${timerButton(t)}
      <button type="button" class="qb" data-action="task-open" data-id="${t.id}" title="Open details" aria-label="Open details">${icon('Field Text')}</button>
      <button type="button" class="qb" data-action="entry-new" data-task="${t.id}" title="Add time by hand" aria-label="Add time by hand"${openForTime(t) ? '' : ' disabled'}>${icon('Plus')}</button></span>
    <span class="tmeta">${t.billable ? '' : '<span class="nb-tag">Non-billable</span>'}${budgetPill(t)}
      <span class="tdue ${dueCls}">${dshort(t.due_date)}</span>
      <span class="tassign" title="${esc(userName(t.assignee_id))}">${avatar(user(t.assignee_id), 28)}</span></span>
  </div>`;
}

/* ---------- timer picker (wireframe timerPickDialog) ---------- */
export function openTasks() {
  return S.boot.tasks.filter(openForTime);
}
modals['timer-pick'] = m => {
  const q = (m.q || '').toLowerCase(), mine = [], rest = [];
  openTasks().forEach(t => {
    const x = taskCtx(t.id);
    if (q && !`${t.title} ${x.c.name} ${x.p.name}`.toLowerCase().includes(q)) return;
    (t.assignee_id === me().id ? mine : rest).push(x);
  });
  const item = x => `<button type="button" class="pick" data-action="${isLocked(x.t) ? 'more-time' : 'timer-go'}" data-id="${x.t.id}"><span class="pick__title">${swatch(x.sl.color)}${esc(x.t.title)}</span><span class="muted">${esc(x.c.name)}, ${esc(x.p.name)}. Due ${dshort(x.t.due_date)}. ${hours(x.t.logged_minutes)} of ${hours(x.t.budget_minutes)} h${isLocked(x.t) ? ', over budget' : ''}</span>${icon(isLocked(x.t) ? 'Lock' : 'Play')}</button>`;
  return dialog('Start a timer', 'Time always goes on a task, which sets the service line.', `<div class="fc-field"><div class="fc-field__box"><span class="fc-field__icon lead">${icon('Search')}</span><input class="fc-field__input with-lead" id="f-pickq" placeholder="Search tasks or clients" value="${esc(m.q || '')}" autocomplete="off"></div></div>
    <div class="pick-list">${mine.length ? `<div class="overline">Assigned to you</div>${mine.map(item).join('')}` : ''}${rest.length ? `<div class="overline">${mine.length ? 'Other open tasks' : 'Open tasks'}</div>${rest.slice(0, 40).map(item).join('')}` : ''}${!mine.length && !rest.length ? '<p class="muted">No open tasks match. Add a task on a project first.</p>' : ''}</div>`,
  btn('Cancel', { action: 'close-modal' }), 'md');
};
actions['timer-pick'] = () => openModal({ type: 'timer-pick', q: '' });

/* ---------- more time (wireframe moreTimeDialog / submitMoreTime) ---------- */
modals['more-time'] = m => {
  const x = taskCtx(m.id); if (!x) return '';
  const t = x.t, lock = isLocked(t);
  return `<form data-form="more-time" novalidate>${dialog(isAdmin() ? 'Add to the time budget' : 'Ask for more time', esc(t.title), `<p class="lead">${hm(t.logged_minutes)} logged against a ${hours(t.budget_minutes)} h budget.${lock ? ` The task is locked for time until ${isAdmin() ? 'you add hours' : 'an admin approves more'}.` : ''}</p>
    <div class="fields cols">${field('Extra hours', inp('mhours', '2', { required: true, placeholder: '2 or 1:30' }), { id: 'f-mhours', suffix: 'h' })}${field('Why', textarea('mwhy', '', { rows: 2, required: true, placeholder: 'What’s taking longer' }), { id: 'f-mwhy', cls: 'span' })}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn(isAdmin() ? 'Add hours' : 'Send request', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
};
actions['more-time'] = a => openModal({ type: 'more-time', id: a.dataset.id });
forms['more-time'] = async f => {
  const fd = new FormData(f), id = ui.modal.id, minutes = parseDuration(fd.get('mhours')), reason = String(fd.get('mwhy') || '').trim();
  const miss = [];
  if (!(minutes > 0)) miss.push(['f-mhours', 'Extra hours', 'How many more hours, like 2 or 1:30.']);
  if (!reason) miss.push(['f-mwhy', 'Why', 'What’s taking longer than planned.']);
  if (miss.length) return alertPopup('Fill these in to continue', miss);
  if (isAdmin()) {
    const r = await api(`/tasks/${id}/budget`, { method: 'POST', body: { minutes, reason } });
    closeModal(); await refresh();
    toast(`Added ${hm(minutes)}`, `The budget is now ${hours(r.budget)} h and the task is unlocked.`);
  } else {
    await api(`/tasks/${id}/hours-requests`, { method: 'POST', body: { minutes, reason } });
    closeModal(); await refresh();
    toast('Request sent', 'An admin approves it before more time can be added.');
  }
};

/* ---------- task dialog ---------- */
function projectOptions(sel0) {
  const groups = S.boot.clients.filter(c => !c.archived_at).map(c => ({ group: c.name, items: S.boot.projects.filter(p => p.client_id === c.id).map(p => [p.id, p.name]) })).filter(g => g.items.length);
  return [['', 'Choose a project'], ...groups];
}
modals['task'] = m => {
  const live = m.id ? S.idx.tasks[m.id] : null;
  const t = m.draft || (m.draft = live ? { ...live } : { title: '', project_id: m.projectId || '', service_line_id: (activeServices()[0] || {}).id, assignee_id: me().id, status: 'todo', budget: '', start_date: today(), due_date: '', billable: true, notes: '' });
  const x = live && taskCtx(live.id), lock = live && isLocked(live), timeInfo = m.time;
  const canDelete = live && (isAdmin() || live.created_by === me().id);
  // Admins and managers edit everything; the person responsible updates status and notes; others can look.
  const full = !live || canSetUp(), work = full || (live && canWorkOn(live)), ro = !full;
  const svcs = activeServices().concat(live && svc(live.service_line_id).archived_at ? [svc(live.service_line_id)] : []);
  const users = activeUsers().concat(live && user(live.assignee_id)?.archived_at ? [user(live.assignee_id)] : []);
  const head = (live ? `${cdot(x.c.color)}${esc(x.c.name)}, ${esc(x.p.name)}` : 'Every task needs a service line, a time budget and a due date.')
    + (live && !full ? `<br><span class="muted">${work ? 'You can update the status and notes. A manager changes the rest.' : 'Only admins, managers and the person responsible change this task.'}</span>` : '');
  const budgetCtl = live
    ? field('Time budget', inp('tbudget', fh(live.budget_minutes / 60), { disabled: !isAdmin(), placeholder: '4 or 1:30' }), { id: 'f-tbudget', suffix: 'h', msg: isAdmin() ? 'Admins can change it here. Changes are logged.' : 'Only admins change a budget. Ask for more time below.' })
    : field('Time budget', inp('tbudget', t.budget ?? '', { required: true, placeholder: '4 or 1:30' }), { id: 'f-tbudget', suffix: 'h', msg: 'Required. Time locks when it’s used up.' });
  const pct = live ? Math.min(100, (live.logged_minutes / live.budget_minutes) * 100) : 0;
  const tm = S.boot.timer;
  const timeSec = live ? `<section class="tsec"><div class="row between"><h3 class="h3">Time logged <span class="muted">${hm(live.logged_minutes)} of ${hours(live.budget_minutes)} h</span></h3>
      <div class="row">${tm && tm.task_id === live.id ? btn('Stop timer', { variant: 'primary', size: 'sm', icon: 'Stop', action: 'timer-stop' }) : btn('Start timer', { variant: 'ink', size: 'sm', icon: lock ? 'Lock' : 'Play', action: 'timer-go', data: { id: live.id }, disabled: lock || !openForTime(live) })}
      ${btn(isAdmin() ? 'Add hours' : 'Ask for more time', { size: 'sm', action: 'more-time', data: { id: live.id } })}</div></div>
      <span class="bar budget-bar${lock ? ' is-over' : pct >= settings().budget_alert_pct ? ' is-warn' : ''}" style="--svc:${x.sl.color}"><span style="width:${pct}%"></span></span>
      ${timeInfo ? `${timeInfo.entries.length ? `<div class="mini-log">${timeInfo.entries.slice(0, 8).map(e => `<div class="li"><span>${avatar(user(e.user_id), 24)} ${esc(e.user_name)}, ${dshort(e.date)}${e.note ? `: ${esc(e.note)}` : ''} <span class="muted">${ESTATUS[e.status][1]}</span></span><span class="num">${hm(e.minutes)}</span></div>`).join('')}</div>` : `<p class="muted">${live.logged_minutes ? 'Others have logged time here; you see your own entries.' : 'No time logged yet.'}</p>`}
        ${timeInfo.budgetLog.length ? `<div class="stack-8"><span class="overline">Budget changes</span>${timeInfo.budgetLog.map(b => `<div class="muted small">${b.minutes > 0 ? '+' : ''}${hm(Math.abs(b.minutes))}${b.minutes < 0 ? ' removed' : ''} by ${esc(b.actor_name)}, ${stamp(b.at)}: ${esc(b.reason)}</div>`).join('')}</div>` : ''}
        ${timeInfo.requests.filter(q => q.status === 'pending').map(q => `<div class="muted small">${icon('Clock')} ${esc(q.requested_by_name)} asked for ${hm(q.minutes)} more, waiting for an admin.</div>`).join('')}` : '<p class="muted">Loading time…</p>'}</section>` : '';
  const lockNote = lock ? alertBox('danger', 'Over its time budget', `${hm(live.logged_minutes)} logged against ${hours(live.budget_minutes)} h. Time can’t be added until ${isAdmin() ? 'you add hours' : 'an admin approves more'}.`, btn(isAdmin() ? 'Add hours' : 'Ask for more time', { size: 'sm', action: 'more-time', data: { id: live.id } })) : '';
  return `<form data-form="task" novalidate>${dialog(live ? 'Task' : 'New task', head, `<div class="stack-16">${lockNote}<div class="fields cols">
    ${field('Task', inp('ttitle', t.title, { required: true, placeholder: 'For example, Holiday social posts', disabled: ro }), { id: 'f-ttitle', cls: 'span' })}
    ${live ? '' : field('Project', sel('tproject', projectOptions(), t.project_id, { required: true }), { id: 'f-tproject', select: true, cls: 'span' })}
    ${field('Responsible', sel('tassignee', [['', 'Choose a person'], ...users.map(u => [u.id, u.name])], t.assignee_id || '', { disabled: ro }), { id: 'f-tassignee', select: true, msg: 'The primary owner.' })}
    ${field('Service line', sel('tsvc', svcs.map(s => [s.id, s.name]), t.service_line_id, { disabled: ro }), { id: 'f-tsvc', select: true, msg: live && full ? 'Changing it affects time not yet submitted; submitted time keeps its approver.' : '' })}
    ${field('Status', sel('tstatus', Object.entries(TSTATUS), t.status, { disabled: !work }), { id: 'f-tstatus', select: true })}
    ${budgetCtl}
    ${field('Starts', inp('tstart', t.start_date || '', { type: 'date', disabled: ro }), { id: 'f-tstart' })}
    ${field('Due', inp('tdue', t.due_date || '', { type: 'date', required: true, disabled: ro }), { id: 'f-tdue', msg: 'Required.' })}
    <div class="span">${toggle('tbill', 'Billable', t.billable !== false, 'Non-billable time is tracked and reported, but doesn’t count against the client’s hours. Submitted time keeps the setting it was submitted with.', { disabled: ro })}</div>
    ${field('Notes', textarea('tnotes', t.notes || '', { rows: 3, placeholder: 'Details, links, feedback', disabled: !work }), { id: 'f-tnotes', cls: 'span' })}</div>
    ${timeSec}</div>`,
  (canDelete ? `<button type="button" class="fc-btn fc-btn--danger fc-btn--md" data-action="task-delete" style="margin-right:auto"${live.logged_minutes ? ' disabled title="Tasks with logged time can’t be deleted. Move it to Done instead."' : ''}>${icon('Trash')}<span class="fc-btn__label">Delete</span></button>` : '')
  + btn(work ? 'Cancel' : 'Close', { action: 'close-modal' }) + (work ? btn(live ? 'Save task' : 'Add task', { variant: 'primary', type: 'submit' }) : ''), 'lg')}</form>`;
};
export async function openTask(id) {
  openModal({ type: 'task', id });
  try {
    const time = await api(`/tasks/${id}/time`);
    if (ui.modal && ui.modal.type === 'task' && ui.modal.id === id) { syncTaskDraft(); ui.modal.time = time; ui.modal.noFocus = true; renderModal(); }
  } catch (e) { handleError(e); }
}
function syncTaskDraft() {
  const f = document.querySelector('form[data-form="task"]'); if (!f || !ui.modal || !ui.modal.draft) return;
  const fd = new FormData(f), d = ui.modal.draft;
  // Disabled fields aren't in the form data; keep the draft's values for those.
  const pick = (k, name) => { if (fd.has(name)) d[k] = fd.get(name); };
  pick('title', 'ttitle'); pick('assignee_id', 'tassignee'); pick('service_line_id', 'tsvc'); pick('status', 'tstatus');
  pick('start_date', 'tstart'); pick('due_date', 'tdue'); pick('notes', 'tnotes'); pick('project_id', 'tproject'); pick('budget', 'tbudget');
  if (!f.elements.tbill.disabled) d.billable = f.elements.tbill.checked;
}
actions['task-open'] = a => openTask(a.dataset.id);
actions['task-new'] = a => openModal({ type: 'task', projectId: a.dataset.project || '' });
forms['task'] = async f => {
  const fd = new FormData(f), m = ui.modal, live = m.id ? S.idx.tasks[m.id] : null;
  if (live && !canSetUp()) {
    await api(`/tasks/${live.id}`, { method: 'PATCH', body: { status: fd.get('tstatus'), notes: fd.get('tnotes') || '' } });
    closeModal(); await refresh(); toast('Task saved'); return;
  }
  const body = {
    title: String(fd.get('ttitle') || '').trim(), assigneeId: fd.get('tassignee'), serviceLineId: fd.get('tsvc'), status: fd.get('tstatus'),
    startDate: fd.get('tstart') || null, dueDate: fd.get('tdue'), billable: f.elements.tbill.checked, notes: fd.get('tnotes') || '',
  };
  const miss = [];
  if (!body.title) miss.push(['f-ttitle', 'Task name', 'Give the task a name at the top of the window.']);
  if (!live && !fd.get('tproject')) miss.push(['f-tproject', 'Project', 'The project this work belongs to.']);
  if (!body.assigneeId) miss.push(['f-tassignee', 'Responsible', 'Who owns the task.']);
  const budgetRaw = fd.get('tbudget');
  if (budgetRaw !== null && (live ? isAdmin() : true)) {
    const bm = parseDuration(budgetRaw);
    if (!(bm > 0)) miss.push(['f-tbudget', 'Time budget', 'The hours this task should take, like 4 or 1:30. Time locks when it’s used up.']);
    else if (!live || bm !== live.budget_minutes) body.budgetMinutes = bm;
  }
  if (!body.dueDate) miss.push(['f-tdue', 'Due date', 'When it needs to be finished.']);
  if (miss.length) return alertPopup(live ? 'Fill these in to save the task' : 'Fill these in to create the task', miss);
  if (body.startDate && body.dueDate < body.startDate) return toast('The due date is before the start date', '', 'danger');
  if (live) await api(`/tasks/${live.id}`, { method: 'PATCH', body });
  else await api('/tasks', { method: 'POST', body: { ...body, projectId: fd.get('tproject') } });
  closeModal(); await refresh();
  toast(live ? 'Task saved' : 'Task added', live ? '' : `${esc(body.title)}. Start a timer on it from Home, the sidebar or the task.`);
};
actions['task-delete'] = a => run(a, async () => {
  const live = S.idx.tasks[ui.modal.id];
  if (!confirm(`Delete “${live.title}”? This can’t be undone.`)) return;
  await api(`/tasks/${live.id}`, { method: 'DELETE' });
  closeModal(); await refresh(); toast('Task deleted');
});
actions['task-done'] = a => run(a, async () => {
  const t = S.idx.tasks[a.dataset.id];
  const tm = S.boot.timer;
  if (!isDone(t) && tm && tm.task_id === t.id) return toast('Stop the timer first', 'This task has your timer running.', 'info');
  await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: isDone(t) ? 'todo' : 'done' } });
  await refresh();
  toast(isDone(t) ? 'Reopened' : 'Marked done', esc(t.title));
});
