import { api } from './api.js';
import {
  jakartaToday, h, icon, toast, fmtDate, fmtDay, fmtTime, fmtPhone, fmtNum, fmtRp, serviceCard, openModal, confirmDialog, emptyState,
  statusPill, empPill, field, EMP_LABEL, ROLE_LABEL,
} from './ui.js';
import { createShell } from './shell.js';
import { donutCard } from './charts.js';
import { customersView } from './customers.js';

export function renderStaffApp(root, user, { onLogout }) {
  const sv = user.role === 'supervisor';
  const tabs = [{ id: 'report', label: 'Laporan' }, { id: 'customers', label: 'Customer' }];
  if (sv) tabs.push({ id: 'services', label: 'Pengaturan Layanan' }, { id: 'accounts', label: 'Akun User' });
  const shell = createShell({
    user, onLogout, tabs,
    onSelect: (id, main) => {
      if (id === 'report') reportView(main, user);
      else if (id === 'customers') customersView(main, user);
      else if (id === 'services') settingsView(main);
      else accountsView(main, user);
    },
  });
  root.append(shell.el);
  shell.select('report');
}

const dl = (label, href) => h('a', { class: 'btn btn--ghost btn--sm', href, download: '' }, icon('download', 16), label);

// ======================= LAPORAN =======================
function reportView(main, user) {
  const sv = user.role === 'supervisor';
  // Default: hanya hari ini. Kosongkan tanggal untuk melihat keseluruhan.
  const todayStr = jakartaToday();
  const from = h('input', { class: 'input', type: 'date', value: todayStr });
  const to = h('input', { class: 'input', type: 'date', value: todayStr });
  const stats = h('div', { class: 'stats' });
  const chartsBox = h('div', { class: 'charts' });
  const attBox = h('div');
  const usersBox = h('div');
  const csv = dl('CSV', '#');
  const xlsx = dl('Excel', '#');
  let usageData = [];

  const period = () => { const p = new URLSearchParams(); if (from.value) p.set('from', from.value); if (to.value) p.set('to', to.value); return p; };
  const qs = (extra = {}) => { const p = period(); for (const [k, v] of Object.entries(extra)) p.set(k, v); return p.toString(); };
  const stat = (label, value, { hero, sub, onClick } = {}) => {
    const body = [h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), sub ? h('div', { class: 'stat__sub' }, sub) : null];
    return onClick
      ? h('button', { class: `stat stat--btn${hero ? ' stat--hero' : ''}`, type: 'button', onclick: onClick }, body)
      : h('div', { class: `stat${hero ? ' stat--hero' : ''}` }, body);
  };

  function showUsage() {
    const total = usageData.reduce((a, s) => a + s.uses, 0);
    openModal({
      title: 'Pemakaian layanan', wide: false,
      content: h('div', null,
        h('p', { class: 'muted' }, `${fmtNum(total)} pelayanan dari input user${from.value || to.value ? ' pada periode terpilih' : ''}.`),
        h('div', { class: 'usage usage--list' }, usageRowEls(usageData))),
    });
  }
  function usageRowEls(rows) {
    const max = Math.max(1, ...rows.map((r) => r.uses));
    return rows.map((r) => {
      const el = h('div', { class: `usage__row${r.uses ? '' : ' is-zero'}` },
        h('span', { class: 'usage__label' }, r.name),
        h('b', null, fmtNum(r.uses)));
      el.style.setProperty('--w', `${(r.uses / max) * 100}%`);
      el.title = r.name;
      return el;
    });
  }

  async function load() {
    csv.href = `/api/staff/export?${qs({ format: 'csv' })}`;
    xlsx.href = `/api/staff/export?${qs({ format: 'xlsx' })}`;
    try {
      const [{ summary, attendance }, { users }, { rows, today }, { usage }, { charts }] = await Promise.all([
        api(`/api/staff/summary?${qs()}`), api(`/api/staff/users?${qs()}`), api(`/api/staff/attendance?${qs()}`), api(`/api/staff/usage?${qs()}`),
        api(`/api/staff/charts?${qs()}`),
      ]);
      usageData = usage;
      stats.replaceChildren(
        ...[
          sv ? stat('Total komisi', fmtRp(summary.commission), { hero: true }) : null,
          stat('Total customer', fmtNum(summary.customers)),
          stat('Total pelayanan', fmtNum(summary.services), { sub: 'Klik untuk rincian per layanan', onClick: showUsage }),
          stat('Hari terlambat', fmtNum(attendance.late), { sub: `${fmtNum(attendance.on_time)} tepat waktu · ${fmtNum(attendance.pending)} menunggu approve` }),
        ].filter(Boolean));

      chartsBox.replaceChildren(
        donutCard({ title: 'Kunjungan', subtitle: 'Per terapis · periode terpilih', unit: 'kunjungan', data: charts.visits }),
        donutCard({ title: 'Layanan', subtitle: 'Pemakaian layanan · periode terpilih', unit: 'layanan', data: charts.services }),
        donutCard({ title: 'New customer', subtitle: 'Data awal vs customer baru · seluruh data', unit: 'customer', data: charts.customers }),
        donutCard({ title: 'Jenis kelamin', subtitle: 'Seluruh data customer', unit: 'customer', data: charts.gender }));

      attBox.replaceChildren(
        h('div', { class: 'summary-chips' },
          h('span', { class: 'pill pill--late' }, `${fmtNum(attendance.late)} terlambat`),
          h('span', { class: 'pill pill--ok' }, `${fmtNum(attendance.on_time)} tepat waktu`),
          h('span', { class: 'pill pill--wait' }, `${fmtNum(attendance.pending)} menunggu approve `),
          h('span', { class: 'pill pill--off' }, `${fmtNum(attendance.expired)} tidak di-approve (tidak dihitung)`)),
        rows.length
          ? h('div', { class: 'table-wrap table-wrap--scroll' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Tanggal'), h('th', null, 'User'), h('th', { class: 'num' }, 'Customer'), h('th', { class: 'num' }, 'Pelayanan'), h('th', null, 'Status'))),
            h('tbody', null, rows.map((r) => {
              const tr = h('tr', { class: 'is-link', tabindex: '0', role: 'button', 'aria-label': `Buka data ${r.user_name} tanggal ${r.day}` },
                h('td', { class: 'nowrap' }, fmtDay(r.day)),
                h('td', null, h('b', null, r.user_name)),
                h('td', { class: 'num' }, fmtNum(r.customers)),
                h('td', { class: 'num' }, fmtNum(r.services)),
                h('td', null, statusPill(r.late, r.day < today), r.reviewed_by ? h('small', null, `oleh ${r.reviewed_by}`) : null));
              const open = () => openUserDetail({ id: r.user_id, name: r.user_name }, user, { day: r.day, period, onChanged: load });
              tr.addEventListener('click', open);
              tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
              return tr;
            }))))
          : h('div', { class: 'table-wrap' }, emptyState('Belum ada data', 'Belum ada input user pada tanggal yang dipilih.')));

      usersBox.replaceChildren(users.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, 'Nama user'), h('th', { class: 'num' }, 'Total customer'), h('th', { class: 'num' }, 'Total pelayanan'),
            sv ? h('th', { class: 'num' }, 'Total komisi') : null, h('th', { class: 'num' }, 'Terlambat (hari)'))),
          h('tbody', null, users.map((u) => {
            const tr = h('tr', { class: 'is-link', tabindex: '0', role: 'button', 'aria-label': `Lihat detail ${u.name}` },
              h('td', null, h('b', null, u.name), ' ', u.active ? null : h('span', { class: 'pill pill--off' }, 'Nonaktif'), h('small', null, `@${u.username}`)),
              h('td', { class: 'num' }, fmtNum(u.total_customers)),
              h('td', { class: 'num' }, fmtNum(u.total_services)),
              sv ? h('td', { class: 'num' }, fmtRp(u.total_commission)) : null,
              h('td', { class: 'num' }, fmtNum(u.late_days)));
            const open = () => openUserDetail(u, user, { period, onChanged: load });
            tr.addEventListener('click', open);
            tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
            return tr;
          }))))
        : h('div', { class: 'table-wrap' }, emptyState('Belum ada user', 'Buat akun user di tab Akun User.')));

    } catch (e) {
      stats.replaceChildren();
      chartsBox.replaceChildren();
      usersBox.replaceChildren(emptyState('Laporan belum bisa dimuat', e.message));
    }
  }
  from.addEventListener('change', load);
  to.addEventListener('change', load);

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Laporan'), h('p', { class: 'muted' }, 'Rekap input semua user. Default menampilkan hari ini; ubah atau kosongkan tanggal untuk periode lain.')),
      h('div', { class: 'toolbar' },
        field('Dari tanggal', from), field('Sampai tanggal', to),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tarik data'), h('div', { class: 'toolbar' }, csv, xlsx)))),
    stats,
    h('div', { class: 'section-head' }, h('h2', null, 'Grafik customer')),
    chartsBox,
    h('div', { class: 'section-head' }, h('h2', null, 'Laporan Kinerja')),
    attBox,
    h('div', { class: 'section-head' }, h('h2', null, 'Data user')),
    usersBox);
  load();
}

