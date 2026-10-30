import { api } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, debounce, normalizePhone, serviceCard, setSelected,
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
  let customer = null; // customer yang sudah divalidasi
  let isNew = false; // customer baru (belum ada di data)
  let results = [];
  let active = -1;
  let reqId = 0;

  // ----- grid layanan -----
  const todayLine = h('p', { class: 'muted' }, 'Ketuk satu atau lebih kotak, lalu isi customer.');
  const filter = h('input', { class: 'input', type: 'search', id: 'svc-filter', placeholder: 'Cari layanan', 'aria-label': 'Cari layanan' });
  const grid = h('div', { class: 'svc-grid', role: 'group', 'aria-label': 'Daftar layanan' });
  for (const s of services) {
    const card = serviceCard(s, {
      badge: user.name,
      pressable: true,
      onClick: () => toggle(s),
    });
    cards.set(s.id, card);
    grid.append(card);
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const s of services) cards.get(s.id).hidden = q !== '' && !s.name.toLowerCase().includes(q);
  });

  // ----- panel input (di atas daftar layanan) -----
  const sumTitle = h('strong');
  const chips = h('ul', { class: 'chips' });
  const clear = h('button', { class: 'link', type: 'button', onclick: () => { for (const s of [...selected.values()]) toggle(s); } }, 'Kosongkan pilihan');

  const nameInput = h('input', {
    class: 'input', id: 'cust-name', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Ketik nama atau nomor WA', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'cust-list', 'aria-autocomplete': 'list',
  });
  const list = h('ul', { class: 'cust__list', id: 'cust-list', role: 'listbox', hidden: true });
  const nameField = h('div', { class: 'field' },
    h('label', { for: 'cust-name' }, 'Customer'),
    h('div', { class: 'cust__box' }, nameInput, list));

  const picked = h('div', { class: 'chip-ok', hidden: true });
  const phoneInput = h('input', { class: 'input', id: 'cust-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: 'Contoh 0812 3456 7890' });
  const phoneHint = h('p', { class: 'hint' }, 'Customer ini belum ada di data. Isi nomor WA-nya.');
  const phoneRow = h('div', { class: 'field', style: null, hidden: true }, h('label', { for: 'cust-phone' }, 'Nomor WA customer baru'), phoneInput, phoneHint);
  phoneRow.style.marginTop = '10px';
  const note = h('textarea', { class: 'textarea', id: 'rekam-medis', maxlength: '2000', rows: '3', placeholder: 'Keluhan, tindakan, atau catatan untuk customer ini' });
  const noteField = h('div', { class: 'field' },
    h('label', { for: 'rekam-medis' }, 'Rekam Medis'), note,
    h('p', { class: 'hint' }, 'Satu catatan berlaku untuk semua layanan yang dipilih.'));
  const submit = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Input');

  const panel = h('section', { class: 'panel', 'aria-label': 'Input customer', hidden: true },
    h('div', { class: 'panel__inner' },
      h('div', { class: 'panel__top' }, sumTitle, clear),
      chips,
      h('div', { class: 'panel__grid' },
        h('div', null, nameField, picked, phoneRow),
        noteField,
        submit)));
  const jump = h('button', { class: 'btn btn--primary jump', type: 'button', onclick: () => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '');
  new IntersectionObserver(([e]) => jump.classList.toggle('is-on', !e.isIntersecting && selected.size > 0), {
    rootMargin: `-${Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 64)}px 0px 0px 0px`,
  }).observe(panel);

  function readyToSubmit() {
    if (selected.size === 0) return false;
    if (customer) return true;
    return isNew && nameInput.value.trim().length >= 2 && normalizePhone(phoneInput.value) !== null;
  }
  function refresh() {
    const n = selected.size;
    panel.hidden = n === 0;
    jump.textContent = `${n} layanan dipilih · isi data`;
    if (n === 0) jump.classList.remove('is-on');
    sumTitle.textContent = `${n} layanan dipilih`;
    chips.replaceChildren(...[...selected.values()].map((s) => h('li', { class: 'chip' },
      h('span', null, s.name),
      h('button', { type: 'button', 'aria-label': `Batalkan ${s.name}`, onclick: () => toggle(s) }, '×'))));
    submit.disabled = !readyToSubmit();
    submit.textContent = n > 1 ? `Input ${n} layanan` : 'Input';
  }
  function toggle(s) {
    if (!s) return;
    if (selected.has(s.id)) selected.delete(s.id);
    else selected.set(s.id, s);
    setSelected(cards.get(s.id), selected.has(s.id));
    refresh();
  }

  function looksLikePhone(q) {
    return /^[+\d\s-]+$/.test(q) && q.replace(/\D/g, '').length >= 6;
  }
  function renderList() {
    const q = nameInput.value.trim();
    const opts = results.map((c) => ({ kind: 'existing', c }));
    if (q.length >= 2 && !looksLikePhone(q)) opts.push({ kind: 'new', name: q });
    if (active >= opts.length) active = opts.length - 1;
    if (active < 0 && opts.length) active = 0;
    list.replaceChildren(...opts.map((o, i) => {
      const btn = h('button', {
        class: `cust__opt${o.kind === 'new' ? ' cust__opt--new' : ''}`, type: 'button', role: 'option',
        'aria-selected': String(i === active),
        onmousedown: (e) => e.preventDefault(), // jaga fokus di input
        onclick: () => pick(o),
      },
      o.kind === 'existing'
        ? [h('b', null, o.c.name), h('small', null, fmtPhone(o.c.phone))]
        : [h('b', null, `+ Customer baru: “${o.name}”`)]);
      return h('li', { role: 'presentation' }, btn);
    }));
    list.hidden = opts.length === 0;
    nameInput.setAttribute('aria-expanded', String(!list.hidden));
    list._opts = opts;
  }
  const runSearch = debounce(async () => {
    const q = nameInput.value.trim();
    if (q.length < 2) { results = []; renderList(); return; }
    const id = ++reqId;
    try {
      const r = await api(`/api/customers/search?q=${encodeURIComponent(q)}`);
      if (id !== reqId) return;
      results = r.customers;
    } catch { results = []; }
    renderList();
  }, 200);

  function pick(o) {
    list.hidden = true;
    nameInput.setAttribute('aria-expanded', 'false');
    if (o.kind === 'existing') {
      customer = o.c;
      isNew = false;
      nameField.hidden = true;
      phoneRow.hidden = true;
      picked.hidden = false;
      picked.replaceChildren(
        h('span', { class: 'chip-ok__tick' }, icon('check', 13)),
        h('span', { class: 'chip-ok__text' }, h('b', null, o.c.name), h('small', null, `${fmtPhone(o.c.phone)} · terverifikasi`)),
        h('button', { class: 'link', type: 'button', onclick: resetCustomer }, 'Ganti'));
    } else {
      customer = null;
      isNew = true;
      nameInput.value = o.name;
      phoneRow.hidden = false;
      phoneInput.focus();
    }
    refresh();
  }
  function resetCustomer() {
    customer = null; isNew = false; results = []; active = -1;
    nameInput.value = '';
    if (!selected.size) note.value = '';
    phoneInput.value = '';
    phoneHint.textContent = 'Customer ini belum ada di data. Isi nomor WA-nya.';
    nameField.hidden = false;
    picked.hidden = true;
    phoneRow.hidden = true;
    list.hidden = true;
    refresh();
  }

  nameInput.addEventListener('input', () => {
    customer = null; isNew = false; phoneRow.hidden = true; active = 0;
    runSearch();
    refresh();
  });
  nameInput.addEventListener('keydown', (e) => {
    const opts = list._opts || [];
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); active = (active + 1) % opts.length; renderList(); }
    else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); active = (active - 1 + opts.length) % opts.length; renderList(); }
    else if (e.key === 'Enter' && !list.hidden && opts[active]) { e.preventDefault(); pick(opts[active]); }
    else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); list.hidden = true; }
  });
  nameInput.addEventListener('blur', () => { setTimeout(() => { list.hidden = true; }, 120); });
  nameInput.addEventListener('focus', () => { if (nameInput.value.trim().length >= 2) renderList(); });
  phoneInput.addEventListener('input', () => {
    const n = normalizePhone(phoneInput.value);
    phoneHint.textContent = n ? `Akan disimpan sebagai ${fmtPhone(n)}` : 'Nomor WA belum lengkap.';
    refresh();
  });

  submit.addEventListener('click', async () => {
    if (!readyToSubmit()) return;
    submit.disabled = true;
    const body = { service_ids: [...selected.keys()] };
    body.note = note.value.trim();
    if (customer) body.customer_id = customer.id;
    else { body.customer_name = nameInput.value.trim(); body.customer_phone = phoneInput.value; }
    try {
      const r = await api('/api/records', { method: 'POST', body });
      toast(`${r.count} layanan tercatat untuk ${r.customer.name}`);
      for (const id of [...selected.keys()]) setSelected(cards.get(id), false);
      selected.clear();
      note.value = '';
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
        : 'Ketuk satu atau lebih kotak, lalu isi customer.';
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
  const q = h('input', { class: 'input', type: 'search', id: 'h-q', placeholder: 'Cari nama, nomor WA, atau layanan' });
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
        h('thead', null, h('tr', null, ['Tanggal', 'Customer', 'No WA', 'Layanan', 'Rekam Medis', ''].map((t) => h('th', null, t)))),
        h('tbody', null, records.map((r) => h('tr', null,
          h('td', { class: 'nowrap' }, fmtDate(r.created_at)),
          h('td', null, h('b', null, r.customer_name)),
          h('td', { class: 'nowrap' }, fmtPhone(r.customer_phone)),
          h('td', null, r.service_name),
          h('td', { class: 'note-cell', title: r.note || null }, r.note || '–'),
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