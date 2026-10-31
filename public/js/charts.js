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

// data: { total, items: [{ label, value }] }
export function donutCard({ title, subtitle, unit, data }) {
  const { total, items } = data;
  const rings = [svgEl('circle', { class: 'donut__track', cx: 21, cy: 21, r: R, fill: 'none', 'stroke-width': 5 })];
  let acc = 0;
  items.forEach((it, i) => {
    const pct = (it.value / total) * 100;
    const cls = it.label === 'Lainnya' ? 'c-other' : `c${i}`;
    rings.push(svgEl('circle', {
      class: `donut__seg ${cls}`, cx: 21, cy: 21, r: R, fill: 'none', 'stroke-width': 5,
      'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': 25 - acc,
    }, (() => { const t = svgEl('title'); t.textContent = `${it.label}: ${fmtNum(it.value)} (${Math.round(pct)}%)`; return t; })()));
    acc += pct;
  });
  const ring = svgEl('svg', { viewBox: '0 0 42 42', class: 'donut__svg', role: 'img', 'aria-label': `${title}: ${fmtNum(total)} ${unit}` }, ...rings);

  const legend = items.length
    ? h('ul', { class: 'legend' }, items.map((it, i) => h('li', null,
      h('span', { class: `legend__dot ${it.label === 'Lainnya' ? 'c-other' : `c${i}`}`, 'aria-hidden': 'true' }),
      h('span', { class: 'legend__label', title: it.label }, it.label),
      h('b', null, fmtNum(it.value)),
      h('small', null, `${Math.round((it.value / total) * 100)}%`))))
    : h('p', { class: 'muted chart-card__empty' }, 'Belum ada data');

  return h('section', { class: 'chart-card', 'aria-label': title },
    h('h3', null, title),
    h('p', { class: 'chart-card__sub' }, subtitle),
    h('div', { class: 'donut' }, ring, h('div', { class: 'donut__center' }, h('b', null, fmtNum(total)), h('small', null, unit))),
    legend);
}