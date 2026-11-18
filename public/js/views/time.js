// Timesheets (wireframe viewTime round 7, calendarWeek, entryDialog round 11, timeApprovals).
import { S, ui, api, me, isAdmin, user, userName, taskCtx, thisWeek, today, teamPeople, hasApprovals, canSeeTimesheet, capacityMinutes, openForTime, isLocked } from '../store.js';
import { esc, icon, btn, iconBtn, chip, statusChip, alertBox, field, inp, sel, textarea, seg, tabs, table, empty, dialog, avatar, cdot, swatch, dshort, dlabel, wlabel, hours, toast, alertPopup, ESTATUS, DOW, to12, stamp, selField, dayOf } from '../ui.js';
import { views, actions, forms, modals, changes, inputs, pageHead, openModal, closeModal, refresh, render, renderModal, run, go, route, setQuery, overlapText, handleError } from '../core.js';
import { openTasks } from './tasks.js';
import { addDays, dow, weekStart, weekDays, hm, fromHM, toHM, parseDuration, isISODate } from '../shared/time.js';

const editable = e => e.user_id === me().id && (e.status === 'draft' || e.status === 'rejected');
const tab = () => route.parts[0] || 'mine';
const week = () => (isISODate(route.query.week) ? weekStart(route.query.week) : thisWeek());
const viewedUser = () => { const u = route.query.user && user(route.query.user); return u && canSeeTimesheet(u) ? u : me(); };

views.time = {
  async load() {
    const t = tab(), ws = week();
    if (t === 'mine') ui.data.entries = await api(`/entries?user=${viewedUser().id}&from=${ws}&to=${addDays(ws, 6)}`);
    if (t === 'team') ui.data.team = await api(`/team?weekStart=${ws}`);
    if (t === 'approvals') ui.data.approvals = await api('/approvals');
    if (t === 'hours') ui.data.requests = await api('/hours-requests');
  },
  render() {
    const c = S.boot.counts, list = [['mine', 'My timesheet']];
    if (teamPeople().length) list.push(['team', 'Team timesheets']);
    if (hasApprovals()) list.push(['approvals', 'Timesheet approvals', c.approvals || null]);
    list.push(['hours', 'Hours requests', (isAdmin() ? c.hoursRequests : 0) || null]);
    const t = list.some(x => x[0] === tab()) ? tab() : 'mine';
    const tabsHtml = tabs('time', list, t);
    if (t === 'approvals') return pageHead({ title: 'Timesheets', sub: 'Submitted time waiting for you as account owner or department manager.' }) + tabsHtml + approvalsView();
    if (t === 'hours') return pageHead({ title: 'Timesheets', sub: isAdmin() ? 'Requests for more hours on tasks that used their time budget.' : 'Your requests for more hours on tasks.' }) + tabsHtml + hoursView();
    if (t === 'team') return pageHead({ title: 'Timesheets', sub: 'Your team’s week. Open a person to see their days.' }) + tabsHtml + `<div class="toolbar">${weekNav()}</div>` + teamView();
    return mineView(tabsHtml);
  },
};
actions['tab:time'] = a => go(`#/time${a.dataset.v === 'mine' ? '' : '/' + a.dataset.v}${route.query.week ? `?week=${route.query.week}` : ''}`);

function weekNav() {
  const ws = week();
  return `<div class="month-nav">${iconBtn('Chevron Left', 'Previous week', { variant: 'secondary', action: 'tweek', data: { d: -7 } })}<span class="month-label">${wlabel(ws)}</span>${iconBtn('Chevron Right', 'Next week', { variant: 'secondary', action: 'tweek', data: { d: 7 } })}${ws !== thisWeek() ? btn('This week', { size: 'sm', variant: 'ghost', action: 'tweek-now' }) : ''}</div>`;
}
actions['tweek'] = a => { setQuery({ week: addDays(week(), +a.dataset.d) }); views.time.load().then(render).catch(handleError); };
actions['tweek-now'] = () => { setQuery({ week: null }); views.time.load().then(render).catch(handleError); };

