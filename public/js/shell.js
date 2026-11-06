import { api } from './api.js';
import { h, icon, emptyState, ROLE_LABEL } from './ui.js';
import { avatar, paintAvatar, openProfileModal } from './profile.js';

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

// Dipertahankan agar impor lama tetap bekerja; akun kini membuka modal profil lengkap.
export function openAccountModal(user, onChange) { return openProfileModal(user, onChange); }

// Kerangka halaman: topbar + tab + area konten.
// tabs: { id, label } = menu langsung, atau { label, items: [{ id | onClick, label, desc, key, init }] } = menu dropdown.
//   Item dengan `id` membuka tab itu; item dengan `onClick(setStatus)` menjalankan aksi (mis. panel Integrasi).
//   `key` + `init(setStatus)` memberi item penanda status kecil (titik) yang juga tampil di tombol dropdown.
// alias: { idHalaman: idMenu } untuk halaman yang dibuka dari tempat lain tanpa tombol menu sendiri.
// onSelect(id, main, ctx): ctx = { signal, isCurrent(), params } baru untuk SETIAP pergantian tab;
// ctx tab sebelumnya otomatis dibatalkan. params = parameter dari select(id, params), {} bila kosong. Tampilan async wajib memakai ctx.signal untuk fetch
// dan mengecek ctx.isCurrent() sebelum menyentuh DOM.
const STATUS_LABEL = { none: 'belum tersambung', paused: 'tersambung, belum dinyalakan', on: 'berjalan', problem: 'perlu perhatian' };

