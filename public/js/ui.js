// ---------- DOM helper ----------
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- ikon (SVG statis, tanpa data pengguna) ----------
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="3"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M10 5H5v14h5M15 8l4 4-4 4M19 12H9"/>',
  edit: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  bell: '<path d="M6 16v-5a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 21h4"/>',
};
export function icon(name, size = 18) {
  const s = h('span', { 'aria-hidden': 'true', style: null });
  s.style.display = 'inline-grid';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

// ---------- zona waktu (nilai tz datang dari server: respons login dan /api/auth/me) ----------
// Sebelum tz diketahui, Intl memakai zona browser (timeZone: undefined).
let TZ;
export function setTz(tz) {
  if (!tz || typeof tz !== 'string') return;
  try {
    new Intl.DateTimeFormat('id-ID', { timeZone: tz });
    TZ = tz;
  } catch { /* nama zona tidak dikenal: abaikan */ }
}
export const getTz = () => TZ;

// ---------- format ----------
export const fmtNum = (n) => new Intl.NumberFormat('id-ID').format(n || 0);
export const fmtRp = (n) => 'Rp' + fmtNum(n);

const validDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
export function fmtDate(iso) {
  const d = validDate(iso);
  return d ? new Intl.DateTimeFormat('id-ID', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(d) : '';
}
export function fmtPhone(p) {
  const s = String(p || '');
  return s.startsWith('62') && s.length >= 10 ? `+62 ${s.slice(2, 5)}-${s.slice(5, 9)}-${s.slice(9)}` : s;
}
// "YYYY-MM-DD" untuk hari ini / untuk satu waktu, menurut zona dari server.
export function dayInTz(date = new Date()) {
  const d = date instanceof Date ? date : validDate(date);
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '';
}
export const todayInTz = () => dayInTz(new Date());
export const jakartaToday = () => todayInTz(); // alias lama
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d.length >= 9 && d.length <= 15 ? d : null;
}
export function debounce(fn, ms) {
  let t;
  const run = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  run.cancel = () => clearTimeout(t);
  return run;
}

// ---------- toast ----------
function toastHost() {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'false');
  return host;
}