/* ---------- my timesheet ---------- */
function mineView(tabsHtml) {
  const u = viewedUser(), own = u.id === me().id, ws = week(), es = ui.data.entries || [];
  const open = es.filter(e => e.status === 'draft' || e.status === 'rejected');
  const tot = es.reduce((s, e) => s + e.minutes, 0), cap = capacityMinutes(user(u.id) || u), view = ui.tsView || 'calendar';
  const head = pageHead({
    title: 'Timesheets',
    sub: own ? 'Your week of logged time. Add or fix entries until you submit, then it goes to the account owner and the department manager.' : `${esc(u.name)}’s week. Only they can change their entries.`,
    actions: own ? btn('Add time', { icon: 'Plus', action: 'entry-new', data: { date: ws <= today() && today() <= addDays(ws, 6) ? today() : ws } })
      + btn(open.length ? `Submit week (${open.length})` : es.length ? 'Week submitted' : 'Nothing to submit', { variant: 'primary', icon: 'Check', action: 'submit-week', disabled: !open.length }) : '',
  });
  const counts = Object.keys(ESTATUS).map(k => [k, es.filter(e => e.status === k).length]).filter(x => x[1]);
  const people = teamPeople();
  const bar = `<div class="toolbar">${weekNav()}${seg('tsview', [['calendar', 'Calendar'], ['list', 'List']], view)}
    ${people.length ? selField('time-user', [[me().id, me().name + ' (you)'], ...people.map(x => [x.id, x.name])], u.id, { change: 'time-user', style: 'min-width:220px' }) : ''}
    <span class="spacer"></span><span class="num"><b>${hm(tot)}</b> <span class="muted">of ${hm(cap)}</span></span>${counts.map(([k, n]) => chip(ESTATUS[k][0], `${n} ${ESTATUS[k][1].toLowerCase()}`)).join('')}</div>`;
  const rej = es.filter(e => e.status === 'rejected');
  const rejNote = rej.length ? alertBox('danger', `${rej.length} ${rej.length === 1 ? 'entry was' : 'entries were'} sent back`, rej.map(e => `${dshort(e.date)}, ${esc(e.task_title)}: ${esc(e.rejected_reason)} (${esc(e.rejected_by_name || '')})`).join('<br>') + (own ? '<br>Fix them, then submit the week again.' : '')) : '';
  return head + tabsHtml + bar + rejNote + (view === 'calendar' ? calendarWeek(u, ws, es, own) : listWeek(u, ws, es, own));
}
actions['seg:tsview'] = a => { ui.tsView = a.dataset.v; render(); };
changes['time-user'] = el => { setQuery({ user: el.value === me().id ? null : el.value }); views.time.load().then(render).catch(handleError); };

function trail(e) {
  const bits = [];
  if (e.ae_by_name) bits.push(`Account owner ${esc(e.ae_by_name)}, ${dshort(dayOf(e.ae_at))}`);
  if (e.dept_by_name) bits.push(`Manager ${esc(e.dept_by_name)}, ${dshort(dayOf(e.dept_at))}`);
  if (e.status === 'draft' && e.rejected_reason) bits.push(`Was sent back: ${esc(e.rejected_reason)}`);
  return bits.length ? `<span class="muted entry-trail">${bits.join(' · ')}</span>` : '';
}
function listWeek(u, ws, es, own) {
  const caps = (user(u.id) || u).capacity || [];
  return `<div class="week">${weekDays(ws).map(d => {
    const de = es.filter(e => e.date === d), dm = de.reduce((s, e) => s + e.minutes, 0), dc = caps[dow(d)] || 0;
    if (!de.length && !dc) return '';
    return `<section class="day${d === today() ? ' is-today' : ''}"><div class="day-head"><span><b>${DOW[dow(d)]}</b> ${dshort(d)}${d === today() ? ' <span class="fc-chip fc-status fc-status--info"><span>Today</span></span>' : ''}</span><span class="num">${hm(dm)}${dc ? ` <span class="muted">of ${hm(dc)}</span>` : ''}</span>${own ? iconBtn('Plus', `Add time on ${dshort(d)}`, { action: 'entry-new', data: { date: d } }) : ''}</div>
      ${de.map(e => `<div class="entry" style="--cc:${esc(e.client_color)}"><span class="entry-time num">${e.start ? `${e.start} – ${e.end}` : 'Added by hand'}</span><span class="entry-task"><span class="cdot"></span><span><b>${esc(e.task_title)}</b>${e.billable ? '' : ' <span class="nb-tag">Non-billable</span>'}<span class="muted">${esc(e.client_name)}, ${esc(e.project_name)}${e.note ? `. ${esc(e.note)}` : ''}</span>${trail(e)}</span></span>${statusChip(e.status)}<span class="entry-dur num">${hm(e.minutes)}</span>${editable(e) ? iconBtn('Edit', 'Edit entry', { action: 'entry-edit', data: { id: e.id } }) : iconBtn('Info', 'Entry details', { action: 'entry-info', data: { id: e.id } })}</div>`).join('') || '<p class="muted day-empty">No time logged.</p>'}</section>`;
  }).join('')}</div>`;
}

