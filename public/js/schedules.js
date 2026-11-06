// Tab "Jadwal" untuk admin dan supervisor: isi, lihat, ubah, dan batalkan jadwal user.
// Aman diimpor di Node: tidak menyentuh document/window saat dimuat.
import { api } from './api.js';
import {
  h, icon, toast, openModal, confirmDialog, emptyState, field, todayInTz, fmtDay, fmtDate, fmtPhone, fmtNum, debounce,
} from './ui.js';
import {
  createGate, tableWrap, pagerNodes, rangeLabel, NO_CTX,
} from './customers.js';
import {
  schedulePill, fmtTimeRange, fmtLongDay, servicesSummary, STAFF_STATUS_FILTER, SOAP_PARTS, countdownEl,
} from './schedule-ui.js';

const isAbort = (e) => e?.name === 'AbortError';
const NOTE_MAX = 500;
const MAX_SERVICES = 29;
const RANGE_MSG = 'Tanggal awal tidak boleh setelah tanggal akhir'; // sama dengan rangeError di staff.js
const dash = (v) => (v ? v : h('span', { class: 'muted' }, '–'));

// ---------- tanggal (fungsi murni; tidak mengimpor staff.js agar tidak ada impor melingkar) ----------
function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const rangeError = (from, to) => (from && to && from > to ? RANGE_MSG : '');

// kind: 'today' | 'tomorrow' | 'next7' (hari ini sampai 6 hari ke depan) | 'all'
function quickRange(kind, today) {
  if (kind === 'today') return { from: today, to: today };
  if (kind === 'tomorrow') { const t = addDays(today, 1); return { from: t, to: t }; }
  if (kind === 'next7') return { from: today, to: addDays(today, 6) };
  return { from: '', to: '' };
}
const QUICK = [['today', 'Hari ini'], ['tomorrow', 'Besok'], ['next7', '7 hari ke depan'], ['all', 'Semua']];

// Hanya supervisor, hanya tugas yang sudah dijalani user (Sedang dijalani atau Selesai).
const canDelete = (s, user) => user.role === 'supervisor' && (s.status === 'berjalan' || s.status === 'selesai');
const canCancel = (s, user) => s.status === 'baru' || (user.role === 'supervisor' && s.status === 'berjalan');

// Menonaktifkan tombol selama permintaan berjalan (cegah klik ganda).
async function busy(btns, fn) {
  const list = [].concat(btns).filter(Boolean);
  if (list.some((b) => b.disabled)) return undefined;
  for (const b of list) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally {
    for (const b of list) { b.disabled = false; b.removeAttribute('aria-busy'); }
  }
}

// Approve = admin atau supervisor menyatakan pekerjaan terapis selesai (jadwal Selesai). Hanya setelah SOAP terisi dan hitung mundur habis.
const canApprove = (s) => s.status === 'berjalan' && s.phase === 'menunggu';

async function approveRequest(s, { onDone, btns }) {
  const label = `${s.customer?.name || 'customer'} (${s.user?.name || 'terapis'})`;
  if (!(await confirmDialog(`Approve pekerjaan ${label}? Jadwal menjadi Selesai dan layanan serta komisi dicatat.`, { confirmText: 'Ya, approve' }))) return;
  await busy(btns, async () => {
    try {
      await api(`/api/staff/schedules/${s.id}/approve`, { method: 'POST', body: {} });
      toast('Pekerjaan di-approve. Jadwal selesai dan layanan tercatat.');
    } catch (e) {
      if (isAbort(e)) return;
      toast(e.message, 'err'); // mis. 409: sudah di-approve atau status berubah
    }
    if (onDone) onDone();
  });
}

