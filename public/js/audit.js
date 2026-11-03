import { api } from './api.js';
import { h, fmtDate, openModal, emptyState, field, debounce } from './ui.js';
import { createGate, NO_CTX, pagerNodes, rangeLabel, tableWrap } from './customers.js';

const isAbort = (e) => e?.name === 'AbortError';

// Nama aksi baku (kontrak D) -> label Indonesia + warna pill.
export const ACTION_LABEL = {
  'record.delete': ['Hapus data', 'late'],
  'review.approve': ['Approve data', 'ok'],
  'review.change': ['Ubah approve', 'wait'],
  'review.cancel': ['Batalkan approve', 'late'],
  'commission.update': ['Ubah komisi', ''],
  'account.create': ['Buat akun', 'ok'],
  'account.update': ['Ubah akun', ''],
  'service.update': ['Ubah layanan', ''],
  'customer.import': ['Impor customer', ''],
  'customer.create': ['Tambah customer', 'ok'],
  'customer.update': ['Ubah customer', ''],
  'auth.password_change': ['Ganti password', 'wait'],
  'integration.connect': ['Sambung WhatsApp', 'ok'],
  'integration.update': ['Ubah integrasi', ''],
  'integration.retry': ['Kirim ulang integrasi', ''],
  'integration.disconnect': ['Putus WhatsApp', 'late'],
};
export const actionLabel = (a) => ACTION_LABEL[a]?.[0] || String(a || '–');

// Buang karakter kontrol dan karakter pengarah teks (bidi) agar tampilan tidak bisa dipalsukan.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (s) => String(s).replace(UNSAFE, ' ');

// detail di database berupa JSON (teks). Hasil: objek/array/nilai biasa, atau teks mentah bila bukan JSON.
export function parseDetail(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

const valueText = (v) => {
  if (v == null) return '–';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return '[objek]'; } }
  return String(v);
};

