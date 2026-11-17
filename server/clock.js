import fs from 'node:fs';

const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const fmtClock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Waktu sekarang. Khusus tes (NODE_ENV=test + APP_FAKE_NOW_FILE): isi berkas dibaca SETIAP dipanggil
// (string waktu ISO) sehingga tes bisa memajukan jam tanpa menyalakan ulang server.
export function now() {
  const file = process.env.APP_FAKE_NOW_FILE;
  if (process.env.NODE_ENV === 'test' && file) {
    try {
      const d = new Date(fs.readFileSync(file, 'utf8').trim());
      if (!Number.isNaN(d.getTime())) return d;
    } catch { /* berkas hilang/rusak: pakai waktu asli */ }
  }
  return new Date();
}

export const ymd = (date = now()) => fmt.format(date); // YYYY-MM-DD di zona waktu bisnis

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// ---------- batas waktu SOAP dan approve ----------
// SOAP diisi user setelah pelayanan selesai, paling lambat jam SOAP_DEADLINE (default 23:00) pada tanggal jadwal.
// Approve admin/supervisor: pada tanggal jadwal, atau besoknya sampai jam APPROVE_UNTIL (default 10:00). Zona APP_TZ (WIB).
export const DEFAULT_SOAP_DEADLINE = '23:00';
export const DEFAULT_APPROVE_UNTIL = '10:00';
const HM_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const hmOf = (envName, fallback) => {
  const raw = String(process.env[envName] ?? '').trim();
  return HM_RX.test(raw) ? raw : fallback;
};
export const soapDeadlineHm = () => hmOf('SOAP_DEADLINE', DEFAULT_SOAP_DEADLINE);
export const approveUntilHm = () => hmOf('APPROVE_UNTIL', DEFAULT_APPROVE_UNTIL);
const minutesOfDay = (date) => { const [hh, mm] = fmtClock.format(date).split(':').map(Number); return hh * 60 + mm; };
const addDaysYmd = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// true bila waktu jadwal (tanggal + jam mulai, WIB) sudah lewat. Jam mulai yang sama dengan menit sekarang masih boleh.
export function slotPassed(day, startHm, at = now()) {
  if (String(process.env.SLOT_CHECK ?? '').trim().toLowerCase() === 'off') return false; // hanya untuk tes data lama; ditolak di produksi (config.js)
  const today = ymd(at);
  if (day < today) return true;
  if (day > today) return false;
  return toMin(startHm) < minutesOfDay(at);
}
export const SLOT_PASSED_MESSAGE = 'Waktu jadwal sudah lewat. Pilih tanggal atau jam mulai yang belum lewat.';

// true bila batas isi SOAP untuk jadwal bertanggal `day` sudah lewat.
export function soapDeadlinePassed(day, at = now()) {
  const today = ymd(at);
  if (today > day) return true;
  if (today < day) return false;
  return minutesOfDay(at) >= toMin(soapDeadlineHm());
}

// true bila pekerjaan bertanggal `day` masih boleh di-approve: hari yang sama, atau besoknya sebelum APPROVE_UNTIL.
export function approvalOpen(day, at = now()) {
  const today = ymd(at);
  if (day === today) return true;
  return addDaysYmd(day, 1) === today && minutesOfDay(at) < toMin(approveUntilHm());
}

export const dotTime = (hm) => String(hm).replace(':', '.');
export const approvalClosedMessage = () => `Batas approve sudah lewat. Pekerjaan bisa di-approve pada hari yang sama atau besoknya sampai pukul ${dotTime(approveUntilHm())} WIB.`;
