import { api, downloadFile } from './api.js';
import {
  h, icon, toast, fmtDate, fmtPhone, fmtNum, fmtBirth, GENDER_LABEL, openModal, emptyState, field, debounce,
} from './ui.js';

const HEADERS = ['No', 'No RM', 'Reimburse', 'Nama', 'Jenis Kelamin', 'Tgl Lahir', 'No WA', 'Pekerjaan', 'Domisili', 'Bulan', 'Referensi', 'SOAP'];
const dash = (v) => (v ? v : h('span', { class: 'muted' }, '–'));
const isAbort = (e) => e?.name === 'AbortError';

// ctx cadangan bila tampilan dipanggil tanpa shell (mis. tes).
export const NO_CTX = { signal: undefined, isCurrent: () => true };

// ---------- pembantu bersama (dipakai staff.js dan audit.js) ----------

// Penjaga urutan permintaan: hanya permintaan TERBARU yang boleh menulis ke layar.
// begin() membatalkan permintaan sebelumnya; req.ok() false bila sudah basi
// atau tampilannya sudah diganti (ctx.isCurrent() false).
export function createGate(ctx = NO_CTX) {
  let seq = 0;
  let ctl = null;
  return {
    begin() {
      if (ctl) ctl.abort();
      ctl = new AbortController();
      const mine = ctl;
      if (ctx.signal) {
        if (ctx.signal.aborted) mine.abort();
        else ctx.signal.addEventListener('abort', () => mine.abort(), { once: true });
      }
      const id = ++seq;
      return { signal: mine.signal, ok: () => id === seq && ctx.isCurrent() };
    },
    cancel() {
      seq++;
      if (ctl) ctl.abort();
      ctl = null;
    },
  };
}

// Tombol unduh. getTarget() mengembalikan { url, filename } (dihitung saat diklik, jadi
// selalu memakai filter terbaru) atau null bila tidak boleh mengunduh.
export function downloadButton(label, getTarget) {
  const btn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('download', 16), label);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    let target;
    try { target = getTarget(); } catch (e) { toast(e.message, 'err'); return; }
    if (!target) return;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try { await downloadFile(target.url, target.filename); } catch { /* downloadFile sudah menampilkan toast */ } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
  return btn;
}

// Tabel yang bisa digulir (ponsel) dan bisa dijangkau keyboard.
export const tableWrap = (table, label, extraClass = '') => h('div', {
  class: `table-wrap${extraClass ? ` ${extraClass}` : ''}`, tabindex: '0', role: 'region', 'aria-label': label,
}, table);

// Tombol halaman. Kosong bila hanya ada satu halaman.
export function pagerNodes({ page, pages, onPage }) {
  if (pages <= 1) return [];
  return [
    h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: page <= 1, onclick: () => onPage(page - 1) }, 'Sebelumnya'),
    h('span', { class: 'muted pager__info' }, `Halaman ${fmtNum(page)} dari ${fmtNum(pages)}`),
    h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Berikutnya'),
  ];
}

// "Menampilkan 51–100 dari 1.234 customer"
export function rangeLabel({ offset, shown, total, noun }) {
  if (!total) return `Tidak ada ${noun}`;
  if (!shown) return `Menampilkan 0 dari ${fmtNum(total)} ${noun}`;
  return `Menampilkan ${fmtNum(offset + 1)}–${fmtNum(offset + shown)} dari ${fmtNum(total)} ${noun}`;
}