const PX = 52;
function calendarWeek(u, ws, es, own) {
  const caps = (user(u.id) || u).capacity || [];
  // 7 AM to 8 PM, stretched to fit any earlier or later entries this week.
  const timedAll = es.filter(e => e.start);
  const H0 = Math.min(7, ...timedAll.map(e => Math.floor(fromHM(e.start) / 60)));
  const H1 = Math.max(20, ...timedAll.map(e => Math.min(24, Math.ceil(Math.min(1440, fromHM(e.start) + e.minutes) / 60))));
  const cols = weekDays(ws).map(d => {
    const de = es.filter(e => e.date === d), dm = de.reduce((s, e) => s + e.minutes, 0);
    const timed = de.filter(e => e.start).map(e => ({ e, s: fromHM(e.start), m: e.minutes })), manual = de.filter(e => !e.start);
    const placed = [...timed]; let cursor = 9 * 60;
    manual.forEach(e => { while (placed.some(p => cursor < p.s + p.m && cursor + e.minutes > p.s)) cursor += 15; placed.push({ e, s: cursor, m: e.minutes }); cursor += e.minutes; });
    // Overlapping entries sit side by side in lanes so both stay visible and clickable.
    placed.sort((x, y) => x.s - y.s || y.m - x.m);
    const lanesEnd = [];
    placed.forEach(p => { let i = lanesEnd.findIndex(end => end <= p.s); if (i < 0) { i = lanesEnd.length; lanesEnd.push(0); } lanesEnd[i] = p.s + p.m; p.lane = i; });
    placed.forEach(p => { p.lanes = 1 + Math.max(...placed.filter(q => q.s < p.s + p.m && p.s < q.s + q.m).map(q => q.lane)); });
    const blocks = placed.map(({ e, s, m, lane, lanes }) => {
      const top = ((s - H0 * 60) / 60) * PX, h = Math.max(24, (Math.min(m, H1 * 60 - s) / 60) * PX - 2);
      const pos = lanes > 1 ? `left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px);right:auto;` : '';
      return `<button type="button" class="cal-ev st-${e.status}${h < 48 ? ' is-short' : ''}" style="--cc:${esc(e.client_color)};top:${top}px;height:${h}px;${pos}" data-action="${editable(e) ? 'entry-edit' : 'entry-info'}" data-id="${e.id}" title="${esc(e.task_title)}, ${hm(e.minutes)}${e.start ? `, ${e.start} – ${e.end}` : ''}, ${ESTATUS[e.status][1]}"><b>${esc(e.task_title)}</b><span>${esc(e.client_name)}</span><span>${hm(e.minutes)}${e.start ? '' : ' (by hand)'}</span></button>`;
    }).join('');
    return `<div class="cal-col${d === today() ? ' is-today' : ''}${!caps[dow(d)] ? ' is-off' : ''}"><div class="cal-day"><span>${DOW[dow(d)]} ${+d.slice(8, 10)}</span><b class="num">${hm(dm)}</b></div><div class="cal-body" style="height:${(H1 - H0) * PX}px" data-h0="${H0}" data-h1="${H1}"${own ? ` data-cal-date="${d}" title="Click and drag to add time"` : ''}>${blocks}</div></div>`;
  });
  const hoursCol = [...Array(H1 - H0)].map((_, i) => `<div class="cal-h" style="height:${PX}px">${((H0 + i + 11) % 12) + 1} ${H0 + i < 12 ? 'AM' : 'PM'}</div>`).join('');
  const legend = [...new Map(es.map(e => [e.client_id, e])).values()].map(e => `<span>${cdot(e.client_color)}${esc(e.client_name)}</span>`).join('');
  return `<section class="fc-card flush cal"><div class="cal-scroll"><div class="cal-grid"><div class="cal-hours"><div class="cal-day"></div>${hoursCol}</div>${cols.join('')}</div></div><div class="legend">${legend || '<span>No time this week.</span>'}<span>${own ? 'Drag on a day to add time. ' : ''}Entries added by hand are placed from 9 AM. Click one to ${own ? 'edit it' : 'see its details'}.</span></div></section>`;
}