// ======================= DETAIL USER + APPROVE =======================
function openUserDetail(u, me, { day: startDay, period, onChanged }) {
  const sv = me.role === 'supervisor';
  const body = h('div', null, h('p', { class: 'muted' }, 'Memuat…'));
  openModal({ title: u.name, content: body, size: 'detail' });

  async function load(day) {
    try {
      const q = day ? `?day=${day}` : '';
      const d = await api(`/api/staff/users/${u.id}/detail${q}`);
      render(d);
    } catch (e) {
      body.replaceChildren(emptyState('Detail belum bisa dimuat', e.message));
    }
  }

  // ---------- kartu persetujuan ----------
  // Approve hanya bisa pada hari yang sama (d.today). Hari lewat: kartu hanya baca.
  function approveBox(d) {
    if (!d.day) return null;
    const dayLabel = fmtDay(d.day);
    const isToday = d.day === d.today;
    const lockText = icon('lock', 14);
    const head = (badge) => h('header', { class: 'approve__head' },
      h('div', null, h('h3', { class: 'approve__title' }, 'Persetujuan data'), h('p', { class: 'approve__date' }, dayLabel)), badge);

    // Dua pilihan besar (kartu radio): tepat waktu / terlambat
    function choices(initial, onChange) {
      const name = `late-${Math.random().toString(36).slice(2, 7)}`;
      const mk = (val, iconName, title, sub) => {
        const input = h('input', { type: 'radio', name, value: val, checked: initial === (val === 'late') ? true : null });
        input.addEventListener('change', () => onChange(val === 'late'));
        return h('label', { class: `choice choice--${val}` }, input,
          h('span', { class: 'choice__card' }, h('span', { class: 'choice__icon' }, icon(iconName, 20)), h('span', { class: 'choice__text' }, h('b', null, title), h('small', null, sub))));
      };
      return h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Status masuk' },
        mk('ontime', 'check', 'Tepat waktu', 'Masuk sesuai jadwal'),
        mk('late', 'clock', 'Terlambat', 'Masuk melewati jadwal'));
    }
    async function save(late) {
      try {
        await api('/api/staff/reviews', { method: 'POST', body: { user_id: u.id, day: d.day, late } });
        toast('Data di-approve');
        await load(d.day); onChanged();
      } catch (e) { toast(e.message, 'err'); await load(d.day); }
    }

    const rv = d.review;

    // --- belum di-approve ---
    if (!rv) {
      if (!isToday) {
        return h('section', { class: 'approve approve--expired', 'aria-label': 'Persetujuan data' },
          head(h('span', { class: 'pill pill--off' }, 'Tidak di-approve')),
          h('p', { class: 'approve__note' }, 'Hari ini sudah lewat dan data tidak di-approve, jadi tidak dihitung ke laporan keterlambatan. Approve hanya bisa dilakukan pada hari yang sama.'));
      }
      let late = null;
      const btn = h('button', { class: 'btn btn--primary approve__btn', type: 'button', disabled: true, onclick: () => save(late) }, 'Approve data ini');
      const hint = h('p', { class: 'approve__hint' }, 'Pilih status masuk dulu untuk mengaktifkan tombol Approve.');
      return h('section', { class: 'approve', 'aria-label': 'Persetujuan data' },
        head(h('span', { class: 'pill pill--wait' }, 'Belum di-approve')),
        h('p', { class: 'approve__q' }, 'Bagaimana kehadiran user pada tanggal ini?'),
        choices(null, (v) => { late = v; btn.disabled = false; hint.hidden = true; }),
        btn, hint,
        h('p', { class: 'approve__lock' }, lockText, 'Setelah di-approve, data hari ini dikunci: user tidak bisa menghapus atau menambah.'));
    }

    // --- sudah di-approve ---
    const doneBadge = h('span', { class: 'approve__done' }, icon('check', 14), 'Di-approve');
    const result = h('div', { class: `approve__result approve__result--${rv.late ? 'late' : 'ok'}` },
      h('span', { class: 'choice__icon' }, icon(rv.late ? 'clock' : 'check', 20)),
      h('div', null, h('b', null, rv.late ? 'Terlambat' : 'Tepat waktu'), h('small', null, `Oleh ${rv.reviewed_by} · ${fmtDate(rv.reviewed_at)}`)));
    if (!sv) {
      const msg = 'Data dikunci. Hanya supervisor yang bisa mengubah status atau membatalkan approve.';
      return h('section', { class: 'approve approve--done', 'aria-label': 'Persetujuan data' }, head(doneBadge), result,
        h('p', { class: 'approve__lock' }, icon('lock', 14), msg));
    }
    let late = !!rv.late;
    const saveBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true, onclick: () => save(late) }, 'Simpan perubahan');
    return h('section', { class: 'approve approve--done', 'aria-label': 'Persetujuan data' }, head(doneBadge), result,
      h('div', { class: 'approve__edit' },
        h('p', { class: 'approve__q' }, 'Ubah status masuk'),
        choices(late, (v) => { late = v; saveBtn.disabled = v === !!rv.late; }),
        h('div', { class: 'approve__actions' }, saveBtn,
          h('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onclick: async () => {
              if (!(await confirmDialog('Batalkan approve? User bisa menghapus atau menambah data hari itu lagi.', { confirmText: 'Batalkan approve', danger: true }))) return;
              try { await api(`/api/sv/reviews?user_id=${u.id}&day=${d.day}`, { method: 'DELETE' }); toast('Approve dibatalkan'); await load(d.day); onChanged(); } catch (e) { toast(e.message, 'err'); }
            },
          }, 'Batalkan approve'))));
  }

  function render(d) {
    const exp = (fmt) => { const p = period(); p.set('user_id', u.id); p.set('format', fmt); return `/api/staff/export?${p}`; };
    const customers = new Set(d.records.map((r) => r.customer_id)).size;
    const commission = sv ? d.records.reduce((a, r) => a + r.commission, 0) : 0;
    const pills = [
      empPill(d.user.employment),
      h('span', { class: 'pill' }, `${fmtNum(customers)} customer`),
      h('span', { class: 'pill' }, `${fmtNum(d.records.length)} pelayanan`),
      sv ? h('span', { class: 'pill' }, `${fmtRp(commission)} komisi`) : null,
    ];
    const heads = ['No RM', 'Nama customer', 'No WA', 'Pelayanan', 'Rekam Medis', ...(sv ? ['Komisi'] : []), 'Jam', ...(sv ? [''] : [])];
    const table = d.records.length
      ? h('div', { class: 'table-wrap table-wrap--detail' }, h('table', { class: 'tbl-detail' },
        h('thead', null, h('tr', null, heads.map((t) => h('th', { class: t === 'Komisi' ? 'num' : null }, t)))),
        h('tbody', null, d.records.map((r) => h('tr', null,
          h('td', { class: 'nowrap' }, r.customer_rm || h('span', { class: 'muted' }, '–')),
          h('td', null, h('b', null, r.customer_name)),
          h('td', { class: 'nowrap' }, fmtPhone(r.customer_phone)),
          h('td', null, r.service_name, r.source === 'bot' ? h('small', null, 'via WA bot') : null),
          h('td', null, r.note ? h('div', { class: 'note' }, r.note) : h('span', { class: 'muted' }, '–')),
          sv ? h('td', { class: 'num nowrap' }, fmtRp(r.commission)) : null,
          h('td', { class: 'nowrap' }, fmtTime(r.created_at)),
          sv ? h('td', { class: 'td-act' }, h('button', {
            class: 'icon-btn icon-btn--danger', type: 'button', title: 'Hapus', 'aria-label': `Hapus ${r.service_name} untuk ${r.customer_name}`,
            onclick: async () => {
              if (!(await confirmDialog(`Hapus “${r.service_name}” untuk ${r.customer_name}? Total komisi ikut berkurang.`, { confirmText: 'Hapus', danger: true }))) return;
              try { await api(`/api/records/${r.id}`, { method: 'DELETE' }); toast('Data dihapus'); await load(d.day); onChanged(); } catch (e) { toast(e.message, 'err'); }
            },
          }, icon('trash'))) : null)))))
      : emptyState('Belum ada data', 'User ini belum menginput pelayanan.');

    // Urutan tampilan: ringkasan → tarik data → persetujuan → data pelayanan
    body.replaceChildren(h('div', { class: 'detail' },
      h('div', { class: 'summary-chips summary-chips--tight' }, pills),
      h('div', { class: 'detail__export' }, h('span', { class: 'label' }, 'Tarik data'), dl('CSV', exp('csv')), dl('Excel', exp('xlsx'))),
      approveBox(d),
      d.day ? h('h4', { class: 'detail__label' }, `Data pelayanan · ${fmtDay(d.day)}`) : null,
      table));
  }
  load(startDay);
}

