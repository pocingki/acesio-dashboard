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

// ---------- jam akses akun user ----------

const DEFAULT_ACCESS = { start: '06:00', end: '23:00' };
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
let warned = false;

// Env dibaca saat dipanggil. Mengembalikan { start, end, startMin, endMin } atau null (tidak dibatasi).
export function accessWindow() {
  const raw = String(process.env.ACCESS_HOURS ?? '').trim();
  if (!raw) return build(DEFAULT_ACCESS);
  if (raw.toLowerCase() === 'off') return null;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(raw);
  if (m) {
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    const valid = h1 < 24 && h2 < 24 && m1 < 60 && m2 < 60 && h1 * 60 + m1 < h2 * 60 + m2;
    if (valid) return build({ start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` });
  }
  if (!warned) {
    warned = true;
    console.warn(`ACCESS_HOURS="${raw}" tidak valid (format HH:MM-HH:MM, mulai harus lebih kecil dari akhir). Memakai default ${DEFAULT_ACCESS.start}-${DEFAULT_ACCESS.end}.`);
  }
  return build(DEFAULT_ACCESS);
}

function build({ start, end }) {
  return { start, end, startMin: toMin(start), endMin: toMin(end) };
}

// true bila tidak dibatasi atau jam:menit (zona APP_TZ) berada di [mulai, akhir).
export function isWithinAccess(date = now()) {
  const w = accessWindow();
  if (!w) return true;
  const [hh, mm] = fmtClock.format(date).split(':').map(Number);
  const minutes = hh * 60 + mm;
  return minutes >= w.startMin && minutes < w.endMin;
}

export function accessMessage() {
  const w = accessWindow() ?? DEFAULT_ACCESS;
  const dot = (t) => t.replace(':', '.');
  return `Akun user hanya bisa dipakai pukul ${dot(w.start)}–${dot(w.end)}. Silakan masuk kembali pada jam tersebut.`;
}

// Bentuk untuk respons API: { start, end } atau null bila tidak dibatasi.
export function accessInfo() {
  const w = accessWindow();
  return w ? { start: w.start, end: w.end } : null;
}
