// Data booking dari WhatsApp, slot jadwal, dan kalender bulanan.
// Jam layanan diatur supervisor di menu Integrasi (env hanya cadangan); bawaan 09:00-17:00 per 60 menit.
import { db } from './db.js';
import { HttpError } from './util.js';
import { slotPassed, ymd } from './clock.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function validDay(v) {
  if (!DAY_RE.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const stored = (k) => { try { return db.prepare('SELECT value FROM integration_settings WHERE key = ?').get(k)?.value || ''; } catch { return ''; } };

/** Jam layanan: pengaturan di dashboard (Integrasi) didahulukan, lalu env (BOOKING_HOURS/BOOKING_STEP_MIN), lalu bawaan. */
export function bookingConfig(env = process.env) {
  let from = '09:00'; let to = '17:00'; let step = 60;
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(String(env.BOOKING_HOURS || '').trim());
  if (m && HM_RE.test(m[1]) && HM_RE.test(m[2]) && toMin(m[1]) < toMin(m[2])) [, from, to] = m;
  const es = Number(env.BOOKING_STEP_MIN);
  if (Number.isInteger(es) && es >= 15 && es <= 240) step = es;
  const sf = stored('booking_from'), st = stored('booking_to'), ss = Number(stored('booking_step'));
  if (HM_RE.test(sf) && HM_RE.test(st) && toMin(sf) < toMin(st)) { from = sf; to = st; }
  if (Number.isInteger(ss) && ss >= 15 && ss <= 240) step = ss;
  return { from, to, step };
}

/** Simpan jam layanan dari dashboard. Melempar HttpError 400 bila tidak valid. */
export function saveBookingConfig({ from, to, step }) {
  if (!HM_RE.test(String(from)) || !HM_RE.test(String(to))) throw new HttpError(400, 'Jam buka dan jam tutup harus berformat JJ:MM');
  if (toMin(from) >= toMin(to)) throw new HttpError(400, 'Jam tutup harus setelah jam buka');
  const n = Number(step);
  if (!Number.isInteger(n) || n < 15 || n > 240) throw new HttpError(400, 'Lama tiap sesi harus 15 sampai 240 menit');
  const up = db.prepare('INSERT INTO integration_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  up.run('booking_from', from); up.run('booking_to', to); up.run('booking_step', String(n));
  return bookingConfig();
}

/** Booking dari data formulir WhatsApp. Nilai yang tidak valid dibuang, tidak melempar. */
export function bookingOf(rawJson) {
  let d = {};
  try { d = JSON.parse(rawJson || '{}') || {}; } catch { d = {}; }
  const day = validDay(d.booking_day) ? d.booking_day : '';
  const time = HM_RE.test(String(d.booking_time ?? '')) ? d.booking_time : '';
  const rawNames = Array.isArray(d.booking_services) ? d.booking_services : String(d.booking_services ?? '').split(/[,;\n]/);
  const names = rawNames
    .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 10);
  const all = db.prepare('SELECT id, name FROM services WHERE active = 1').all();
  const service_ids = [];
  for (const n of names) {
    const hit = all.find((s) => s.name.trim().toLowerCase() === n.toLowerCase());
    if (hit && !service_ids.includes(hit.id)) service_ids.push(hit.id);
  }
  return { day, time, service_names: names, service_ids };
}

const activeWorkers = () => db.prepare("SELECT id FROM users WHERE role = 'user' AND active = 1").all().map((r) => r.id);

// Jadwal petugas yang masih berlaku pada hari itu. Tanpa jam selesai dianggap memakai satu langkah slot.
function busyRanges(day, step) {
  return db.prepare("SELECT user_id, start_time, end_time FROM schedules WHERE day = ? AND status != 'batal'").all(day)
    .map((r) => {
      const s = toMin(String(r.start_time).slice(0, 5));
      const e = r.end_time && HM_RE.test(String(r.end_time).slice(0, 5)) && toMin(String(r.end_time).slice(0, 5)) > s ? toMin(String(r.end_time).slice(0, 5)) : s + step;
      return { user_id: r.user_id, s, e };
    });
}

export function workerBusy(userId, day, startHm, endHm = '', step = bookingConfig().step) {
  const s = toMin(startHm);
  const e = endHm && toMin(endHm) > s ? toMin(endHm) : s + step;
  return busyRanges(day, step).some((r) => r.user_id === Number(userId) && r.s < e && s < r.e);
}

/** Slot hari itu: tersedia bila belum lewat dan masih ada petugas yang kosong. */
export function slotsFor(day) {
  if (!validDay(day)) throw new HttpError(400, 'Isi ?date=YYYY-MM-DD');
  const cfg = bookingConfig();
  const workers = activeWorkers();
  const busy = busyRanges(day, cfg.step);
  const slots = [];
  for (let m = toMin(cfg.from); m < toMin(cfg.to); m += cfg.step) {
    const hm = toHm(m);
    const taken = new Set(busy.filter((r) => r.s < m + cfg.step && m < r.e).map((r) => r.user_id));
    const free = workers.filter((id) => !taken.has(id)).length;
    slots.push({ time: hm, free, available: free > 0 && !slotPassed(day, hm) });
  }
  return { date: day, supported: true, step_minutes: cfg.step, slots };
}

/** Jumlah jadwal per hari dan status untuk satu bulan (YYYY-MM). */
export function calendarMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) throw new HttpError(400, 'Isi ?month=YYYY-MM');
  const rows = db.prepare('SELECT day, status, COUNT(*) AS n FROM schedules WHERE day >= ? AND day <= ? GROUP BY day, status')
    .all(`${month}-01`, `${month}-31`);
  const days = {};
  for (const r of rows) {
    const d = (days[r.day] ||= { total: 0, baru: 0, berjalan: 0, selesai: 0, batal: 0 });
    d[r.status] = r.n;
    d.total += r.n;
  }
  return { month, today: ymd(), days };
}
