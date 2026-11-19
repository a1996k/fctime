// Entry point: sign-in, boot, routing.
import { S, ui, api, loadBoot } from './store.js';
import { esc, btn, field, inp, icon } from './ui.js';
import { LOGO } from './icons.js';
import { installEvents, loadAndRender, inputs, renderModal } from './core.js';
import './views/tasks.js';
import './views/home.js';
import './views/time.js';
import './views/clients.js';
import './views/reports.js';
import './views/settings.js';

inputs['#f-pickq'] = t => {
  ui.modal.q = t.value; renderModal();
  const el = document.getElementById('f-pickq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length);
};

function loginScreen(err) {
  document.getElementById('modal-root').innerHTML = '';
  document.getElementById('app').innerHTML = `<div class="login">
    <form class="login-card fc-card stack-16" id="login-form" novalidate>
      <div class="login-brand">${LOGO}<span class="sb-app">Time tracker</span></div>
      <h1 class="h2">Sign in</h1>
      ${err ? `<div class="fc-alert fc-alert--danger" role="alert"><span class="fc-alert__icon">${icon('Alert')}</span><div class="fc-alert__body"><div class="fc-alert__text">${esc(err)}</div></div></div>` : ''}
      ${field('Email or username', inp('email', localStorage.getItem('fct-email') || '', { type: 'text', required: true, autocomplete: 'username' }), { id: 'f-email' })}
      ${field('Password', inp('password', '', { type: 'password', required: true, autocomplete: 'current-password' }), { id: 'f-password' })}
      ${btn('Sign in', { variant: 'primary', type: 'submit', size: 'lg' })}
    </form></div>`;
  const f = document.getElementById('login-form');
  (f.email.value ? f.password : f.email).focus();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const b = f.querySelector('button'); b.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { email: f.email.value.trim(), password: f.password.value } });
      localStorage.setItem('fct-email', f.email.value.trim());
      await start();
    } catch (ex) { loginScreen(ex.message); }
  });
}

async function start() {
  try { await loadBoot(); } catch (e) { if (e.status === 401) return loginScreen(); return loginScreen(e.message); }
  if (!location.hash) history.replaceState(null, '', '#/home');
  await loadAndRender();
}

installEvents();
window.addEventListener('hashchange', () => { if (S.boot) { ui.modal = null; loadAndRender(); } });
window.addEventListener('fct:signedout', () => loginScreen());
// Pick up a timer started or stopped in another tab when this one regains focus.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.boot || ui.modal) return;
  const prev = S.boot.timer && S.boot.timer.id;
  try { const { timer } = await api('/timer'); if ((timer && timer.id) !== prev) { await loadBoot(); loadAndRender(); } } catch { /* ignore */ }
});
start();
