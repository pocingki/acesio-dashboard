import { add } from './index.js';
import { requireWorker } from './helpers.js';
import { db } from '../db.js';
import { ymd } from '../clock.js';
import { SCHEDULE_SELECT, toApi } from '../schedules.js';
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

  // Berikutnya: baru/berjalan hari ini dengan jam mulai terdekat yang belum lewat; bila semua sudah lewat, yang paling awal.
  const open = db.prepare(`${SCHEDULE_SELECT} WHERE s.user_id = ? AND s.day = ? AND s.status IN ('baru','berjalan')
    ORDER BY s.start_time, s.id`).all(user.id, today);
  const hm = nowHm();
  const row = open.find((r) => r.start_time >= hm) || open[0] || null;

  return { today, customers_today, by_status, next: row ? toApi(row) : null, unread: unreadCount(user.id) };
});
