import { api } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, fmtBirth, GENDER_LABEL, openModal, emptyState, field, debounce,
} from './ui.js';

const HEADERS = ['No', 'No RM', 'Reimburse', 'Nama', 'Jenis Kelamin', 'Tgl Lahir', 'No WA', 'Pekerjaan', 'Domisili', 'Bulan', 'Referensi'];
const dl = (label, href) => h('a', { class: 'btn btn--ghost btn--sm', href, download: '' }, icon('download', 16), label);
const dash = (v) => (v ? v : h('span', { class: 'muted' }, '–'));

// ======================= MENU CUSTOMER =======================
export function customersView(main) {
  const q = h('input', { class: 'input', type: 'search', id: 'c-q', placeholder: 'Cari No RM, nama, domisili, pekerjaan, atau referensi' });
  const summary = h('p', { class: 'muted' }, 'Memuat…');
  const box = h('div');
  const pager = h('div', { class: 'pager' });
  const csv = dl('CSV', '#');
  const xlsx = dl('Excel', '#');
  let page = 1;

  async function load() {
    const qs = new URLSearchParams({ q: q.value.trim() });
    csv.href = `/api/staff/customers/export?${new URLSearchParams({ q: q.value.trim(), format: 'csv' })}`;
    xlsx.href = `/api/staff/customers/export?${new URLSearchParams({ q: q.value.trim(), format: 'xlsx' })}`;
    qs.set('page', String(page));
    try {
      const { customers, total, page_size: size, offset } = await api(`/api/staff/customers?${qs}`);
      const pages = Math.max(1, Math.ceil(total / size));
      if (page > pages) { page = pages; return load(); }
      summary.textContent = `${fmtNum(total)} customer${q.value.trim() ? ' cocok dengan pencarian' : ''}`;
      box.replaceChildren(customers.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl-rm' },
          h('thead', null, h('tr', null, [...HEADERS, 'Riwayat'].map((t) => h('th', { class: t === 'No' ? 'num' : null }, t)))),
          h('tbody', null, customers.map((c, i) => h('tr', null,
            h('td', { class: 'num' }, fmtNum(offset + i + 1)),
            h('td', { class: 'nowrap' }, c.rm_no ? h('b', null, c.rm_no) : h('span', { class: 'pill pill--wait', title: 'Customer lama tanpa No RM. Klik Ubah untuk mengisinya.' }, 'Belum ada')),
            h('td', null, dash(c.reimburse)),
            h('td', null, h('b', null, c.name), c.origin === 'baru' ? h('small', null, h('span', { class: 'pill pill--emp-part_time', title: 'Customer baru yang dilaporkan user' }, 'Customer baru')) : null),
            h('td', { class: 'nowrap' }, dash(GENDER_LABEL[c.gender])),
            h('td', { class: 'nowrap' }, dash(fmtBirth(c.birth_date))),
            h('td', { class: 'nowrap' }, dash(c.phone ? fmtPhone(c.phone) : '')),
            h('td', null, dash(c.occupation)),
            h('td', null, dash(c.domicile)),
            h('td', null, dash(c.month)),
            h('td', null, dash(c.reference)),
            h('td', null, h('div', { class: 'cust-act' },
              h('button', { class: 'link nowrap', type: 'button', onclick: () => openVisits(c) }, c.visits ? `${fmtNum(c.visits)}× terapi` : 'Belum ada'),
              h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openCustomerForm(c, load) }, 'Ubah'))))))))
        : h('div', { class: 'table-wrap' }, emptyState(
          q.value.trim() ? 'Customer tidak ditemukan' : 'Data customer masih kosong',
          q.value.trim() ? 'Coba kata kunci lain.' : 'Klik “Upload data” untuk mengunggah file, atau “Tambah customer” untuk memasukkan satu per satu.')));

      pager.replaceChildren(...(pages > 1 ? [
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: page <= 1, onclick: () => { page--; load(); } }, 'Sebelumnya'),
        h('span', { class: 'muted' }, `Halaman ${fmtNum(page)} dari ${fmtNum(pages)}`),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: page >= pages, onclick: () => { page++; load(); } }, 'Berikutnya'),
      ] : []));
    } catch (e) {
      box.replaceChildren(emptyState('Customer belum bisa dimuat', e.message));
      pager.replaceChildren();
    }
  }

  q.addEventListener('input', debounce(() => { page = 1; load(); }, 250));

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Riwayat customer'), summary),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openCustomerForm(null, load) }, icon('plus', 18), 'Tambah customer'),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => openImport(() => { page = 1; load(); }) }, icon('download', 16), 'Upload data'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tarik data'), h('div', { class: 'toolbar' }, csv, xlsx)))),
    h('div', { class: 'toolbar mb' }, h('div', { class: 'field toolbar__grow' }, h('label', { for: 'c-q' }, 'Cari'), q)),
    box, pager);
  load();
}

