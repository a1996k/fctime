// Component builders ported from the FifthColor Studio Manager wireframe so markup and classes match.
import { ICONS } from './icons.js';
import { addDays } from './shared/time.js';

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const ESTATUS = {
  draft: ['muted', 'Not submitted'], submitted: ['warning', 'Waiting for account owner'],
  'ae-approved': ['info', 'Waiting for department manager'], approved: ['success', 'Approved'], rejected: ['danger', 'Sent back'],
};
export const TSTATUS = { todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done' };
export const PSTATUS = { active: ['success', 'Active'], waiting: ['info', 'Waiting on client'], hold: ['warning', 'On hold'], done: ['muted', 'Completed'] };

export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fh(x) { const v = Math.round(x * 100) / 100; if (Math.abs(v) < 0.005) return '0'; return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''); }
export const hours = min => fh((min || 0) / 60);
export function dlabel(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; }
export const dshort = iso => { const [, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}`; };
export const wlabel = ws => `${dshort(ws)} – ${dlabel(addDays(ws, 6))}`;
// Timestamps show in the workspace time zone (set at sign-in), like every date in the app.
let TZ;
export const setTimeZone = tz => { TZ = tz; };
const fmt = (o, loc = 'en-US') => { try { return new Intl.DateTimeFormat(loc, { timeZone: TZ, ...o }); } catch { return new Intl.DateTimeFormat(loc, o); } };
/** 'YYYY-MM-DD' of an instant in the workspace time zone. */
export const dayOf = ts => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(new Date(ts));
export const clock = ts => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
export const stamp = ts => (ts ? `${dshort(dayOf(ts))}, ${clock(ts)}` : '');
export const to12 = m => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();

export function icon(name, size = 16) {
  const b = ICONS[name]; if (!b) return '';
  return `<svg class="fc-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">${b}</svg>`;
}
const dataAttrs = d => Object.entries(d || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
export function btn(label, o = {}) {
  const v = o.variant || 'secondary', s = o.size || 'md';
  return `<button type="${o.type || 'button'}" class="fc-btn fc-btn--${v} fc-btn--${s}${o.cls ? ' ' + o.cls : ''}"${o.action ? ` data-action="${o.action}"` : ''}${dataAttrs(o.data)}${o.disabled ? ' disabled' : ''}${o.title ? ` title="${esc(o.title)}"` : ''}${o.id ? ` id="${o.id}"` : ''}>${o.icon ? icon(o.icon, s === 'lg' ? 20 : 16) : ''}${label != null ? `<span class="fc-btn__label">${label}</span>` : ''}</button>`;
}
export function iconBtn(ic, label, o = {}) {
  return `<button type="button" class="fc-btn fc-btn--${o.variant || 'ghost'} fc-iconbtn fc-iconbtn--sm${o.cls ? ' ' + o.cls : ''}" aria-label="${esc(label)}" title="${esc(o.title || label)}"${o.action ? ` data-action="${o.action}"` : ''}${dataAttrs(o.data)}${o.disabled ? ' disabled' : ''}>${icon(ic)}</button>`;
}
/** An action that needs a role: stays visible, disabled with the reason. */
export function gated(label, allowed, reason, o = {}) { return btn(label, { ...o, disabled: !allowed || o.disabled, title: !allowed ? reason : (o.title || ''), icon: !allowed ? 'Lock' : o.icon }); }
export function chip(tone, text, ic, o = {}) { return `<span class="fc-chip fc-status fc-status--${tone}"${o.title ? ` title="${esc(o.title)}"` : ''}>${ic ? icon(ic) : '<span class="fc-chip__dot" aria-hidden="true"></span>'}<span>${text}</span></span>`; }
export const statusChip = s => chip(ESTATUS[s][0], ESTATUS[s][1], s === 'approved' ? 'Check Circle' : null);
export function alertBox(tone, title, text, action) {
  const ic = { info: 'Info', success: 'Check Circle', warning: 'Alert', danger: 'Alert' }[tone];
  return `<div class="fc-alert fc-alert--${tone}" role="${tone === 'danger' ? 'alert' : 'status'}"><span class="fc-alert__icon">${icon(ic)}</span><div class="fc-alert__body">${title ? `<div class="fc-alert__title">${title}</div>` : ''}${text ? `<div class="fc-alert__text">${text}</div>` : ''}${action ? `<div class="fc-alert__action">${action}</div>` : ''}</div></div>`;
}
export function field(label, control, o = {}) {
  const msg = o.error || o.msg;
  return `<div class="fc-field${o.error ? ' fc-field--error' : ''}${o.cls ? ' ' + o.cls : ''}"${o.attr ? ' ' + o.attr : ''}>${label ? `<label class="fc-field__label" for="${o.id || ''}">${label}</label>` : ''}<div class="fc-field__box">${control}${o.suffix ? `<span class="fc-field__suffix">${o.suffix}</span>` : ''}${o.select ? `<span class="fc-field__icon">${icon('Chevron Down')}</span>` : ''}${o.lock ? `<span class="fc-field__icon">${icon('Lock')}</span>` : ''}</div>${msg ? `<div class="fc-field__msg">${o.error ? icon('Alert') : ''}<span>${msg}</span></div>` : ''}</div>`;
}
export const inp = (name, val, o = {}) => `<input class="fc-field__input" id="f-${esc(name)}" name="${esc(name)}" type="${o.type || 'text'}" value="${esc(val ?? '')}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}${o.step ? ` step="${o.step}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.required ? ' required' : ''}${o.readonly ? ' readonly' : ''}${o.disabled ? ' disabled' : ''}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ''}${o.data ? dataAttrs(o.data) : ''}>`;
export const sel = (name, opts, val, o = {}) => `<select class="fc-field__input" id="f-${esc(name)}" name="${esc(name)}"${o.disabled ? ' disabled' : ''}${o.required ? ' required' : ''}${o.change ? ` data-change="${o.change}"` : ''}>${opts.map(op => op.group ? `<optgroup label="${esc(op.group)}">${op.items.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>` : `<option value="${esc(op[0])}"${String(op[0]) === String(val ?? '') ? ' selected' : ''}>${esc(op[1])}</option>`).join('')}</select>`;
export const selField = (name, opts, val, o = {}) => `<div class="fc-field"${o.style ? ` style="${o.style}"` : ''}><div class="fc-field__box">${sel(name, opts, val, o)}<span class="fc-field__icon">${icon('Chevron Down')}</span></div></div>`;
export const textarea = (name, val, o = {}) => `<textarea class="fc-field__input" id="f-${esc(name)}" name="${esc(name)}" rows="${o.rows || 3}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.required ? ' required' : ''}${o.disabled ? ' disabled' : ''}>${esc(val || '')}</textarea>`;
export function toggle(name, label, checked, desc, o = {}) {
  return `<div class="fc-toggle${o.disabled ? ' is-disabled' : ''}"><span class="fc-check__hit fc-toggle__hit"><input class="fc-toggle__input" type="checkbox" role="switch" id="f-${esc(name)}" name="${esc(name)}"${checked ? ' checked' : ''}${o.disabled ? ' disabled' : ''}${o.action ? ` data-action="${o.action}"` : ''}><span class="fc-toggle__track" aria-hidden="true"><span class="fc-toggle__knob">${icon('Check')}</span></span></span>${label != null ? `<label for="f-${esc(name)}" class="fc-check__text"><span class="fc-check__label">${label}</span>${desc ? `<span class="fc-check__desc">${desc}</span>` : ''}</label>` : ''}</div>`;
}
export function seg(name, opts, val) {
  return `<div class="fc-seg fc-seg--sm" role="radiogroup" aria-label="${esc(name)}">${opts.map(([v, l, c]) => `<button type="button" role="radio" aria-checked="${v === val}" class="fc-seg__opt${v === val ? ' is-on' : ''}" data-action="seg-${name}" data-v="${v}"><span>${l}</span>${c != null ? `<span class="seg-count">${c}</span>` : ''}</button>`).join('')}</div>`;
}
export function crumbs(items) {
  return `<nav class="fc-crumbs" aria-label="Breadcrumb"><ol>${items.map((it, i) => `<li>${i ? icon('Chevron Right') : ''}${i === items.length - 1 ? `<span aria-current="page" class="fc-crumbs__cur">${esc(it.label)}</span>` : `<a href="${it.href}">${esc(it.label)}</a>`}</li>`).join('')}</ol></nav>`;
}
export function tabs(name, list, cur) {
  return `<div class="fc-tabs" role="tablist">${list.map(([v, l, c]) => `<button type="button" role="tab" aria-selected="${v === cur}" class="fc-tabs__tab${v === cur ? ' is-on' : ''}" data-action="tab-${name}" data-v="${v}"><span>${l}</span>${c ? `<span class="fc-tabs__count">${c}</span>` : ''}</button>`).join('')}</div>`;
}
export function table(cols, rows, o = {}) {
  return `<div class="fc-table${o.dense ? ' fc-table--dense' : ''}"><div class="fc-table__scroll"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'is-num' : ''}"${c.w ? ` style="width:${c.w}"` : ''}>${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="${r._cls || ''}">${cols.map(c => { const v = c.render ? c.render(r) : r[c.key]; return `<td class="${c.num ? 'is-num' : ''}${c.primary ? ' is-primary' : ''}${c.wrap ? ' wrap' : ''}">${v == null || v === '' ? '<span class="fc-table__empty">—</span>' : v}</td>`; }).join('')}</tr>`).join('')}</tbody>${o.foot ? `<tfoot>${o.foot}</tfoot>` : ''}</table></div>${o.footer ? `<div class="fc-table__foot">${o.footer}</div>` : ''}</div>`;
}
export function empty(ic, title, text, action) { return `<div class="fc-card fc-empty stack-16"><span class="fc-empty__icon">${icon(ic, 20)}</span><h3 class="h3">${title}</h3>${text ? `<p class="muted">${text}</p>` : ''}${action || ''}</div>`; }
export function dialog(title, sub, body, foot, size) {
  return `<div class="fc-overlay"><div class="fc-scrim" data-action="close-modal"></div><div class="fc-dialog fc-dialog--${size || 'md'}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="fc-dialog__head"><div><h2 class="fc-dialog__title">${title}</h2>${sub ? `<div class="fc-dialog__sub">${sub}</div>` : ''}</div><button type="button" class="fc-btn fc-btn--soft fc-iconbtn fc-iconbtn--sm fc-round40" aria-label="Close" title="Close" data-action="close-modal">${icon('X')}</button></div><div class="fc-dialog__body">${body}</div><div class="fc-dialog__foot">${foot}</div></div></div>`;
}
export const swatch = color => `<span class="swatch" style="--svc:${esc(color || '#868E96')}"></span>`;
export const cdot = color => `<span class="cdot" style="background:${esc(color || '#868E96')}"></span>`;
export function avatar(user, size = 28) {
  if (!user) return `<span class="fc-avatar avatar-empty" style="width:${size}px;height:${size}px" title="Unassigned" role="img" aria-label="Unassigned">${icon('User')}</span>`;
  return `<span class="fc-avatar" style="width:${size}px;height:${size}px;font-size:${size <= 28 ? 13 : 16}px" title="${esc(user.name)}" role="img" aria-label="${esc(user.name)}">${initials(user.name)}</span>`;
}