// ======================= PENGATURAN LAYANAN (SUPERVISOR) =======================
function settingsView(main) {
  const content = h('div');
  const tabs = [['boxes', 'Kotak layanan'], ['comm', 'Perbedaan komisi']];
  const btns = new Map();
  const bar = h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([id, label]) => {
    const b = h('button', { class: 'subtab', type: 'button', role: 'tab', onclick: () => show(id) }, label);
    btns.set(id, b);
    return b;
  }));
  function show(id) {
    for (const [k, b] of btns) { if (k === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    content.replaceChildren();
    (id === 'boxes' ? boxesView : commissionView)(content);
  }
  main.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Pengaturan layanan'))), bar, content);
  show('boxes');
}

async function boxesView(box) {
  const grid = h('div', { class: 'svc-grid' });
  box.append(h('p', { class: 'muted mb' }, 'Ketuk kotak untuk mengubah nama dan foto. Komisi diatur di tab Perbedaan komisi.'), grid);
  async function load() {
    try {
      const { services } = await api('/api/services');
      grid.replaceChildren(...services.map((s) => serviceCard(s, { editIcon: true, onClick: () => openServiceEditor(s, load) })));
    } catch (e) { grid.replaceChildren(emptyState('Layanan belum bisa dimuat', e.message)); }
  }
  load();
}

function resizeToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const W = 480, H = 600;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const scale = Math.max(W / img.width, H / img.height);
      canvas.getContext('2d').drawImage(img, (W - img.width * scale) / 2, (H - img.height * scale) / 2, img.width * scale, img.height * scale);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('File gambar tidak bisa dibaca')); };
    img.src = url;
  });
}