// ======================= MENU CUSTOMER =======================
export function customersView(main, user, ctx = NO_CTX) {
  const gate = createGate(ctx);
  const q = h('input', { class: 'input', type: 'search', id: 'c-q', placeholder: 'Cari No RM, nama, domisili, pekerjaan, referensi, atau SOAP' });
  const summary = h('p', { class: 'muted', role: 'status' }, 'Memuat…');
  const box = h('div');
  const pager = h('nav', { class: 'pager', 'aria-label': 'Halaman customer' });
  let page = 1;

  const exportTarget = (format) => ({
    url: `/api/staff/customers/export?${new URLSearchParams({ q: q.value.trim(), format })}`,
    filename: `data-customer.${format}`,
  });

  // Tinggi tabel dibatasi sesuai sisa layar: header (sticky) dan scrollbar horizontal
  // tabel selalu terlihat tanpa harus menggulir halaman ke atas/bawah.
  function fitTable() {
    const wrap = box.querySelector('.table-wrap--customers');
    if (!wrap) return;
    if (window.innerWidth <= 760) { wrap.style.maxHeight = ''; return; }
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    const room = window.innerHeight - top - 84; // 84px = ruang tombol halaman di bawah tabel
    wrap.style.maxHeight = `${Math.max(320, Math.round(room))}px`;
  }
  window.addEventListener('resize', debounce(fitTable, 100), { signal: ctx.signal });

  async function load() {
    const req = gate.begin();
    const qs = new URLSearchParams({ q: q.value.trim(), page: String(page) });
    try {
      const { customers, total, page_size: size, offset } = await api(`/api/staff/customers?${qs}`, { signal: req.signal });
      if (!req.ok()) return;
      const pages = Math.max(1, Math.ceil(total / (size || 50)));
      if (page > pages) { page = pages; return load(); }
      const searching = q.value.trim() !== '';
      summary.textContent = `${rangeLabel({ offset, shown: customers.length, total, noun: 'customer' })}${searching ? ' (cocok dengan pencarian)' : ''}`;
      box.replaceChildren(customers.length
        ? tableWrap(h('table', { class: 'tbl-rm' },
          h('thead', null, h('tr', null, [...HEADERS, 'Riwayat'].map((t) => h('th', { class: t === 'No' ? 'num' : null }, t)))),
          h('tbody', null, customers.map((c, i) => h('tr', null,
            h('td', { class: 'num', 'data-label': 'No' }, fmtNum(offset + i + 1)),
            h('td', { class: 'nowrap', 'data-label': 'No RM' }, c.rm_no ? h('b', null, c.rm_no) : h('span', { class: 'pill pill--wait', title: 'Customer lama tanpa No RM. Klik Ubah untuk mengisinya.' }, 'Belum ada')),
            h('td', { 'data-label': 'Reimburse' }, dash(c.reimburse)),
            h('td', { 'data-label': 'Nama' }, h('b', null, c.name), c.origin === 'baru' ? h('small', null, h('span', { class: 'pill pill--emp-part_time', title: 'Ditambahkan setelah data awal' }, 'Customer baru')) : null),
            h('td', { class: 'nowrap', 'data-label': 'Jenis Kelamin' }, dash(GENDER_LABEL[c.gender])),
            h('td', { class: 'nowrap', 'data-label': 'Tgl Lahir' }, dash(fmtBirth(c.birth_date))),
            h('td', { class: 'nowrap', 'data-label': 'No WA' }, dash(c.phone ? fmtPhone(c.phone) : '')),
            h('td', { 'data-label': 'Pekerjaan' }, dash(c.occupation)),
            h('td', { 'data-label': 'Domisili' }, dash(c.domicile)),
            h('td', { 'data-label': 'Bulan' }, dash(c.month)),
            h('td', { 'data-label': 'Referensi' }, dash(c.reference)),
            h('td', { class: 'cell-note', 'data-label': 'SOAP' }, dash(c.medical_note)),
            h('td', { 'data-label': 'Riwayat' }, h('div', { class: 'cust-act' },
              h('button', { class: 'link nowrap', type: 'button', onclick: () => openVisits(c, ctx) }, c.visits ? `${fmtNum(c.visits)}× terapi` : 'Belum ada'),
              h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openCustomerForm(c, load) }, 'Ubah'))))))), 'Tabel data customer', 'table-wrap--customers')
        : h('div', { class: 'table-wrap' }, emptyState(
          searching ? 'Customer tidak ditemukan' : 'Data customer masih kosong',
          searching ? 'Coba kata kunci lain.' : 'Klik “Upload data” untuk mengunggah file, atau “Tambah customer” untuk customer baru yang datang kemudian.')));
      pager.replaceChildren(...pagerNodes({ page, pages, onPage: (p) => { page = p; load(); } }));
      fitTable();
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      summary.textContent = '';
      box.replaceChildren(emptyState('Customer belum bisa dimuat', e.message));
      pager.replaceChildren();
    }
  }

  q.addEventListener('input', debounce(() => { page = 1; load(); }, 250));

  const upload = icon('download', 16);
  upload.style.transform = 'rotate(180deg)';
  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Riwayat customer'), summary),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openCustomerForm(null, load) }, icon('plus', 18), 'Tambah customer'),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => openImport(() => { page = 1; load(); }) }, upload, 'Upload data'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tarik data'),
          h('div', { class: 'toolbar' },
            downloadButton('CSV', () => exportTarget('csv')),
            downloadButton('Excel', () => exportTarget('xlsx')))))),
    h('div', { class: 'toolbar mb' }, h('div', { class: 'field toolbar__grow' }, h('label', { for: 'c-q' }, 'Cari'), q)),
    box, pager);
  load();
}