// ======================= RIWAYAT TERAPI (per customer) =======================
async function openVisits(c) {
  const content = h('div', null, h('p', { class: 'muted' }, 'Memuat…'));
  openModal({ title: c.name, content });
  try {
    const { visits } = await api(`/api/staff/customers/${c.id}/visits`);
    content.replaceChildren(
      h('p', { class: 'muted' }, `No RM ${c.rm_no || '–'}${c.phone ? ` · ${fmtPhone(c.phone)}` : ''} · ${fmtNum(visits.length)} kali terapi`),
      ...(visits.length ? visits.map((v) => h('div', { class: 'visit' },
        h('b', null, fmtDate(v.created_at)),
        h('div', { class: 'muted' }, `${v.services.join(', ')} · oleh ${v.therapist}`),
        v.note ? h('div', { class: 'note note--gap' }, v.note) : null)) : [emptyState('Belum ada riwayat', 'Customer ini belum pernah dicatat layanannya.')]));
  } catch (e) { content.replaceChildren(emptyState('Riwayat belum bisa dimuat', e.message)); }
}

// ======================= TAMBAH / UBAH CUSTOMER =======================
function openCustomerForm(c, onSaved) {
  const creating = !c;
  const text = (id, value, extra = {}) => h('input', { class: 'input', id, type: 'text', value: value || '', autocomplete: 'off', ...extra });
  const rm = text('cf-rm', c?.rm_no, { maxlength: '40' });
  const name = text('cf-name', c?.name, { maxlength: '100' });
  const reimburse = text('cf-reimburse', c?.reimburse, { maxlength: '60' });
  const gender = h('select', { class: 'input select', id: 'cf-gender' },
    [['', 'Belum diisi'], ['L', 'Laki-laki'], ['P', 'Perempuan']].map(([v, l]) => h('option', { value: v, selected: (c?.gender || '') === v ? true : null }, l)));
  const birth = h('input', { class: 'input', id: 'cf-birth', type: 'date', value: c?.birth_date || '' });
  const phone = h('input', { class: 'input', id: 'cf-phone', type: 'tel', inputmode: 'tel', value: c?.phone || '', placeholder: '0812 3456 7890', autocomplete: 'off' });
  const occupation = text('cf-job', c?.occupation, { maxlength: '100' });
  const domicile = text('cf-dom', c?.domicile, { maxlength: '150' });
  const month = text('cf-month', c?.month, { maxlength: '40' });
  const reference = text('cf-ref', c?.reference, { maxlength: '150' });
  const origin = h('select', { class: 'input select', id: 'cf-origin' },
    [['baru', 'Customer baru (dilaporkan user)'], ['awal', 'Data awal (tambahan data admin)']]
      .map(([v, l]) => h('option', { value: v, selected: (c?.origin || 'baru') === v ? true : null }, l)));
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, creating ? 'Simpan customer' : 'Simpan perubahan');

  const form = h('form', null,
    creating ? h('p', { class: 'muted mb' }, 'Dipakai saat user melapor bahwa No RM customer tidak ditemukan, atau untuk menambah data awal.') : null,
    h('div', { class: 'form-grid' },
      field('No RM', rm, 'Wajib dan harus unik. User mencari customer lewat No RM ini.'),
      field('Nama', name),
      field('Reimburse', reimburse, 'Contoh: Ya, Tidak, atau nama asuransi.'),
      field('Jenis Kelamin', gender),
      field('Tgl Lahir', birth),
      field('No WA', phone),
      field('Pekerjaan', occupation),
      field('Domisili', domicile),
      field('Bulan', month, 'Contoh: Oktober 2026.'),
      field('Referensi', reference),
      field('Asal data', origin, 'Dipakai untuk grafik “Data awal” vs “Customer baru”.')),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  const modal = openModal({ title: creating ? 'Tambah customer' : `Ubah ${c.name}`, content: form, wide: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    const body = {
      rm_no: rm.value, name: name.value, reimburse: reimburse.value, gender: gender.value, birth_date: birth.value, phone: phone.value,
      occupation: occupation.value, domicile: domicile.value, month: month.value, reference: reference.value, origin: origin.value,
    };
    try {
      if (creating) await api('/api/staff/customers', { method: 'POST', body });
      else await api(`/api/staff/customers/${c.id}`, { method: 'PATCH', body });
      modal.close();
      toast(creating ? 'Customer ditambahkan' : 'Data customer diperbarui');
      onSaved();
    } catch (ex) { err.textContent = ex.message; save.disabled = false; }
  });
}

