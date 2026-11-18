// Router, shell (sidebar and page header), event delegation, and the timer shared by every screen.
import { S, ui, api, ApiError, loadBoot, me, isAdmin, roleName, taskCtx, now, uuid, svc } from './store.js';
import { esc, icon, btn, avatar, toast, alertPopup, dialog } from './ui.js';
import { LOGO } from './icons.js';
import { hm } from './shared/time.js';

export const views = {}, actions = {}, forms = {}, modals = {}, changes = {}, inputs = {};
export const route = { name: 'home', parts: [], query: {} };

/* ---------- routing: #/view/part?query ---------- */
export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  route.name = views[parts[0]] ? parts[0] : 'home';
  route.parts = parts.slice(1);
  route.query = Object.fromEntries(new URLSearchParams(qs || ''));
}
export const href = (...parts) => '#/' + parts.map(encodeURIComponent).join('/');
export function go(h) { if (location.hash === h) loadAndRender(); else location.hash = h; }
export function setQuery(q) {
  const qs = new URLSearchParams(Object.entries({ ...route.query, ...q }).filter(([, v]) => v != null && v !== '')).toString();
  const base = '#/' + [route.name, ...route.parts].map(encodeURIComponent).join('/');
  history.replaceState(null, '', base + (qs ? '?' + qs : ''));
  parseHash();
}

let loading = 0;
export async function loadAndRender() {
  parseHash();
  const v = views[route.name], ticket = ++loading;
  try {
    if (v.load) await v.load();
  } catch (e) { if (ticket === loading) handleError(e); }
  if (ticket === loading) render();
}
/** Reload server data (bootstrap and the current view) and redraw. */
export async function refresh() {
  await loadBoot();
  const v = views[route.name];
  if (v.load) await v.load();
  render();
}

/* ---------- rendering ---------- */
const rail = () => window.matchMedia('(max-width: 1023px)').matches || localStorage.getItem('fct-rail') === '1';
export function render() {
  if (!S.boot) return;
  const v = views[route.name];
  let body;
  try { body = v.render(); } catch (e) { console.error(e); body = pageHead({ title: 'Something went wrong' }) + `<p class="muted">${esc(e.message)}</p>`; }
  document.getElementById('app').innerHTML = `<div class="fc-shell">${sidebar()}<main class="fc-shell__main" id="main">${body}</main></div>`;
  renderModal();
}
export function renderModal() {
  const root = document.getElementById('modal-root');
  if (!ui.modal) { root.innerHTML = ''; return; }
  const m = modals[ui.modal.type];
  root.innerHTML = m ? m(ui.modal) : '';
  const f = root.querySelector('form[data-form]');
  const first = root.querySelector('[autofocus]') || (f && f.querySelector('input:not([type=checkbox]):not([type=hidden]):not([readonly]):not(:disabled),select,textarea'));
  if (first && !ui.modal.noFocus) first.focus();
}
export function openModal(m) { ui.modal = m; renderModal(); }
export function closeModal() { ui.modal = null; renderModal(); }

