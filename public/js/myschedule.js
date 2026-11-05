// Tab "Jadwal Saya" untuk user: dashboard jadwal harian (default hari ini) dengan filter tanggal.
// Mengklik baris yang boleh dijalankan = memulai jadwal lalu membuka tab Input Customer.
// Fungsi murni di bagian atas diekspor untuk tes; modul ini tidak menyentuh document saat dimuat.
import { api } from './api.js';
import { h, icon, toast, openModal, todayInTz, fmtDay } from './ui.js';
import { schedulePill, fmtLongDay, servicesSummary, SOAP_PARTS } from './schedule-ui.js';

export const RANGE_ERROR = 'Tanggal awal tidak boleh setelah tanggal akhir';
export const TRUNCATED_NOTE = 'Menampilkan 500 jadwal pertama, persempit rentang tanggal';
export const MSG_NOT_TODAY = 'Jadwal ini bukan untuk hari ini. Jadwal hanya bisa dijalankan pada tanggalnya.';
export const MSG_OVERDUE = 'Jadwal terlewat, hubungi admin.';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (v) => typeof v === 'string' && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

// ---------- fungsi murni ----------
export function addDaysYmd(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const rangeProblem = (from, to) => (from && to && from > to ? RANGE_ERROR : '');

// kind: 'today' | 'tomorrow' | 'week' (hari ini sampai 6 hari ke depan) | 'all'
export function scheduleRange(kind, today) {
  if (kind === 'tomorrow') { const d = addDaysYmd(today, 1); return { from: d, to: d, all: false }; }
  if (kind === 'week') return { from: today, to: addDaysYmd(today, 6), all: false };
  if (kind === 'all') return { from: '', to: '', all: true };
  return { from: today, to: today, all: false };
}

// Tombol cepat mana yang cocok dengan rentang saat ini ('' bila rentang bebas).
export function activeQuick(range, today) {
  for (const kind of ['today', 'tomorrow', 'week', 'all']) {
    const r = scheduleRange(kind, today);
    if (r.all === !!range.all && r.from === (range.from || '') && r.to === (range.to || '')) return kind;
  }
  return '';
}

export const isSingleDay = (range) => !range.all && !!range.from && range.from === range.to;

export function scheduleQuery(range) {
  if (range.all) return 'all=1';
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  return p.toString();
}

// Kelompok per tanggal (urut tanggal naik); urutan di dalam kelompok mengikuti urutan dari server.
export function groupByDay(schedules) {
  const map = new Map();
  for (const s of schedules || []) {
    if (!map.has(s.day)) map.set(s.day, []);
    map.get(s.day).push(s);
  }
  return [...map.keys()].sort().map((day) => ({ day, items: map.get(day) }));
}

// 'start' | 'detail' | 'overdue' | 'future' | 'none'
export function rowAction(s, today) {
  if (s.status === 'batal') return 'none';
  if (s.status === 'selesai') return 'detail';
  if (s.overdue || s.day < today) return 'overdue';
  if (s.day > today) return 'future';
  return 'start';
}

export function summaryParts(summary) {
  const sm = summary || {};
  return {
    total: sm.total || 0,
    selesai: sm.selesai || 0,
    sisa: (sm.baru || 0) + (sm.berjalan || 0),
  };
}

export const emptyTitle = (range) => (range.all ? 'Belum ada jadwal' : 'Tidak ada jadwal pada tanggal ini');

const isAbort = (e) => e?.aborted || e?.name === 'AbortError';

// ---------- tampilan ----------
const QUICK = [['today', 'Hari ini'], ['tomorrow', 'Besok'], ['week', '7 hari ke depan'], ['all', 'Semua']];

export function scheduleView(main, user, ctx, { goTo } = {}) {
  const { signal } = ctx;
  let today = todayInTz();
  const startDay = ctx.params?.day;
  let range = isYmd(startDay) ? { from: startDay, to: startDay, all: false } : scheduleRange('today', today);
  let seq = 0;
  const starting = new Set(); // id jadwal yang sedang dimulai (cegah klik ganda)

  const title = h('h1', null, 'Jadwal Saya');
  const dayLine = h('p', { class: 'us-day' });
  const sumLine = h('p', { class: 'us-sum', role: 'status' });
  const prev = h('button', { class: 'icon-btn us-nav us-nav--prev', type: 'button', 'aria-label': 'Hari sebelumnya', onclick: () => shift(-1) }, icon('chevron', 20));
  const next = h('button', { class: 'icon-btn us-nav us-nav--next', type: 'button', 'aria-label': 'Hari berikutnya', onclick: () => shift(1) }, icon('chevron', 20));
  const quickBtns = QUICK.map(([kind, label]) => h('button', {
    class: 'btn btn--ghost btn--sm btn--toggle us-quick', type: 'button', 'aria-pressed': 'false',
    onclick: () => apply(scheduleRange(kind, today)),
  }, label));
  const fromIn = h('input', { class: 'input', type: 'date', id: 'us-from', onchange: () => fromInputs() });
  const toIn = h('input', { class: 'input', type: 'date', id: 'us-to', onchange: () => fromInputs() });
  const rangeMsg = h('p', { class: 'error us-range-msg', role: 'alert' });
  const body = h('div', { class: 'us-body', 'aria-live': 'polite' });

  const filters = h('div', { class: 'us-filters' },
    h('div', { class: 'us-quicks', role: 'group', 'aria-label': 'Pilih rentang cepat' }, quickBtns),
    h('div', { class: 'us-dates' },
      h('div', { class: 'us-date' }, h('label', { for: 'us-from' }, 'Dari'), fromIn),
      h('div', { class: 'us-date' }, h('label', { for: 'us-to' }, 'Sampai'), toIn)),
    rangeMsg);

  main.replaceChildren(h('div', { class: 'us' },
    h('header', { class: 'us-head' },
      title,
      h('div', { class: 'us-headrow' }, prev, dayLine, next),
      sumLine),
    filters,
    body));

  function paintControls() {
    const kind = activeQuick(range, today);
    QUICK.forEach(([k], i) => quickBtns[i].setAttribute('aria-pressed', String(k === kind)));
    fromIn.value = range.all ? '' : range.from;
    toIn.value = range.all ? '' : range.to;
    const single = isSingleDay(range);
    prev.hidden = !single;
    next.hidden = !single;
    dayLine.textContent = range.all ? 'Semua tanggal'
      : single ? fmtLongDay(range.from)
        : `${fmtDay(range.from, true)} – ${fmtDay(range.to, true)}`;
  }

  function fromInputs() {
    let from = fromIn.value;
    let to = toIn.value;
    if (!from && !to) { paintControls(); return; }
    if (!from) from = to;
    if (!to) to = from;
    const msg = rangeProblem(from, to);
    rangeMsg.textContent = msg;
    fromIn.setAttribute('aria-invalid', String(!!msg));
    toIn.setAttribute('aria-invalid', String(!!msg));
    if (msg) return; // rentang terbalik ditolak, daftar tidak dimuat
    apply({ from, to, all: false });
  }

  function shift(n) {
    if (!isSingleDay(range)) return;
    apply({ from: addDaysYmd(range.from, n), to: addDaysYmd(range.from, n), all: false });
  }

  function apply(r) {
    range = r;
    rangeMsg.textContent = '';
    fromIn.removeAttribute('aria-invalid');
    toIn.removeAttribute('aria-invalid');
    load();
  }

  function showLoading() {
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(h('p', { class: 'us-loading muted' }, 'Memuat jadwal…'));
  }

  function showError(e) {
    body.removeAttribute('aria-busy');
    sumLine.textContent = '';
    body.replaceChildren(h('div', { class: 'empty us-empty' },
      h('b', null, 'Jadwal belum bisa dimuat'),
      e?.message || 'Terjadi kesalahan',
      h('div', { class: 'us-retry' }, h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => load() }, 'Coba lagi'))));
  }

  async function load() {
    const mine = ++seq;
    paintControls();
    showLoading();
    try {
      const data = await api(`/api/my/schedules?${scheduleQuery(range)}`, { signal });
      if (!ctx.isCurrent() || mine !== seq) return;
      if (isYmd(data?.today)) today = data.today;
      paintControls();
      render(data);
    } catch (e) {
      if (isAbort(e) || !ctx.isCurrent() || mine !== seq) return;
      showError(e);
    }
  }

  function render(data) {
    const list = data.schedules || [];
    const sm = summaryParts(data.summary);
    sumLine.replaceChildren(
      h('span', null, 'Total ', h('b', null, sm.total)),
      h('span', null, 'Selesai ', h('b', null, sm.selesai)),
      h('span', null, 'Sisa ', h('b', null, sm.sisa)));
    body.removeAttribute('aria-busy');
    if (!list.length) {
      body.replaceChildren(h('div', { class: 'empty us-empty' }, h('b', null, emptyTitle(range))));
      return;
    }
    const grouped = !isSingleDay(range);
    const nodes = groupByDay(list).map((g) => h('section', { class: 'us-group' },
      grouped ? h('h2', { class: 'us-group__title' }, fmtLongDay(g.day), g.day === today ? h('span', { class: 'us-group__tag' }, 'Hari ini') : null) : null,
      h('ul', { class: 'us-list' }, g.items.map(rowEl))));
    if (data.truncated) nodes.push(h('p', { class: 'us-note muted', role: 'note' }, TRUNCATED_NOTE));
    body.replaceChildren(...nodes);
  }

  function rowEl(s) {
    const action = rowAction(s, today);
    const tone = s.status === 'batal' ? 'batal' : (s.overdue || action === 'overdue') ? 'overdue' : s.status;
    const cust = s.customer || {};
    const svc = servicesSummary(s.services || []);
    const btn = h('button', {
      class: `us-item us-item--${tone}`, type: 'button', disabled: action === 'none' ? true : null,
      onclick: () => open(s, action, btn),
    },
    h('span', { class: 'us-time' },
      h('span', { class: 'us-time__start' }, s.start_time),
      s.end_time ? h('span', { class: 'us-time__end' }, s.end_time) : null),
    h('span', { class: 'us-card' },
      h('span', { class: 'us-card__top' },
        h('span', { class: 'us-card__name' }, cust.name || '-'),
        schedulePill(s.status, !!s.overdue)),
      h('span', { class: 'us-card__rm' }, cust.rm_no ? `No RM ${cust.rm_no}` : null),
      svc ? h('span', { class: 'us-card__svc' }, svc) : null,
      s.note ? h('span', { class: 'us-card__note' }, s.note) : null));
    return h('li', null, btn);
  }

  // ----- aksi klik baris -----
  function open(s, action, btn) {
    if (action === 'start') return startSchedule(s, btn);
    if (action === 'detail') return showDetail(s, btn);
    if (action === 'overdue') return showInfo(s, MSG_OVERDUE);
    if (action === 'future') return showInfo(s, MSG_NOT_TODAY);
    return undefined;
  }

  async function startSchedule(s, btn) {
    if (starting.has(s.id)) return;
    if (typeof goTo !== 'function') { toast('Navigasi tidak tersedia. Muat ulang halaman.', 'err'); return; }
    starting.add(s.id);
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await api(`/api/my/schedules/${s.id}/start`, { method: 'POST', signal });
      if (!ctx.isCurrent()) return;
      goTo('input', { scheduleId: s.id });
    } catch (e) {
      if (isAbort(e) || !ctx.isCurrent()) return;
      toast(e.message || 'Jadwal belum bisa dimulai', 'err');
      if (e.code === 'SCHEDULE_STATE' || e.code === 'SCHEDULE_NOT_TODAY') load(); // data di layar sudah usang
    } finally {
      starting.delete(s.id);
      if (btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  }

  function infoBlock(s) {
    const cust = s.customer || {};
    return h('dl', { class: 'us-meta' },
      h('dt', null, 'Customer'), h('dd', null, `${cust.name || '-'}${cust.rm_no ? ` · ${cust.rm_no}` : ''}`),
      h('dt', null, 'Waktu'), h('dd', null, `${fmtLongDay(s.day)}, ${s.start_time}${s.end_time ? `–${s.end_time}` : ''}`));
  }

  function showInfo(s, text) {
    const m = openModal({
      title: 'Informasi jadwal',
      content: h('div', null,
        infoBlock(s),
        h('p', null, text),
        h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => m.close() }, 'Tutup'))),
    });
  }

  async function showDetail(s, btn) {
    if (starting.has(s.id)) return;
    starting.add(s.id);
    btn.disabled = true;
    try {
      const data = await api(`/api/my/schedules/${s.id}`, { signal });
      if (!ctx.isCurrent()) return;
      const d = data.schedule || s;
      const soap = d.soap || {};
      const m = openModal({
        title: 'Detail jadwal',
        content: h('div', { class: 'us-detail' },
          infoBlock(d),
          h('h3', null, 'Layanan'),
          h('ul', { class: 'us-svclist' }, (d.services || []).map((x) => h('li', null, x.name))),
          h('h3', null, 'SOAP'),
          soap && (soap.s || soap.o || soap.a || soap.p)
            ? h('dl', { class: 'us-soap' }, SOAP_PARTS.flatMap((p) => [h('dt', null, p.label), h('dd', null, soap[p.key] || '-')]))
            : h('p', { class: 'muted' }, 'SOAP belum tersedia.'),
          h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => m.close() }, 'Tutup'))),
      });
    } catch (e) {
      if (isAbort(e) || !ctx.isCurrent()) return;
      toast(e.message || 'Detail belum bisa dimuat', 'err');
    } finally {
      starting.delete(s.id);
      if (btn.isConnected) btn.disabled = false;
    }
  }

  load();
}
