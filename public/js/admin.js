import { api } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, fmtRp, serviceCard, openModal, confirmDialog, emptyState,
} from './ui.js';
import { createShell } from './shell.js';

export function renderAdminApp(root, user, { onLogout }) {
  const shell = createShell({
    user,
    onLogout,
    tabs: [
      { id: 'report', label: 'Laporan' },
      { id: 'services', label: 'Pengaturan Layanan' },
      { id: 'accounts', label: 'Akun User' },
    ],
    onSelect: (id, main) => {
      if (id === 'report') reportView(main, () => shell.select('services'));
      else if (id === 'services') servicesView(main);
      else accountsView(main, user);
    },
  });
  root.append(shell.el);
  shell.select('report');
}

const field = (label, input, hint) => {
  const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
};

// ======================= LAPORAN =======================
function reportView(main, goSettings) {
  const from = h('input', { class: 'input', type: 'date' });
  const to = h('input', { class: 'input', type: 'date' });
  const stats = h('div', { class: 'stats' });
  const tableBox = h('div');
  const csv = h('a', { class: 'btn btn--ghost btn--sm', download: '' }, icon('download', 16), 'CSV');
  const xlsx = h('a', { class: 'btn btn--ghost btn--sm', download: '' }, icon('download', 16), 'Excel');

  const period = () => new URLSearchParams({ from: from.value, to: to.value });
  const withPeriod = (extra = {}) => { const p = period(); for (const [k, v] of Object.entries(extra)) p.set(k, v); return p.toString(); };

  const stat = (label, value, hero) => h('div', { class: `stat${hero ? ' stat--hero' : ''}` }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value));

  async function load() {
    csv.href = `/api/admin/export?${withPeriod({ format: 'csv' })}`;
    xlsx.href = `/api/admin/export?${withPeriod({ format: 'xlsx' })}`;
    try {
      const [{ summary }, { users }] = await Promise.all([
        api(`/api/admin/summary?${withPeriod()}`),
        api(`/api/admin/users?${withPeriod()}`),
      ]);
      stats.replaceChildren(
        stat('Total komisi', fmtRp(summary.commission), true),
        stat('Total customer', fmtNum(summary.customers)),
        stat('Total pelayanan', fmtNum(summary.services)));
      if (!users.length) {
        tableBox.replaceChildren(h('div', { class: 'table-wrap' }, emptyState('Belum ada user', 'Buat akun terapis di tab Akun User.')));
        return;
      }
      tableBox.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'Nama user'),
          h('th', { class: 'num' }, 'Total customer'),
          h('th', { class: 'num' }, 'Total pelayanan'),
          h('th', { class: 'num' }, 'Total komisi'))),
        h('tbody', null, users.map((u) => {
          const open = () => openUserDetail(u, period, load);
          const tr = h('tr', { class: 'is-link', tabindex: '0', role: 'button', 'aria-label': `Lihat detail ${u.name}` },
            h('td', null, h('b', null, u.name), ' ', u.active ? null : h('span', { class: 'pill pill--off' }, 'Nonaktif'), h('small', null, `@${u.username}`)),
            h('td', { class: 'num' }, fmtNum(u.total_customers)),
            h('td', { class: 'num' }, fmtNum(u.total_services)),
            h('td', { class: 'num' }, fmtRp(u.total_commission)));
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
          return tr;
        })))));
    } catch (e) {
      tableBox.replaceChildren(emptyState('Laporan belum bisa dimuat', e.message));
    }
  }
  from.addEventListener('change', load);
  to.addEventListener('change', load);

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Laporan'), h('p', { class: 'muted' }, 'Rekap hasil input semua user. Kosongkan tanggal untuk melihat keseluruhan.')),
      h('div', { class: 'toolbar' },
        field('Dari tanggal', from), field('Sampai tanggal', to),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tarik data'), h('div', { class: 'toolbar' }, csv, xlsx)))),
    stats,
    h('div', { class: 'section-head' },
      h('h2', null, 'Data user'),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: goSettings }, icon('edit', 16), 'Edit komisi layanan')),
    tableBox);
  load();
}

