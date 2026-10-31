import { api } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, debounce, serviceCard, setSelected,
  confirmDialog, jakartaToday, emptyState,
} from './ui.js';
import { createShell } from './shell.js';

export function renderUserApp(root, user, { onLogout }) {
  const shell = createShell({
    user,
    onLogout,
    tabs: [{ id: 'services', label: 'Layanan' }, { id: 'history', label: 'Riwayat Customer' }],
    onSelect: (id, main) => (id === 'services' ? servicesView(main, user) : historyView(main)),
  });
  root.append(shell.el);
  shell.select('services');
}

// ======================= TAB LAYANAN =======================
// Alur: 1) isi No RM dan klik yang sesuai, 2) pilih layanan, 3) Input.
// User tidak mengisi catatan medis; semua data customer dikelola admin dan supervisor.
// User tidak bisa membuat customer: kalau No RM tidak ada, laporkan ke admin.
async function servicesView(main, user) {
  let services;
  try {
    ({ services } = await api('/api/services'));
  } catch (e) {
    main.append(emptyState('Layanan belum bisa dimuat', e.message));
    return;
  }

  const selected = new Map(); // id -> service
  const cards = new Map(); // id -> button
  let customer = null; // customer yang dipilih dari data admin
  let results = [];
  let searchedQ = ''; // kata kunci yang hasilnya sudah dimuat
  let active = -1;
  let reqId = 0;

  // ----- grid layanan -----
  const todayLine = h('p', { class: 'muted' }, 'Mulai dengan mengisi No RM customer di kotak atas.');
  const filter = h('input', { class: 'input', type: 'search', id: 'svc-filter', placeholder: 'Cari layanan', 'aria-label': 'Cari layanan' });
  const grid = h('div', { class: 'svc-grid is-locked', role: 'group', 'aria-label': 'Daftar layanan' });
  for (const s of services) {
    const card = serviceCard(s, {
      badge: user.name,
      pressable: true,
      onClick: () => {
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
    grid.append(card);
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const s of services) cards.get(s.id).hidden = q !== '' && !s.name.toLowerCase().includes(q);
  });

  // ----- panel input (di atas daftar layanan) -----
  const chips = h('ul', { class: 'chips' });
  const stepHint = h('p', { class: 'hint' });
  const clear = h('button', { class: 'link', type: 'button', onclick: () => { for (const s of [...selected.values()]) toggle(s); } }, 'Kosongkan pilihan');

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

  const submit = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Input');

  const panel = h('section', { class: 'panel', 'aria-label': 'Input customer' },
    h('div', { class: 'panel__inner' },
      h('div', { class: 'panel__grid' },
        h('div', null, rmField, picked),
        submit),
      h('div', { class: 'panel__top' }, h('strong', { id: 'sum-title' }, '2 · Layanan dipilih'), clear),
      chips, stepHint));
  const sumTitle = panel.querySelector('#sum-title');
  const jump = h('button', { class: 'btn btn--primary jump', type: 'button', onclick: () => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '');
  new IntersectionObserver(([e]) => jump.classList.toggle('is-on', !e.isIntersecting && selected.size > 0), {
    rootMargin: `-${Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 64)}px 0px 0px 0px`,
  }).observe(panel);

  function refresh() {
    const n = selected.size;
    jump.textContent = `${n} layanan dipilih · isi data`;
    if (n === 0) jump.classList.remove('is-on');
    sumTitle.textContent = n ? `2 · ${n} layanan dipilih` : '2 · Layanan dipilih';
    clear.hidden = n === 0;
    chips.replaceChildren(...[...selected.values()].map((s) => h('li', { class: 'chip' },
      h('span', null, s.name),
      h('button', { type: 'button', 'aria-label': `Batalkan ${s.name}`, onclick: () => toggle(s) }, '×'))));
    grid.classList.toggle('is-locked', !customer);
    stepHint.textContent = !customer ? 'Pilih customer dulu (langkah 1), lalu ketuk kotak layanan di bawah.'
      : n === 0 ? 'Ketuk satu atau lebih kotak layanan di bawah.' : '';
    stepHint.hidden = stepHint.textContent === '';
    submit.disabled = !(customer && n > 0);
    submit.textContent = n > 1 ? `Input ${n} layanan` : 'Input';
  }
  function toggle(s) {
    if (!s) return;
    if (selected.has(s.id)) selected.delete(s.id);
    else selected.set(s.id, s);
    setSelected(cards.get(s.id), selected.has(s.id));
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
  const runSearch = debounce(async () => {
    const q = rmInput.value.trim();
    if (q.length < 2) { results = []; searchedQ = ''; renderList(); return; }
    const id = ++reqId;
    try {
      const r = await api(`/api/customers/search?q=${encodeURIComponent(q)}`);
      if (id !== reqId) return;
      results = r.customers;
      searchedQ = q;
    } catch { results = []; searchedQ = ''; }
    renderList();
  }, 200);

  function pick(c) {
    customer = c;
    list.hidden = true;
    notFound.hidden = true;
    rmInput.setAttribute('aria-expanded', 'false');
    rmField.hidden = true;
    picked.hidden = false;
    picked.replaceChildren(
      h('span', { class: 'chip-ok__tick' }, icon('check', 13)),
      h('span', { class: 'chip-ok__text' }, h('b', null, c.name), h('small', null, `No RM ${c.rm_no} · terverifikasi`)),
      h('button', { class: 'link', type: 'button', onclick: resetCustomer }, 'Ganti'));
    refresh();
  }
  function resetCustomer() {
    customer = null; results = []; searchedQ = ''; active = -1;
    rmInput.value = '';
    rmField.hidden = false;
    picked.hidden = true;
    list.hidden = true;
    notFound.hidden = true;
    refresh();
  }

  rmInput.addEventListener('input', () => { customer = null; active = 0; notFound.hidden = true; runSearch(); refresh(); });
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
    if (!customer || selected.size === 0) return;
    submit.disabled = true;
    const body = { service_ids: [...selected.keys()], customer_id: customer.id };
    try {
      const r = await api('/api/records', { method: 'POST', body });
      toast(`${r.count} layanan tercatat untuk ${r.customer.name}`);
      for (const id of [...selected.keys()]) setSelected(cards.get(id), false);
      selected.clear();
      resetCustomer();
      loadToday();
    } catch (e) {
      toast(e.message, 'err');
      refresh();
    }
  });

  async function loadToday() {
    try {
      const d = jakartaToday();
      const { totals } = await api(`/api/records/mine?from=${d}&to=${d}`);
      todayLine.textContent = totals.services
        ? `Hari ini kamu sudah mencatat ${fmtNum(totals.services)} layanan untuk ${fmtNum(totals.customers)} customer.`
        : 'Mulai dengan mengisi No RM customer di kotak atas.';
    } catch { /* abaikan */ }
  }

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Pilih layanan'), todayLine),
      h('div', { class: 'toolbar' }, filter)),
    panel, grid, jump);
  refresh();
  loadToday();
}

