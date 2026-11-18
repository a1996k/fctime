// Settings for admins: people and roles, service lines and managers, company defaults (wireframe viewSettings round 6).
import { S, ui, api, me, isAdmin, user, svc, activeUsers, activeServices } from '../store.js';
import { esc, icon, btn, chip, field, inp, sel, tabs, table, empty, dialog, avatar, toast, alertPopup, selField } from '../ui.js';
import { views, actions, forms, modals, changes, pageHead, openModal, closeModal, refresh, render, route, go, run } from '../core.js';
import { hm, parseDuration } from '../shared/time.js';

const ROLE_HELP = 'Admins manage setup and can approve any step. Managers and Account Executives see their clients and their team’s timesheets. Team Members log time and work on tasks. Whoever owns a client approves its time first; each service line’s manager approves second.';
const TZS = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC']; } })();

views.settings = {
  render() {
    if (!isAdmin()) return pageHead({ title: 'Admins only' }) + empty('Lock', 'This page is for admins', 'Ask an admin if something here needs changing.', btn('Go home', { action: 'go', data: { href: '#/home' } }));
    const tab = route.parts[0] || 'people';
    const head = pageHead({ title: 'Settings', sub: 'People and roles, service lines and their managers, and company defaults.' });
    const t = tabs('set', [['people', 'People'], ['services', 'Service lines'], ['general', 'Company defaults']], tab);
    if (tab === 'services') return head + t + services();
    if (tab === 'general') return head + t + general();
    return head + t + people();
  },
};
actions['tab:set'] = a => go(`#/settings/${a.dataset.v}`);