// ======================= UPLOAD DATA (CSV / EXCEL) =======================
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function openImport(onDone) {
  const file = h('input', { class: 'input', id: 'imp-file', type: 'file', accept: '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const err = h('p', { class: 'error', role: 'alert' });
  const result = h('div');
  const send = h('button', { class: 'btn btn--primary', type: 'button' }, 'Upload');

  const body = h('div', null,
    h('p', null, 'Unggah file CSV atau Excel (.xlsx) dengan baris judul seperti ini:'),
    h('p', { class: 'imp-cols' }, HEADERS.map((t) => h('span', { class: 'mini' }, t))),
    h('ul', { class: 'imp-notes' },
      h('li', null, 'Kolom ', h('b', null, 'No RM'), ' dan ', h('b', null, 'Nama'), ' wajib terisi. Kolom lain boleh kosong. Kolom No diabaikan (nomor dibuat otomatis).'),
      h('li', null, 'No RM yang sudah ada akan diperbarui; yang belum ada ditambahkan. Sel kosong tidak menghapus data lama.'),
      h('li', null, 'Jenis Kelamin: L/P atau Laki-laki/Perempuan. Tgl Lahir: 31/12/1990.')),
    h('div', { class: 'toolbar mb' }, h('span', { class: 'label' }, 'Template kosong'),
      dl('CSV', '/api/staff/customers/template?format=csv'), dl('Excel', '/api/staff/customers/template?format=xlsx')),
    field('File data customer', file),
    err, result,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Tutup'), send));
  const modal = openModal({ title: 'Upload data customer', content: body, wide: true });

  send.addEventListener('click', async () => {
    err.textContent = '';
    result.replaceChildren();
    const f = file.files[0];
    if (!f) { err.textContent = 'Pilih file dulu.'; return; }
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx')) { err.textContent = 'Format file harus .csv atau .xlsx. File .xls lama: simpan ulang sebagai .xlsx.'; return; }
    if (f.size > 20 * 1024 * 1024) { err.textContent = 'Ukuran file maksimal 20 MB.'; return; }
    send.disabled = true;
    send.textContent = 'Memproses…';
    try {
      const payload = lower.endsWith('.csv')
        ? { format: 'csv', content: await f.text() }
        : { format: 'xlsx', content: toBase64(await f.arrayBuffer()) };
      const { result: r } = await api('/api/staff/customers/import', { method: 'POST', body: payload });
      toast(`${fmtNum(r.added)} ditambahkan, ${fmtNum(r.updated)} diperbarui`);
      result.replaceChildren(
        h('div', { class: 'summary-chips summary-chips--tight imp-sum' },
          h('span', { class: 'pill pill--ok' }, `${fmtNum(r.added)} ditambahkan`),
          h('span', { class: 'pill' }, `${fmtNum(r.updated)} diperbarui`),
          h('span', { class: `pill ${r.skipped ? 'pill--late' : 'pill--off'}` }, `${fmtNum(r.skipped)} dilewati`)),
        r.issues.length ? h('div', { class: 'imp-issues' },
          h('b', null, 'Catatan'),
          h('ul', null, r.issues.map((i) => h('li', null, i.line ? h('b', null, `Baris ${i.line}${i.skipped ? ' (dilewati)' : ''}: `) : null, i.text)))) : null);
      file.value = '';
      onDone();
    } catch (ex) { err.textContent = ex.message; }
    send.disabled = false;
    send.textContent = 'Upload';
  });
}