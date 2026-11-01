import { db } from './db.js';

// Mencatat satu baris jejak audit. Sinkron dan memakai koneksi yang sama dengan pemanggil,
// jadi bila dipanggil di dalam tx() baris ini ikut batal/ikut tersimpan bersama perubahan datanya.
// action baku: record.delete, review.approve, review.change, review.cancel, commission.update,
// account.create, account.update, service.update, customer.import, customer.create,
// customer.update, auth.password_change
export function logAudit({ actor, action, targetType = '', targetId = '', detail = {}, ip = '' }) {
  const payload = typeof detail === 'string' ? detail : JSON.stringify(detail ?? {});
  const info = db.prepare(`INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    actor?.id ?? null,
    String(actor?.name ?? ''),
    String(action),
    String(targetType ?? ''),
    String(targetId ?? ''),
    payload,
    String(ip ?? '').slice(0, 100),
  );
  return Number(info.lastInsertRowid);
}