// ======================= RIWAYAT TERAPI (per customer) =======================
async function openVisits(c, ctx = NO_CTX) {
  const gate = createGate(ctx);
  const content = h('div', null, h('p', { class: 'muted' }, 'Memuat…'));
  openModal({ title: c.name, content, onClose: () => gate.cancel() });
  const req = gate.begin();
  try {
    const { visits } = await api(`/api/staff/customers/${c.id}/visits`, { signal: req.signal });
    if (!req.ok()) return;
    content.replaceChildren(
      h('p', { class: 'muted' }, `No RM ${c.rm_no || '–'}${c.phone ? ` · ${fmtPhone(c.phone)}` : ''} · ${fmtNum(visits.length)} kali terapi`),
      ...(visits.length ? visits.map((v) => h('div', { class: 'visit' },
        h('b', null, fmtDate(v.created_at)),
        h('div', { class: 'muted' }, `${v.services.join(', ')} · oleh ${v.therapist}`),
        v.note ? h('div', { class: 'note note--gap' }, v.note) : null)) : [emptyState('Belum ada riwayat', 'Customer ini belum pernah dicatat layanannya.')]));
  } catch (e) {
    if (!req.ok() || isAbort(e)) return;
    content.replaceChildren(emptyState('Riwayat belum bisa dimuat', e.message));
  }
}

// ======================= TAMBAH / UBAH CUSTOMER =======================
// 409 = No RM bentuknya sama dengan customer lain. Pesan server dipertahankan lalu diberi petunjuk tindakan.
export function duplicateMessage(serverMessage) {
  const base = String(serverMessage || 'No RM sudah terdaftar').replace(/[.\s]+$/, '');
  return `${base}. Setiap customer harus punya No RM sendiri: periksa kembali angkanya, atau cari customer tersebut di daftar lalu pilih Ubah.`;
}

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
  const reference = text('cf-ref', c?.reference, { maxlength: '150', list: 'cf-ref-list', placeholder: 'fb, ig, tiktok, IG01, atau nama lain' });
  const refList = h('datalist', { id: 'cf-ref-list' });
  api('/api/staff/platforms').then(({ platforms }) => refList.replaceChildren(...platforms.map((n) => h('option', { value: n })))).catch(() => {});
  // Singkatan platform dilengkapi saat kolom ditinggalkan, supaya terlihat sebelum disimpan.
  let refSeq = 0;
  reference.addEventListener('change', async () => {
    const typed = reference.value;
    const seq = ++refSeq;
    if (!typed.trim()) return;
    try {
      const { value, matched } = await api(`/api/staff/platforms/resolve?q=${encodeURIComponent(typed)}`);
      if (seq === refSeq && matched && reference.value === typed) reference.value = value;
    } catch { /* server tetap melengkapi saat disimpan */ }
  });
  const medical = h('textarea', { class: 'input textarea', id: 'cf-medical', rows: '4', maxlength: '2000', placeholder: 'Catatan awal tentang customer yang perlu diketahui terapis' });
  medical.value = c?.medical_note || '';
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, creating ? 'Simpan customer' : 'Simpan perubahan');

  const form = h('form', { novalidate: true },
    creating ? h('p', { class: 'muted mb' }, 'Untuk customer yang datang setelah data awal diunggah. Data awal sendiri dimasukkan lewat Upload data. Customer di sini otomatis dihitung sebagai customer baru.') : null,
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
      field('Referensi', reference, 'Ketik singkatan platform (fb, ig, tt, atau kode seperti IG01): otomatis menjadi nama lengkap, mis. Facebook. Isian lain, mis. nama teman, disimpan apa adanya.'),
      h('div', { class: 'form-grid__full' }, field('SOAP', medical, 'Hanya terlihat oleh admin dan supervisor. Maksimal 2.000 huruf.'))),
    err,
    h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Batal'), save));
  form.append(refList);
  const modal = openModal({ title: creating ? 'Tambah customer' : `Ubah ${c.name}`, content: form, wide: true });

  const flag = (el, on) => { if (on) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    flag(rm, false); flag(name, false);
    if (!rm.value.trim()) { err.textContent = 'No RM wajib diisi.'; flag(rm, true); rm.focus(); return; }
    if (!name.value.trim()) { err.textContent = 'Nama wajib diisi.'; flag(name, true); name.focus(); return; }
    save.disabled = true;
    const body = {
      rm_no: rm.value, name: name.value, reimburse: reimburse.value, gender: gender.value, birth_date: birth.value, phone: phone.value,
      occupation: occupation.value, domicile: domicile.value, month: month.value, reference: reference.value, medical_note: medical.value,
    };
    try {
      if (creating) await api('/api/staff/customers', { method: 'POST', body });
      else await api(`/api/staff/customers/${c.id}`, { method: 'PATCH', body });
      modal.close();
      toast(creating ? 'Customer ditambahkan' : 'Data customer diperbarui');
      onSaved();
    } catch (ex) {
      if (ex.status === 409) { err.textContent = duplicateMessage(ex.message); flag(rm, true); rm.focus(); rm.select?.(); } else err.textContent = ex.message;
      save.disabled = false;
    }
  });
}

