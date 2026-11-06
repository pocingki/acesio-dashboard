// Beranda user ("personal workspace"): sapaan, empat kartu statistik pribadi, dan Jadwal Saya Hari Ini (hanya tugas Baru + Berjalan; yang Selesai pindah ke tab Jadwal Saya).
// Data dari GET /api/my/home (hanya jadwal milik user yang login); dimuat ulang setiap tab dibuka.
// Tombol Mulai (jadwal Baru -> Sedang berjalan) ada di daftar dan langsung membuka form SOAP (wajib). Setelah SOAP disimpan
// hitung mundur berjalan; saat habis tugas menunggu approve admin/supervisor, lalu Selesai. Tidak ada yang mulai otomatis.
// Modul ini tidak menyentuh document/window saat dimuat.
import { api } from './api.js';
import { h, icon, emptyState, fmtNum, todayInTz, toast } from './ui.js';
import { schedulePill, fmtTimeRange, fmtLongDay, servicesSummary, countdownEl } from './schedule-ui.js';

export const HOME_POLL_MS = 15_000; // segarkan senyap selama ada tugas yang menunggu approve

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// Ikon garis sederhana untuk kartu statistik.
const STAT_ICONS = {
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.2 2.6-5 5.5-5s5.1 1.8 5.5 5"/><path d="M16 5.2a3.2 3.2 0 010 5.6M17.5 14.4c1.8.6 2.8 2.2 3 4.6"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  run: '<path d="M4 12h4l2.5-6 3 12 2.5-6H20"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l3 3 5-6"/>',
};
const statIcon = (name) => {
  const el = h('span', { 'aria-hidden': 'true', style: null });
  el.style.display = 'inline-grid';
  el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${STAT_ICONS[name]}</svg>`;
  return el;
};

export function homeView(main, user, ctx, { goTo }) {
  const { signal } = ctx;
  const toSchedule = () => goTo('schedule');
  const body = h('div', { class: 'home__body' });
  const dateLine = h('p', { class: 'muted' }, fmtLongDay(todayInTz()));
  const name = firstName(user?.name);
  const starting = new Set();

  main.append(h('div', { class: 'home' },
    h('div', { class: 'home__greet' }, h('h1', null, name ? `Halo, ${name}!` : 'Halo!'), dateLine),
    body));

  function showLoading() { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Memuat…')); }

  function showError(e) {
    body.replaceChildren(
      emptyState('Beranda belum bisa dimuat', e?.message || 'Terjadi kesalahan'),
      h('div', { class: 'home__retry' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: load }, 'Coba lagi')));
  }

  // Empat kartu seragam: Total Customer, Belum Dimulai, Sedang Berjalan, Selesai.
  function stats(d) {
    const by = d.by_status || {};
    const cards = [
      ['users', 'Total Customer', d.customers_today, 'Terjadwal hari ini', 'total'],
      ['wait', 'Belum Dimulai', by.baru, 'Menunggu layanan', 'baru'],
      ['run', 'Sedang Berjalan', by.berjalan, 'Layanan aktif', 'berjalan'],
      ['done', 'Selesai', by.selesai, 'Hari ini', 'selesai'],
    ];
    return h('dl', { class: 'hstats', 'aria-label': 'Ringkasan hari ini' },
      cards.map(([ic, label, n, sub, tone]) => h('div', { class: `hstat hstat--${tone}` },
        h('span', { class: 'hstat__icon', 'aria-hidden': 'true' }, statIcon(ic)),
        h('dt', { class: 'hstat__label' }, label),
        h('dd', { class: 'hstat__num' }, fmtNum(n)),
        h('dd', { class: 'hstat__sub' }, sub))));
  }

  async function mulai(s, btn) {
    if (starting.has(s.id)) return;
    starting.add(s.id);
    btn.disabled = true;
    try {
      await api(`/api/my/schedules/${s.id}/start`, { method: 'POST', signal });
      if (!ctx.isCurrent()) return;
      goTo('input', { scheduleId: s.id }); // wajib isi SOAP dulu; hitung mundur berjalan setelah SOAP disimpan
      return;
    } catch (e) {
      if (e.aborted || !ctx.isCurrent()) return;
      toast(e.message || 'Tugas belum bisa dimulai', 'err');
      load();
    } finally {
      starting.delete(s.id);
      if (btn.isConnected) btn.disabled = false;
    }
  }

  function item(s) {
    const c = s.customer || {};
    const range = fmtTimeRange(s.start_time, s.end_time);
    let action;
    if (s.status === 'baru') {
      const btn = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => mulai(s, btn) }, 'Mulai');
      action = btn;
    } else if (s.status === 'berjalan' && s.phase === 'timer') {
      action = countdownEl(s.remaining_sec, { signal, onDone: () => { if (ctx.isCurrent()) load({ silent: true }); } });
    } else if (s.status === 'berjalan' && s.phase === 'menunggu') {
      action = h('span', { class: 'hitem__wait', role: 'status' }, 'Menunggu approve');
    } else if (s.status === 'berjalan') {
      action = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => goTo('input', { scheduleId: s.id }) }, 'Isi SOAP');
    } else {
      action = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: toSchedule }, 'Lihat');
    }
    return h('li', { class: `hitem hitem--${s.status}` },
      h('div', { class: 'hitem__main' },
        h('div', { class: 'hitem__top' }, h('span', { class: 'hitem__time' }, range), schedulePill(s.status, !!s.overdue, s.phase)),
        h('b', { class: 'hitem__name' }, c.name || '-'),
        h('span', { class: 'hitem__meta' }, c.rm_no ? `No. RM ${c.rm_no}` : 'No. RM -'),
        h('span', { class: 'hitem__svc' }, servicesSummary(s.services))),
      h('div', { class: 'hitem__action' }, action));
  }

  function schedules(d) {
    const list = d.schedules || [];
    const ph = d.phases || {};
    const timing = ph.timer || 0;
    const waiting = ph.menunggu || 0;
    const needSoap = ph.soap || 0;
    return h('section', { class: 'hsched', 'aria-labelledby': 'hs-title' },
      h('div', { class: 'hsched__head' },
        h('h2', { id: 'hs-title' }, 'Jadwal Saya Hari Ini'),
        h('button', { class: 'hlink', type: 'button', onclick: toSchedule }, 'Lihat semua & selesai →')),
      needSoap ? h('p', { class: 'hnotice', role: 'status' }, `${fmtNum(needSoap)} tugas menunggu SOAP. SOAP wajib diisi dulu; hitung mundur baru berjalan setelah SOAP disimpan.`) : null,
      timing ? h('p', { class: 'hnotice hnotice--info', role: 'status' }, `${fmtNum(timing)} tugas sedang dalam hitung mundur.`) : null,
      waiting ? h('p', { class: 'hnotice', role: 'status' }, `${fmtNum(waiting)} tugas menunggu approve admin atau supervisor.`) : null,
      list.length
        ? h('ul', { class: 'hlist' }, list.map(item))
        : h('div', { class: 'hempty' }, h('b', null, (d.by_status?.selesai || 0) > 0 ? 'Semua tugas hari ini sudah selesai' : 'Belum ada tugas hari ini'), h('p', { class: 'muted' }, (d.by_status?.selesai || 0) > 0 ? 'Tugas yang selesai ada di Jadwal Saya.' : 'Jadwal dibuat oleh admin atau supervisor. Cek Jadwal Saya untuk hari lain.')));
  }

  let pollTimer = null;
  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
  signal?.addEventListener?.('abort', stopPoll, { once: true });
  const poll = () => { stopPoll(); pollTimer = setTimeout(() => { if (ctx.isCurrent()) load({ silent: true }); }, HOME_POLL_MS); };

  async function load({ silent = false } = {}) {
    stopPoll();
    if (!silent) showLoading();
    try {
      const d = await api('/api/my/home', { signal });
      if (!ctx.isCurrent()) return;
      if (d.today) dateLine.textContent = fmtLongDay(d.today);
      body.replaceChildren(stats(d), schedules(d));
      const ph = d.phases || {};
      if ((ph.timer || 0) + (ph.menunggu || 0) > 0) poll();
    } catch (e) {
      if (e.aborted || !ctx.isCurrent()) return;
      if (silent) poll(); else showError(e);
    }
  }

  load();
}