export function createShell({ user, tabs, onSelect, onLogout, actions = [], alias = {} }) {
  disposeActiveShell();
  const tabButtons = new Map(); // id tab -> tombol (di bar atau di dalam dropdown)
  const groupOf = new Map(); // id tab -> tombol grup dropdown induknya
  const dots = new Map(); // key -> [elemen titik]
  const statuses = new Map(); // key -> status
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Menu utama' });
  let openMenu = null; // { btn, menu }
  const menus = [];

  // ---- dropdown (posisi fixed supaya tidak terpotong bar tab yang bisa digeser di mobile) ----
  function placeMenu(btn, menu, align) {
    const r = btn.getBoundingClientRect();
    const hdr = header.getBoundingClientRect();
    menu.style.top = `${Math.round(Math.max(r.bottom, hdr.bottom - 8) + 6)}px`;
    if (window.innerWidth <= 760) { menu.style.left = '12px'; menu.style.right = '12px'; menu.style.width = 'auto'; return; }
    menu.style.width = '';
    if (align === 'right') { menu.style.left = 'auto'; menu.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`; }
    else { menu.style.right = 'auto'; menu.style.left = `${Math.max(12, Math.round(r.left))}px`; }
  }
  function closeMenu(refocus = false) {
    if (!openMenu) return;
    const { btn, menu } = openMenu;
    openMenu = null;
    btn.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    if (refocus) btn.focus();
  }
  function toggleMenu(btn, menu, align) {
    if (openMenu?.menu === menu) { closeMenu(); return; }
    closeMenu();
    menu.hidden = false;
    placeMenu(btn, menu, align);
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { btn, menu, align };
    menu.querySelector('[role=menuitem]')?.focus();
  }
  function menuKeys(btn, menu) {
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); if (openMenu?.menu !== menu) btn.click(); } });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role=menuitem]')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu();
    });
  }
  const onDocDown = (e) => { if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.btn.contains(e.target)) closeMenu(); };
  const onReflow = () => { if (openMenu) placeMenu(openMenu.btn, openMenu.menu, openMenu.align); };
  document.addEventListener('pointerdown', onDocDown);
  window.addEventListener('resize', onReflow);

  const dot = (key) => {
    const d = h('span', { class: 'intg-dot', 'data-status': statuses.get(key) || 'none', 'aria-hidden': 'true' });
    if (!dots.has(key)) dots.set(key, []);
    dots.get(key).push(d);
    return d;
  };
  function setStatus(key, st) {
    statuses.set(key, st || 'none');
    for (const d of dots.get(key) || []) d.dataset.status = st || 'none';
    for (const [lbl, els] of statusLabels) if (lbl.key === key) for (const el of els) el.textContent = ` (${STATUS_LABEL[st] || STATUS_LABEL.none})`;
  }
  const statusLabels = new Map();

  for (const t of tabs) {
    if (!t.items) {
      const b = h('button', { class: 'tab', type: 'button', onclick: () => select(t.id) }, t.label);
      tabButtons.set(t.id, b);
      nav.append(b);
      continue;
    }
    const keys = t.items.map((i) => i.key).filter(Boolean);
    const menu = h('div', { class: 'menu', role: 'menu', hidden: true, 'aria-label': t.label });
    const grpBtn = h('button', { class: 'tab tab--menu', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      t.label, ...keys.map((k) => dot(k)), icon('chevron', 16));
    for (const it of t.items) {
      const sr = it.key ? h('span', { class: 'sr-only' }, '') : null;
      if (sr) statusLabels.set({ key: it.key }, [sr]);
      const b = h('button', { class: 'menu__item', type: 'button', role: 'menuitem',
        onclick: () => { closeMenu(); if (it.id) select(it.id); else it.onClick?.((st) => setStatus(it.key, st?.status || st)); } },
      h('span', { class: 'menu__text' }, h('b', null, it.label, it.key ? dot(it.key) : null, sr), it.desc ? h('small', null, it.desc) : null));
      if (it.id) { tabButtons.set(it.id, b); groupOf.set(it.id, grpBtn); }
      menu.append(b);
      if (it.init) it.init((st) => setStatus(it.key, st?.status || st));
    }
    grpBtn.addEventListener('click', () => toggleMenu(grpBtn, menu, 'left'));
    menuKeys(grpBtn, menu);
    nav.append(grpBtn);
    document.body.append(menu); // di luar header: tidak ikut terpotong dan selalu di atas konten
    menus.push(menu);
  }

  // ---- menu profil ----
  const userAvatar = avatar(user, 34);
  const userName = h('span', { class: 'userbtn__name' }, user.name);
  const userBtn = h('button', { class: 'userbtn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Menu akun: ${user.name}, ${ROLE_LABEL[user.role]}` },
    userAvatar, h('span', { class: 'userbtn__text' }, userName), h('span', { class: 'userbtn__chev' }, icon('chevron', 16)));
  const menuAvatar = avatar(user, 44);
  const menuName = h('b', null, user.name);
  const refreshUser = () => { userName.textContent = user.name; menuName.textContent = user.name; paintAvatar(userAvatar, user); paintAvatar(menuAvatar, user); userBtn.setAttribute('aria-label', `Menu akun: ${user.name}, ${ROLE_LABEL[user.role]}`); };
  const userMenu = h('div', { class: 'menu menu--user', role: 'menu', hidden: true, 'aria-label': 'Akun' },
    h('div', { class: 'menu__who' }, menuAvatar, h('span', { class: 'menu__text' }, menuName, h('small', null, `@${user.username} · ${ROLE_LABEL[user.role]}`))),
    h('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: () => { closeMenu(); openProfileModal(user, refreshUser); } },
      h('span', { class: 'menu__text' }, h('b', null, 'Profil / Akun Saya'), h('small', null, 'Data diri, foto, dan password'))),
    h('div', { class: 'menu__sep', role: 'separator' }),
    h('button', { class: 'menu__item menu__item--danger', type: 'button', role: 'menuitem', onclick: () => { closeMenu(); onLogout(); } },
      icon('logout', 18), h('span', { class: 'menu__text' }, h('b', null, 'Keluar'))));
  userBtn.addEventListener('click', () => toggleMenu(userBtn, userMenu, 'right'));
  menuKeys(userBtn, userMenu);
  document.body.append(userMenu);
  menus.push(userMenu);

  const main = h('main', { class: 'page', id: 'main' });
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__inner' },
      brand(),
      nav,
      h('div', { class: 'topbar__user' }, ...actions, userBtn)));
  const el = h('div', null, header, main);
  const setH = () => document.documentElement.style.setProperty('--topbar-h', `${header.offsetHeight}px`);
  const resizeObserver = new ResizeObserver(setH);
  resizeObserver.observe(header);
  setH();

  let controller = null;
  const abortCurrent = () => { if (controller) controller.abort(); };

  function select(id, params = {}) {
    abortCurrent(); // membatalkan fetch dan pembaruan DOM tab sebelumnya
    const mine = new AbortController();
    controller = mine;
    const ctx = { signal: mine.signal, params, isCurrent: () => controller === mine && !mine.signal.aborted };
    const lit = alias[id] || id; // halaman tanpa tombol menu (mis. isi SOAP) menyorot menu induknya
    for (const [k, b] of tabButtons) {
      if (k === lit) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const g of new Set(groupOf.values())) {
      if (groupOf.get(lit) === g) g.setAttribute('aria-current', 'page');
      else g.removeAttribute('aria-current');
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
    document.removeEventListener('pointerdown', onDocDown);
    window.removeEventListener('resize', onReflow);
    for (const m of menus) m.remove();
    resizeObserver.disconnect();
  }

  const shell = { el, main, select, dispose, setStatus };
  activeShell = shell;
  return shell;
}
