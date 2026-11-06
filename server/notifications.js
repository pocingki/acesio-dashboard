import { db } from './db.js';
import { now } from './clock.js';
import { HttpError } from './util.js';

// Tipe notifikasi. Enam pertama untuk terapis; perlu_approve untuk admin dan supervisor.
export const NOTIFICATION_TYPES = Object.freeze({
  tugas_baru: 'tugas_baru',
  tugas_diubah: 'tugas_diubah',
  tugas_berjalan: 'tugas_berjalan',
  tugas_selesai: 'tugas_selesai',
  tugas_disetujui: 'tugas_disetujui',
  tugas_dibatalkan: 'tugas_dibatalkan',
  perlu_approve: 'perlu_approve',
});

// Judul baku tiap tipe.
export const NOTIFICATION_TITLES = Object.freeze({
  tugas_baru: 'Tugas baru',
  tugas_diubah: 'Jadwal diubah',
  tugas_berjalan: 'Tugas sedang dijalani',
  tugas_selesai: 'Tugas selesai',
  tugas_disetujui: 'Pekerjaan disetujui, isi SOAP',
  tugas_dibatalkan: 'Tugas dibatalkan',
  perlu_approve: 'Perlu approve terapis',
});

// Hanya INSERT. Ikut transaksi yang sedang berjalan dan tidak pernah melempar error ke pemanggil:
// gagal membuat notifikasi tidak boleh membatalkan perubahan jadwal. Mengembalikan id, atau null bila gagal.
export function createNotification({ userId, type, scheduleId = null, title, body = '' }) {
  try {
    if (!NOTIFICATION_TYPES[type]) return null;
    const info = db.prepare(`INSERT INTO notifications (user_id, type, schedule_id, title, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      Number(userId), type, scheduleId == null ? null : Number(scheduleId),
      String(title || NOTIFICATION_TITLES[type]), String(body ?? ''), new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

// =====================================================================
// Bagian baca (Fase 5): daftar, tandai dibaca, hitung belum dibaca, bersih-bersih.
// Semua hanya menyentuh notifikasi milik user yang diminta.
// =====================================================================
export const NOTIF_DEFAULT_LIMIT = 30;
export const NOTIF_MAX_LIMIT = 100;
export const NOTIF_MAX_IDS = 100;

// limit kosong/tidak ada -> 30. Selain bilangan bulat 1..100 -> 400.
function readLimit(v) {
  if (v === undefined || v === null || String(v).trim() === '') return NOTIF_DEFAULT_LIMIT;
  const s = String(v).trim();
  const n = /^\d{1,6}$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > NOTIF_MAX_LIMIT) {
    throw new HttpError(400, `Batas harus berupa angka 1–${NOTIF_MAX_LIMIT}`);
  }
  return n;
}

export function unreadCount(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = ''").get(Number(userId)).n;
}

// Terbaru dulu. day diambil dari jadwal terkait (null bila jadwal tidak ada).
// Jadwal yang hitung mundurnya sudah habis (siap di-approve) diberi satu notifikasi
// ke tiap admin dan supervisor aktif. Dipanggil saat lonceng dibuka; aman diulang.
export function syncApprovalNotifications(at = now()) {
  const nowIso = at.toISOString();
  const due = db.prepare(`SELECT s.id, s.day, s.start_time, c.name AS customer_name, u.name AS therapist_name
    FROM schedules s
    JOIN customers c ON c.id = s.customer_id
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'berjalan' AND s.flow = 1 AND s.due_at != '' AND s.due_at <= ?`).all(nowIso);
  if (!due.length) return 0;
  const staff = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin', 'supervisor')").all();
  const exists = db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND schedule_id = ? AND type = 'perlu_approve'");
  let made = 0;
  for (const s of due) {
    const body = `${s.therapist_name} · ${s.customer_name} · ${s.day} ${String(s.start_time || '').slice(0, 5)}`;
    for (const st of staff) {
      if (exists.get(st.id, s.id)) continue;
      if (createNotification({ userId: st.id, type: 'perlu_approve', scheduleId: s.id, body })) made += 1;
    }
  }
  return made;
}

export function listNotifications(userId, { limit } = {}) {
  try { syncApprovalNotifications(); } catch { /* lonceng tetap menampilkan yang sudah ada */ }
  const n = readLimit(limit);
  const rows = db.prepare(`SELECT n.id, n.type, n.title, n.body, n.schedule_id, n.created_at, n.read_at, s.day AS day
    FROM notifications n LEFT JOIN schedules s ON s.id = n.schedule_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`).all(Number(userId), n);
  return {
    notifications: rows.map((r) => ({
      id: r.id, type: r.type, title: r.title, body: r.body,
      schedule_id: r.schedule_id, day: r.day ?? null, created_at: r.created_at, read: r.read_at !== '',
    })),
    unread: unreadCount(userId),
  };
}

// ids: array bilangan bulat positif (maks 100); all: true menandai semuanya.
// Id milik orang lain atau yang tidak ada diabaikan tanpa error. Yang sudah dibaca tidak diubah.
export function markRead(userId, { ids, all } = {}) {
  const uid = Number(userId);
  const now = new Date().toISOString();
  if (all !== undefined && all !== true && all !== false) throw new HttpError(400, 'Isi "all" harus true atau false');
  if (all === true) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = ''").run(now, uid);
  } else {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > NOTIF_MAX_IDS
      || !ids.every((x) => typeof x === 'number' && Number.isInteger(x) && x > 0)) {
      throw new HttpError(400, `Kirim "ids" (1–${NOTIF_MAX_IDS} id notifikasi) atau all: true`);
    }
    const list = [...new Set(ids)];
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = '' AND id IN (${list.map(() => '?').join(',')})`)
      .run(now, uid, ...list);
  }
  return unreadCount(uid);
}

// Menghapus notifikasi yang lebih tua dari `days` hari. Mengembalikan jumlah baris terhapus.
export function pruneOldNotifications(days = 90) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  return Number(db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes);
}
