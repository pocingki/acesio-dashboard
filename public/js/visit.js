// Halaman isi SOAP (dulu tab "Input Customer") untuk user: bekerja HANYA dari jadwal (D3, D12).
// Customer dan layanan sudah ditentukan admin; user hanya mengisi SOAP kunjungan (S/O/A/P, semua wajib)
// lalu menyimpan. Alur baru: SOAP wajib diisi dulu, baru hitung mundur berjalan; layanan tercatat dan jadwal Selesai
// saat admin/supervisor approve setelah waktu habis. Jadwal lama (tanpa alur ini) tetap selesai langsung saat Simpan.
// Modul ini tidak menyentuh document/window saat dimuat (aman diimpor tes Node).
import { api } from './api.js';
import { h, toast, emptyState, todayInTz } from './ui.js';
import { SOAP_PARTS, fmtTimeRange, fmtLongDay, schedulePill, countdownEl } from './schedule-ui.js';

export const SOAP_MIN = 3;
export const SOAP_MAX = 2000;
export const UNCERTAIN_MSG = 'Belum pasti tersimpan. Menekan Simpan lagi aman, data tidak akan ganda.';

// crypto.randomUUID hanya ada di konteks aman (https/localhost); cadangan untuk http biasa.
export function newIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ----- fungsi murni (dites di test/visit-ui.test.mjs) -----

const PART_KEYS = ['s', 'o', 'a', 'p'];
const PART_LABEL = { s: 'Subjective', o: 'Objective', a: 'Assessment', p: 'Planning' };

// Perapian sama dengan sisi server: ujung dipangkas, baris baru Windows jadi satu bentuk.
export const tidySoapText = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

// Kunci draf/Idempotency per jadwal; kosong bila id tidak sah.
export function soapDraftKey(scheduleId) {
  const n = Number(scheduleId);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}

// Pesan galat satu bagian, atau '' bila sah.
export function soapPartError(key, value) {
  const label = PART_LABEL[key];
  if (!label) return 'Bagian SOAP tidak dikenal';
  const n = tidySoapText(value).length;
  if (n === 0) return `${label} wajib diisi.`;
  if (n < SOAP_MIN) return `${label} minimal ${SOAP_MIN} karakter.`;
  if (n > SOAP_MAX) return `${label} maksimal ${SOAP_MAX} karakter (sekarang ${n}).`;
  return '';
}

// -> { ok, errors: { s, o, a, p }, first } ; first = kunci bagian pertama yang salah (atau '').
// Hanya kunci s/o/a/p yang dinilai; bagian yang tidak ada dianggap kosong.
export function validateSoapClient(soap) {
  const src = soap && typeof soap === 'object' ? soap : {};
  const errors = {};
  let first = '';
  for (const k of PART_KEYS) {
    errors[k] = soapPartError(k, src[k]);
    if (errors[k] && !first) first = k;
  }
  return { ok: first === '', errors, first };
}

// Bentuk isi yang dikirim ke server: dirapikan, hanya empat bagian.
export function cleanSoap(soap) {
  const src = soap && typeof soap === 'object' ? soap : {};
  return Object.fromEntries(PART_KEYS.map((k) => [k, tidySoapText(src[k])]));
}

// Alasan jadwal tidak bisa diisi (null bila bisa). today = "YYYY-MM-DD".
export function visitBlockReason(schedule, today) {
  if (!schedule) return 'Jadwal tidak ditemukan.';
  if (schedule.status === 'batal') return 'Jadwal ini dibatalkan, jadi tidak bisa diisi.';
  if (schedule.status === 'selesai') return null; // tampil baca-saja
  if (schedule.day !== today) {
    return schedule.day < today
      ? 'Jadwal ini sudah terlewat. Jadwal hari lampau hanya bisa dilihat, tidak bisa dijalankan.'
      : 'Jadwal ini bukan untuk hari ini. Jadwal hanya bisa dijalankan pada harinya.';
  }
  if (schedule.status === 'baru') return 'Tekan Mulai dulu di Jadwal Saya. Setelah itu isi SOAP; hitung mundur berjalan setelah SOAP disimpan.';
  if (schedule.status === 'berjalan' && schedule.phase === 'timer') return 'SOAP sudah disimpan dan hitung mundur sedang berjalan. Setelah waktu habis, tugas menunggu approve admin atau supervisor.';
  if (schedule.status === 'berjalan' && schedule.phase === 'menunggu') return 'SOAP sudah disimpan dan waktu habis. Menunggu approve admin atau supervisor; setelah disetujui tugas Selesai.';
  return null;
}

// ----- memori modul: draf SOAP dan Idempotency-Key per jadwal -----
const mem = {
  userId: null,
  drafts: new Map(), // scheduleId -> { s, o, a, p }
  keys: new Map(), // scheduleId -> Idempotency-Key
};

export function resetVisitState() {
  mem.userId = null;
  mem.drafts.clear();
  mem.keys.clear();
}