function navItems() {
  const c = S.boot.counts;
  return [
    { v: 'home', l: 'Home', ic: 'Dashboard', col: '#1C7ED6' },
    { v: 'clients', l: 'Clients', ic: 'Group', col: '#0C8599', c: S.boot.clients.filter(x => !x.archived_at).length },
    { v: 'projects', l: 'Projects', ic: 'Kanban View', col: '#2F9E44' },
    { v: 'reports', l: 'Time Reports', ic: 'Row Height', col: '#C2255C' },
    { v: 'time', l: 'Timesheets', ic: 'Clock', col: '#E03131', c: (c.approvals + (isAdmin() ? c.hoursRequests : 0)) || null },
  ];
}
function sidebar() {
  const isRail = rail(), forced = window.matchMedia('(max-width: 1023px)').matches;
  const active = it => route.name === it.v || (it.v === 'clients' && route.name === 'project');
  const items = navItems().map(it => {
    const a = active(it);
    return `<a href="${href(it.v)}" class="fc-nav fc-nav--dark${a ? ' is-active' : ''}${isRail ? ' is-rail' : ''}" style="--ic:${it.col}"${a ? ' aria-current="page"' : ''}${isRail ? ` title="${it.l}" aria-label="${it.l}"` : ''}>${icon(it.ic)}${isRail ? '' : `<span class="fc-nav__label">${it.l}</span>${it.c ? `<span class="fc-nav__count">${it.c}</span>` : ''}`}</a>`;
  }).join('');
  const tm = S.boot.timer, tx = tm && taskCtx(tm.task_id);
  const timer = isRail
    ? `<button type="button" class="nav-timer is-rail${tm ? ' is-on' : ''}" data-action="${tm ? 'timer-stop' : 'timer-pick'}" title="${tm ? 'Stop timer' : 'Start timer'}" aria-label="${tm ? 'Stop timer' : 'Start timer'}">${icon(tm ? 'Stop' : 'Clock')}</button>`
    : `<div class="nav-timer${tm ? ' is-on' : ''}"><button type="button" class="nav-timer__main" data-action="${tm ? 'task-open' : 'timer-pick'}"${tm ? ` data-id="${tm.task_id}"` : ''} title="${tm ? 'Open the task' : 'Start a timer'}">${icon('Clock', 20)}<span class="nav-timer__time num"${tm ? ` data-timer="${tm.started_ms}"` : ''}>${tm ? hmsSince(tm.started_ms) : '00:00<span>:00</span>'}</span></button>${tm ? `<button type="button" class="nav-timer__stop" data-action="timer-stop" aria-label="Stop timer" title="Stop timer">${icon('Stop')}</button>` : ''}${tx ? `<span class="nav-timer__task">${esc(tx.t.title)}, ${esc(tx.c.name)}</span>` : ''}</div>`;
  const collapse = forced ? '' : `<button type="button" class="nav-collapse" data-action="nav-collapse" aria-label="${isRail ? 'Expand menu' : 'Collapse menu'}" title="${isRail ? 'Expand menu' : 'Collapse menu'}">${icon(isRail ? 'Chevron Right' : 'Chevron Left')}</button>`;
  const gear = a => isAdmin() ? `<a href="${href('settings')}" class="${a}${route.name === 'settings' ? ' is-active' : ''}" aria-label="Settings" title="Settings">${icon('Grid View')}</a>` : '';
  const foot = isRail
    ? `<div class="fc-sidebar__foot nav-foot">${timer}${gear('fc-nav fc-nav--dark is-rail')}${collapse}</div>`
    : `<div class="fc-sidebar__foot nav-foot">${timer}<div class="nav-me">${avatar(me(), 32)}<span class="client-cell"><b>${esc(me().name)}</b><span>${roleName(me().role)}</span></span>${gear('nav-gear')}</div></div>`;
  return `<nav class="fc-sidebar app-nav${isRail ? ' is-rail' : ''}" aria-label="Main">
    ${isRail ? '<span class="rail-mark" title="FifthColor Time">FC</span>' : `<div class="sb-brand"><div class="row between" style="flex-wrap:nowrap">${LOGO}${collapse}</div><span class="sb-app">Time tracker</span></div>`}
    ${isRail ? `<a class="fc-sidebar__searchbtn" aria-label="Search clients" href="${href('clients')}">${icon('Search')}</a>` : `<div class="fc-sidebar__search">${icon('Search')}<input placeholder="Search clients" aria-label="Search clients" id="sb-search" value="${esc(ui.q || '')}" autocomplete="off"></div>`}
    <div class="nav-scroll"><div class="fc-sidebar__items">${items}</div></div>${foot}</nav>`;
}
export function pageHead(o) {
  return `<header class="fc-pagehead"><div class="fc-pagehead__bar">${o.crumbs || '<span></span>'}<div class="fc-pagehead__tools"><span class="who-me muted">${esc(me().name)}, ${roleName(me().role)}</span>${btn('Sign out', { size: 'sm', variant: 'ghost', action: 'sign-out' })}</div></div>
  <div class="fc-pagehead__main"><div>${o.eyebrow ? `<div class="fc-pagehead__eyebrow">${o.eyebrow}</div>` : ''}<div class="fc-pagehead__titlerow"><h1 class="fc-pagehead__title">${o.title}</h1>${o.status || ''}</div>${o.sub ? `<p class="fc-pagehead__sub">${o.sub}</p>` : ''}</div>${o.actions ? `<div class="fc-pagehead__actions">${o.actions}</div>` : ''}</div></header>`;
}

/* ---------- errors ---------- */
export function handleError(e, o = {}) {
  if (!(e instanceof ApiError)) { console.error(e); toast('Something went wrong', esc(e.message), 'danger'); return; }
  if (e.status === 401) return;
  if (e.body && e.body.code === 'budget_locked' && !o.noBudgetDialog) {
    const b = e.body;
    toast(esc(e.message), `${hm(b.budget)} budget, ${hm(b.logged)} already logged. ${isAdmin() ? 'Add hours to the budget first.' : 'Ask an admin for more time first.'}`, 'danger');
    openModal({ type: 'more-time', id: b.taskId });
    return;
  }
  toast(esc(e.message), '', 'danger');
}
/** Run an async action with a busy button and error handling. */
export async function run(el, fn) {
  const b = el && el.closest && el.closest('button');
  if (b) { if (b.classList.contains('is-loading')) return; b.classList.add('is-loading'); b.disabled = true; }
  try { return await fn(); } catch (e) { handleError(e); } finally { if (b && b.isConnected) { b.classList.remove('is-loading'); b.disabled = false; } }
}

