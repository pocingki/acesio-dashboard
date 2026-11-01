import { h, fmtNum } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids) el.append(kid);
  return el;
};

// Lingkar r = 100 / (2π) sehingga 1 satuan stroke-dasharray = 1 persen.
const R = 100 / (2 * Math.PI);
const PALETTE_SIZE = 6; // c0..c5 di app.css
export const LABEL_MAX = 26;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Potong label panjang (hitung per karakter Unicode, bukan per unit UTF-16).
export function shortLabel(label, max = LABEL_MAX) {
  const chars = [...String(label ?? '')];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : chars.join('');
}

// Persentase aman: total 0 / tidak valid -> 0, tidak pernah NaN atau di luar 0..100.
export function pctOf(value, total) {
  const v = num(value);
  const t = num(total);
  if (t <= 0 || v <= 0) return 0;
  return Math.min(100, (v / t) * 100);
}

// Hitung potongan donat. Item bernilai 0 tetap ada (untuk legenda) tapi tidak digambar.
export function donutSegments(items, total) {
  const list = Array.isArray(items) ? items : [];
  const sum = list.reduce((a, it) => a + Math.max(0, num(it.value)), 0);
  const base = num(total) > 0 ? num(total) : sum;
  let acc = 0;
  return list.map((it, i) => {
    const value = Math.max(0, num(it.value));
    const pct = pctOf(value, base);
    const seg = {
      label: String(it.label ?? ''),
      value,
      pct,
      start: acc,
      cls: it.label === 'Lainnya' ? 'c-other' : `c${i % PALETTE_SIZE}`,
    };
    acc += pct;
    return seg;
  });
}

// Ringkasan teks untuk pembaca layar.
export function donutSummary({ title, unit, total, segments }) {
  const head = `${title}: ${fmtNum(total)} ${unit}.`;
  if (!segments.length || !(num(total) > 0)) return `${head} Belum ada data.`;
  const top = segments.slice(0, 3).map((s) => `${s.label} ${fmtNum(s.value)} (${Math.round(s.pct)}%)`).join(', ');
  const more = segments.length > 3 ? `, dan ${fmtNum(segments.length - 3)} lainnya` : '';
  return `${head} ${top}${more}.`;
}

// data: { total, items: [{ label, value }] }
export function donutCard({ title, subtitle, unit, data }) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const segments = donutSegments(items, data?.total);
  const total = num(data?.total) > 0 ? num(data.total) : segments.reduce((a, s) => a + s.value, 0);

  const rings = [svgEl('circle', { class: 'donut__track', cx: 21, cy: 21, r: R, fill: 'none', 'stroke-width': 5 })];
  for (const s of segments) {
    if (s.pct <= 0) continue;
    const t = svgEl('title');
    t.textContent = `${s.label}: ${fmtNum(s.value)} (${Math.round(s.pct)}%)`;
    rings.push(svgEl('circle', {
      class: `donut__seg ${s.cls}`, cx: 21, cy: 21, r: R, fill: 'none', 'stroke-width': 5,
      'stroke-dasharray': `${s.pct.toFixed(3)} ${(100 - s.pct).toFixed(3)}`, 'stroke-dashoffset': (25 - s.start).toFixed(3),
    }, t));
  }
  const ring = svgEl('svg', {
    viewBox: '0 0 42 42', class: 'donut__svg', role: 'img',
    'aria-label': donutSummary({ title, unit, total, segments }),
  }, ...rings);

  const legend = segments.length && total > 0
    ? h('ul', { class: 'legend' }, segments.map((s) => h('li', null,
      h('span', { class: `legend__dot ${s.cls}`, 'aria-hidden': 'true' }),
      h('span', { class: 'legend__label', title: s.label }, shortLabel(s.label)),
      h('b', null, fmtNum(s.value)),
      h('small', null, `${Math.round(s.pct)}%`))))
    : h('p', { class: 'muted chart-card__empty' }, 'Belum ada data');

  return h('section', { class: 'chart-card', 'aria-label': title },
    h('h3', null, title),
    h('p', { class: 'chart-card__sub' }, subtitle),
    h('div', { class: 'donut' }, ring, h('div', { class: 'donut__center', 'aria-hidden': 'true' }, h('b', null, fmtNum(total)), h('small', null, unit))),
    legend);
}