// ======================= TAMPILAN UTAMA =======================
export function scheduleView(main, user, ctx = NO_CTX) {
  const gate = createGate(ctx);
  const today = todayInTz();
  const from = h('input', { class: 'input', type: 'date', id: 'sch-from', value: today });
  const to = h('input', { class: 'input', type: 'date', id: 'sch-to', value: today });
  const userSel = h('select', { class: 'input select', id: 'sch-user' }, h('option', { value: '' }, 'Semua user'));
  const statusSel = h('select', { class: 'input select', id: 'sch-status' },
    h('option', { value: '' }, 'Semua status'),
    Object.entries(STAFF_STATUS_FILTER).map(([v, l]) => h('option', { value: v }, l)));
  const q = h('input', { class: 'input', type: 'search', id: 'sch-q', placeholder: 'Cari nama customer, No RM, atau nama user' });
  const rangeMsg = h('p', { class: 'error range-msg', role: 'alert' });
  const summary = h('p', { class: 'muted', role: 'status' }, 'Memuat…');
  const box = h('div', { 'aria-live': 'polite' });
  const pendingNote = h('p', { class: 'sch-pending', role: 'status', hidden: true });
  const pager = h('nav', { class: 'pager', 'aria-label': 'Halaman jadwal' });
  let page = 1;
  let firstLoad = true;
  let workers = [];

  const checkRange = () => rangeError(from.value, to.value);

  // ---------- periode cepat ----------
  const quickBtns = QUICK.map(([kind, label]) => h('button', {
    class: 'btn btn--ghost btn--sm btn--toggle', type: 'button', 'aria-pressed': 'false',
    onclick: () => {
      const r = quickRange(kind, todayInTz());
      from.value = r.from; to.value = r.to;
      onFilterChange();
    },
  }, label));
  function syncQuick() {
    const now = todayInTz();
    QUICK.forEach(([kind], i) => {
      const r = quickRange(kind, now);
      quickBtns[i].setAttribute('aria-pressed', String(r.from === from.value && r.to === to.value));
    });
  }

  // ---------- memuat daftar ----------
  async function load({ silent = false } = {}) {
    const req = gate.begin();
    const params = new URLSearchParams({ page: String(page) });
    if (from.value) params.set('from', from.value);
    if (to.value) params.set('to', to.value);
    if (userSel.value) params.set('user_id', userSel.value);
    if (statusSel.value) params.set('status', statusSel.value);
    if (q.value.trim()) params.set('q', q.value.trim());
    if (!silent) box.setAttribute('aria-busy', 'true');
    if (firstLoad) box.replaceChildren(emptyState('Memuat jadwal…', ''));
    try {
      const { schedules, total, page: pg, pageSize, pending_approval: pending } = await api(`/api/staff/schedules?${params}`, { signal: req.signal });
      if (!req.ok()) return;
      firstLoad = false;
      pendingNote.textContent = pending ? `${fmtNum(pending)} jadwal menunggu approve` : '';
      pendingNote.hidden = !pending;
      const size = pageSize || 50;
      const pages = Math.max(1, Math.ceil(total / size));
      if (page > pages) { page = pages; load(); return; }
      const offset = ((pg || page) - 1) * size;
      const filtering = !!(userSel.value || statusSel.value || q.value.trim());
      summary.textContent = rangeLabel({ offset, shown: schedules.length, total, noun: 'jadwal' });
      box.replaceChildren(schedules.length
        ? scheduleTable(schedules)
        : h('div', { class: 'table-wrap' }, emptyState(
          filtering || from.value || to.value ? 'Tidak ada jadwal' : 'Belum ada jadwal',
          filtering || from.value || to.value
            ? 'Tidak ada jadwal yang cocok dengan filter. Ubah tanggal atau pilih “Semua”.'
            : 'Klik “Tambah jadwal” untuk mengisi jadwal user.')));
      pager.replaceChildren(...pagerNodes({ page, pages, onPage: (p) => { page = p; load(); } }));
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      firstLoad = true;
      summary.textContent = '';
      pager.replaceChildren();
      const err = emptyState('Jadwal belum bisa dimuat', e.message);
      err.append(h('div', { class: 'sch-retry' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => load() }, 'Coba lagi')));
      box.replaceChildren(h('div', { class: 'table-wrap' }, err));
    } finally {
      if (req.ok()) box.removeAttribute('aria-busy');
    }
  }

  // ---------- tabel (jadi kartu bertumpuk di ponsel lewat CSS) ----------
  function scheduleTable(rows) {
    const body = h('tbody', null, rows.map((s) => {
      const actions = [];
      const viewBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openDetail(s, ctx) }, 'Lihat');
      actions.push(viewBtn);
      if (s.status === 'baru') {
        actions.push(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openForm({ schedule: s, workers, ctx, onSaved: load }) }, 'Ubah'));
      }
      if (canApprove(s)) {
        const approveBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Approve');
        approveBtn.addEventListener('click', () => approveRequest(s, { btns: actions, onDone: () => { if (ctx.isCurrent()) load(); } }));
        actions.push(approveBtn);
      }
      if (canCancel(s, user)) {
        const cancelBtn = h('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Batalkan');
        cancelBtn.addEventListener('click', () => cancelSchedule(s, actions));
        actions.push(cancelBtn);
      }
      if (canDelete(s, user)) {
        const delBtn = h('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Hapus');
        delBtn.addEventListener('click', () => deleteSchedule(s, actions));
        actions.push(delBtn);
      }
      return h('tr', { class: s.status === 'batal' ? 'sch-row is-cancelled' : 'sch-row' },
        h('td', { 'data-label': 'Waktu', class: 'nowrap' }, h('b', null, fmtTimeRange(s.start_time, s.end_time)), h('small', null, fmtDay(s.day))),
        h('td', { 'data-label': 'Terapis' }, s.user?.name || '–'),
        h('td', { 'data-label': 'Customer' }, h('b', null, s.customer?.name || '–'), h('small', null, s.customer?.rm_no || '–')),
        h('td', { 'data-label': 'Layanan', title: (s.services || []).map((x) => x.name).join(', ') }, servicesSummary(s.services)),
        h('td', { 'data-label': 'Catatan', class: 'sch-note' }, dash(s.note)),
        h('td', { 'data-label': 'Status' }, schedulePill(s.status, s.overdue, s.phase),
          s.phase === 'timer' && !s.overdue
            ? h('small', { class: 'sch-timer' }, countdownEl(s.remaining_sec, { signal: ctx.signal, label: 'Sisa', onDone: () => { if (ctx.isCurrent()) load({ silent: true }); } }))
            : null),
        h('td', { 'data-label': 'Aksi', class: 'sch-actions' }, h('div', { class: 'row-actions' }, actions)));
    }));
    return tableWrap(h('table', { class: 'sch-table' },
      h('thead', null, h('tr', null, ['Waktu', 'Terapis', 'Customer', 'Layanan', 'Catatan', 'Status'].map((t) => h('th', null, t)), h('th', null, h('span', { class: 'sr-only' }, 'Aksi')))),
      body), 'Tabel jadwal', 'table-wrap--sch');
  }

  async function deleteSchedule(s, siblings) {
    const label = `${s.customer?.name || 'customer'} oleh ${s.user?.name || 'user'} pada ${fmtDay(s.day)} ${fmtTimeRange(s.start_time, s.end_time)}`;
    const ok = await confirmDialog(`Setuju menghapus tugas ${label}? Jadwal, SOAP, serta layanan dan komisi yang tercatat dari tugas ini ikut terhapus permanen. Tindakan ini tidak bisa dibatalkan.`, { confirmText: 'Ya, hapus tugas', danger: true });
    if (!ok) return;
    await busy(siblings, async () => {
      try {
        await api(`/api/sv/schedules/${s.id}`, { method: 'DELETE' });
        toast('Tugas dihapus');
      } catch (e) {
        if (isAbort(e)) return;
        toast(e.message, 'err');
      }
      if (ctx.isCurrent()) load();
    });
  }

  async function cancelSchedule(s, siblings) {
    const label = `${s.customer?.name || 'customer'} pada ${fmtDay(s.day)} ${fmtTimeRange(s.start_time, s.end_time)}`;
    if (!(await confirmDialog(`Batalkan jadwal ${label}? User ${s.user?.name || ''} akan menerima pemberitahuan pembatalan.`, { confirmText: 'Ya, batalkan jadwal', danger: true }))) return;
    await busy(siblings, async () => {
      try {
        await api(`/api/staff/schedules/${s.id}/cancel`, { method: 'POST', body: {} });
        toast('Jadwal dibatalkan');
      } catch (e) {
        if (isAbort(e)) return;
        toast(e.message, 'err'); // mis. 409 SCHEDULE_STATE: status sudah berubah
      }
      if (ctx.isCurrent()) load();
    });
  }

  // ---------- filter ----------
  function onFilterChange() {
    const msg = checkRange();
    rangeMsg.textContent = msg;
    for (const el of [from, to]) { if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    syncQuick();
    if (msg) return; // jangan memuat rentang terbalik; tampilan lama tetap
    page = 1;
    load();
  }
  from.addEventListener('change', onFilterChange);
  to.addEventListener('change', onFilterChange);
  userSel.addEventListener('change', onFilterChange);
  statusSel.addEventListener('change', onFilterChange);
  q.addEventListener('input', debounce(() => { if (!checkRange()) { page = 1; load(); } }, 250));

  async function loadWorkers() {
    try {
      const r = await api('/api/staff/schedule-workers', { signal: ctx.signal });
      if (!ctx.isCurrent()) return;
      workers = r.workers || [];
      userSel.append(...workers.map((w) => h('option', { value: w.id }, w.name)));
    } catch (e) {
      if (isAbort(e) || !ctx.isCurrent()) return;
      toast('Daftar user belum bisa dimuat. Filter user dan tombol Tambah jadwal belum lengkap; muat ulang halaman.', 'err');
    }
  }

  const addBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openForm({ schedule: null, workers, ctx, onSaved: () => { page = 1; load(); } }) }, icon('plus', 18), 'Tambah jadwal');
  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Jadwal'), summary),
      h('div', { class: 'toolbar' }, addBtn)),
    h('div', { class: 'quick', role: 'group', 'aria-label': 'Periode cepat' }, h('span', { class: 'label' }, 'Periode cepat'), quickBtns),
    h('div', { class: 'toolbar sch-filters mb' },
      field('Dari tanggal', from), field('Sampai tanggal', to), field('User', userSel), field('Status', statusSel),
      h('div', { class: 'field toolbar__grow' }, h('label', { for: 'sch-q' }, 'Cari'), q)),
    rangeMsg, pendingNote, box, pager);
  syncQuick();
  loadWorkers();
  load();
}