function openServiceEditor(s, onSaved) {
  let photo;
  const name = h('input', { class: 'input', value: s.name, maxlength: '100' });
  const err = h('p', { class: 'error', role: 'alert' });
  const preview = h('div', { class: 'photo-edit__preview' });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
  const removeBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Hapus foto');
  function paint() {
    const url = photo === undefined ? s.photo : photo;
    preview.style.backgroundImage = url ? `url("${url}")` : '';
    preview.textContent = url ? '' : String(s.position);
    removeBtn.hidden = !url;
  }
  paint();
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try { photo = await resizeToDataUrl(f); paint(); } catch (e) { err.textContent = e.message; }
  });
  removeBtn.addEventListener('click', () => { photo = null; paint(); });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan');
  const form = h('form', null,
    field('Nama layanan', name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Foto kotak'),
      h('div', { class: 'photo-edit' }, preview,
        h('div', { class: 'photo-edit__btns' },
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => file.click() }, 'Pilih foto'),
          removeBtn, file, h('span', { class: 'hint' }, 'Otomatis dipotong rasio 4:5.')))),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({ title: `Layanan ${s.position}`, content: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    const body = { name: name.value };
    if (photo !== undefined) body.photo = photo;
    try {
      await api(`/api/sv/services/${s.id}`, { method: 'PATCH', body });
      modal.close(); toast('Layanan disimpan'); onSaved();
    } catch (ex) { err.textContent = ex.message; save.disabled = false; }
  });
}

