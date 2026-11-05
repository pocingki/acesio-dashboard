// Beranda user: angka customer hari ini, ringkasan status, dan jadwal berikutnya.
// Data dari GET /api/my/home; dimuat ulang setiap kali tab dibuka (homeView dipanggil per pemilihan tab).
// Modul ini tidak menyentuh document/window saat dimuat.
import { api } from './api.js';
import { h, emptyState, fmtNum, todayInTz } from './ui.js';
import { schedulePill, fmtTimeRange, fmtLongDay, servicesSummary } from './schedule-ui.js';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export function homeView(main, user, ctx, { goTo }) {
  const { signal } = ctx;
  const toSchedule = () => goTo('schedule');
  const body = h('div', { class: 'home' });
  const dateLine = h('p', { class: 'muted' }, fmtLongDay(todayInTz()));
  const name = firstName(user?.name);

  main.append(
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, name ? `Halo, ${name}` : 'Beranda'), dateLine)),
    body);

  function showLoading() {
    body.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Memuat…'));
  }

  function showError(e) {
    body.replaceChildren(
      emptyState('Beranda belum bisa dimuat', e?.message || 'Terjadi kesalahan'),
      h('div', { class: 'home__retry' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: load }, 'Coba lagi')));
  }

  function hero(n) {
    const count = Number(n) || 0;
    return h('button', {
      class: 'home-hero', type: 'button', onclick: toSchedule,
      'aria-label': `${fmtNum(count)} customer hari ini. Lihat jadwal`,
    },
      h('span', { class: 'home-hero__num', 'aria-hidden': 'true' }, fmtNum(count)),
      h('span', { class: 'home-hero__text', 'aria-hidden': 'true' },
        h('span', { class: 'home-hero__label' }, 'Customer hari ini'),
        h('span', { class: 'home-hero__hint' }, 'Lihat jadwal →')));
  }

  function stats(by = {}) {
    const items = [['baru', 'Baru'], ['berjalan', 'Sedang dijalani'], ['selesai', 'Selesai']];
    return h('dl', { class: 'home-stats', 'aria-label': 'Ringkasan status jadwal hari ini' },
      items.map(([key, label]) => h('div', { class: 'home-stat' },
        h('dd', { class: 'home-stat__num' }, fmtNum(by[key])),
        h('dt', { class: 'home-stat__label' }, label))));
  }

  function nextCard(s) {
    if (!s) {
      return h('section', { class: 'home-next home-next--empty', 'aria-label': 'Berikutnya' },
        h('p', { class: 'muted' }, 'Tidak ada jadwal yang menunggu hari ini.'));
    }
    const c = s.customer || {};
    const label = `Berikutnya: ${fmtTimeRange(s.start_time, s.end_time)}, ${c.name || ''}. Lihat jadwal`;
    return h('button', { class: 'home-next', type: 'button', onclick: toSchedule, 'aria-label': label },
      h('span', { class: 'home-next__head' },
        h('span', { class: 'home-next__kicker' }, 'Berikutnya'),
        schedulePill(s.status, s.overdue)),
      h('span', { class: 'home-next__time' }, fmtTimeRange(s.start_time, s.end_time)),
      h('span', { class: 'home-next__name' }, c.name || ''),
      h('span', { class: 'home-next__meta' }, c.rm_no ? `No RM ${c.rm_no}` : ''),
      h('span', { class: 'home-next__svc' }, servicesSummary(s.services)));
  }

  async function load() {
    showLoading();
    try {
      const d = await api('/api/my/home', { signal });
      if (!ctx.isCurrent()) return;
      if (d.today) dateLine.textContent = fmtLongDay(d.today);
      body.replaceChildren(hero(d.customers_today), stats(d.by_status), nextCard(d.next));
    } catch (e) {
      if (e.aborted || !ctx.isCurrent()) return;
      showError(e);
    }
  }

  load();
}