/* ---------- timer ---------- */
export function hmsSince(ms) {
  const s = Math.max(0, Math.floor((now() - ms) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(() => document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = hmsSince(+el.dataset.timer); }), 1000);

function overlapText(list) { return list.map(o => `${o.start} – ${o.end} on ${esc(o.task_title)}`).join('; '); }
export async function startTimer(taskId) {
  const x = taskCtx(taskId);
  const out = await api('/timer/start', { method: 'POST', body: { taskId, timerId: uuid() }, retries: 2 });
  ui.modal = null;
  await refresh();
  const prev = out.stopped ? `Stopped the last timer at ${hm(out.stopped.minutes)} and saved it as a draft. ` : '';
  toast('Timer started', `${prev}${esc(x ? x.t.title : '')}${x ? `, ${esc(x.c.name)}` : ''}.`);
}
/** Stop is safe to retry: the server returns the same entry for the same timer id. */
export async function stopTimer() {
  const tm = S.boot.timer; if (!tm) return;
  const out = await api('/timer/stop', { method: 'POST', body: { timerId: tm.id }, retries: 3 });
  await refresh();
  const e = out.entry, rounded = out.rawMinutes && out.minutes !== out.rawMinutes ? ` Rounded up from ${hm(out.rawMinutes)}.` : '';
  if (out.capped) toast('Timer ran over 24 hours', 'It was saved as 24:00. Fix the time on your timesheet before you submit.', 'warning', { label: 'View', action: 'go', data: { href: '#/time' } });
  else if (out.overlaps && out.overlaps.length) toast(`Logged ${hm(out.minutes)}. This overlaps another entry`, `${overlapText(out.overlaps)}. It was saved anyway.`, 'warning', { label: 'View', action: 'go', data: { href: '#/time' } });
  else toast(`Logged ${hm(out.minutes)}`, `${esc(e ? e.task_title : '')}.${rounded} Submit your week on Timesheets when it’s done.`, 'success', { label: 'View', action: 'go', data: { href: '#/time' } });
}
export { overlapText };

/* ---------- global events ---------- */
export function installEvents() {
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]');
    if (!a || a.disabled) return;
    const name = a.dataset.action;
    const fn = actions[name] || (name.startsWith('seg-') && actions['seg:' + name.slice(4)]) || (name.startsWith('tab-') && actions['tab:' + name.slice(4)]);
    if (!fn) return;
    if (a.tagName === 'A' || a.type !== 'checkbox') e.preventDefault();
    fn(a, e);
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('form[data-form]');
    if (!f || !forms[f.dataset.form]) return;
    e.preventDefault();
    const b = f.querySelector('button[type=submit]');
    run(b, () => forms[f.dataset.form](f, e.submitter));
  });
  document.addEventListener('change', e => {
    const t = e.target.closest('[data-change]');
    if (t && changes[t.dataset.change]) changes[t.dataset.change](t, e);
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'sb-search') { ui.q = t.value; clearTimeout(t._d); t._d = setTimeout(() => { if (route.name !== 'clients') go('#/clients'); else render(); setTimeout(() => { const s = document.getElementById('sb-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); }, 250); return; }
    for (const k in inputs) if (t.matches(k)) inputs[k](t, e);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ui.modal && !document.querySelector('.ap-ov')) { closeModal(); }
  });
  window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 150); });
}

actions['close-modal'] = () => closeModal();
actions['toast-x'] = a => { a.closest('.toast-wrap').innerHTML = ''; };
actions['go'] = a => go(a.dataset.href);
actions['nav-collapse'] = () => { localStorage.setItem('fct-rail', localStorage.getItem('fct-rail') === '1' ? '0' : '1'); render(); };
actions['sign-out'] = a => run(a, async () => { await api('/auth/logout', { method: 'POST', body: {} }); S.boot = null; location.hash = ''; window.dispatchEvent(new Event('fct:signedout')); });
actions['timer-stop'] = a => run(a, stopTimer);
actions['timer-go'] = a => run(a, () => startTimer(a.dataset.id));

export { svc, dialog, alertPopup };