// ======================= LIHAT DETAIL =======================
function openDetail(s, ctx = NO_CTX) {
  const gate = createGate(ctx);
  const content = h('div');
  openModal({ title: 'Detail jadwal', content, wide: true, onClose: () => gate.cancel() });

  function render(d) {
    const row = (label, value) => [h('dt', null, label), h('dd', null, value)];
    const soap = d.soap
      ? h('section', { class: 'sch-soap', 'aria-label': 'SOAP' },
        h('h3', { class: 'sch-sub' }, 'SOAP'),
        h('p', { class: 'hint' }, 'Hanya baca. Diisi terapis sebelum hitung mundur dimulai.'),
        SOAP_PARTS.map((p) => h('div', { class: 'sch-soap__part' },
          h('h4', null, `${p.key.toUpperCase()} · ${p.label}`),
          h('p', { class: 'sch-soap__text' }, d.soap[p.key] || '–'))))
      : null;
    const customer = d.customer || {};
    content.replaceChildren(
      h('div', { class: 'summary-chips summary-chips--tight' }, schedulePill(d.status, d.overdue, d.phase),
        d.phase === 'timer' && !d.overdue ? countdownEl(d.remaining_sec, { onDone: () => { if (ctx.isCurrent()) load(); } }) : null),
      canApprove(d) && !d.overdue
        ? h('div', { class: 'sch-approve' },
          h('p', null, 'SOAP sudah diisi dan waktu layanan habis. Periksa SOAP di bawah, lalu approve untuk menyatakan pekerjaan terapis selesai; layanan dan komisi dicatat saat itu.'),
          (() => { const b = h('button', { class: 'btn btn--primary', type: 'button' }, 'Approve pekerjaan'); b.addEventListener('click', () => approveRequest(d, { btns: b, onDone: load })); return b; })())
        : null,
      h('dl', { class: 'kv' },
        row('Tanggal', fmtLongDay(d.day)),
        row('Waktu', fmtTimeRange(d.start_time, d.end_time)),
        row('Terapis', d.user?.name || '–'),
        row('Customer', `${customer.name || '–'} · ${customer.rm_no || '–'}${customer.phone ? ` · ${fmtPhone(customer.phone)}` : ''}`),
        row('Catatan', d.note || '–'),
        row('Dibuat oleh', d.created_by_name || '–'),
        d.started_at ? row('Dimulai', fmtDate(d.started_at)) : null,
        d.due_at ? row('Hitung mundur sampai', fmtDate(d.due_at)) : null,
        d.approved_at ? row('Di-approve', `${fmtDate(d.approved_at)}${d.approved_by_name ? ` oleh ${d.approved_by_name}` : ''}`) : null,
        d.completed_at ? row('Selesai', fmtDate(d.completed_at)) : null),
      h('h3', { class: 'sch-sub' }, `Layanan (${fmtNum((d.services || []).length)})`),
      (d.services || []).length
        ? h('ul', { class: 'sch-svc-list' }, d.services.map((x) => h('li', null, x.name)))
        : h('p', { class: 'muted' }, 'Tidak ada layanan.'),
      soap);
  }

  async function load() {
    const req = gate.begin();
    content.replaceChildren(h('p', { class: 'muted' }, 'Memuat…'));
    try {
      const { schedule: d } = await api(`/api/staff/schedules/${s.id}`, { signal: req.signal });
      if (!req.ok()) return;
      render(d);
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      const err = emptyState('Detail belum bisa dimuat', e.message);
      err.append(h('div', { class: 'sch-retry' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => load() }, 'Coba lagi')));
      content.replaceChildren(err);
    }
  }
  load();
}