function draftFor(id) {
  let d = mem.drafts.get(id);
  if (!d) { d = { s: '', o: '', a: '', p: '' }; mem.drafts.set(id, d); }
  return d;
}

// ----- tampilan -----
export async function visitView(main, user, ctx, { goTo, params } = {}) {
  const { signal } = ctx;
  if (mem.userId !== user.id) { resetVisitState(); mem.userId = user.id; }
  const toSchedule = () => goTo('schedule');
  const backBtn = (label = 'Buka Jadwal Saya') => h('button', { class: 'btn btn--primary', type: 'button', onclick: toSchedule }, label);

  const sid = soapDraftKey(params?.scheduleId);
  if (!sid) {
    main.append(h('div', { class: 'visit' },
      emptyState('Pilih jadwal dulu', 'SOAP diisi setelah kamu memulai tugas. Buka Jadwal Saya atau Beranda, tekan Mulai pada tugas hari ini.'),
      h('div', { class: 'visit__actions' }, backBtn())));
    return;
  }

  main.append(h('p', { class: 'muted', role: 'status' }, 'Memuat jadwal…'));
  let schedule;
  try {
    ({ schedule } = await api(`/api/my/schedules/${sid}`, { signal }));
  } catch (e) {
    if (e.aborted || !ctx.isCurrent()) return;
    main.replaceChildren(h('div', { class: 'visit' },
      emptyState(e.status === 404 ? 'Jadwal tidak ditemukan' : 'Jadwal belum bisa dimuat',
        e.status === 404 ? 'Jadwal ini tidak ada atau bukan milikmu.' : e.message),
      h('div', { class: 'visit__actions' }, backBtn('Kembali ke Jadwal Saya'))));
    return;
  }
  if (!ctx.isCurrent()) return;

  const today = todayInTz();
  const blocked = visitBlockReason(schedule, today);
  if (blocked) {
    main.replaceChildren(h('div', { class: 'visit' },
      customerCard(schedule),
      schedule.status === 'berjalan' && schedule.phase === 'timer'
        ? h('div', { class: 'visit__countdown' }, countdownEl(schedule.remaining_sec, { signal, onDone: () => { if (ctx.isCurrent()) goTo('schedule'); } }))
        : null,
      emptyState(schedule.status === 'berjalan' && schedule.phase ? 'SOAP sudah disimpan' : 'Jadwal tidak bisa diisi', blocked),
      h('div', { class: 'visit__actions' }, backBtn('Kembali ke Jadwal Saya'))));
    return;
  }

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Isi SOAP kunjungan'), h('p', { class: 'muted' }, 'Isi SOAP dulu. Setelah disimpan, hitung mundur berjalan; saat waktu habis tugas menunggu approve admin atau supervisor.')),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: toSchedule }, 'Jadwal Saya')));

  if (schedule.status === 'selesai') {
    main.replaceChildren(h('div', { class: 'visit' }, head, customerCard(schedule), servicesBox(schedule), soapReadOnly(schedule),
      h('div', { class: 'visit__actions' }, backBtn('Kembali ke Jadwal Saya'))));
    return;
  }

  // ----- form SOAP -----
  const draft = draftFor(sid);
  let busy = false;
  const touched = new Set(); // bagian yang sudah disentuh/dicoba simpan -> baru tampil galatnya
  const boxes = {};

  const uncertain = h('p', { class: 'warn', role: 'status', hidden: true }, UNCERTAIN_MSG);
  const serverError = h('p', { class: 'error visit__error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Simpan');

  const fields = SOAP_PARTS.map((part) => {
    const id = `soap-${part.key}`;
    const area = h('textarea', {
      class: 'textarea visit__area', id, rows: '4', required: true, 'aria-required': 'true',
      'aria-describedby': `${id}-hint ${id}-count ${id}-err`, 'aria-invalid': 'false', spellcheck: 'true',
    });
    area.value = draft[part.key] || '';
    const count = h('span', { class: 'visit__count', id: `${id}-count` }, '');
    const err = h('p', { class: 'error visit__field-error', id: `${id}-err` });
    boxes[part.key] = { area, count, err };
    area.addEventListener('input', () => { draft[part.key] = area.value; update(); });
    area.addEventListener('blur', () => { touched.add(part.key); update(); });
    area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); trySave(); } });
    return h('div', { class: 'field visit__field' },
      h('label', { for: id }, `${part.key.toUpperCase()} · ${part.label} `, h('span', { class: 'visit__req' }, '(wajib)')),
      h('p', { class: 'hint', id: `${id}-hint` }, part.hint),
      area,
      h('div', { class: 'visit__meta' }, err, count));
  });

  function update() {
    const v = validateSoapClient(draft);
    for (const k of PART_KEYS) {
      const b = boxes[k];
      const n = tidySoapText(draft[k]).length;
      b.count.textContent = `${n} / ${SOAP_MAX}`;
      b.count.classList.toggle('is-over', n > SOAP_MAX);
      const shown = (touched.has(k) || n > SOAP_MAX) && v.errors[k] ? v.errors[k] : '';
      b.err.textContent = shown;
      b.area.setAttribute('aria-invalid', String(shown !== ''));
      b.area.disabled = busy;
    }
    save.disabled = busy || !v.ok;
    save.textContent = busy ? 'Menyimpan…' : 'Simpan';
    return v;
  }

  async function trySave() {
    if (busy) return;
    const v = validateSoapClient(draft);
    if (!v.ok) {
      for (const k of PART_KEYS) touched.add(k);
      update();
      boxes[v.first].area.focus();
      return;
    }
    let key = mem.keys.get(sid);
    if (!key) { key = newIdempotencyKey(); mem.keys.set(sid, key); }
    busy = true;
    uncertain.hidden = true;
    serverError.textContent = '';
    update();
    try {
      const saved = await api('/api/records', {
        method: 'POST',
        body: { schedule_id: Number(sid), soap: cleanSoap(draft) },
        headers: { 'Idempotency-Key': key },
        signal,
      });
      mem.drafts.delete(sid);
      mem.keys.delete(sid);
      toast(saved?.schedule?.phase === 'timer'
        ? `SOAP tersimpan. Hitung mundur ${schedule.customer.name} dimulai; setelah waktu habis menunggu approve.`
        : `SOAP tersimpan. Tugas ${schedule.customer.name} selesai.`);
      busy = false;
      if (ctx.isCurrent()) toSchedule();
      return;
    } catch (e) {
      if (e.aborted) return; // pindah tab / sesi berakhir: key dan draf tetap, mengulang Simpan aman
      if (e.status === 401) return; // login sudah ditampilkan oleh app.js
      if (e.uncertain || e.status >= 500) {
        // Jaringan putus / timeout / server error: bisa jadi sudah tersimpan. Key DIPERTAHANKAN.
        if (ctx.isCurrent()) uncertain.hidden = false;
        toast(e.uncertain ? UNCERTAIN_MSG : e.message, 'err');
      } else {
        // Ditolak tegas (4xx): tidak ada yang tersimpan, jadi percobaan berikutnya memakai key baru.
        mem.keys.delete(sid);
        if (ctx.isCurrent()) serverError.textContent = e.message;
        toast(e.message, 'err');
      }
    } finally {
      busy = false;
      if (ctx.isCurrent()) update();
    }
  }
  save.addEventListener('click', trySave);

  main.replaceChildren(h('div', { class: 'visit' },
    head,
    customerCard(schedule),
    servicesBox(schedule),
    h('form', { class: 'visit__form', novalidate: true, 'aria-label': 'SOAP kunjungan', onsubmit: (e) => { e.preventDefault(); trySave(); } },
      h('h2', { class: 'visit__title' }, 'SOAP kunjungan'),
      ...fields,
      uncertain, serverError,
      h('div', { class: 'visit__actions' }, save))));
  update();
}