let toastT = null;
export function toast(title, text, tone, action) {
  let w = document.querySelector('.toast-wrap');
  if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
  const ic = tone === 'danger' ? 'X Circle' : tone === 'info' || tone === 'warning' ? 'Info' : 'Check Circle';
  w.innerHTML = `<div class="fc-toast" role="${tone === 'danger' ? 'alert' : 'status'}"><span class="fc-toast__icon is-${tone || 'success'}">${icon(ic)}</span><div class="fc-toast__body"><div class="fc-toast__title">${title}</div>${text ? `<div class="fc-toast__text">${text}</div>` : ''}</div>${action ? `<button type="button" class="fc-toast__action" data-action="${action.action}"${dataAttrs(action.data)}>${action.label}</button>` : ''}<button type="button" class="fc-toast__x" aria-label="Dismiss" data-action="toast-x">${icon('X')}</button></div>`;
  clearTimeout(toastT);
  toastT = setTimeout(() => { w.innerHTML = ''; }, action || tone === 'warning' ? 7000 : 4000);
}
/** Wireframe alertPopup: list the missing fields, then focus the first. */
export function alertPopup(title, items) {
  document.querySelectorAll('.ap-ov').forEach(x => x.remove());
  const el = document.createElement('div'); el.className = 'ap-ov';
  el.innerHTML = `<div class="ap-scrim"></div><div class="ap-box" role="alertdialog" aria-modal="true" aria-labelledby="ap-t"><div class="ap-head">${icon('Alert', 20)}<h2 id="ap-t">${esc(title)}</h2></div>
    <ul class="ap-list">${items.map(([, l, d]) => `<li><b>${esc(l)}</b><span class="muted">${esc(d)}</span></li>`).join('')}</ul><div class="ap-foot">${btn('OK, fill them in', { variant: 'primary', cls: 'ap-ok' })}</div></div>`;
  document.body.appendChild(el);
  const close = () => {
    el.remove();
    items.forEach(([id]) => { const x = document.getElementById(id); if (x) x.classList.add('needs-fill'); });
    const f = items[0] && document.getElementById(items[0][0]); if (f) f.focus();
  };
  el.querySelector('.ap-ok').addEventListener('click', e => { e.stopPropagation(); close(); });
  el.querySelector('.ap-scrim').addEventListener('click', close);
  el.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } });
  el.querySelector('.ap-ok').focus();
}