async function openUserDetail(u, period, onChanged) {
  const body = h('div', null, h('p', { class: 'muted' }, 'Memuat…'));
  const modal = openModal({ title: u.name, content: body, wide: true });
  async function load() {
    try {
      const p = period();
      const { records } = await api(`/api/admin/users/${u.id}/records?${p}`);
      const commission = records.reduce((a, r) => a + r.commission, 0);
      const customers = new Set(records.map((r) => r.customer_id)).size;
      const exp = (fmt) => { const q = period(); q.set('user_id', u.id); q.set('format', fmt); return `/api/admin/export?${q}`; };
      body.replaceChildren(
        h('div', { class: 'summary-chips' },
          h('span', { class: 'pill' }, `${fmtNum(customers)} customer`),
          h('span', { class: 'pill' }, `${fmtNum(records.length)} pelayanan`),
          h('span', { class: 'pill' }, `${fmtRp(commission)} komisi`),
          h('a', { class: 'btn btn--ghost btn--sm', href: exp('csv'), download: '' }, icon('download', 16), 'CSV'),
          h('a', { class: 'btn btn--ghost btn--sm', href: exp('xlsx'), download: '' }, icon('download', 16), 'Excel')),
        records.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null,
              h('th', null, 'Nama customer'), h('th', null, 'No WA'), h('th', null, 'Pelayanan'),
              h('th', { class: 'num' }, 'Komisi'), h('th', null, 'Tanggal'), h('th', null, ''))),
            h('tbody', null, records.map((r) => h('tr', null,
              h('td', null, h('b', null, r.customer_name)),
              h('td', { class: 'nowrap' }, fmtPhone(r.customer_phone)),
              h('td', null, r.service_name, r.source === 'bot' ? h('small', null, 'via WA bot') : null),
              h('td', { class: 'num nowrap' }, fmtRp(r.commission)),
              h('td', { class: 'nowrap' }, fmtDate(r.created_at)),
              h('td', null, h('button', {
                class: 'icon-btn icon-btn--danger', type: 'button', title: 'Hapus', 'aria-label': `Hapus ${r.service_name} untuk ${r.customer_name}`,
                onclick: async () => {
                  if (!(await confirmDialog(`Hapus “${r.service_name}” untuk ${r.customer_name}? Total komisi ikut berkurang.`, { confirmText: 'Hapus', danger: true }))) return;
                  try { await api(`/api/records/${r.id}`, { method: 'DELETE' }); toast('Data dihapus'); await load(); onChanged(); } catch (e) { toast(e.message, 'err'); }
                },
              }, icon('trash'))))))))
          : emptyState('Belum ada data', 'User ini belum menginput pelayanan pada periode ini.'));
    } catch (e) {
      body.replaceChildren(emptyState('Detail belum bisa dimuat', e.message));
    }
  }
  load();
  return modal;
}

// ======================= PENGATURAN LAYANAN =======================
async function servicesView(main) {
  const grid = h('div', { class: 'svc-grid' });
  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Pengaturan layanan'), h('p', { class: 'muted' }, 'Ketuk kotak untuk mengubah nama, foto, dan komisi. User tidak melihat komisi.'))),
    grid);

  async function load() {
    try {
      const { services } = await api('/api/services');
      grid.replaceChildren(...services.map((s) => serviceCard(s, {
        badge: fmtRp(s.commission),
        editIcon: true,
        onClick: () => openServiceEditor(s, load),
      })));
    } catch (e) {
      grid.replaceChildren(emptyState('Layanan belum bisa dimuat', e.message));
    }
  }
  load();
}

function resizeToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const W = 480, H = 600; // rasio 4:5 seperti kotak layanan
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(W / img.width, H / img.height);
      const w = img.width * scale, hh = img.height * scale;
      ctx.drawImage(img, (W - w) / 2, (H - hh) / 2, w, hh);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('File gambar tidak bisa dibaca')); };
    img.src = url;
  });
}

