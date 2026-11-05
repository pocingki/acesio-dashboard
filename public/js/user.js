import { api, anySignal, downloadFile } from './api.js';
import {
  h, icon, toast, fmtNum, debounce, confirmDialog, todayInTz, dayInTz, emptyState,
} from './ui.js';
import { createShell } from './shell.js';
import { notificationBell } from './notify.js';
import { groupRecords, customerGroups } from './groups.js';
import { homeView } from './home.js';
import { scheduleView } from './myschedule.js';
import { visitView, resetVisitState, newIdempotencyKey } from './visit.js';

// Kunci idempotensi kini dibuat di visit.js; diekspor ulang di sini supaya impor lama tetap bekerja.
export { newIdempotencyKey };

// Shell yang sedang tampil; goTo() memakainya untuk berpindah tab (dengan parameter) dari tampilan mana pun.
let activeShell = null;
let currentUserId = null;

export function resetUserState() {
  currentUserId = null;
  resetVisitState();
}

// Pindah tab user: goTo('schedule', { day }) atau goTo('input', { scheduleId }).
export function goTo(tabId, params = {}) {
  if (activeShell) activeShell.select(tabId, params);
}

export function renderUserApp(root, user, { onLogout }) {
  if (currentUserId !== user.id) { resetUserState(); currentUserId = user.id; }
  const nav = { goTo };
  const bell = notificationBell({ goTo });
  const shell = createShell({
    user,
    onLogout,
    actions: [bell],
    tabs: [
      { id: 'home', label: 'Beranda' },
      { id: 'schedule', label: 'Jadwal Saya' },
      { id: 'input', label: 'Input Customer' },
      { id: 'history', label: 'Riwayat Customer' },
    ],
    onSelect: (id, main, ctx) => {
      const params = ctx.params || {};
      if (id === 'home') return homeView(main, user, ctx, nav);
      if (id === 'schedule') return scheduleView(main, user, ctx, nav);
      if (id === 'input') return visitView(main, user, ctx, { ...nav, params });
      return historyView(main, ctx);
    },
  });
  // Lonceng dibuang bersama shell (logout, sesi berakhir, atau render ulang) lewat disposeActiveShell.
  const baseDispose = shell.dispose;
  shell.dispose = () => {
    bell.dispose();
    if (activeShell === shell) activeShell = null;
    baseDispose();
  };
  activeShell = shell;
  root.append(shell.el);
  shell.select('home');
}

// Alur input user (lihat visit.js): admin membuat jadwal beserta customer dan layanannya; user membuka jadwal
// dari tab Jadwal Saya, mengisi SOAP kunjungan (wajib) lalu menyimpan. User tidak memilih customer maupun
// layanan sendiri, dan tidak ada pencarian No RM.

// ======================= TAB RIWAYAT =======================
export function historyView(main, ctx) {
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