function people() {
  const rows = S.boot.users.slice().sort((a, b) => !!a.archived_at - !!b.archived_at || a.name.localeCompare(b.name));
  return `<section class="fc-card flush"><div class="card-head"><div><h2>People and roles</h2><p>${ROLE_HELP}</p></div>${btn('Add person', { variant: 'primary', icon: 'Plus', action: 'user-new' })}</div>
    ${table([
      { label: 'Person', primary: true, render: u => `<div class="row" style="gap:12px;flex-wrap:nowrap">${avatar(u, 40)}<div class="client-cell"><b>${esc(u.name)}${u.archived_at ? ` ${chip('muted', 'Archived')}` : ''}</b><span class="muted">${esc(u.email)}</span></div></div>` },
      { label: 'Role', render: u => esc(S.boot.roles[u.role]) },
      { label: 'Department', render: u => (u.dept_id ? esc(svc(u.dept_id).name) : '<span class="muted">None</span>') },
      { label: 'Hours a week', num: true, render: u => hm(u.capacity.reduce((a, b) => a + b, 0)) },
      { label: 'Approves', wrap: true, render: u => { const c = S.boot.clients.filter(x => x.owner_id === u.id && !x.archived_at).map(x => x.name), s = S.boot.serviceLines.filter(x => x.manager_id === u.id && !x.archived_at).map(x => x.name); return [c.length ? `Owner: ${esc(c.join(', '))}` : '', s.length ? `Manager: ${esc(s.join(', '))}` : ''].filter(Boolean).join('<br>') || '<span class="muted">—</span>'; } },
      { label: '', render: u => btn('Edit', { size: 'sm', variant: 'ghost', action: 'user-edit', data: { id: u.id } }) },
    ], rows)}</section>`;
}
modals['user'] = m => {
  const u = m.id ? user(m.id) : { name: '', email: '', role: 'member', dept_id: '', capacity: [480, 480, 480, 480, 480, 0, 0] };
  const self = m.id === me().id;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return `<form data-form="user" novalidate>${dialog(m.id ? 'Edit person' : 'Add person', m.id ? esc(u.email) : 'They sign in with this email and the password you set.', `<div class="fields cols">
    ${field('Name', inp('uname', u.name, { required: true }), { id: 'f-uname' })}
    ${field('Email', inp('uemail', u.email, { type: 'email', required: true, placeholder: 'name@fifthcolor.com' }), { id: 'f-uemail' })}
    ${field('Role', sel('urole', Object.entries(S.boot.roles), u.role, { disabled: self }), { id: 'f-urole', select: true, msg: self ? 'You can’t change your own role.' : '' })}
    ${field('Department', sel('udept', [['', 'No department'], ...activeServices().map(s => [s.id, s.name])], u.dept_id || ''), { id: 'f-udept', select: true, msg: 'Their department manager can see their timesheet.' })}
    ${field(m.id ? 'New password' : 'Password', inp('upass', '', { type: 'password', placeholder: m.id ? 'Leave blank to keep it' : 'At least 8 characters', autocomplete: 'new-password' }), { id: 'f-upass' })}
    <div class="span"><span class="fc-field__label">Capacity, hours per day</span><div class="cap-grid" style="margin-top:8px">${DAYS.map((d, i) => field(d, inp('ucap' + i, String((u.capacity[i] || 0) / 60), { type: 'number', min: 0, max: 24, step: 0.5 }), { id: 'f-ucap' + i })).join('')}</div></div>
    ${m.id && !self ? `<label class="inform-chip span"><input type="checkbox" name="uarchived"${u.archived_at ? ' checked' : ''}> <span>Archived. They can’t sign in; their time stays in reports.</span></label>` : ''}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn(m.id ? 'Save person' : 'Add person', { variant: 'primary', type: 'submit' }), 'md')}</form>`;
};
actions['user-new'] = () => openModal({ type: 'user' });
actions['user-edit'] = a => openModal({ type: 'user', id: a.dataset.id });
forms['user'] = async f => {
  const fd = new FormData(f), m = ui.modal;
  const body = { name: String(fd.get('uname') || '').trim(), email: String(fd.get('uemail') || '').trim(), deptId: fd.get('udept') || null, capacity: [0, 1, 2, 3, 4, 5, 6].map(i => Math.round((+fd.get('ucap' + i) || 0) * 60)) };
  if (fd.has('urole')) body.role = fd.get('urole');
  const pw = String(fd.get('upass') || '');
  const miss = [];
  if (!body.name) miss.push(['f-uname', 'Name', 'Their full name.']);
  if (!body.email) miss.push(['f-uemail', 'Email', 'They sign in with it.']);
  if (!m.id && pw.length < 8) miss.push(['f-upass', 'Password', 'At least 8 characters. They can be given a new one later.']);
  if (miss.length) return alertPopup('Fill these in', miss);
  if (pw) body.password = pw;
  if (m.id) { if (m.id !== me().id) body.archived = !!fd.get('uarchived'); await api(`/users/${m.id}`, { method: 'PATCH', body }); }
  else await api('/users', { method: 'POST', body });
  closeModal(); await refresh(); toast(m.id ? 'Person saved' : 'Person added');
};

function services() {
  return `<section class="fc-card flush"><div class="card-head"><div><h2>Service lines and departments</h2><p>Each service line is a department with its own rate, color and manager. The manager gives the second approval on time. With no manager, admins approve.</p></div>${btn('Add service line', { variant: 'primary', icon: 'Plus', action: 'svc-new' })}</div>
    ${table([
      { label: 'Service line', primary: true, render: s => `<span class="svc-name"><span class="swatch" style="--svc:${esc(s.color)}"></span>${esc(s.name)}</span>` },
      { label: 'Bill rate', num: true, render: s => `$${(+s.rate).toFixed(0)}/h` },
      { label: 'Department manager', render: s => (s.manager_id ? esc(user(s.manager_id)?.name || '') : '<span class="muted">Admins approve</span>') },
      { label: 'People', num: true, render: s => S.boot.users.filter(u => u.dept_id === s.id && !u.archived_at).length },
      { label: 'Status', render: s => (s.archived_at ? chip('muted', 'Archived') : chip('success', 'Active', 'Check Circle')) },
      { label: '', render: s => btn('Edit', { size: 'sm', variant: 'ghost', action: 'svc-edit', data: { id: s.id } }) },
    ], S.boot.serviceLines)}</section>`;
}
modals['svc'] = m => {
  const s = m.id ? svc(m.id) : { name: '', color: '#868E96', rate: 150, manager_id: '' };
  return `<form data-form="svc" novalidate>${dialog(m.id ? 'Edit service line' : 'Add service line', 'Tasks belong to a service line, so time counts against the right department.', `<div class="fields cols">
    ${field('Name', inp('sname', s.name, { required: true, placeholder: 'For example, Social' }), { id: 'f-sname' })}
    ${field('Bill rate', inp('srate', s.rate, { type: 'number', min: 0, step: 1 }), { id: 'f-srate', suffix: '/h' })}
    ${field('Department manager', sel('smgr', [['', 'Admins approve'], ...activeUsers().map(u => [u.id, u.name])], s.manager_id || ''), { id: 'f-smgr', select: true, msg: 'Gives the second approval on time in this service line.' })}
    ${field('Color', `<input type="color" class="color-in" id="f-scolor" name="scolor" value="${esc(s.color)}">`, { id: 'f-scolor' })}
    ${m.id ? `<label class="inform-chip span"><input type="checkbox" name="sarchived"${s.archived_at ? ' checked' : ''}> <span>Archived. New tasks can’t use it.</span></label>` : ''}</div>`,
  btn('Cancel', { action: 'close-modal' }) + btn(m.id ? 'Save service line' : 'Add service line', { variant: 'primary', type: 'submit' }), 'sm')}</form>`;
};
actions['svc-new'] = () => openModal({ type: 'svc' });
actions['svc-edit'] = a => openModal({ type: 'svc', id: a.dataset.id });
forms['svc'] = async f => {
  const fd = new FormData(f), m = ui.modal, body = { name: String(fd.get('sname') || '').trim(), rate: +fd.get('srate') || 0, managerId: fd.get('smgr') || null, color: fd.get('scolor') };
  if (!body.name) return alertPopup('Name the service line', [['f-sname', 'Name', 'For example, Creative or Development.']]);
  if (m.id) { body.archived = !!fd.get('sarchived'); await api(`/service-lines/${m.id}`, { method: 'PATCH', body }); }
  else await api('/service-lines', { method: 'POST', body });
  closeModal(); await refresh(); toast(m.id ? 'Service line saved' : 'Service line added');
};

function general() {
  const s = S.boot.settings;
  return `<form class="stack" data-form="settings">
    <section class="fc-card"><div class="card-head"><div><h2>Time tracking</h2><p>Rounding applies when a timer stops. Time added by hand is saved as entered.</p></div></div>
      <div class="fields cols">${field('Round timer entries up to', sel('rounding', [['0', 'No rounding'], ['6', '6 minutes'], ['15', '15 minutes']], String(s.rounding_minutes)), { id: 'f-rounding', select: true })}
      ${field('Time budget alert at', inp('alert', s.budget_alert_pct, { type: 'number', min: 10, max: 100, step: 5 }), { id: 'f-alert', suffix: '% used', msg: 'Task budgets turn amber here and lock at 100%.' })}</div></section>
    <section class="fc-card"><div class="card-head"><div><h2>Workspace time zone</h2><p>Sets “today”, the dates timers land on, and when weeks start (Monday). Changing it doesn’t move entries already saved.</p></div></div>
      <div class="fields cols">${field('Time zone', sel('tz', TZS.map(z => [z, z.replace(/_/g, ' ')]), s.time_zone), { id: 'f-tz', select: true, msg: `Today is ${s.today} in this time zone.` })}</div></section>
    <div class="row">${btn('Save defaults', { variant: 'primary', type: 'submit' })}</div></form>`;
}
forms['settings'] = async f => {
  const fd = new FormData(f);
  await api('/settings', { method: 'PATCH', body: { roundingMinutes: +fd.get('rounding'), budgetAlertPct: +fd.get('alert'), timeZone: fd.get('tz') } });
  await refresh(); toast('Defaults saved');
};
