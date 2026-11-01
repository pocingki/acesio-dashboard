// Tampilan ringkas "satu baris per customer" untuk riwayat user dan detail approve staff.
// Baris induk memuat data customer SEKALI (tanggal, No RM, nama, No WA); rincian (dibuka dengan klik)
// hanya berisi daftar layanan. Semua teks lewat textContent (h() tidak memakai innerHTML).
import { h, icon, fmtDate, fmtPhone, fmtNum, fmtRp, fmtTime, dayInTz } from './ui.js';

// Kelompokkan baris record menjadi satu grup per customer per hari. Urutan grup = urutan kemunculan
// pertama (server sudah mengurutkan terbaru dulu), urutan layanan di dalam grup tetap.
export function groupRecords(records) {
  const map = new Map();
  for (const r of records || []) {
    const day = r.day || dayInTz(r.created_at);
    const key = `${r.customer_id}|${day}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key, day, customer_id: r.customer_id, rm: r.customer_rm || '', name: r.customer_name || '',
        phone: r.customer_phone || '', created_at: r.created_at, commission: 0, records: [],
      };
      map.set(key, g);
    }
    g.records.push(r);
    g.commission += Number(r.commission) || 0;
  }
  return [...map.values()];
}

let uid = 0;

// opts: { open:Set (kunci grup yang terbuka; diubah di tempat), showDay, showCommission,
//         renderService(r) -> Node|null (aksi per layanan, mis. tombol hapus), label }
export function customerGroups(groups, opts = {}) {
  const { open = new Set(), showDay = false, showCommission = false, renderService = null, label = 'Daftar customer' } = opts;
  const cls = `cgroups${showDay ? ' cgroups--day' : ''}${showCommission ? ' cgroups--comm' : ''}`;
  const head = h('div', { class: 'cgroups__head', 'aria-hidden': 'true' },
    showDay ? h('span', null, 'Tanggal') : null,
    h('span', null, 'No RM'), h('span', null, 'Customer'), h('span', null, 'No WA'),
    h('span', null, 'Layanan'), showCommission ? h('span', { class: 'cg-num' }, 'Komisi') : null, h('span', null, ''));

  const items = groups.map((g) => {
    const id = `cg-${++uid}`;
    const isOpen = open.has(g.key);
    const count = `${fmtNum(g.records.length)} layanan`;
    const row = h('button', {
      class: 'cgroup__row', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': `${id}-d`,
      'aria-label': `${g.name}, ${count}. ${isOpen ? 'Tutup' : 'Buka'} rincian layanan`,
    },
      showDay ? h('span', { class: 'cg-day' }, fmtDate(g.created_at)) : null,
      h('span', { class: 'cg-rm' }, g.rm || '–'),
      h('span', { class: 'cg-name' }, h('b', null, g.name)),
      h('span', { class: 'cg-wa' }, fmtPhone(g.phone) || '–'),
      h('span', { class: 'cg-count' }, h('span', { class: 'pill' }, count)),
      showCommission ? h('span', { class: 'cg-num' }, fmtRp(g.commission)) : null,
      h('span', { class: 'cg-chev' }, icon('chevron', 18)));

    const list = h('ul', { class: 'svc-list', 'aria-label': `Layanan untuk ${g.name}` },
      g.records.map((r) => h('li', { class: 'svc-item' },
        h('div', { class: 'svc-main' },
          h('span', { class: 'svc-name' }, r.service_name, r.source === 'bot' ? h('small', null, 'via WA bot') : null),
          r.note && String(r.note).trim() ? h('div', { class: 'note' }, r.note) : null),
        h('span', { class: 'svc-time nowrap' }, fmtTime(r.created_at)),
        showCommission ? h('span', { class: 'svc-comm cg-num' }, fmtRp(r.commission)) : null,
        renderService ? h('span', { class: 'svc-act' }, renderService(r)) : null)));
    const detail = h('div', { class: 'cgroup__detail', id: `${id}-d`, hidden: !isOpen }, list);

    row.addEventListener('click', () => {
      const now = detail.hidden; // akan dibuka bila sekarang tersembunyi
      detail.hidden = !now;
      row.setAttribute('aria-expanded', String(now));
      row.setAttribute('aria-label', `${g.name}, ${count}. ${now ? 'Tutup' : 'Buka'} rincian layanan`);
      if (now) open.add(g.key); else open.delete(g.key);
    });
    const item = h('div', { class: `cgroup${isOpen ? ' is-open' : ''}` }, row, detail);
    row.addEventListener('click', () => item.classList.toggle('is-open', !detail.hidden));
    return item;
  });

  const root = h('div', { class: cls, role: 'group', 'aria-label': label }, head, items);
  return root;
}