// ======================= UPLOAD DATA (CSV / EXCEL) =======================
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MAX_ISSUES_SHOWN = 200;

// Ringkasan hasil impor: ditambah, diperbarui, dilewati, dan semua catatan per baris.
export function importSummary(r) {
  const added = Number(r?.added) || 0;
  const updated = Number(r?.updated) || 0;
  const skipped = Number(r?.skipped) || 0;
  const issues = Array.isArray(r?.issues) ? r.issues : [];
  return { added, updated, skipped, issues, processed: added + updated + skipped };
}

function importResult(r) {
  const s = importSummary(r);
  const shown = s.issues.slice(0, MAX_ISSUES_SHOWN);
  const li = (i) => {
    const item = typeof i === 'string' ? { text: i } : (i || {});
    return h('li', null,
      item.line ? h('b', null, `Baris ${item.line}${item.skipped ? ' (dilewati)' : ''}: `) : null,
      String(item.text ?? item.message ?? ''));
  };
  return h('div', { role: 'status' },
    h('div', { class: 'summary-chips summary-chips--tight imp-sum' },
      h('span', { class: 'pill pill--ok' }, `${fmtNum(s.added)} ditambahkan`),
      h('span', { class: 'pill' }, `${fmtNum(s.updated)} diperbarui`),
      h('span', { class: `pill ${s.skipped ? 'pill--late' : 'pill--off'}` }, `${fmtNum(s.skipped)} dilewati`),
      h('span', { class: 'pill pill--off' }, `${fmtNum(s.issues.length)} catatan`)),
    h('p', { class: 'muted imp-total' }, s.processed ? `${fmtNum(s.processed)} baris data diproses.` : 'Tidak ada baris data yang diproses. Periksa baris judul dan isi file.'),
    s.issues.length ? h('div', { class: 'imp-issues', tabindex: '0', role: 'region', 'aria-label': 'Catatan hasil impor' },
      h('b', null, 'Catatan'),
      h('ul', null, shown.map(li)),
      s.issues.length > shown.length ? h('p', { class: 'muted' }, `…dan ${fmtNum(s.issues.length - shown.length)} catatan lain tidak ditampilkan.`) : null) : null);
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
      downloadButton('CSV', () => ({ url: '/api/staff/customers/template?format=csv', filename: 'template-data-customer.csv' })),
      downloadButton('Excel', () => ({ url: '/api/staff/customers/template?format=xlsx', filename: 'template-data-customer.xlsx' }))),
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
      const s = importSummary(r);
      toast(`${fmtNum(s.added)} ditambahkan, ${fmtNum(s.updated)} diperbarui, ${fmtNum(s.skipped)} dilewati`);
      result.replaceChildren(importResult(r));
      file.value = '';
      onDone();
    } catch (ex) { err.textContent = ex.message; }
    send.disabled = false;
    send.textContent = 'Upload';
  });
}