async function commissionView(box) {
  const wrap = h('div');
  box.append(
    h('p', { class: 'muted mb' }, 'Komisi diatur per user dan per layanan, tidak ada komisi umum. Layanan yang belum diisi dihitung Rp0.'),
    wrap);
  async function load() {
    try {
      const { users, total_services: total } = await api('/api/sv/commissions');
      wrap.replaceChildren(users.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Nama user'), h('th', null, 'Status kerja'), h('th', { class: 'num' }, 'Komisi terisi'), h('th', null, ''))),
          h('tbody', null, users.map((u) => h('tr', null,
            h('td', null, h('b', null, u.name), ' ', u.active ? null : h('span', { class: 'pill pill--off' }, 'Nonaktif'), h('small', null, `@${u.username}`)),
            h('td', null, empPill(u.employment)),
            h('td', { class: 'num' }, u.filled === 0 ? h('span', { class: 'pill pill--wait' }, 'Belum diisi') : `${u.filled} dari ${total} layanan`),
            h('td', null, h('div', { class: 'row-actions' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openCommissionEditor(u, users, load) }, 'Atur komisi'))))))))
        : h('div', { class: 'table-wrap' }, emptyState('Belum ada user', 'Buat akun user di tab Akun User dulu.')));
    } catch (e) { wrap.replaceChildren(emptyState('Data komisi belum bisa dimuat', e.message)); }
  }
  load();
}