function openServiceEditor(s, onSaved) {
  let photo; // undefined = tidak berubah, null = hapus, string = foto baru
  const name = h('input', { class: 'input', value: s.name, maxlength: '100' });
  const commission = h('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(s.commission) });
  const apply = h('input', { type: 'checkbox', id: 'apply-history' });
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
    field('Komisi per layanan (Rp)', commission),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Foto kotak'),
      h('div', { class: 'photo-edit' }, preview,
        h('div', { class: 'photo-edit__btns' },
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => file.click() }, 'Pilih foto'),
          removeBtn, file,
          h('span', { class: 'hint' }, 'Otomatis dipotong rasio 4:5.')))),
    h('label', { class: 'check', for: 'apply-history' }, apply,
      h('span', null, 'Terapkan komisi ini juga ke data yang sudah tercatat. Jika tidak dicentang, komisi baru hanya berlaku untuk input berikutnya.')),
    err,
    h('div', { class: 'modal__actions' },
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({ title: `Layanan ${s.position}`, content: form });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    const body = { name: name.value, commission: Number(commission.value), apply_to_history: apply.checked };
    if (photo !== undefined) body.photo = photo;
    try {
      await api(`/api/admin/services/${s.id}`, { method: 'PATCH', body });
      modal.close();
      toast('Layanan disimpan');
      onSaved();
    } catch (ex) {
      err.textContent = ex.message;
      save.disabled = false;
    }
  });
}

// ======================= AKUN USER =======================
function accountsView(main, me) {
  const box = h('div');
  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Akun user'), h('p', { class: 'muted' }, 'Hanya akun yang terdaftar di sini yang bisa masuk.')),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openAccountEditor(null, load) }, icon('plus', 18), 'Tambah user')),
    box);

  async function load() {
    try {
      const { accounts } = await api('/api/admin/accounts');
      box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Nama'), h('th', null, 'Username'), h('th', null, 'Peran'), h('th', null, 'Status'), h('th', null, ''))),
        h('tbody', null, accounts.map((a) => h('tr', null,
          h('td', null, h('b', null, a.name)),
          h('td', null, a.username),
          h('td', null, a.role === 'admin' ? 'Admin' : 'User'),
          h('td', null, h('span', { class: `pill${a.active ? '' : ' pill--off'}` }, a.active ? 'Aktif' : 'Nonaktif')),
          h('td', null, h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openAccountEditor(a, load, me) }, 'Ubah')))))))));
    } catch (e) {
      box.replaceChildren(emptyState('Akun belum bisa dimuat', e.message));
    }
  }
  load();
}

function openAccountEditor(account, onSaved, me) {
  const creating = !account;
  const name = h('input', { class: 'input', value: account ? account.name : '', maxlength: '100' });
  const username = h('input', { class: 'input', value: account ? account.username : '', maxlength: '32', autocapitalize: 'none', spellcheck: 'false', disabled: !creating });
  const password = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: creating ? '' : 'Kosongkan jika tidak diganti' });
  const active = h('input', { type: 'checkbox', id: 'acc-active', checked: creating || !!account.active, disabled: !creating && me && account.id === me.id });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Simpan');
  const form = h('form', null,
    field('Nama (tampil di kotak layanan)', name),
    field('Username untuk login', username, creating ? 'Huruf, angka, titik, atau strip. Tidak bisa diubah nanti.' : null),
    field(creating ? 'Password' : 'Password baru', password, 'Minimal 8 karakter. Sampaikan ke user secara langsung.'),
    creating ? null : h('label', { class: 'check', for: 'acc-active' }, active, h('span', null, 'Akun aktif (bisa login)')),
    err,
    h('div', { class: 'modal__actions' },
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({ title: creating ? 'Tambah user' : `Ubah ${account.name}`, content: form });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    try {
      if (creating) {
        await api('/api/admin/accounts', { method: 'POST', body: { name: name.value, username: username.value, password: password.value } });
      } else {
        const body = { name: name.value, active: active.checked };
        if (password.value) body.password = password.value;
        await api(`/api/admin/accounts/${account.id}`, { method: 'PATCH', body });
      }
      modal.close();
      toast(creating ? 'User ditambahkan' : 'Akun diperbarui');
      onSaved();
    } catch (ex) {
      err.textContent = ex.message;
      save.disabled = false;
    }
  });
}