// Ringkasan satu baris: "kunci: nilai; kunci: nilai". Dipotong supaya tabel tetap rapi.
export function summarizeDetail(raw, max = 140) {
  const d = parseDetail(raw);
  if (d == null) return '';
  let s;
  if (Array.isArray(d)) s = d.map(valueText).join(', ');
  else if (typeof d === 'object') s = Object.entries(d).map(([k, v]) => `${k}: ${valueText(v)}`).join('; ');
  else s = String(d);
  s = clean(s).replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

// Daftar [kunci, nilai] untuk modal rincian (nilai sudah dibersihkan dan dibatasi).
export function detailPairs(raw, maxValue = 500) {
  const d = parseDetail(raw);
  if (d == null) return [];
  const cut = (v) => { const chars = [...clean(valueText(v))]; return chars.length > maxValue ? `${chars.slice(0, maxValue - 1).join('')}…` : chars.join(''); };
  if (Array.isArray(d)) return d.map((v, i) => [String(i + 1), cut(v)]);
  if (typeof d === 'object') return Object.entries(d).map(([k, v]) => [clean(k), cut(v)]);
  return [['detail', cut(d)]];
}

const targetText = (r) => r.target_label || (r.target_type || r.target_id ? `${r.target_type || '–'}${r.target_id ? ` #${r.target_id}` : ''}` : '–');

// Rincian siap baca dari server: [{ label, value }] atau [{ label, at }] (waktu diformat di sini).
// Hanya bila server tidak mengirim `items` (mis. server lama) dipakai cadangan lama dari data mentah.
function readableItems(r) {
  if (Array.isArray(r.items)) {
    return r.items.map((i) => [clean(i.label ?? ''), i.at ? fmtDate(i.at) : clean(valueText(i.value))]);
  }
  return detailPairs(r.detail);
}

const rowSummary = (r) => {
  if (typeof r.summary === 'string') return clean(r.summary).replace(/\s+/g, ' ').trim();
  return summarizeDetail(r.detail);
};

function openDetail(r) {
  const pairs = readableItems(r);
  openModal({
    title: actionLabel(r.action),
    content: h('div', null,
      h('dl', { class: 'kv' },
        h('dt', null, 'Waktu'), h('dd', null, r.at ? fmtDate(r.at) : '–'),
        h('dt', null, 'Pelaku'), h('dd', null, clean(r.actor_name || '–')),
        h('dt', null, 'Sasaran'), h('dd', null, clean(targetText(r))),
        h('dt', null, 'Alamat IP'), h('dd', null, clean(r.ip || '–'))),
      h('h4', { class: 'detail__label' }, 'Rincian'),
      pairs.length
        ? h('dl', { class: 'kv kv--detail kv--readable' }, pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
        : h('p', { class: 'muted' }, 'Tidak ada rincian tambahan.')),
  });
}

// ======================= TAB LOG AUDIT (SUPERVISOR) =======================
export function auditView(main, ctx = NO_CTX) {
  const gate = createGate(ctx);
  const q = h('input', { class: 'input', type: 'search', id: 'au-q', placeholder: 'Cari pelaku, nama sasaran, atau rincian' });
  const action = h('select', { class: 'input select', id: 'au-action' },
    h('option', { value: '' }, 'Semua aksi'),
    Object.entries(ACTION_LABEL).map(([v, [l]]) => h('option', { value: v }, l)));
  const info = h('p', { class: 'muted', role: 'status' }, 'Memuat…');
  const box = h('div');
  const pager = h('nav', { class: 'pager', 'aria-label': 'Halaman log audit' });
  let page = 1;

  async function load() {
    const req = gate.begin();
    const p = new URLSearchParams({ page: String(page) });
    if (q.value.trim()) p.set('q', q.value.trim());
    if (action.value) p.set('action', action.value);
    try {
      const { rows, total, page_size: size } = await api(`/api/sv/audit?${p}`, { signal: req.signal });
      if (!req.ok()) return;
      const pageSize = size || 50;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (page > pages) { page = pages; return load(); }
      const filtered = q.value.trim() !== '' || action.value !== '';
      info.textContent = `${rangeLabel({ offset: (page - 1) * pageSize, shown: rows.length, total, noun: 'catatan' })}${filtered ? ' (sesuai filter)' : ''}`;
      box.replaceChildren(rows.length
        ? tableWrap(h('table', { class: 'tbl-audit' },
          h('thead', null, h('tr', null, ['Waktu', 'Pelaku', 'Aksi', 'Sasaran', 'Ringkasan', ''].map((t) => h('th', null, t || h('span', { class: 'sr-only' }, 'Rincian'))))),
          h('tbody', null, rows.map((r) => {
            const [label, tone] = ACTION_LABEL[r.action] || [String(r.action || '–'), ''];
            const sum = rowSummary(r);
            return h('tr', null,
              h('td', { class: 'nowrap' }, r.at ? fmtDate(r.at) : '–'),
              h('td', null, h('b', null, clean(r.actor_name || '–'))),
              h('td', null, h('span', { class: `pill${tone ? ` pill--${tone}` : ''}`, title: clean(r.action || '') }, clean(label))),
              h('td', { class: 'nowrap' }, clean(targetText(r))),
              h('td', { class: 'audit-sum', title: sum }, sum || h('span', { class: 'muted' }, '–')),
              h('td', null, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Lihat rincian ${label} oleh ${clean(r.actor_name || 'pelaku')}`, onclick: () => openDetail(r) }, 'Rincian')));
          }))), 'Tabel log audit')
        : h('div', { class: 'table-wrap' }, emptyState(filtered ? 'Tidak ada catatan yang cocok' : 'Log audit masih kosong', filtered ? 'Ubah kata kunci atau filter aksi.' : 'Aksi penting seperti hapus data dan ubah approve akan tercatat di sini.')));
      pager.replaceChildren(...pagerNodes({ page, pages, onPage: (n) => { page = n; load(); } }));
    } catch (e) {
      if (!req.ok() || isAbort(e)) return;
      info.textContent = '';
      box.replaceChildren(emptyState('Log audit belum bisa dimuat', e.message));
      pager.replaceChildren();
    }
  }

  q.addEventListener('input', debounce(() => { page = 1; load(); }, 300));
  action.addEventListener('change', () => { page = 1; load(); });

  main.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Log audit'), info)),
    h('div', { class: 'toolbar mb' },
      h('div', { class: 'field toolbar__grow' }, h('label', { for: 'au-q' }, 'Cari'), q),
      field('Aksi', action)),
    box, pager);
  load();
}