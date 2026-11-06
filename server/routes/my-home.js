import { add } from './index.js';
import { requireWorker } from './helpers.js';
import { db } from '../db.js';
import { ymd } from '../clock.js';
import { SCHEDULE_SELECT, toApi, toApiList, phaseOf } from '../schedules.js';
import { unreadCount } from '../notifications.js';

// Ringkasan Beranda user (D7): angka customer hari ini, jumlah per status, tugas berikutnya, dan notifikasi belum dibaca.
// Admin/supervisor mendapat 403 (requireWorker).

const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Jam sekarang "HH:MM" pada zona waktu bisnis.
const nowHm = () => hmFmt.format(new Date());

add('GET', '/api/my/home', 'user', ({ user }) => {
  requireWorker(user);
  const today = ymd();

  // Customer unik pada jadwal hari ini yang bukan batal.
  const customers_today = db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM schedules
    WHERE user_id = ? AND day = ? AND status <> 'batal'`).get(user.id, today).n;

  const by_status = { baru: 0, berjalan: 0, selesai: 0, batal: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM schedules WHERE user_id = ? AND day = ? GROUP BY status').all(user.id, today)) {
    if (r.status in by_status) by_status[r.status] = r.n;
  }

  // Dari yang berjalan hari ini: berapa yang menunggu SOAP, sedang hitung mundur, atau menunggu approve (jadwal lama tanpa fase tidak dihitung).
  const phases = { soap: 0, timer: 0, menunggu: 0 };
  for (const r of db.prepare(`${SCHEDULE_SELECT} WHERE s.user_id = ? AND s.day = ? AND s.status = 'berjalan'`).all(user.id, today)) { const ph = phaseOf(r); if (ph) phases[ph]++; }

  // Berikutnya: baru/berjalan hari ini dengan jam mulai terdekat yang belum lewat; bila semua sudah lewat, yang paling awal.
  const open = db.prepare(`${SCHEDULE_SELECT} WHERE s.user_id = ? AND s.day = ? AND s.status IN ('baru','berjalan')
    ORDER BY s.start_time, s.id`).all(user.id, today);
  const hm = nowHm();
  const row = open.find((r) => r.start_time >= hm) || open[0] || null;

  // Jadwal Saya Hari Ini (beranda): hanya tugas yang belum dimulai (baru) dan sedang dijalani (berjalan), urut jam.
  // Tugas selesai (dan batal) tidak tampil di sini; riwayat lengkap ada di tab Jadwal Saya.
  const todayRows = db.prepare(`${SCHEDULE_SELECT} WHERE s.user_id = ? AND s.day = ? AND s.status IN ('baru','berjalan')
    ORDER BY s.start_time, s.id`).all(user.id, today);

  return { today, customers_today, by_status, phases, next: row ? toApi(row) : null, schedules: toApiList(todayRows), unread: unreadCount(user.id) };
});
