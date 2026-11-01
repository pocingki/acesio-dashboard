import { api, anySignal, downloadFile } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, debounce, serviceCard, setSelected,
  confirmDialog, todayInTz, dayInTz, emptyState,
} from './ui.js';
import { createShell } from './shell.js';
import { groupRecords, customerGroups } from './groups.js';

const UNCERTAIN_MSG = 'Belum pasti tersimpan. Menekan Input lagi aman, data tidak akan ganda.';

// Pilihan user disimpan di memori modul supaya tidak hilang saat pindah tab.
// Dikosongkan setelah input sukses, saat keluar, dan saat akun yang masuk berbeda.
const mem = {
  userId: null,
  customer: null,
  selected: new Map(), // id layanan -> layanan
  key: null, // Idempotency-Key untuk kombinasi (customer + layanan) saat ini
  sig: '', // tanda kombinasi yang memiliki key tersebut
};

export function resetUserState() {
  mem.userId = null;
  mem.customer = null;
  mem.selected.clear();
  mem.key = null;
  mem.sig = '';
}

// crypto.randomUUID hanya ada di konteks aman (https/localhost); cadangan untuk http biasa.
export function newIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function renderUserApp(root, user, { onLogout }) {
  if (mem.userId !== user.id) { resetUserState(); mem.userId = user.id; }
  const shell = createShell({
    user,
    onLogout,
    tabs: [{ id: 'services', label: 'Layanan' }, { id: 'history', label: 'Riwayat Customer' }],
    onSelect: (id, main, ctx) => (id === 'services' ? servicesView(main, user, ctx) : historyView(main, ctx)),
  });
  root.append(shell.el);
  shell.select('services');
}