async function openCommissionEditor(u, allUsers, onSaved) {
  const content = h('div', null, h('p', { class: 'muted' }, 'Memuat…'));
  const modal = openModal({ title: u.name, content, wide: true }); // nama user di paling atas
  let items;
  try { ({ items } = await api(`/api/sv/commissions/${u.id}`)); } catch (e) { content.replaceChildren(emptyState('Komisi belum bisa dimuat', e.message)); return; }
  const inputs = new Map();
  const grid = h('div', { class: 'comm-grid' }, items.map((it) => {
    const input = h('input', { class: 'input', type: 'number', min: '0', step: '500', inputmode: 'numeric', value: String(it.amount), id: `cm${it.service_id}`, 'aria-label': `Komisi ${it.name}` });
    inputs.set(it.service_id, input);
    return h('div', { class: 'comm-row' }, h('label', { for: `cm${it.service_id}`, title: it.name }, `${it.position}. ${it.name}`), input);
  }));
  const others = allUsers.filter((x) => x.id !== u.id);
  const src = h('select', { class: 'input select', id: 'copy-from' }, h('option', { value: '' }, 'Pilih user…'), others.map((x) => h('option', { value: x.id }, `${x.name} (${EMP_LABEL[x.employment]})`)));
  const apply = h('input', { type: 'checkbox', id: 'comm-hist' });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Simpan komisi');
  content.replaceChildren(
    h('div', { class: 'summary-chips summary-chips--tight' }, empPill(u.employment), h('span', { class: 'muted' }, `@${u.username}`)),
    others.length ? h('div', { class: 'copyrow' },
      h('div', { class: 'field' }, h('label', { for: 'copy-from' }, 'Salin angka dari user lain (belum disimpan)'), src),
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: async () => {
          if (!src.value) return;
          try {
            const { items: from } = await api(`/api/sv/commissions/${src.value}`);
            for (const it of from) inputs.get(it.service_id).value = String(it.amount);
            toast('Angka disalin. Periksa lalu klik Simpan komisi.');
          } catch (e) { toast(e.message, 'err'); }
        },
      }, 'Salin')) : null,
    grid,
    h('label', { class: 'check', for: 'comm-hist' }, apply, h('span', null, 'Terapkan juga ke data yang sudah tercatat milik user ini. Jika tidak dicentang, komisi baru hanya berlaku untuk input berikutnya.')),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  save.addEventListener('click', async () => {
    err.textContent = '';
    const amounts = {};
    for (const [id, input] of inputs) {
      const n = Number(input.value === '' ? 0 : input.value);
      if (!Number.isInteger(n) || n < 0) { err.textContent = 'Komisi harus angka bulat 0 atau lebih'; input.focus(); return; }
      amounts[id] = n;
    }
    save.disabled = true;
    try {
      await api(`/api/sv/commissions/${u.id}`, { method: 'PUT', body: { amounts, apply_to_history: apply.checked } });
      modal.close(); toast(`Komisi ${u.name} disimpan`); onSaved();
    } catch (ex) { err.textContent = ex.message; save.disabled = false; }
  });
}