// ======================= TAB RIWAYAT =======================
function historyView(main) {
  const q = h('input', { class: 'input', type: 'search', id: 'h-q', placeholder: 'Cari No RM, nama, nomor WA, atau layanan' });
  // Default: hanya customer yang diinput hari ini. Ubah tanggal untuk melihat hari lain; kosongkan untuk semua.
  const todayStr = jakartaToday();
  const from = h('input', { class: 'input', type: 'date', id: 'h-from', value: todayStr });
  const to = h('input', { class: 'input', type: 'date', id: 'h-to', value: todayStr });
  const csv = h('a', { class: 'btn btn--ghost btn--sm', download: '' }, icon('download', 16), 'CSV');
  const xlsx = h('a', { class: 'btn btn--ghost btn--sm', download: '' }, icon('download', 16), 'Excel');
  const summary = h('p', { class: 'muted' }, 'Memuat…');
  const body = h('div');

  const params = (extra = {}) => new URLSearchParams({ q: q.value.trim(), from: from.value, to: to.value, ...extra }).toString();

  async function load() {
    csv.href = `/api/records/mine/export?${params({ format: 'csv' })}`;
    xlsx.href = `/api/records/mine/export?${params({ format: 'xlsx' })}`;
    try {
      const { records, totals } = await api(`/api/records/mine?${params()}`);
      const isToday = from.value === todayStr && to.value === todayStr;
      summary.textContent = `${isToday ? 'Hari ini: ' : ''}${fmtNum(totals.services)} layanan untuk ${fmtNum(totals.customers)} customer` + (records.length >= 1000 ? ' (menampilkan 1.000 terbaru; unduh untuk data lengkap)' : '');
      if (!records.length) {
        body.replaceChildren(h('div', { class: 'table-wrap' }, emptyState('Belum ada data', from.value === todayStr && to.value === todayStr ? 'Belum ada input hari ini. Ubah tanggal di atas untuk melihat hari lain.' : 'Tidak ada input pada tanggal yang dipilih.')));
        return;
      }
      body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Tanggal', 'No RM', 'Customer', 'No WA', 'Layanan', ''].map((t) => h('th', null, t)))),
        h('tbody', null, records.map((r) => h('tr', null,
          h('td', { class: 'nowrap' }, fmtDate(r.created_at)),
          h('td', { class: 'nowrap' }, r.customer_rm || '–'),
          h('td', null, h('b', null, r.customer_name)),
          h('td', { class: 'nowrap' }, fmtPhone(r.customer_phone)),
          h('td', null, r.service_name),
          h('td', null, r.locked ? h('span', { class: 'pill', title: 'Sudah di-approve, tidak bisa dihapus' }, 'Terkunci') : h('div', { class: 'row-actions' },
            h('button', {
              class: 'icon-btn icon-btn--danger', type: 'button', 'aria-label': `Hapus ${r.service_name} untuk ${r.customer_name}`, title: 'Hapus',
              onclick: async () => {
                if (!(await confirmDialog(`Hapus “${r.service_name}” untuk ${r.customer_name}? Data ini juga hilang dari laporan.`, { confirmText: 'Hapus', danger: true }))) return;
                try { await api(`/api/records/${r.id}`, { method: 'DELETE' }); toast('Data dihapus'); load(); } catch (e) { toast(e.message, 'err'); }
              },
            }, icon('trash')))))))))); 
    } catch (e) {
      body.replaceChildren(emptyState('Riwayat belum bisa dimuat', e.message));
    }
  }

  q.addEventListener('input', debounce(load, 250));
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
    h('div', { class: 'section-head' }, h('h2', null, 'Data layanan')),
    body);
  load();
}