// Kalender bulan penuh untuk tab Jadwal (admin dan supervisor).
// Fungsi murni di atas (bisa dites di Node); komponen DOM di bawah.
import { api } from './api.js';
import { h, icon, toast } from './ui.js';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const pad = (n) => String(n).padStart(2, '0');

export const monthOf = (ymd) => String(ymd || '').slice(0, 7);
export const monthTitle = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export function shiftMonth(month, n) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Minggu-minggu satu bulan (awal minggu Senin). Sel: { ymd, day, inMonth }. */
export function monthGrid(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1;
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Senin = 0
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = -lead; cells.length % 7 !== 0 || i < days; i += 1) {
    const d = new Date(Date.UTC(y, m, 1 + i));
    cells.push({ ymd: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, day: d.getUTCDate(), inMonth: i >= 0 && i < days });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function dayLabel(info) {
  if (!info || !info.total) return 'tidak ada jadwal';
  const parts = [];
  for (const [k, l] of [['baru', 'baru'], ['berjalan', 'berjalan'], ['selesai', 'selesai'], ['batal', 'batal']]) if (info[k]) parts.push(`${info[k]} ${l}`);
  return `${info.total} jadwal (${parts.join(', ')})`;
}

const STATUS_DOTS = ['baru', 'berjalan', 'selesai', 'batal'];

/**
 * monthCalendar({ today, month, selected, onPick(ymd), onCreate(ymd), fmtLong(ymd), signal })
 * -> { el, refresh(), sync({ selected, month }) }
 */
export function monthCalendar({ today, month, selected = '', onPick, onCreate, fmtLong = (d) => d }) {
  let cur = month || monthOf(today);
  let sel = selected;
  let counts = {};
  let seq = 0;
  const title = h('h2', { class: 'cal__title', 'aria-live': 'polite' });
  const grid = h('div', { class: 'cal__grid', role: 'grid' });
  const bar = h('div', { class: 'cal__bar', role: 'status' });
  const nav = (n, label, glyph) => h('button', { class: 'icon-btn cal__nav', type: 'button', 'aria-label': label, onclick: () => go(shiftMonth(cur, n)) }, glyph);
  const todayBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go(monthOf(today)) }, 'Bulan ini');
  const el = h('section', { class: 'cal', 'aria-label': 'Kalender jadwal bulanan' },
    h('div', { class: 'cal__head' }, nav(-1, 'Bulan sebelumnya', '‹'), title, nav(1, 'Bulan berikutnya', '›'), todayBtn),
    h('div', { class: 'cal__week', 'aria-hidden': 'true' }, WEEKDAYS.map((w) => h('span', null, w))),
    grid, bar);

  function paintBar() {
    if (!sel) { bar.replaceChildren(h('span', { class: 'muted' }, 'Klik tanggal untuk melihat jadwalnya atau membuat jadwal baru.')); return; }
    const past = sel < today;
    bar.replaceChildren(
      h('span', null, h('b', null, fmtLong(sel)), ` · ${dayLabel(counts[sel])}`),
      h('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: past ? true : null, title: past ? 'Tanggal sudah lewat' : null, onclick: () => onCreate(sel) },
        icon('plus', 16), 'Tambah jadwal tanggal ini'));
  }

  function paint() {
    title.textContent = monthTitle(cur);
    grid.replaceChildren(...monthGrid(cur).flat().map((c) => {
      const info = counts[c.ymd];
      const dots = info ? STATUS_DOTS.filter((s) => info[s]).map((s) => h('i', { class: `cal__dot cal__dot--${s}` })) : [];
      return h('button', {
        class: `cal__day${c.inMonth ? '' : ' cal__day--out'}${c.ymd === today ? ' cal__day--today' : ''}${c.ymd === sel ? ' cal__day--sel' : ''}${c.ymd < today ? ' cal__day--past' : ''}`,
        type: 'button', role: 'gridcell', 'aria-pressed': String(c.ymd === sel),
        'aria-label': `${fmtLong(c.ymd)}, ${dayLabel(info)}`,
        onclick: () => { sel = c.ymd; if (!c.inMonth) go(monthOf(c.ymd)); else paint(); onPick(c.ymd); },
      }, h('span', { class: 'cal__num' }, String(c.day)),
      info ? h('span', { class: 'cal__count' }, String(info.total)) : null,
      dots.length ? h('span', { class: 'cal__dots' }, dots) : null);
    }));
    paintBar();
  }

  async function refresh() {
    const my = ++seq;
    try {
      const r = await api(`/api/staff/schedule-calendar?month=${cur}`);
      if (my !== seq) return;
      counts = r.days || {};
    } catch (e) {
      if (my !== seq) return;
      counts = {};
      if (e?.name !== 'AbortError') toast('Kalender belum bisa dimuat', 'err');
    }
    paint();
  }

  function go(m) {
    cur = m;
    paint();
    refresh();
  }

  function sync({ selected: s, month: m }) {
    sel = s || '';
    if (m && m !== cur) { cur = m; refresh(); return; }
    paint();
  }

  paint();
  refresh();
  return { el, refresh, sync };
}