// ======================= AKUN (SUPERVISOR) =======================
function accountsView(main, me) {
  const box = h('div');
  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Akun user'), h('p', { class: 'muted' }, 'Hanya akun yang terdaftar di sini yang bisa masuk.')),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openAccountEditor(null, load, me) }, icon('plus', 18), 'Tambah akun')),
    box);
  async function load() {
    try {
      const { accounts } = await api('/api/sv/accounts');
      box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Nama', 'Username', 'Jenis akun', 'Status kerja', 'Status', ''].map((t) => h('th', null, t)))),
        h('tbody', null, accounts.map((a) => h('tr', null,
          h('td', null, h('b', null, a.name)),
          h('td', null, a.username),
          h('td', null, ROLE_LABEL[a.role]),
          h('td', null, a.role === 'user' ? empPill(a.employment) : h('span', { class: 'muted' }, '–')),
          h('td', null, h('span', { class: `pill${a.active ? '' : ' pill--off'}` }, a.active ? 'Aktif' : 'Nonaktif')),
          h('td', null, h('div', { class: 'row-actions' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openAccountEditor(a, load, me) }, 'Ubah')))))))));
    } catch (e) { box.replaceChildren(emptyState('Akun belum bisa dimuat', e.message)); }
  }
  load();
}

function openAccountEditor(account, onSaved, me) {
  const creating = !account;
  const isSelf = !creating && account.id === me.id;
  const name = h('input', { class: 'input', value: account ? account.name : '', maxlength: '100' });
  const username = h('input', { class: 'input', value: account ? account.username : '', maxlength: '32', autocapitalize: 'none', spellcheck: 'false', disabled: !creating });
  const password = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: creating ? '' : 'Kosongkan jika tidak diganti' });
  const role = h('select', { class: 'input select', disabled: isSelf },
    [['user', 'User (input layanan)'], ['admin', 'Admin (lihat data, approve, tanpa komisi)'], ['supervisor', 'Supervisor (akses penuh)']]
      .map(([v, l]) => h('option', { value: v, selected: (account ? account.role : 'user') === v ? true : null }, l)));
  const employment = h('select', { class: 'input select' },
    [['tetap', EMP_LABEL.tetap], ['part_time', EMP_LABEL.part_time]].map(([v, l]) => h('option', { value: v, selected: (account ? account.employment : 'tetap') === v ? true : null }, l)));
  const empField = field('Status kerja', employment, 'Dipakai untuk membedakan komisi karyawan tetap dan part time.');
  const syncEmp = () => { empField.hidden = role.value !== 'user'; };
  role.addEventListener('change', syncEmp); syncEmp();
  const active = h('input', { type: 'checkbox', id: 'acc-active', checked: creating || !!account.active, disabled: isSelf });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan');
  const form = h('form', null,
    field('Nama (tampil di kotak layanan)', name),
    field('Username untuk login', username, creating ? 'Huruf, angka, titik, atau strip. Tidak bisa diubah nanti.' : null),
    field(creating ? 'Password' : 'Password baru', password, 'Minimal 8 karakter. Sampaikan ke yang bersangkutan secara langsung.'),
    field('Jenis akun', role, isSelf ? 'Anda tidak bisa mengubah jenis akun sendiri.' : null),
    empField,
    creating ? null : h('label', { class: 'check', for: 'acc-active' }, active, h('span', null, 'Akun aktif (bisa login)')),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({ title: creating ? 'Tambah akun' : `Ubah ${account.name}`, content: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    try {
      const common = { name: name.value, role: role.value, employment: employment.value };
      if (creating) await api('/api/sv/accounts', { method: 'POST', body: { ...common, username: username.value, password: password.value } });
      else {
        const body = { ...common, active: active.checked };
        if (password.value) body.password = password.value;
        await api(`/api/sv/accounts/${account.id}`, { method: 'PATCH', body });
      }
      modal.close(); toast(creating ? 'Akun ditambahkan' : 'Akun diperbarui'); onSaved();
    } catch (ex) { err.textContent = ex.message; save.disabled = false; }
  });
}