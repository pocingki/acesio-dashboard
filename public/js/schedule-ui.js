// Modul tampilan jadwal yang dipakai bersama (admin/supervisor dan user).
// Aman diimpor di Node: tidak menyentuh document/window saat dimuat.
import { h } from './ui.js';

export const SCHEDULE_STATUS_LABEL = {
  baru: 'Baru', berjalan: 'Sedang dijalani', selesai: 'Selesai', batal: 'Dibatalkan',
};

// Lencana status. overdue (jadwal lampau yang belum selesai) tampil "Terlewat".
export function schedulePill(status, overdue = false) {
  if (overdue && (status === 'baru' || status === 'berjalan')) {
    return h('span', { class: 'pill sch-pill sch-pill--terlewat' }, 'Terlewat');
  }
  const key = SCHEDULE_STATUS_LABEL[status] ? status : 'baru';
  return h('span', { class: `pill sch-pill sch-pill--${key}` }, SCHEDULE_STATUS_LABEL[key]);
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