// ======================= FORM TAMBAH / UBAH =======================
// Validasi sisi klien yang sama dengan server. Mengembalikan { msg, key } atau null bila lolos.
function validateForm(v, { today, original }) {
  const bad = (key, msg) => ({ key, msg });
  if (!v.user_id) return bad('user', 'Pilih user terlebih dahulu.');
  if (!v.customer) return bad('customer', 'Pilih customer terlebih dahulu.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.day)) return bad('day', 'Tanggal wajib diisi.');
  if (v.day < today && !(original && original.day === v.day)) return bad('day', 'Tanggal tidak boleh sudah lewat.');
  if (!v.service_ids.length) return bad('services', 'Pilih minimal satu layanan.');
  if (v.service_ids.length > MAX_SERVICES) return bad('services', `Layanan maksimal ${MAX_SERVICES}.`);
  if (!/^\d{2}:\d{2}$/.test(v.start_time)) return bad('start', 'Jam mulai wajib diisi.');
  if (v.end_time && !/^\d{2}:\d{2}$/.test(v.end_time)) return bad('end', 'Jam selesai tidak valid.');
  if (v.end_time && v.end_time < v.start_time) return bad('end', 'Jam selesai tidak boleh sebelum jam mulai.');
  if (v.note.length > NOTE_MAX) return bad('note', `Catatan maksimal ${NOTE_MAX} karakter.`);
  return null;
}

function openForm({ schedule, workers, ctx = NO_CTX, onSaved }) {
  const editing = !!schedule;
  const today = todayInTz();
  const flag = (el, on) => { if (on) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); };

  // --- user ---
  const list = workers.slice();
  if (editing && schedule.user && !list.some((w) => w.id === schedule.user.id)) list.unshift({ id: schedule.user.id, name: schedule.user.name });
  const userSel = h('select', { class: 'input select', id: 'sf-user' },
    h('option', { value: '' }, 'Pilih user…'),
    list.map((w) => h('option', { value: w.id, selected: editing && schedule.user?.id === w.id ? true : null }, w.name)));

  // --- customer (cari No RM / nama, saran dari server) ---
  let customer = editing ? schedule.customer : null;
  const custGate = createGate(ctx);
  const custInput = h('input', { class: 'input', id: 'sf-cust', type: 'search', autocomplete: 'off', placeholder: 'Ketik No RM atau nama (minimal 2 karakter)' });
  const suggest = h('ul', { class: 'sch-suggest', 'aria-label': 'Saran customer' });
  const suggestInfo = h('p', { class: 'hint', role: 'status' });
  const chosen = h('div', { class: 'sch-chosen' });
  const searchBox = h('div', null, custInput, suggestInfo, suggest);
  function paintCustomer() {
    if (customer) {
      chosen.replaceChildren(
        h('div', { class: 'sch-chosen__text' }, h('b', null, customer.name), h('small', null, customer.rm_no || '–')),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { customer = null; paintCustomer(); custInput.focus(); } }, 'Ganti'));
      chosen.hidden = false; searchBox.hidden = true;
    } else {
      chosen.hidden = true; searchBox.hidden = false;
    }
  }
  const runSearch = debounce(async () => {
    const term = custInput.value.trim();
    suggest.replaceChildren();
    if (term.length < 2) { custGate.cancel(); suggestInfo.textContent = term ? 'Ketik minimal 2 karakter.' : ''; return; }
    const req = custGate.begin(); // permintaan sebelumnya dibatalkan
    suggestInfo.textContent = 'Mencari…';
    try {
      const { customers } = await api(`/api/staff/customers?${new URLSearchParams({ q: term })}`, { signal: req.signal });
      if (!req.ok()) return;
      const shown = customers.slice(0, 8);
      suggestInfo.textContent = shown.length ? (customers.length > shown.length ? 'Menampilkan 8 teratas. Persempit pencarian bila perlu.' : '') : 'Customer tidak ditemukan.';
      suggest.replaceChildren(...shown.map((c) => h('li', null, h('button', {
        class: 'sch-suggest__item', type: 'button',
        onclick: () => { customer = { id: c.id, rm_no: c.rm_no, name: c.name, phone: c.phone }; custInput.value = ''; suggest.replaceChildren(); suggestInfo.textContent = ''; paintCustomer(); },
      }, h('b', null, c.name), h('small', null, c.rm_no || 'Belum ada No RM')))));
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      suggestInfo.textContent = e.message;
    }
  }, 250);
  custInput.addEventListener('input', runSearch);
  const custField = h('div', { class: 'field' }, h('label', { for: 'sf-cust' }, 'Customer'), chosen, searchBox);
  paintCustomer();

  // --- tanggal, jam, catatan ---
  const day = h('input', { class: 'input', id: 'sf-day', type: 'date', min: today, value: editing ? schedule.day : today });
  const start = h('input', { class: 'input', id: 'sf-start', type: 'time', value: editing ? schedule.start_time : '' });
  const end = h('input', { class: 'input', id: 'sf-end', type: 'time', value: editing ? schedule.end_time : '' });
  const note = h('textarea', { class: 'input textarea', id: 'sf-note', rows: '3', maxlength: String(NOTE_MAX), placeholder: 'Catatan untuk terapis (opsional)' });
  note.value = editing ? (schedule.note || '') : '';
  const noteCount = h('span', { class: 'hint sch-count' });
  const syncNote = () => { noteCount.textContent = `${fmtNum(note.value.length)}/${NOTE_MAX}`; };
  note.addEventListener('input', syncNote); syncNote();

  // --- layanan (kotak centang berganda, bisa dicari) ---
  const selected = new Map(editing ? (schedule.services || []).map((s) => [s.id, s.name]) : []);
  const svcQ = h('input', { class: 'input', id: 'sf-svcq', type: 'search', placeholder: 'Cari layanan', autocomplete: 'off', 'aria-label': 'Cari layanan' });
  const svcGrid = h('div', { class: 'sch-svc-grid', role: 'group', 'aria-label': 'Pilih layanan' }, h('p', { class: 'muted' }, 'Memuat layanan…'));
  const svcChips = h('div', { class: 'sch-chips' });
  const svcCount = h('p', { class: 'hint', role: 'status' });
  const svcRows = []; // { id, name, el }
  const paintSelected = () => {
    svcCount.textContent = `${fmtNum(selected.size)} layanan dipilih (maksimal ${MAX_SERVICES})`;
    svcChips.replaceChildren(...[...selected].map(([id, name]) => h('span', { class: 'sch-chip' }, name,
      h('button', { class: 'sch-chip__x', type: 'button', 'aria-label': `Hapus ${name}`, onclick: () => toggle(id, false) }, icon('close', 12)))));
    for (const r of svcRows) r.input.checked = selected.has(r.id);
  };
  function toggle(id, on, name) {
    if (on) {
      if (selected.size >= MAX_SERVICES) { toast(`Layanan maksimal ${MAX_SERVICES}`, 'err'); paintSelected(); return; }
      selected.set(id, name ?? svcRows.find((r) => r.id === id)?.name ?? '');
    } else selected.delete(id);
    paintSelected();
  }
  const svcGate = createGate(ctx);
  (async function loadServices() {
    const req = svcGate.begin();
    try {
      const { services } = await api('/api/services', { signal: req.signal });
      if (!req.ok()) return;
      svcRows.length = 0;
      svcGrid.replaceChildren(...services.map((s) => {
        const input = h('input', { type: 'checkbox', checked: selected.has(s.id) ? true : null });
        input.addEventListener('change', () => toggle(s.id, input.checked, s.name));
        const el = h('label', { class: 'sch-svc' }, input, h('span', { class: 'sch-svc__num' }, String(s.position)), h('span', { class: 'sch-svc__name' }, s.name));
        svcRows.push({ id: s.id, name: s.name, input, el });
        return el;
      }));
      for (const [id] of selected) { const r = svcRows.find((x) => x.id === id); if (r) selected.set(id, r.name); }
      paintSelected();
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      svcGrid.replaceChildren(h('p', { class: 'error' }, `Layanan belum bisa dimuat: ${e.message}`));
    }
  }());
  svcQ.addEventListener('input', () => {
    const t = svcQ.value.trim().toLowerCase();
    for (const r of svcRows) r.el.hidden = !!t && !r.name.toLowerCase().includes(t);
  });
  paintSelected();

  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, editing ? 'Simpan perubahan' : 'Simpan jadwal');
  const form = h('form', { novalidate: true, class: 'sch-form' },
    h('div', { class: 'form-grid' },
      field('User (terapis)', userSel),
      field('Tanggal', day, 'Tidak boleh sudah lewat.')),
    custField,
    h('div', { class: 'form-grid' }, field('Jam mulai', start), field('Jam selesai (opsional)', end)),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Layanan (wajib, minimal satu)'),
      svcChips, svcCount, svcQ, svcGrid),
    h('div', { class: 'field' }, h('label', { for: 'sf-note' }, 'Catatan'), note, noteCount),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({
    title: editing ? 'Ubah jadwal' : 'Tambah jadwal', content: form, wide: true,
    onClose: () => { runSearch.cancel(); custGate.cancel(); svcGate.cancel(); },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    err.textContent = '';
    for (const el of [userSel, day, start, end, note, custInput]) flag(el, false);
    const v = {
      user_id: Number(userSel.value) || 0, customer, day: day.value, start_time: start.value, end_time: end.value,
      note: note.value.trim(), service_ids: [...selected.keys()],
    };
    const problem = validateForm(v, { today, original: editing ? schedule : null });
    if (problem) {
      err.textContent = problem.msg;
      const target = {
        user: userSel, customer: custInput, day, services: svcQ, start, end, note,
      }[problem.key];
      flag(target, true);
      target.focus();
      return;
    }
    const body = {
      user_id: v.user_id, customer_id: v.customer.id, service_ids: v.service_ids,
      day: v.day, start_time: v.start_time, end_time: v.end_time, note: v.note,
    };
    await busy([save], async () => {
      try {
        if (editing) await api(`/api/staff/schedules/${schedule.id}`, { method: 'PATCH', body });
        else await api('/api/staff/schedules', { method: 'POST', body });
        modal.close();
        toast(editing ? 'Jadwal diperbarui' : 'Jadwal ditambahkan');
        if (ctx.isCurrent()) onSaved();
      } catch (ex) {
        if (isAbort(ex)) return;
        err.textContent = ex.message; // pesan server apa adanya
        if (ex.code === 'SCHEDULE_STATE' && ctx.isCurrent()) onSaved(); // status berubah: segarkan daftar
      }
    });
  });
}