/* drag on the calendar opens the form with the range filled in (wireframe round 11) */
let calDrag = null;
document.addEventListener('pointerdown', e => {
  const body = e.target.closest && e.target.closest('.cal-body[data-cal-date]');
  if (!body || e.target.closest('.cal-ev') || e.button !== 0) return;
  e.preventDefault();
  const r = body.getBoundingClientRect(), snap = v => Math.round(v / 15) * 15, H0 = +body.dataset.h0, H1 = +body.dataset.h1;
  const toMin = y => Math.max(H0 * 60, Math.min(H1 * 60, H0 * 60 + snap(((y - r.top) / PX) * 60)));
  const a = toMin(e.clientY), selEl = document.createElement('div'); selEl.className = 'cal-sel'; body.appendChild(selEl);
  calDrag = { body, a, b: a + 60, moved: false, toMin, sel: selEl, y0: e.clientY, H0 };
  drawSel();
  body.setPointerCapture && body.setPointerCapture(e.pointerId);
});
function drawSel() {
  const d = calDrag; if (!d) return;
  const lo = Math.min(d.a, d.b), hi = Math.max(d.a, d.b);
  d.sel.style.top = ((lo - d.H0 * 60) / 60) * PX + 'px'; d.sel.style.height = Math.max(12, ((hi - lo) / 60) * PX) + 'px';
  d.sel.innerHTML = `<b>${to12(lo)} – ${to12(hi)}</b><span>${hm(hi - lo)}</span>`;
}
document.addEventListener('pointermove', e => {
  const d = calDrag; if (!d) return;
  if (Math.abs(e.clientY - d.y0) > 4) d.moved = true;
  if (!d.moved) return;
  let b = d.toMin(e.clientY); if (b === d.a) b = d.a + 15; d.b = b; drawSel();
});
document.addEventListener('pointerup', () => {
  const d = calDrag; if (!d) return; calDrag = null;
  let lo = Math.min(d.a, d.b), hi = Math.max(d.a, d.b);
  if (!d.moved) { lo = d.a; hi = Math.min(24 * 60 - 15, d.a + 60); }
  setTimeout(() => d.sel.remove(), 150);
  openEntry({ date: d.body.dataset.calDate, start: toHM(lo), end: toHM(hi), mode: 'range' });
});