// ----- potongan tampilan -----
function customerCard(schedule) {
  const c = schedule.customer || {};
  return h('section', { class: 'visit-card', 'aria-label': 'Customer' },
    h('div', { class: 'visit-card__top' },
      h('div', null, h('p', { class: 'visit-card__label' }, 'Customer'), h('h2', { class: 'visit-card__name' }, c.name || '-')),
      schedulePill(schedule.status, schedule.overdue)),
    h('dl', { class: 'visit-card__facts' },
      h('div', null, h('dt', null, 'No RM'), h('dd', null, c.rm_no || '-')),
      h('div', null, h('dt', null, 'Hari'), h('dd', null, fmtLongDay(schedule.day))),
      h('div', null, h('dt', null, 'Jam'), h('dd', null, fmtTimeRange(schedule.start_time, schedule.end_time)))),
    schedule.note ? h('p', { class: 'visit-card__note' }, h('b', null, 'Catatan admin: '), schedule.note) : null);
}

function servicesBox(schedule) {
  const list = Array.isArray(schedule.services) ? schedule.services : [];
  return h('section', { class: 'visit-services', 'aria-label': 'Layanan' },
    h('div', { class: 'visit-services__head' },
      h('h2', { class: 'visit__title' }, `Layanan (${list.length})`),
      ),
    h('ul', { class: 'visit-services__list' }, ...list.map((s) => h('li', null, s.name))));
}

function soapReadOnly(schedule) {
  const soap = schedule.soap;
  return h('section', { class: 'visit__readonly', 'aria-label': 'SOAP kunjungan' },
    h('h2', { class: 'visit__title' }, 'SOAP kunjungan'),
    soap
      ? SOAP_PARTS.map((p) => h('div', { class: 'visit__ro-part' }, h('h3', null, `${p.key.toUpperCase()} · ${p.label}`), h('p', null, soap[p.key] || '-')))
      : h('p', { class: 'muted' }, 'SOAP tidak tersedia.'));
}
