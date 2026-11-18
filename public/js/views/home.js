// Home (wireframe viewMyWork + homeTaskSection): timer, this week, and tasks grouped by due date.
import { S, ui, api, me, roleName, svc, taskCtx, isDone, dueBucket, thisWeek, today, activeServices, activeUsers, user, capacityMinutes } from '../store.js';
import { esc, btn, seg, selField, empty, wlabel } from '../ui.js';
import { views, actions, changes, pageHead, hmsSince, render } from '../core.js';
import { taskRow } from './tasks.js';
import { addDays, hm } from '../shared/time.js';

const BUCKETS = [['past', 'Past due', '#E03131'], ['today', 'Today', '#E67700'], ['week', 'This week', '#1971C2'], ['later', 'Later', '#495057'], ['none', 'No due date', '#868E96']];
const filters = () => ui.hf || (ui.hf = { scope: 'mine', client: 'all', person: 'all', svc: 'all', due: 'all', status: 'open' });

function homeTasks() {
  const f = filters();
  return S.boot.tasks.filter(t => {
    const x = taskCtx(t.id); if (!x || !x.c || x.c.archived_at) return false;
    const done = isDone(t);
    if ((f.status === 'open' && done) || (f.status === 'done' && !done)) return false;
    if (f.scope === 'mine' && t.assignee_id !== me().id) return false;
    if (f.scope === 'all' && f.person !== 'all' && t.assignee_id !== f.person) return false;
    if (f.client !== 'all' && x.c.id !== f.client) return false;
    if (f.svc !== 'all' && t.service_line_id !== f.svc) return false;
    if (f.due !== 'all' && dueBucket(t) !== f.due) return false;
    return true;
  });
}

views.home = {
  async load() {
    const ws = thisWeek();
    ui.data.homeEntries = await api(`/entries?from=${ws}&to=${addDays(ws, 6)}`);
  },
  render() {
    const u = me(), ws = thisWeek(), mine = ui.data.homeEntries || [];
    const cap = capacityMinutes(user(u.id) || u), logged = mine.reduce((s, e) => s + e.minutes, 0), bill = mine.filter(e => e.billable).reduce((s, e) => s + e.minutes, 0);
    const drafts = mine.filter(e => e.status === 'draft' || e.status === 'rejected').length, sent = mine.filter(e => e.status === 'rejected').length;
    const tm = S.boot.timer, tx = tm && taskCtx(tm.task_id);
    const pastDue = S.boot.tasks.filter(t => t.assignee_id === u.id && !isDone(t) && dueBucket(t) === 'past').length;
    const head = pageHead({ title: 'Home', sub: `${esc(u.name)}, ${roleName(u.role)}${u.dept_id ? `, ${esc(svc(u.dept_id).name)}` : ''}. Week of ${wlabel(ws)}.` });
    const timerCard = `<section class="fc-card timer-card">${tm && tx ? `<div><span class="overline">Timer running</span><div class="big-timer num" data-timer="${tm.started_ms}">${hmsSince(tm.started_ms)}</div><p>${esc(tx.t.title)} <span class="muted">${esc(tx.c.name)}, ${esc(tx.p.name)}</span></p></div>${btn('Stop timer', { variant: 'primary', icon: 'Stop', action: 'timer-stop', size: 'lg' })}`
      : `<div><span class="overline">No timer running</span><p class="muted" style="margin-top:4px">Pick a task to start tracking.</p></div>${btn('Start timer', { variant: 'ink', icon: 'Play', action: 'timer-pick', size: 'lg' })}`}</section>`;
    const tiles = `<div class="grid-4">
      <div class="fc-card fc-kpi kpi-c" style="--k:#7048E8"><span class="fc-kpi__label">Logged this week</span><span class="fc-kpi__value">${hm(logged)}</span><span class="bar" style="--svc:#7048E8;margin-top:8px"><span style="width:${cap ? Math.min(100, logged / cap * 100) : 0}%"></span></span><span class="muted">of ${hm(cap)} capacity</span></div>
      <div class="fc-card fc-kpi kpi-c" style="--k:#2B8A3E"><span class="fc-kpi__label">Billable this week</span><span class="fc-kpi__value">${hm(bill)}</span><span class="muted">${hm(logged - bill)} non-billable</span></div>
      <div class="fc-card fc-kpi kpi-c" style="--k:#E03131"><span class="fc-kpi__label">Past due</span><span class="fc-kpi__value">${pastDue}</span><span class="muted">Tasks you’re responsible for</span></div>
      <div class="fc-card fc-kpi kpi-c" style="--k:#E67700"><span class="fc-kpi__label">Timesheet</span><span class="fc-kpi__value">${drafts || 'Done'}</span><span class="muted">${drafts ? `${drafts === 1 ? 'entry' : 'entries'} to submit${sent ? `, ${sent} sent back` : ''}` : 'Nothing to submit'}</span>${btn('Open timesheet', { size: 'sm', action: 'go', data: { href: '#/time' } })}</div></div>`;
    return head + timerCard + tiles + taskSection();
  },
};

function taskSection() {
  const f = filters(), list = homeTasks();
  const bar = `<div class="toolbar">${seg('hscope', [['mine', 'My tasks'], ['all', 'All tasks']], f.scope)}
    ${f.scope === 'all' ? selField('hf-person', [['all', 'Anyone'], ...activeUsers().map(u => [u.id, u.name])], f.person, { change: 'hf' }) : ''}
    ${selField('hf-client', [['all', 'All clients'], ...S.boot.clients.filter(c => !c.archived_at).map(c => [c.id, c.name])], f.client, { change: 'hf' })}
    ${selField('hf-svc', [['all', 'All service lines'], ...activeServices().map(s => [s.id, s.name])], f.svc, { change: 'hf' })}
    ${selField('hf-due', [['all', 'Any due date'], ...BUCKETS.map(b => [b[0], b[1]])], f.due, { change: 'hf' })}
    ${selField('hf-status', [['open', 'Open'], ['done', 'Done'], ['all', 'Open and done']], f.status, { change: 'hf' })}
    <span class="spacer"></span>${btn('Add task', { variant: 'ink', icon: 'Plus', action: 'task-new' })}</div>`;
  const groups = BUCKETS.map(([k, l, col]) => {
    const g = list.filter(t => dueBucket(t) === k).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    if (!g.length) return '';
    return `<div class="tgroup" style="--g:${col}"><div class="tgroup-head"><b>${l}</b><span class="muted">${g.length}</span></div><div class="trows">${g.map(t => taskRow(t, { showProject: true })).join('')}</div></div>`;
  }).join('');
  return `<section class="stack-16"><h2 class="h2">Tasks</h2>${bar}${list.length ? `<div class="tlist">${groups}</div>` : empty('Check Circle', f.scope === 'mine' && f.status === 'open' ? 'Nothing assigned to you' : 'No tasks match', 'Change the filters, or add a task.', '')}</section>`;
}

actions['seg:hscope'] = a => { filters().scope = a.dataset.v; render(); };
changes['hf'] = el => { filters()[el.name.slice(3)] = el.value; render(); };
