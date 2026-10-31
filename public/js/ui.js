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
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M10 5H5v14h5M15 8l4 4-4 4M19 12H9"/>',
  edit: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
};
export function icon(name, size = 18) {
  const s = h('span', { 'aria-hidden': 'true', style: null });
  s.style.display = 'inline-grid';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

// ---------- format ----------
const TZ = 'Asia/Jakarta';
export const fmtNum = (n) => new Intl.NumberFormat('id-ID').format(n || 0);
export const fmtRp = (n) => 'Rp' + fmtNum(n);
export function fmtDate(iso) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
export function fmtPhone(p) {
  const s = String(p || '');
  return s.startsWith('62') && s.length >= 10 ? `+62 ${s.slice(2, 5)}-${s.slice(5, 9)}-${s.slice(9)}` : s;
}
export function jakartaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d.length >= 9 && d.length <= 15 ? d : null;
}
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- toast & modal ----------
export function toast(message, type = 'ok') {
  const el = h('div', { class: `toast toast--${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}

export function openModal({ title, content, wide = false, size = null, onClose }) {
  const previous = document.activeElement;
  const overlay = h('div', { class: 'overlay' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: () => close() }, icon('close'));
  const card = h('div', { class: `modal${wide ? ' modal--wide' : ''}${size ? ` modal--${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal__head' }, h('h2', { class: 'modal__title' }, title), closeBtn),
    h('div', { class: 'modal__body' }, content));
  overlay.append(card);
  document.body.append(overlay);
  const onKey = (e) => {
    if (e.key === 'Escape' && [...document.querySelectorAll('.overlay')].pop() === overlay) close();
  };
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  const first = card.querySelector('.modal__body input:not([type=file]):not([type=checkbox])');
  if (first) first.focus();
  return { close, card };
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

export function fmtDay(ymd, short = false) {
  const d = new Date(`${ymd}T00:00:00+07:00`);
  return new Intl.DateTimeFormat('id-ID', short
    ? { timeZone: TZ, day: 'numeric', month: 'short' }
    : { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}
export function fmtTime(iso) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
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