export function toast(message, type = 'ok') {
  const host = toastHost();
  while (host.children.length >= 4) host.firstElementChild.remove();
  // Error memakai role=alert supaya dibacakan segera oleh pembaca layar.
  const el = h('div', { class: `toast toast--${type}`, role: type === 'err' ? 'alert' : null }, message);
  host.append(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
  return el;
}

// ---------- modal ----------
// Modal terbuka disimpan dalam tumpukan; hanya SATU listener keydown di dokumen,
// dipasang saat modal pertama dibuka dan dilepas saat yang terakhir tertutup (apa pun jalannya).
const modals = [];
let modalSeq = 0;
let keyBound = false;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (card) => [...card.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length > 0);

function prune() {
  for (const m of [...modals]) if (!m.overlay.isConnected) m.close(); // overlay dicabut dari luar
}

function onKey(e) {
  prune();
  const top = modals[modals.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    e.preventDefault();
    top.close(); // hanya modal paling atas
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables(top.card);
  if (!items.length) { e.preventDefault(); top.card.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const now = document.activeElement;
  if (!top.card.contains(now)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && (now === first || now === top.card)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && now === last) { e.preventDefault(); first.focus(); }
}

export function openModal({ title, content, wide = false, size = null, onClose }) {
  const previous = document.activeElement;
  const titleId = `modal-title-${++modalSeq}`;
  const overlay = h('div', { class: 'overlay' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: () => close() }, icon('close'));
  const card = h('div', {
    class: `modal${wide ? ' modal--wide' : ''}${size ? ` modal--${size}` : ''}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  },
  h('div', { class: 'modal__head' }, h('h2', { class: 'modal__title', id: titleId }, title), closeBtn),
  h('div', { class: 'modal__body' }, content));
  overlay.append(card);

  let closed = false;
  const entry = { overlay, card, close };
  function close() {
    if (closed) return;
    closed = true;
    const i = modals.indexOf(entry);
    if (i >= 0) modals.splice(i, 1);
    overlay.remove();
    if (!modals.length && keyBound) { document.removeEventListener('keydown', onKey); keyBound = false; }
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    if (onClose) onClose();
  }

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modals.push(entry);
  document.body.append(overlay);
  if (!keyBound) { document.addEventListener('keydown', onKey); keyBound = true; }

  const first = card.querySelector('.modal__body input:not([type=file]):not([type=checkbox])')
    || focusables(card.querySelector('.modal__body'))[0]
    || card;
  first.focus();
  return { close, card, overlay };
}

// Menutup semua modal (dipakai saat sesi habis atau keluar). Paling atas ditutup lebih dulu.
export function closeAllModals() {
  for (const m of [...modals].reverse()) m.close();
  document.querySelectorAll('.overlay').forEach((o) => o.remove()); // sisa overlay tak terdaftar
}

export function confirmDialog(message, { confirmText = 'Ya, lanjut', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; modal.close(); resolve(v); };
    const modal = openModal({
      title: 'Konfirmasi',
      content: h('div', null,
        h('p', null, message),
        h('div', { class: 'modal__actions' },
          h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => done(false) }, 'Batal'),
          h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', onclick: () => done(true) }, confirmText))),
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ---------- kotak layanan (dipakai user & admin) ----------
export function serviceCard(s, { badge, selected = false, pressable = false, editIcon = false, onClick }) {
  const art = h('span', { class: 'svc__art' }, s.photo ? null : h('span', { class: 'svc__num' }, String(s.position)));
  if (s.photo) art.style.backgroundImage = `url("${s.photo}")`;
  const btn = h('button', {
    type: 'button',
    class: `svc tone-${s.position % 3}${selected ? ' is-selected' : ''}`,
    title: s.name,
    'aria-pressed': pressable ? String(selected) : null,
  },
  art,
  badge ? h('span', { class: 'svc__badge' }, badge) : null,
  h('span', { class: 'svc__bar' },
    h('span', { class: 'svc__name' }, s.name),
    h('span', { class: `svc__check${editIcon ? ' svc__check--edit' : ''}` }, icon(editIcon ? 'edit' : 'check'))));
  btn.addEventListener('click', () => onClick && onClick(s, btn));
  return btn;
}

export function setSelected(btn, on) {
  btn.classList.toggle('is-selected', on);
  btn.setAttribute('aria-pressed', String(on));
}

export const emptyState = (title, text) => h('div', { class: 'empty' }, h('b', null, title), text);

// ---------- tambahan v2 ----------
export const EMP_LABEL = { tetap: 'Karyawan tetap', part_time: 'Part time' };
export const ROLE_LABEL = { user: 'User', admin: 'Admin', supervisor: 'Supervisor' };

// "YYYY-MM-DD" adalah tanggal kalender; diformat di UTC supaya tidak bergeser oleh zona mana pun.
export function fmtDay(ymd, short = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat('id-ID', short
    ? { timeZone: 'UTC', day: 'numeric', month: 'short' }
    : { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}
export function fmtTime(iso) {
  const d = validDate(iso);
  return d ? new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d) : '';
}

// late: null = menunggu approve, 0 = tepat waktu, 1 = terlambat
// expired = hari sudah lewat dan tidak di-approve (tidak terhitung)
export function statusPill(late, expired = false) {
  if (late === null || late === undefined) {
    return expired
      ? h('span', { class: 'pill pill--off' }, 'Tidak di-approve')
      : h('span', { class: 'pill pill--wait' }, 'Menunggu approve');
  }
  return late ? h('span', { class: 'pill pill--late' }, 'Terlambat') : h('span', { class: 'pill pill--ok' }, 'Tepat waktu');
}

export const empPill = (e) => h('span', { class: `pill pill--emp-${e}` }, EMP_LABEL[e] || e);

export function field(label, input, hint) {
  const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}

// ---------- data customer ----------
export const GENDER_LABEL = { L: 'Laki-laki', P: 'Perempuan', '': '' };
// "1990-03-05" -> "05/03/1990" (tanpa konversi zona waktu)
export function fmtBirth(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Kontrak G: downloadFile boleh diimpor dari ui.js maupun api.js.
export { downloadFile } from './api.js';