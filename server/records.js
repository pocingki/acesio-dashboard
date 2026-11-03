import crypto from 'node:crypto';
import { db, tx } from './db.js';
import { HttpError } from './util.js';
import { ymd } from './clock.js';
import { logAudit } from './audit.js';
import { enqueueVisit } from './integration.js';

const nowIso = () => new Date().toISOString();

// Satu-satunya jalur pembuatan record. Semua pengecekan dan INSERT ada di satu transaksi
// (ikut transaksi luar bila dipanggil dari withIdempotency). Mengembalikan jumlah baris.
export function createRecords({ userId, customer, serviceIds, source, note }) {
  return tx(() => {
    const u = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(userId);
    if (!u) throw new HttpError(404, 'User tidak ditemukan');
    if (!u.active) throw new HttpError(403, 'Akun tidak aktif');
    if (u.role !== 'user') throw new HttpError(403, 'Hanya akun user yang menginput layanan');
    if (!customer || !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customer.id)) {
      throw new HttpError(404, 'Customer tidak ditemukan. Laporkan ke admin untuk memasukkan data customer baru.');
    }
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) throw new HttpError(400, 'Pilih minimal satu layanan');

    const day = ymd();
    if (db.prepare('SELECT 1 FROM day_reviews WHERE user_id = ? AND day = ?').get(userId, day)) {
      throw new HttpError(409, 'Data hari ini sudah di-approve dan dikunci. Hubungi supervisor jika perlu menambah.');
    }
    const price = db.prepare('SELECT amount FROM user_commissions WHERE user_id = ? AND service_id = ?');
    const svc = db.prepare('SELECT id FROM services WHERE id = ?');
    const ins = db.prepare('INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const when = nowIso();
    const batch = crypto.randomUUID();
    for (const id of serviceIds) {
      if (!svc.get(id)) throw new HttpError(400, 'Ada layanan yang tidak ditemukan');
      ins.run(userId, customer.id, id, price.get(userId, id)?.amount ?? 0, source, when, day, String(note || ''), batch);
    }
    // Antrean ke Amnan ikut transaksi ini; tidak pernah melempar error dan tidak menunggu jaringan.
    enqueueVisit({ customer, serviceIds, day });
    return serviceIds.length;
  });
}

// Satu-satunya jalur penghapusan record.
// - user: hanya miliknya, day === hari ini (APP_TZ), dan belum di-approve; selain itu 409
// - supervisor: boleh menghapus apa saja
// - admin (dan data milik orang lain): 404
// Setiap penghapusan tercatat di audit_log dalam transaksi yang sama.
export function deleteRecord({ actor, id, ip = '' }) {
  return tx(() => {
    const r = db.prepare(`SELECT r.id, r.user_id, r.customer_id, r.service_id, r.commission, r.day, (dr.day IS NOT NULL) AS locked
      FROM records r LEFT JOIN day_reviews dr ON dr.user_id = r.user_id AND dr.day = r.day WHERE r.id = ?`).get(id);
    const isSv = actor.role === 'supervisor';
    const isOwner = actor.role === 'user' && !!r && r.user_id === actor.id;
    if (!r || !(isSv || isOwner)) throw new HttpError(404, 'Data tidak ditemukan');
    if (!isSv) {
      if (r.day !== ymd()) throw new HttpError(409, 'Data hari lampau sudah terkunci');
      if (r.locked) throw new HttpError(409, 'Data sudah di-approve dan dikunci');
    }
    db.prepare('DELETE FROM records WHERE id = ?').run(r.id);
    logAudit({
      actor: { id: actor.id, name: actor.name },
      action: 'record.delete',
      targetType: 'record',
      targetId: String(r.id),
      detail: { user_id: r.user_id, customer_id: r.customer_id, service_id: r.service_id, commission: r.commission, day: r.day },
      ip,
    });
  });
}