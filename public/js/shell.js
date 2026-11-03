import { api } from './api.js';
import { h, icon, openModal, toast, emptyState, ROLE_LABEL } from './ui.js';

// Shell yang sedang tampil; app.js membatalkannya saat sesi habis atau keluar.
let activeShell = null;
export function disposeActiveShell() {
  if (activeShell) activeShell.dispose();
  activeShell = null;
}

export function brand() {
  return h('div', { class: 'brand' },
    h('span', { class: 'brand__name' }, 'acesio'),
    h('span', { class: 'brand__sub' }, 'Physiotherapy Rehab & Sport Recovery Rehab'));
}

export function openAccountModal(user) {
  const current = h('input', { class: 'input', id: 'pw-cur', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan password');
  const form = h('form', null,
    h('p', { class: 'muted' }, `Masuk sebagai ${user.name} (${user.username})`),
    h('div', { class: 'field', style: null }, h('label', { for: 'pw-cur' }, 'Password saat ini'), current),
    h('div', { class: 'field' }, h('label', { for: 'pw-new' }, 'Password baru'), next, h('p', { class: 'hint' }, 'Minimal 8 karakter.')),
    err,
    h('div', { class: 'modal__actions' }, save));
  const modal = openModal({ title: 'Akun saya', content: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    err.textContent = '';
    save.disabled = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
      modal.close();
      toast('Password diganti');
    } catch (ex) {
      if (!ex.aborted) err.textContent = ex.message;
    } finally {
      save.disabled = false;
    }
  });
}

// Kerangka halaman: topbar + tab + area konten.
// onSelect(id, main, ctx): ctx = { signal, isCurrent() } baru untuk SETIAP pergantian tab;
// ctx tab sebelumnya otomatis dibatalkan. Tampilan async wajib memakai ctx.signal untuk fetch
// dan mengecek ctx.isCurrent() sebelum menyentuh DOM.
export function createShell({ user, tabs, onSelect, onLogout, actions = [] }) {
  disposeActiveShell();
  const tabButtons = new Map();
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Menu utama' });
  for (const t of tabs) {
    const b = h('button', { class: 'tab', type: 'button', onclick: () => select(t.id) }, t.label);
    tabButtons.set(t.id, b);
    nav.append(b);
  }
  const main = h('main', { class: 'page', id: 'main' });
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__inner' },
      brand(),
      nav,
      h('div', { class: 'topbar__user' },
        ...actions,
        h('button', { class: 'userbtn', type: 'button', title: `${ROLE_LABEL[user.role]} · ganti password`, onclick: () => openAccountModal(user) }, user.name),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Keluar', title: 'Keluar', onclick: onLogout }, icon('logout', 20)))));
  const el = h('div', null, header, main);
  const setH = () => document.documentElement.style.setProperty('--topbar-h', `${header.offsetHeight}px`);
  const resizeObserver = new ResizeObserver(setH);
  resizeObserver.observe(header);
  setH();

  let controller = null;
  const abortCurrent = () => { if (controller) controller.abort(); };

  function select(id) {
    abortCurrent(); // membatalkan fetch dan pembaruan DOM tab sebelumnya
    const mine = new AbortController();
    controller = mine;
    const ctx = { signal: mine.signal, isCurrent: () => controller === mine && !mine.signal.aborted };
    for (const [k, b] of tabButtons) {
      if (k === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    main.className = 'page';
    main.replaceChildren();
    const failed = (e) => {
      if (!ctx.isCurrent() || e?.aborted || e?.name === 'AbortError') return;
      main.replaceChildren(emptyState('Halaman belum bisa dimuat', e?.message || 'Terjadi kesalahan'));
    };
    try {
      const r = onSelect(id, main, ctx);
      if (r && typeof r.then === 'function') r.catch(failed);
    } catch (e) {
      failed(e);
    }
    return ctx;
  }

  function dispose() {
    abortCurrent();
    resizeObserver.disconnect();
  }

  const shell = { el, main, select, dispose };
  activeShell = shell;
  return shell;
}
