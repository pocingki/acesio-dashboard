// Modul tampilan jadwal yang dipakai bersama (admin/supervisor dan user).
// Aman diimpor di Node: tidak menyentuh document/window saat dimuat.
import { h } from './ui.js';

export const SCHEDULE_STATUS_LABEL = {
  baru: 'Baru', berjalan: 'Sedang dijalani', selesai: 'Selesai', batal: 'Dibatalkan',
};

// Fase jadwal berjalan (dari server): soap = menunggu SOAP (hitung mundur belum jalan), timer = hitung mundur,
// menunggu = waktu habis & belum di-approve. Setelah approve jadwal Selesai.
export const PHASE_LABEL = { soap: 'Isi SOAP', timer: 'Sedang dijalani', menunggu: 'Menunggu approve' };
// Opsi filter status untuk staf: empat status + pseudo-status "menunggu".
export const STAFF_STATUS_FILTER = { ...SCHEDULE_STATUS_LABEL, menunggu: 'Menunggu approve' };

// Lencana status. overdue (jadwal lampau yang belum selesai) tampil "Terlewat".
// phase (opsional) memperjelas jadwal berjalan: Isi SOAP / Sedang dijalani / Menunggu approve.
export function schedulePill(status, overdue = false, phase = null) {
  if (overdue && (status === 'baru' || status === 'berjalan')) {
    return h('span', { class: 'pill sch-pill sch-pill--terlewat' }, 'Terlewat');
  }
  if (status === 'berjalan' && PHASE_LABEL[phase]) {
    return h('span', { class: `pill sch-pill sch-pill--${phase === 'menunggu' ? 'menunggu' : 'berjalan'}` }, PHASE_LABEL[phase]);
  }
  const key = SCHEDULE_STATUS_LABEL[status] ? status : 'baru';
  return h('span', { class: `pill sch-pill sch-pill--${key}` }, SCHEDULE_STATUS_LABEL[key]);
}

// ---------- hitung mundur ----------
// 3725 -> "1:02:05", 125 -> "02:05", 0 -> "00:00". Nilai tak sah dianggap 0.
export function fmtCountdown(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(n / 3600);
  const mm = String(Math.floor((n % 3600) / 60)).padStart(2, '0');
  const ss = String(n % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Elemen hitung mundur untuk jadwal berjalan dengan phase 'timer' (SOAP sudah disimpan). Sisa waktu berasal dari server (remaining_sec);
// penghitung memakai jam monotonik browser sehingga jam perangkat yang salah tidak berpengaruh.
// onDone dipanggil sekali saat habis. Berhenti sendiri bila elemen dilepas dari halaman atau signal dibatalkan.
export function countdownEl(remainingSec, { onDone, signal, label = 'Sisa waktu' } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const total = Math.max(0, Math.ceil(Number(remainingSec) || 0));
  const time = h('b', { class: 'cd__time', role: 'timer', 'aria-live': 'off' }, fmtCountdown(total));
  const el = h('span', { class: 'cd' }, h('span', { class: 'cd__label' }, label), time);
  let done = false;
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const tick = () => {
    const left = Math.max(0, total - Math.floor((clock() - t0) / 1000));
    time.textContent = fmtCountdown(left);
    if (left <= 0 && !done) { done = true; stop(); el.classList.add('is-done'); if (typeof onDone === 'function') onDone(); }
  };
  if (total <= 0) { queueMicrotask(tick); return el; }
  timer = setInterval(() => {
    if (!el.isConnected || signal?.aborted) { stop(); return; }
    tick();
  }, 1000);
  signal?.addEventListener?.('abort', stop, { once: true });
  return el;
}

// "09:00–10:00" atau "09:00" bila jam selesai kosong.
export function fmtTimeRange(start, end) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (!s) return e;
  return e ? `${s}–${e}` : s;
}

const LONG_DAY = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

// "2026-11-05" -> "Kamis, 5 November 2026" (tanggal kalender, tanpa pergeseran zona).
export function fmtLongDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return String(ymd);
  const out = LONG_DAY.format(d);
  return out.includes(',') ? out : out.replace(/^(\S+) /, '$1, ');
}

// "Layanan 1, Layanan 3 +2"; kosong -> "-".
export function servicesSummary(services, max = 2) {
  const names = (Array.isArray(services) ? services : []).map((s) => String(s?.name ?? '').trim()).filter(Boolean);
  if (!names.length) return '-';
  const keep = Math.max(1, Number(max) || 2);
  const shown = names.slice(0, keep).join(', ');
  return names.length > keep ? `${shown} +${names.length - keep}` : shown;
}

export const SOAP_PARTS = [
  { key: 's', label: 'Subjective', hint: 'Keluhan dan cerita pasien' },
  { key: 'o', label: 'Objective', hint: 'Hasil pemeriksaan dan pengukuran' },
  { key: 'a', label: 'Assessment', hint: 'Penilaian dan diagnosis' },
  { key: 'p', label: 'Planning', hint: 'Rencana tindakan dan tindak lanjut' },
];