/* ---------- entry form: start and end, or a total ---------- */
function taskSelect(name, val) {
  const groups = new Map();
  const list = openTasks(); const cur = val && S.idx.tasks[val];
  if (cur && !list.includes(cur)) list.push(cur);
  list.forEach(t => { const x = taskCtx(t.id), k = `${x.c.name}, ${x.p.name}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([t.id, `${t.title} (${x.sl.name})${isLocked(t) && t.id !== val ? ', over budget' : ''}`]); });
  return sel(name, [['', 'Choose a task'], ...[...groups].map(([g, items]) => ({ group: g, items }))], val || '', { required: true });
}
modals['entry'] = m => {
  const e = m.entry || { task_id: m.taskId || (S.boot.timer || {}).task_id || '', date: m.date || today(), minutes: m.start && m.end ? fromHM(m.end) - fromHM(m.start) : 60, note: m.note || '', start: m.start || null, end: m.end || null };
  // Editing keeps the entry's own format; new entries remember the last one used.
  const mode = m.mode || (m.entry ? (e.start ? 'range' : 'total') : (ui.entryMode || 'range')); m.mode = mode;
  const st = m.vstart || e.start || '09:00', en = m.vend || e.end || toHM(Math.min(23 * 60 + 45, (fromHM(st) || 540) + (e.minutes || 60)));
  // Unchanged times on a saved entry show its stored minutes (timer rounding, or a timer that ran past midnight).
  const same = m.entry && m.entry.start && st === m.entry.start && en === m.entry.end;
  const dur = same ? m.entry.minutes : Math.max(0, (fromHM(en) || 0) - (fromHM(st) || 0));
  const sent = m.entry && m.entry.status === 'rejected' ? alertBox('danger', 'Sent back', `${esc(m.entry.rejected_reason)} (${esc(m.entry.rejected_by_name || '')}). Fix it, save, then submit the week again.`) : '';
  return `<form data-form="entry" novalidate>${dialog(m.entry ? 'Edit time' : 'Add time', 'Time goes on a task, which sets the service line and the hours it counts against.', `${sent}<div class="fields cols">
    ${field('Task', taskSelect('etask', m.vtask ?? e.task_id), { id: 'f-etask', select: true, cls: 'span' })}
    ${field('Date', inp('edate', m.vdate || e.date, { type: 'date', required: true }), { id: 'f-edate' })}
    <div class="span">${seg('emode', [['range', 'Start and end time'], ['total', 'Total time']], mode)}</div>
    ${mode === 'range' ? `${field('Start', inp('estart', st, { type: 'time', step: 300 }), { id: 'f-estart' })}${field('End', inp('eend', en, { type: 'time', step: 300 }), { id: 'f-eend' })}<div class="span ent-dur"><span class="muted">Duration</span> <b id="ent-dur">${dur > 0 ? hm(dur) : 'End must be after start'}</b></div><div class="span" id="ent-overlap" aria-live="polite">${m.overlapHtml || ''}</div>`
      : field('Total time', inp('edur', m.vdur || hm(e.minutes || 60), { placeholder: '1:30 or 1.5' }), { id: 'f-edur', msg: 'For time you didn’t clock: hours and minutes (1:30) or decimal hours (1.5).' })}
    ${field('Note', inp('enote', m.vnote ?? e.note, { placeholder: 'What you worked on' }), { id: 'f-enote', cls: 'span' })}</div>`,
  (m.entry ? `<button type="button" class="fc-btn fc-btn--danger fc-btn--md" data-action="entry-delete" style="margin-right:auto">${icon('Trash')}<span class="fc-btn__label">Delete</span></button>` : '')
  + btn('Cancel', { action: 'close-modal' }) + btn(m.entry ? 'Save' : 'Add time', { variant: 'primary', type: 'submit' }))}</form>`;
};
function keepEntryForm() {
  const f = document.querySelector('form[data-form="entry"]'); if (!f) return;
  const fd = new FormData(f), m = ui.modal;
  m.vtask = fd.get('etask'); m.vdate = fd.get('edate'); m.vnote = fd.get('enote');
  if (fd.has('estart')) { m.vstart = fd.get('estart'); m.vend = fd.get('eend'); }
  if (fd.has('edur')) m.vdur = fd.get('edur');
}
actions['seg:emode'] = a => { keepEntryForm(); ui.modal.mode = a.dataset.v; ui.entryMode = a.dataset.v; renderModal(); checkOverlap(); };
inputs['#f-estart, #f-eend, #f-edate'] = () => {
  const a = fromHM(document.getElementById('f-estart')?.value), b = fromHM(document.getElementById('f-eend')?.value), o = document.getElementById('ent-dur');
  const st = document.getElementById('f-estart')?.value, en = document.getElementById('f-eend')?.value, mm = ui.modal && ui.modal.entry;
  if (o) o.textContent = mm && mm.start && mm.start === st && mm.end === en ? hm(mm.minutes) : a != null && b != null && b > a ? hm(b - a) : 'End must be after start';
  clearTimeout(overlapTimer); overlapTimer = setTimeout(checkOverlap, 250);
};
/* Warn about overlaps while the form is open (the wireframe only warned after saving). */
let overlapTimer = null;
async function checkOverlap() {
  const m = ui.modal; if (!m || m.type !== 'entry') return;
  const date = document.getElementById('f-edate')?.value, start = document.getElementById('f-estart')?.value, end = document.getElementById('f-eend')?.value;
  const box = document.getElementById('ent-overlap');
  if (!box) return;
  if (!date || fromHM(start) == null || fromHM(end) == null || fromHM(end) <= fromHM(start)) { box.innerHTML = m.overlapHtml = ''; return; }
  try {
    const list = await api(`/entries/overlaps?date=${date}&start=${start}&end=${end}${m.entry ? `&exclude=${m.entry.id}` : ''}`);
    if (ui.modal !== m) return;
    m.overlapHtml = list.length ? alertBox('warning', 'This overlaps another entry', `${overlapText(list)}. You can still save it.`) : '';
    const el = document.getElementById('ent-overlap'); if (el) el.innerHTML = m.overlapHtml;
  } catch { /* the save will report problems */ }
}
function openEntry(m) { openModal({ type: 'entry', ...m }); checkOverlap(); }
actions['entry-new'] = a => openEntry({ date: a.dataset.date, taskId: a.dataset.task });
actions['entry-edit'] = a => { const e = (ui.data.entries || []).find(x => x.id === a.dataset.id); if (e) openEntry({ entry: e }); };
forms['entry'] = async f => {
  const fd = new FormData(f), m = ui.modal, mode = m.mode || 'range', miss = [];
  const body = { taskId: fd.get('etask'), date: fd.get('edate'), note: String(fd.get('enote') || '').trim() };
  if (!body.taskId) miss.push(['f-etask', 'Task', 'Pick the task the time goes on.']);
  if (!body.date) miss.push(['f-edate', 'Date', 'The day you did the work.']);
  if (mode === 'range') {
    const a = fromHM(fd.get('estart')), b = fromHM(fd.get('eend'));
    if (a == null) miss.push(['f-estart', 'Start', 'When you started.']);
    if (b == null) miss.push(['f-eend', 'End', 'When you stopped.']);
    const unchanged = m.entry && m.entry.start === fd.get('estart') && m.entry.end === fd.get('eend');
    if (a != null && b != null && b <= a && !unchanged) miss.push(['f-eend', 'End after start', 'The end time has to be later than the start time.']);
    body.start = fd.get('estart'); body.end = fd.get('eend');
  } else {
    const min = parseDuration(fd.get('edur'));
    if (!min || min < 1 || min > 1440) miss.push(['f-edur', 'Total time', 'Enter it as 1:30 or 1.5 hours.']);
    body.duration = fd.get('edur');
  }
  if (miss.length) return alertPopup(m.entry ? 'Fill these in to save the time' : 'Fill these in to add the time', miss);
  const out = m.entry ? await api(`/entries/${m.entry.id}`, { method: 'PATCH', body }) : await api('/entries', { method: 'POST', body });
  ui.entryMode = mode;
  closeModal();
  if (route.name === 'time' && tab() === 'mine') setQuery({ week: weekStart(body.date) === thisWeek() ? null : weekStart(body.date), user: null });
  await refresh();
  const e = out.entry, what = `${hm(e.minutes)}${e.start ? `, ${e.start} – ${e.end}` : ''}`;
  if (out.overlaps.length) toast(`${m.entry ? 'Saved' : 'Added'} ${what}. This overlaps another entry`, `${overlapText(out.overlaps)}. It was saved anyway.`, 'warning');
  else toast(m.entry ? 'Entry saved' : `Added ${what}`, m.entry && m.entry.status === 'rejected' ? 'Submit the week again when everything is fixed.' : '');
};
actions['entry-delete'] = a => run(a, async () => {
  if (!confirm('Delete this time entry?')) return;
  await api(`/entries/${ui.modal.entry.id}`, { method: 'DELETE' });
  closeModal(); await refresh(); toast('Entry deleted');
});

/* entry details with its audit trail */
modals['entry-info'] = m => {
  const e = m.entry;
  const hist = m.history ? m.history.map(h => `<li><b>${esc(h.actor_name)}</b> ${ACTION[h.action]?.(h) || esc(h.action)} <span class="muted">${stamp(h.at)}</span>${h.reason ? `<div class="muted">“${esc(h.reason)}”</div>` : ''}</li>`).join('') : '<li class="muted">Loading…</li>';
  return dialog('Time entry', `${esc(e.user_name)}, ${dlabel(e.date)}`, `<div class="stack-16">${table([{ label: 'Task', primary: true, wrap: true, render: () => `<div class="client-cell">${esc(e.task_title)}<span class="muted">${esc(e.client_name)}, ${esc(e.project_name)}</span></div>` }, { label: 'Time', num: true, render: () => `${hm(e.minutes)}${e.start ? `<div class="muted">${e.start} – ${e.end}</div>` : ''}` }, { label: 'Status', render: () => statusChip(e.status) }], [e], { dense: true })}
    ${e.note ? `<p>${esc(e.note)}</p>` : ''}<section class="stack-8"><span class="overline">History</span><ul class="hist">${hist}</ul></section></div>`, btn('Close', { action: 'close-modal' }), 'md');
};
const ACTION = {
  created: h => (h.detail && h.detail.source === 'timer' ? 'stopped the timer and saved this entry' : 'added this entry'),
  updated: () => 'edited it', deleted: () => 'deleted it', submitted: () => 'submitted it',
  approved: h => (h.step === 'ae' ? 'approved it as account owner' : h.detail && h.detail.auto ? 'approved it as department manager too' : 'approved it as department manager'),
  returned: h => `sent it back at the ${h.step === 'ae' ? 'account owner' : 'department manager'} step`,
  imported: h => `imported it from Paymo${h.detail && h.detail.status === 'approved' ? ' as approved' : ''}`,
};
actions['entry-info'] = async a => {
  const e = [...(ui.data.entries || []), ...((ui.data.approvals || []).flatMap(g => g.entries))].find(x => x.id === a.dataset.id);
  if (!e) return;
  openModal({ type: 'entry-info', entry: e });
  try { const h = await api(`/entries/${e.id}/history`); if (ui.modal && ui.modal.entry === e) { ui.modal.history = h; renderModal(); } } catch (err) { handleError(err); }
};

/* ---------- submit ---------- */
actions['submit-week'] = a => run(a, async () => {
  const ws = week();
  const out = await api('/timesheets/submit', { method: 'POST', body: { weekStart: ws } });
  await refresh();
  toast(`Week submitted, ${hm(out.minutes)}`, 'Account owners approve first, then department managers.');
});

/* ---------- team ---------- */
function teamView() {
  const ppl = ui.data.team || [], ws = week(), days = weekDays(ws);
  if (!ppl.length) return empty('Group', 'No team timesheets', 'You can see your own timesheet only.', '');
  return table([
    { label: 'Person', primary: true, wrap: true, render: u => `<span class="row" style="gap:10px;flex-wrap:nowrap">${avatar(u, 32)}<span class="client-cell"><a href="#/time?user=${u.id}&week=${ws}">${esc(u.name)}</a><span class="muted">${u.dept_id ? esc(S.idx.svc[u.dept_id]?.name || '') : S.boot.roles[u.role]}</span></span></span>` },
    ...days.map(d => ({ label: `${DOW[dow(d)]} ${+d.slice(8, 10)}`, num: true, render: u => { const m = u.days.filter(x => x.date === d).reduce((s, x) => s + x.minutes, 0); return m ? hm(m) : '<span class="muted">0:00</span>'; } })),
    { label: 'Total', num: true, render: u => `<b>${hm(u.days.reduce((s, x) => s + x.minutes, 0))}</b><div class="muted">of ${hm(capacityMinutes(u))}</div>` },
    { label: 'Status', wrap: true, render: u => { const n = s => u.days.filter(x => s.includes(x.status)).reduce((a, x) => a + x.n, 0); if (!u.days.length) return chip('muted', 'No time'); const d = n(['draft', 'rejected']), p = n(['submitted', 'ae-approved']); return d ? chip('warning', `${d} not submitted`) : p ? chip('info', `${p} waiting`) : chip('success', 'Approved', 'Check Circle'); } },
  ], ppl);
}

/* ---------- approvals ---------- */
function approvalsView() {
  const gs = ui.data.approvals || [];
  if (!gs.length) return empty('Check Circle', 'No time waiting for you', isAdmin() ? 'Submitted weeks show up here for the account owner, then the department manager.' : 'When someone submits time on your clients or in your department, it shows up here.');
  const card = g => {
    const sel = selected(g), part = sel.length < g.entries.length ? ` ${sel.length} of ${g.entries.length}` : '';
    return `<section class="fc-card appr" data-group="${esc(g.key)}"><div class="card-head"><div class="row" style="gap:12px">${avatar({ name: g.userName }, 40)}<div><h2>${esc(g.userName)}, ${hm(g.minutes)}</h2><p>${esc(g.scope)}. Week of ${wlabel(g.weekStart)}. ${g.step === 'ae' ? 'Step 1 of 2: account owner' : 'Step 2 of 2: department manager'}${isAdmin() ? ` <span class="muted">(${esc(g.approver)})</span>` : ''}</p></div></div>
    <div class="row">${btn(`Send back${part}`, { action: 'reject-time', data: { key: g.key }, disabled: !sel.length })}${btn(`Approve${part}`, { variant: 'ink', icon: 'Check', action: 'approve-time', data: { key: g.key }, disabled: !sel.length })}</div></div>
    ${table([{ label: '<span class="fc-sr">Include</span>', w: '44px', render: e => `<input type="checkbox" class="appr-ck" data-change="appr-ck" value="${e.id}" aria-label="Include ${esc(e.task_title)}, ${dshort(e.date)}"${ui.apprOff.has(e.id) ? '' : ' checked'}>` },
      { label: 'Date', render: e => `${DOW[dow(e.date)]} ${dshort(e.date)}` }, { label: 'Task', primary: true, wrap: true, render: e => `<div class="client-cell">${esc(e.task_title)}<span class="muted">${esc(e.client_name)}, ${esc(e.project_name)}</span></div>` },
      { label: 'Service line', render: e => `<span class="svc-name">${swatch(e.service_line_color)}${esc(e.service_line_name)}</span>` }, { label: 'Note', wrap: true, render: e => esc(e.note) },
      { label: 'How', render: e => (e.source === 'timer' ? 'Timer' : e.source === 'import' ? 'Imported' : 'Added by hand') + (e.ae_by_name ? `<div class="muted">Owner: ${esc(e.ae_by_name)}</div>` : '') }, { label: 'Billable', render: e => (e.billable ? 'Yes' : 'No') }, { label: 'Time', num: true, render: e => hm(e.minutes) }], g.entries, { dense: true })}</section>`;
  };
  const ae = gs.filter(g => g.step === 'ae'), dp = gs.filter(g => g.step === 'dept');
  return (ae.length ? `<section class="stack-16"><h3 class="h3">As account owner <span class="muted">${ae.length}</span></h3>${ae.map(card).join('')}</section>` : '')
    + (dp.length ? `<section class="stack-16"><h3 class="h3">As department manager <span class="muted">${dp.length}</span></h3>${dp.map(card).join('')}</section>` : '');
}
const group = key => (ui.data.approvals || []).find(g => g.key === key);
// Reviewers can leave entries out (ticked by default) and send back or approve only some of a week.
ui.apprOff = ui.apprOff || new Set();
const selected = g => g.entries.filter(e => !ui.apprOff.has(e.id));
changes['appr-ck'] = el => { if (el.checked) ui.apprOff.delete(el.value); else ui.apprOff.add(el.value); render(); };
/** The ids and the version of each entry the reviewer saw; the server refuses anything that changed since. */
const decision = g => { const es = selected(g); return { step: g.step, entryIds: es.map(e => e.id), versions: Object.fromEntries(es.map(e => [e.id, e.version])) }; };
actions['approve-time'] = a => run(a, async () => {
  const g = group(a.dataset.key); if (!g || !selected(g).length) return;
  const out = await api('/approvals/approve', { method: 'POST', body: decision(g) });
  await refresh();
  toast('Time approved', g.step === 'ae' && out.fullyApproved < out.count ? 'It moves on to the department manager.' : 'It now counts as approved.');
});
actions['reject-time'] = a => openModal({ type: 'reject', key: a.dataset.key });
modals['reject'] = m => {
  const g = group(m.key); if (!g) return '';
  const sel = selected(g), mins = sel.reduce((s, e) => s + e.minutes, 0);
  return `<form data-form="reject" novalidate>${dialog('Send time back', `${esc(g.userName)}: ${sel.length === g.entries.length ? 'the whole week' : `${sel.length} of ${g.entries.length} entries`}, ${hm(mins)}. ${esc(g.scope)}, week of ${wlabel(g.weekStart)}.`, `<div class="fields">${field('What needs fixing', textarea('rreason', '', { rows: 3, required: true, placeholder: 'For example, split the Tuesday entry between the two tasks' }), { id: 'f-rreason', msg: `${esc(g.userName.split(' ')[0])} sees this note on their timesheet.` })}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn('Send back', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
};
forms['reject'] = async f => {
  const reason = String(new FormData(f).get('rreason') || '').trim();
  if (!reason) return alertPopup('Add a reason', [['f-rreason', 'What needs fixing', 'They need to know what to change before they resubmit.']]);
  const g = group(ui.modal.key);
  await api('/approvals/return', { method: 'POST', body: { ...decision(g), reason } });
  closeModal(); await refresh();
  toast('Sent back', `${esc(g.userName)} will see your note and can fix the entries.`);
};

/* ---------- hours requests ---------- */
const QSTATUS = { pending: ['warning', 'Waiting'], approved: ['success', 'Approved'], declined: ['danger', 'Declined'] };
function hoursView() {
  const rows = ui.data.requests || [];
  if (!rows.length) return empty('Clock', 'No requests', isAdmin() ? 'When someone asks for more time on a task, it shows up here.' : 'When a task uses its time budget, ask for more time from the task.');
  const pend = rows.filter(q => q.status === 'pending'), done = rows.filter(q => q.status !== 'pending');
  const t = (list, act) => table([
    { label: 'Task', primary: true, wrap: true, render: q => `<div class="client-cell"><a href="#" data-action="task-open" data-id="${q.task_id}">${esc(q.task_title)}</a><span class="muted">${esc(q.client_name)}, ${esc(q.project_name)}</span></div>` },
    { label: 'Asked by', render: q => `${esc(q.requested_by_name)}<div class="muted">${stamp(q.created_at)}</div>` },
    { label: 'Extra', num: true, render: q => hm(q.minutes) },
    { label: 'Logged of budget', num: true, render: q => `${hours(q.logged_minutes)} / ${hours(q.budget_minutes)} h` },
    { label: 'Why', wrap: true, render: q => esc(q.reason) + (q.decision_note ? `<div class="muted">${esc(q.decided_by_name)}: ${esc(q.decision_note)}</div>` : '') },
    { label: 'Status', render: q => chip(QSTATUS[q.status][0], QSTATUS[q.status][1]) + (q.decided_by_name && !q.decision_note ? `<div class="muted">${esc(q.decided_by_name)}</div>` : '') },
    ...(act && isAdmin() ? [{ label: '', render: q => `<span class="row" style="flex-wrap:nowrap">${btn('Decline', { size: 'sm', action: 'hr-decline', data: { id: q.id } })}${btn('Approve', { size: 'sm', variant: 'ink', action: 'hr-approve', data: { id: q.id } })}</span>` }] : []),
  ], list, { dense: true });
  return `<section class="stack-16"><h3 class="h3">Waiting <span class="muted">${pend.length}</span></h3>${pend.length ? t(pend, true) : '<p class="muted">Nothing waiting.</p>'}</section>${done.length ? `<section class="stack-16"><h3 class="h3">Decided</h3>${t(done, false)}</section>` : ''}`;
}
actions['hr-approve'] = a => run(a, async () => { await api(`/hours-requests/${a.dataset.id}/approve`, { method: 'POST', body: {} }); await refresh(); toast('Request approved', 'The task’s budget went up and it’s unlocked.'); });
actions['hr-decline'] = a => openModal({ type: 'hr-decline', id: a.dataset.id });
modals['hr-decline'] = () => `<form data-form="hr-decline" novalidate>${dialog('Decline the request', 'They’ll see your note.', field('Why', textarea('hnote', '', { rows: 2, required: true }), { id: 'f-hnote' }), btn('Cancel', { action: 'close-modal' }) + btn('Decline', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
forms['hr-decline'] = async f => {
  const note = String(new FormData(f).get('hnote') || '').trim();
  if (!note) return alertPopup('Add a reason', [['f-hnote', 'Why', 'Say why the extra hours aren’t approved.']]);
  await api(`/hours-requests/${ui.modal.id}/decline`, { method: 'POST', body: { note } });
  closeModal(); await refresh(); toast('Request declined');
};
