import { api } from './api.js';
import { h } from './ui.js';
import { brand } from './shell.js';

export function renderLogin(root, onSuccess, notice = '') {
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  const username = h('input', { class: 'input', id: 'u', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { class: 'input', id: 'p', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' }, notice);
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Masuk');
  const form = h('form', { class: 'login__form' },
    h('h2', null, 'Masuk'),
    h('p', { class: 'muted' }, 'Gunakan akun yang didaftarkan admin.'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), username),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), password),
    error, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Memeriksa…';
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { username: username.value.trim(), password: password.value } });
      onSuccess(user);
    } catch (ex) {
      error.textContent = ex.message;
      password.value = '';
      password.focus();
      submit.disabled = false;
      submit.textContent = 'Masuk';
    }
  });

  const on = new Set([1, 2, 6, 8]);
  const tiles = h('div', { class: 'tiles', 'aria-hidden': 'true' }, Array.from({ length: 10 }, (_, i) => h('div', { class: `tile${on.has(i) ? ' is-on' : ''}` })));
  root.replaceChildren(h('div', { class: 'login' },
    h('section', { class: 'login__brand' },
      h('div', { class: 'brand' }, h('span', { class: 'brand__name' }, 'acesio'), h('span', { class: 'brand__sub' }, 'Physiotherapy Rehab & Sport Recovery Rehab')),
      h('div', null,
        h('h1', null, 'Layanan Pengimputan Data Integrasi Pelanggan Acesioterapi.id'),
        h('p', null, 'Satu Input Untuk Semua')),
      tiles),
    h('section', { class: 'login__panel' }, form)));
  username.focus();
}