// ======================= TAB LAYANAN =======================
// Alur: 1) isi No RM dan klik yang sesuai, 2) pilih layanan, 3) Input.
// User tidak mengisi catatan medis; semua data customer dikelola admin dan supervisor.
// User tidak bisa membuat customer: kalau No RM tidak ada, laporkan ke admin.
// Kerangka DOM dibangun SINKRON; data layanan mengisi grid setelah datang (dan dibuang bila tab sudah berganti).
function servicesView(main, user, ctx) {
  const { signal } = ctx;
  const selected = mem.selected; // id -> service (memori modul)
  const cards = new Map(); // id -> button
  let services = [];
  let customer = mem.customer; // customer yang dipilih dari data admin
  let results = [];
  let searchedQ = ''; // kata kunci yang hasilnya sudah dimuat
  let active = -1;
  let reqId = 0;
  let busy = false; // permintaan Input sedang berjalan

  const setCustomer = (c) => { customer = c; mem.customer = c; };

  // Key baru setiap kali kombinasi (customer + layanan) berubah; sama selama kombinasinya sama.
  function syncKey() {
    const sig = customer && selected.size ? `${customer.id}:${[...selected.keys()].sort((a, b) => a - b).join(',')}` : '';
    if (sig !== mem.sig) {
      mem.sig = sig;
      mem.key = sig ? newIdempotencyKey() : null;
      uncertain.hidden = true;
    }
  }

  // ----- grid layanan -----
  const todayLine = h('p', { class: 'muted' }, 'Mulai dengan mengisi No RM customer di kotak atas.');
  const filter = h('input', { class: 'input', type: 'search', id: 'svc-filter', placeholder: 'Cari layanan', 'aria-label': 'Cari layanan' });
  const grid = h('div', { class: 'svc-grid is-locked', role: 'group', 'aria-label': 'Daftar layanan', 'aria-busy': 'true' });
  const gridNote = h('div');

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    for (const s of services) cards.get(s.id).hidden = q !== '' && !s.name.toLowerCase().includes(q);
  }
  filter.addEventListener('input', applyFilter);

  function fillGrid(list) {
    services = list;
    cards.clear();
    // Pulihkan pilihan yang tersimpan; buang layanan yang sudah tidak ada.
    const known = new Map(list.map((s) => [s.id, s]));
    for (const id of [...selected.keys()]) {
      if (known.has(id)) selected.set(id, known.get(id));
      else selected.delete(id);
    }
    grid.replaceChildren(...list.map((s) => {
      const card = serviceCard(s, {
        badge: user.name,
        pressable: true,
        selected: selected.has(s.id),
        onClick: () => {
          if (busy) return;
          if (!customer && !selected.has(s.id)) {
            toast('Isi No RM dulu, lalu klik No RM yang sesuai.', 'err');
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            rmInput.focus({ preventScroll: true });
            return;
          }
          toggle(s);
        },
      });
      cards.set(s.id, card);
      return card;
    }));
    grid.setAttribute('aria-busy', 'false');
    applyFilter();
    refresh();
  }

  async function loadServices() {
    gridNote.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Memuat layanan…'));
    try {
      const { services: list } = await api('/api/services', { signal });
      if (!ctx.isCurrent()) return;
      gridNote.replaceChildren();
      fillGrid(list);
    } catch (e) {
      if (e.aborted || !ctx.isCurrent()) return;
      grid.setAttribute('aria-busy', 'false');
      gridNote.replaceChildren(
        emptyState('Layanan belum bisa dimuat', e.message),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: loadServices }, 'Coba lagi'));
    }
  }

  // ----- panel input (di atas daftar layanan) -----
  const chips = h('ul', { class: 'chips' });
  const stepHint = h('p', { class: 'hint' });
  const uncertain = h('p', { class: 'warn', role: 'status', hidden: true }, UNCERTAIN_MSG);
  const clear = h('button', { class: 'link', type: 'button', onclick: () => { if (!busy) for (const s of [...selected.values()]) toggle(s); } }, 'Kosongkan pilihan');

  const rmInput = h('input', {
    class: 'input', id: 'cust-rm', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Ketik No RM customer', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'cust-list', 'aria-autocomplete': 'list',
  });
  const list = h('ul', { class: 'cust__list', id: 'cust-list', role: 'listbox', hidden: true });
  const notFound = h('p', { class: 'warn', role: 'status', hidden: true },
    'No RM tidak ditemukan. Laporkan ke admin untuk memasukkan data customer baru, lalu coba lagi.');
  const rmField = h('div', { class: 'field' },
    h('label', { for: 'cust-rm' }, '1 · No RM customer'),
    h('div', { class: 'cust__box' }, rmInput, list),
    notFound);
  const picked = h('div', { class: 'chip-ok', hidden: true });
  let changeBtn = null;

  const submit = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Input');

  const panel = h('section', { class: 'panel', 'aria-label': 'Input customer' },
    h('div', { class: 'panel__inner' },
      h('div', { class: 'panel__grid' },
        h('div', null, rmField, picked),
        submit),
      h('div', { class: 'panel__top' }, h('strong', { id: 'sum-title' }, '2 · Layanan dipilih'), clear),
      chips, stepHint, uncertain));
  const sumTitle = panel.querySelector('#sum-title');
  const jump = h('button', { class: 'btn btn--primary jump', type: 'button', onclick: () => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '');
  const observer = new IntersectionObserver(([e]) => jump.classList.toggle('is-on', !e.isIntersecting && selected.size > 0), {
    rootMargin: `-${Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 64)}px 0px 0px 0px`,
  });
  observer.observe(panel);

  const runSearch = debounce(async () => {
    const q = rmInput.value.trim();
    if (q.length < 2) { results = []; searchedQ = ''; renderList(); return; }
    const id = ++reqId;
    try {
      const r = await api(`/api/customers/search?q=${encodeURIComponent(q)}`, { signal });
      if (id !== reqId || !ctx.isCurrent()) return;
      results = r.customers;
      searchedQ = q;
    } catch (e) {
      if (e.aborted || id !== reqId || !ctx.isCurrent()) return;
      results = []; searchedQ = '';
      if (e.status === 429) toast(e.message, 'err');
    }
    renderList();
  }, 200);
  signal.addEventListener('abort', () => { runSearch.cancel(); observer.disconnect(); }, { once: true });

  function refresh() {
    const n = selected.size;
    syncKey();
    jump.textContent = `${n} layanan dipilih · isi data`;
    if (n === 0) jump.classList.remove('is-on');
    sumTitle.textContent = n ? `2 · ${n} layanan dipilih` : '2 · Layanan dipilih';
    clear.hidden = n === 0;
    chips.replaceChildren(...[...selected.values()].map((s) => h('li', { class: 'chip' },
      h('span', null, s.name),
      h('button', { type: 'button', 'aria-label': `Batalkan ${s.name}`, disabled: busy, onclick: () => toggle(s) }, '×'))));
    grid.classList.toggle('is-locked', !customer || busy);
    stepHint.textContent = !customer ? 'Pilih customer dulu (langkah 1), lalu ketuk kotak layanan di bawah.'
      : n === 0 ? 'Ketuk satu atau lebih kotak layanan di bawah.' : '';
    stepHint.hidden = stepHint.textContent === '';
    rmInput.disabled = busy;
    if (changeBtn) changeBtn.disabled = busy;
    // Tombol Input nonaktif selama permintaan berjalan.
    submit.disabled = busy || !(customer && n > 0);
    submit.textContent = busy ? 'Menyimpan…' : n > 1 ? `Input ${n} layanan` : 'Input';
  }
  function toggle(s) {
    if (!s || busy) return;
    if (selected.has(s.id)) selected.delete(s.id);
    else selected.set(s.id, s);
    const card = cards.get(s.id);
    if (card) setSelected(card, selected.has(s.id));
    refresh();
  }

  function renderList() {
    if (active >= results.length) active = results.length - 1;
    if (active < 0 && results.length) active = 0;
    list.replaceChildren(...results.map((c, i) => {
      const btn = h('button', {
        class: 'cust__opt', type: 'button', role: 'option', 'aria-selected': String(i === active),
        onmousedown: (e) => e.preventDefault(), // jaga fokus di input
        onclick: () => pick(c),
      }, h('b', null, c.rm_no), h('small', null, c.name));
      return h('li', { role: 'presentation' }, btn);
    }));
    list.hidden = results.length === 0;
    rmInput.setAttribute('aria-expanded', String(!list.hidden));
    const q = rmInput.value.trim();
    notFound.hidden = !(q.length >= 2 && searchedQ === q && results.length === 0 && !customer);
    list._opts = results;
  }

  function showPicked(c) {
    list.hidden = true;
    notFound.hidden = true;
    rmInput.setAttribute('aria-expanded', 'false');
    rmField.hidden = true;
    picked.hidden = false;
    changeBtn = h('button', { class: 'link', type: 'button', onclick: resetCustomer }, 'Ganti');
    picked.replaceChildren(
      h('span', { class: 'chip-ok__tick' }, icon('check', 13)),
      h('span', { class: 'chip-ok__text' }, h('b', null, c.name), h('small', null, `No RM ${c.rm_no} · terverifikasi`)),
      changeBtn);
  }
  function pick(c) {
    if (busy) return;
    setCustomer(c);
    showPicked(c);
    refresh();
  }
  function resetCustomer() {
    if (busy) return;
    setCustomer(null); results = []; searchedQ = ''; active = -1;
    rmInput.value = '';
    rmField.hidden = false;
    picked.hidden = true;
    changeBtn = null;
    list.hidden = true;
    notFound.hidden = true;
    refresh();
  }

  rmInput.addEventListener('input', () => { setCustomer(null); active = 0; notFound.hidden = true; runSearch(); refresh(); });
  rmInput.addEventListener('keydown', (e) => {
    const opts = list._opts || [];
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); active = (active + 1) % opts.length; renderList(); }
    else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); active = (active - 1 + opts.length) % opts.length; renderList(); }
    else if (e.key === 'Enter' && !list.hidden && opts[active]) { e.preventDefault(); pick(opts[active]); }
    else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); list.hidden = true; }
  });
  rmInput.addEventListener('blur', () => { setTimeout(() => { list.hidden = true; }, 120); });
  rmInput.addEventListener('focus', () => { if (results.length) renderList(); });

  submit.addEventListener('click', async () => {
    if (busy || !customer || selected.size === 0) return;
    syncKey();
    const key = mem.key;
    const body = { service_ids: [...selected.keys()], customer_id: customer.id };
    busy = true;
    uncertain.hidden = true;
    refresh();
    try {
      const r = await api('/api/records', { method: 'POST', body, headers: { 'Idempotency-Key': key }, signal });
      // Sukses: key dibuang dan pilihan dikosongkan (state), lalu tampilan diperbarui bila masih aktif.
      mem.selected.clear();
      mem.customer = null;
      mem.key = null;
      mem.sig = '';
      toast(`${r.count} layanan tercatat untuk ${r.customer.name}`);
      if (ctx.isCurrent()) {
        for (const card of cards.values()) setSelected(card, false);
        customer = null;
        busy = false;
        resetCustomer();
        loadToday();
      }
    } catch (e) {
      if (e.aborted) return; // pindah tab / sesi berakhir: key tetap, mengulang Input aman
      if (e.status === 401) return; // login sudah ditampilkan oleh app.js
      if (e.uncertain || e.status >= 500) {
        // Jaringan putus / timeout / server error: bisa jadi sudah tersimpan. Key DIPERTAHANKAN.
        uncertain.hidden = false;
        toast(e.uncertain ? UNCERTAIN_MSG : e.message, 'err');
      } else {
        toast(e.message, 'err');
        // Ditolak tegas (4xx): tidak ada yang tersimpan, jadi percobaan berikutnya memakai key baru.
        if (e.status >= 400 && e.status < 500) { mem.sig = ''; mem.key = null; }
      }
    } finally {
      busy = false;
      if (ctx.isCurrent()) refresh();
    }
  });

  async function loadToday() {
    try {
      const d = todayInTz();
      const { totals } = await api(`/api/records/mine?from=${d}&to=${d}`, { signal });
      if (!ctx.isCurrent()) return;
      todayLine.textContent = totals.services
        ? `Hari ini kamu sudah mencatat ${fmtNum(totals.services)} layanan untuk ${fmtNum(totals.customers)} customer.`
        : 'Mulai dengan mengisi No RM customer di kotak atas.';
    } catch { /* abaikan */ }
  }

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Pilih layanan'), todayLine),
      h('div', { class: 'toolbar' }, filter)),
    panel, gridNote, grid, jump);
  if (customer) showPicked(customer); // pulihkan customer yang dipilih sebelum pindah tab
  refresh();
  loadServices();
  loadToday();
}

// ======================= TAB RIWAYAT =======================
function historyView(main, ctx) {
  const { signal } = ctx;
  const q = h('input', { class: 'input', type: 'search', id: 'h-q', placeholder: 'Cari No RM, nama, nomor WA, atau layanan' });
  // Default: hanya customer yang diinput hari ini. Ubah tanggal untuk melihat hari lain; kosongkan untuk semua.
  const todayStr = todayInTz();
  const from = h('input', { class: 'input', type: 'date', id: 'h-from', value: todayStr });
  const to = h('input', { class: 'input', type: 'date', id: 'h-to', value: todayStr });
  const summary = h('p', { class: 'muted', role: 'status' }, 'Memuat…');
  const banner = h('p', { class: 'warn', role: 'status', hidden: true });
  const body = h('div');

  const params = (extra = {}) => new URLSearchParams({ q: q.value.trim(), from: from.value, to: to.value, ...extra }).toString();

  // Unduh lewat fetch (bukan tautan download) supaya sesi habis / error tidak tersimpan sebagai berkas.
  function exportButton(label, format) {
    const text = h('span', null, label);
    const btn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('download', 16), text);
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      text.textContent = 'Mengunduh…';
      const range = from.value || to.value ? `${from.value || 'awal'}_${to.value || 'akhir'}` : 'semua';
      try {
        await downloadFile(`/api/records/mine/export?${params({ format })}`, `riwayat-customer-${range}.${format}`);
      } finally {
        btn.disabled = false;
        text.textContent = label;
      }
    });
    return btn;
  }
  const csv = exportButton('CSV', 'csv');
  const xlsx = exportButton('Excel', 'xlsx');

  const openGroups = new Set(); // grup yang sedang dibuka bertahan saat data dimuat ulang
  let seq = 0;
  let loadCtl = null;
  async function load() {
    if (loadCtl) loadCtl.abort(); // permintaan lama yang belum selesai dibatalkan
    loadCtl = new AbortController();
    const mine = ++seq;
    const sig = anySignal([signal, loadCtl.signal]);
    const stale = () => !ctx.isCurrent() || mine !== seq;
    try {
      const { records, totals, truncated } = await api(`/api/records/mine?${params()}`, { signal: sig });
      if (stale()) return;
      const today = todayInTz();
      const isToday = from.value === today && to.value === today;
      summary.textContent = `${isToday ? 'Hari ini: ' : ''}${fmtNum(totals.services)} layanan untuk ${fmtNum(totals.customers)} customer`;
      banner.hidden = !truncated;
      banner.textContent = truncated
        ? `Data terlalu banyak: hanya ${fmtNum(records.length)} baris terbaru yang ditampilkan. Ringkasan di atas tetap menghitung semua data. Unduh CSV atau Excel untuk data lengkap.`
        : '';
      if (!records.length) {
        body.replaceChildren(h('div', { class: 'table-wrap' }, emptyState('Belum ada data', isToday ? 'Belum ada input hari ini. Ubah tanggal di atas untuk melihat hari lain.' : 'Tidak ada input pada tanggal yang dipilih.')));
        return;
      }
      // Satu baris per customer (per hari); klik untuk melihat daftar layanannya.
      body.replaceChildren(customerGroups(groupRecords(records), {
        open: openGroups, showDay: true, label: 'Riwayat per customer',
        renderService: (r) => rowAction(r, today),
      }));
    } catch (e) {
      if (e.aborted || stale()) return;
      banner.hidden = true;
      body.replaceChildren(emptyState('Riwayat belum bisa dimuat', e.message));
    }
  }

  // Aturan: hanya data hari ini yang belum di-approve boleh dihapus user.
  function rowAction(r, today) {
    if (r.locked) return h('span', { class: 'pill', title: 'Sudah di-approve, tidak bisa dihapus' }, 'Terkunci');
    if ((r.day || dayInTz(r.created_at)) < today) return h('span', { class: 'pill', title: 'Data hari sebelumnya tidak bisa dihapus' }, 'Terkunci');
    return h('div', { class: 'row-actions' },
      h('button', {
        class: 'icon-btn icon-btn--danger', type: 'button', 'aria-label': `Hapus ${r.service_name} untuk ${r.customer_name}`, title: 'Hapus',
        onclick: async () => {
          if (!(await confirmDialog(`Hapus “${r.service_name}” untuk ${r.customer_name}? Data ini juga hilang dari laporan.`, { confirmText: 'Hapus', danger: true }))) return;
          if (!ctx.isCurrent()) return;
          try {
            await api(`/api/records/${r.id}`, { method: 'DELETE', signal });
            toast('Data dihapus');
            if (ctx.isCurrent()) load();
          } catch (e) {
            if (!e.aborted) toast(e.message, 'err');
          }
        },
      }, icon('trash')));
  }

  const reload = debounce(load, 250);
  signal.addEventListener('abort', () => reload.cancel(), { once: true });
  q.addEventListener('input', reload);
  from.addEventListener('change', load);
  to.addEventListener('change', load);

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Riwayat customer'), summary),
      h('div', { class: 'toolbar' }, h('span', { class: 'label' }, 'Tarik data'), csv, xlsx)),
    h('div', { class: 'toolbar', style: null },
      h('div', { class: 'field toolbar__grow' }, h('label', { for: 'h-q' }, 'Cari'), q),
      h('div', { class: 'field' }, h('label', { for: 'h-from' }, 'Dari tanggal'), from),
      h('div', { class: 'field' }, h('label', { for: 'h-to' }, 'Sampai tanggal'), to)),
    banner,
    h('div', { class: 'section-head' }, h('h2', null, 'Customer'), h('span', { class: 'hint' }, 'Klik customer untuk melihat layanannya')),
    body);
  load();
}