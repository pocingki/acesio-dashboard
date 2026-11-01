// Rute supervisor: layanan, komisi, akun, pembatalan approve, dan log audit.
// Setiap perubahan data di sini dicatat lewat logAudit DI DALAM transaksi yang sama,
// jadi perubahan dan jejaknya berhasil atau gagal bersama.
import { db, tx } from '../db.js';
import { hashPassword, destroyUserSessions, clientIp } from '../auth.js';
import { logAudit } from '../audit.js';
import { enrichAuditRows } from '../auditview.js';
import { HttpError, cleanName, likePattern, isYmd, saveDataUrlImage, removeUpload } from '../util.js';
import { add, LIMITS } from './index.js';

const nowIso = () => new Date().toISOString();
const ROLES = ['user', 'admin', 'supervisor'];
const EMPLOYMENT = ['tetap', 'part_time'];
const PAGE_SIZE = 50;

const idParam = (v) => {
  if (!/^\d{1,12}$/.test(String(v ?? '')) || Number(v) < 1) throw new HttpError(400, 'ID tidak valid');
  return Number(v);
};

// Detail audit tidak boleh berisi password (hanya penanda password_changed).
const audit = (req, user, action, targetType, targetId, detail) => logAudit({
  actor: { id: user.id, name: user.name },
  action,
  targetType,
  targetId: String(targetId),
  detail,
  ip: clientIp(req),
});

// ----- layanan (nama & foto) -----
add('PATCH', '/api/sv/services/:id', 'sv', ({ req, user, params, body }) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(idParam(params.id));
  if (!s) throw new HttpError(404, 'Layanan tidak ditemukan');
  const name = body.name === undefined ? s.name : cleanName(body.name);
  if (!name) throw new HttpError(400, 'Nama layanan minimal 2 huruf');
  let photo = s.photo;
  let newPhoto = null;
  if (body.photo === null) photo = null;
  else if (typeof body.photo === 'string') { photo = saveDataUrlImage(body.photo, `svc${s.id}`); newPhoto = photo; }

  const changes = {};
  if (name !== s.name) changes.name = { from: s.name, to: name };
  if (photo !== s.photo) changes.photo = { from: s.photo, to: photo };
  try {
    tx(() => {
      db.prepare('UPDATE services SET name = ?, photo = ? WHERE id = ?').run(name, photo, s.id);
      if (Object.keys(changes).length) audit(req, user, 'service.update', 'service', s.id, { position: s.position, changes });
    });
  } catch (err) {
    if (newPhoto) removeUpload(newPhoto); // transaksi gagal: jangan tinggalkan foto yatim
    throw err;
  }
  if (photo !== s.photo) removeUpload(s.photo);
  return { service: { id: s.id, position: s.position, name, photo } };
}, { limit: LIMITS.image }); // foto base64 di body JSON: batas bawaan terlalu kecil (413)

// ----- komisi per user -----
add('GET', '/api/sv/commissions', 'sv', () => ({
  users: db.prepare(`
    SELECT u.id, u.name, u.username, u.employment, u.active,
           (SELECT COUNT(*) FROM user_commissions c WHERE c.user_id = u.id AND c.amount > 0) AS filled
    FROM users u WHERE u.role = 'user' ORDER BY u.name COLLATE NOCASE`).all(),
  total_services: db.prepare('SELECT COUNT(*) AS n FROM services').get().n,
}));

add('GET', '/api/sv/commissions/:userId', 'sv', ({ params }) => {
  const u = db.prepare("SELECT id, name, username, employment FROM users WHERE id = ? AND role = 'user'").get(idParam(params.userId));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const items = db.prepare(`
    SELECT s.id AS service_id, s.position, s.name, COALESCE(c.amount, 0) AS amount
    FROM services s LEFT JOIN user_commissions c ON c.service_id = s.id AND c.user_id = ? ORDER BY s.position`).all(u.id);
  return { user: u, items };
});

add('PUT', '/api/sv/commissions/:userId', 'sv', ({ req, user, params, body }) => {
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(idParam(params.userId));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const amounts = body.amounts;
  if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) throw new HttpError(400, 'Data komisi tidak valid');
  const entries = Object.entries(amounts).map(([k, v]) => [Number(k), Number(v)]);
  if (!entries.every(([k, v]) => Number.isInteger(k) && k > 0 && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000)) {
    throw new HttpError(400, 'Komisi harus angka bulat 0 atau lebih');
  }
  const applyToHistory = body.apply_to_history === true;

  return tx(() => {
    const current = db.prepare('SELECT amount FROM user_commissions WHERE user_id = ? AND service_id = ?');
    const serviceExists = db.prepare('SELECT 1 FROM services WHERE id = ?');
    const upsert = db.prepare(`INSERT INTO user_commissions (user_id, service_id, amount) SELECT ?, id, ? FROM services WHERE id = ?
      ON CONFLICT (user_id, service_id) DO UPDATE SET amount = excluded.amount`);
    // "AND commission <> ?" supaya jumlah baris yang dilaporkan = baris yang benar-benar berubah.
    const history = db.prepare('UPDATE records SET commission = ? WHERE user_id = ? AND service_id = ? AND commission <> ?');
    const changes = {};
    let historyRows = 0;
    for (const [serviceId, amount] of entries) {
      if (!serviceExists.get(serviceId)) throw new HttpError(400, 'Ada layanan yang tidak ditemukan');
      const before = current.get(u.id, serviceId)?.amount ?? 0;
      if (before !== amount) changes[serviceId] = { from: before, to: amount };
      upsert.run(u.id, amount, serviceId);
      if (applyToHistory) historyRows += Number(history.run(amount, u.id, serviceId, amount).changes);
    }
    const changed = Object.keys(changes).length;
    if (changed || historyRows) {
      audit(req, user, 'commission.update', 'user', u.id, {
        user_id: u.id, apply_to_history: applyToHistory, history_rows_changed: historyRows, changes,
      });
    }
    return { ok: true, changed, history_rows: historyRows };
  });
});

// ----- akun -----
add('GET', '/api/sv/accounts', 'sv', () => ({
  accounts: db.prepare('SELECT id, username, name, role, employment, active, created_at FROM users ORDER BY CASE role WHEN \'supervisor\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, name COLLATE NOCASE').all(),
}));

add('POST', '/api/sv/accounts', 'sv', async ({ req, user, body }) => {
  const username = String(body.username || '').trim();
  const name = cleanName(body.name);
  const password = String(body.password || '');
  const role = body.role === undefined ? 'user' : body.role;
  const employment = body.employment === undefined ? 'tetap' : body.employment;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username 3–32 karakter: huruf, angka, titik, strip');
  if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');
  if (password.length < 8) throw new HttpError(400, 'Password minimal 8 karakter');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Jenis akun tidak valid');
  if (!EMPLOYMENT.includes(employment)) throw new HttpError(400, 'Status kerja tidak valid');
  const hash = await hashPassword(password);
  const id = tx(() => {
    // Dicek ulang di dalam transaksi karena hashPassword async (ada jeda sebelum insert).
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username sudah dipakai');
    const info = db.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(username, name, hash, role, employment, nowIso());
    const newId = Number(info.lastInsertRowid);
    audit(req, user, 'account.create', 'user', newId, { username, name, role, employment });
    return newId;
  });
  return { id };
});

add('PATCH', '/api/sv/accounts/:id', 'sv', async ({ req, params, body, user }) => {
  const id = idParam(params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Akun tidak ditemukan');
  const changePassword = body.password !== undefined && body.password !== '';
  let hash = null;
  if (changePassword) {
    if (String(body.password).length < 8) throw new HttpError(400, 'Password minimal 8 karakter');
    hash = await hashPassword(String(body.password));
  }

  const revoke = tx(() => {
    // Baca ulang di dalam transaksi: state bisa berubah selama menunggu hashPassword.
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Akun tidak ditemukan');
    const name = body.name === undefined ? u.name : cleanName(body.name);
    if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');
    const active = body.active === undefined ? u.active : body.active ? 1 : 0;
    const role = body.role === undefined ? u.role : body.role;
    const employment = body.employment === undefined ? u.employment : body.employment;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Jenis akun tidak valid');
    if (!EMPLOYMENT.includes(employment)) throw new HttpError(400, 'Status kerja tidak valid');
    if (u.id === user.id && (!active || role !== u.role)) throw new HttpError(400, 'Anda tidak bisa menonaktifkan atau mengubah jenis akun sendiri');
    if (u.role === 'supervisor' && u.active && (role !== 'supervisor' || !active)) {
      const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'supervisor' AND active = 1 AND id <> ?").get(u.id).n;
      if (others === 0) throw new HttpError(400, 'Tidak bisa menurunkan atau menonaktifkan supervisor aktif terakhir. Angkat supervisor lain dulu.');
    }

    const changes = {};
    if (name !== u.name) changes.name = { from: u.name, to: name };
    if (active !== u.active) changes.active = { from: !!u.active, to: !!active };
    if (role !== u.role) changes.role = { from: u.role, to: role };
    if (employment !== u.employment) changes.employment = { from: u.employment, to: employment };
    if (changePassword) changes.password_changed = true; // nilai password TIDAK pernah dicatat
    if (!Object.keys(changes).length) return false;

    db.prepare('UPDATE users SET name = ?, active = ?, role = ?, employment = ?, password_hash = ? WHERE id = ?')
      .run(name, active, role, employment, changePassword ? hash : u.password_hash, u.id);
    audit(req, user, 'account.update', 'user', u.id, { username: u.username, changes });
    return !active || changePassword || role !== u.role;
  });
  // Sesi dicabut setelah commit: password diganti, dinonaktifkan, atau peran berubah.
  if (revoke) destroyUserSessions(id);
  return { ok: true };
});

// ----- batalkan approve harian -----
add('DELETE', '/api/sv/reviews', 'sv', ({ req, user, query }) => {
  if (!/^\d{1,12}$/.test(String(query.user_id ?? '')) || Number(query.user_id) < 1) throw new HttpError(400, 'user_id harus angka');
  if (!isYmd(query.day)) throw new HttpError(400, 'Tanggal harus berformat YYYY-MM-DD');
  const userId = Number(query.user_id);
  const day = String(query.day);
  tx(() => {
    const row = db.prepare('SELECT late, reviewed_by, reviewed_at FROM day_reviews WHERE user_id = ? AND day = ?').get(userId, day);
    if (!row) return; // tidak ada yang dibatalkan, tidak ada yang perlu dicatat
    db.prepare('DELETE FROM day_reviews WHERE user_id = ? AND day = ?').run(userId, day);
    audit(req, user, 'review.cancel', 'day_review', `${userId}:${day}`, {
      user_id: userId, day, late: !!row.late, reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at,
    });
  });
  return { ok: true };
});

// ----- log audit -----
add('GET', '/api/sv/audit', 'sv', ({ query }) => {
  let page = 1;
  if (query.page !== undefined && query.page !== '') {
    if (!/^\d{1,6}$/.test(String(query.page)) || Number(query.page) < 1) throw new HttpError(400, 'Halaman harus angka 1 atau lebih');
    page = Number(query.page);
  }
  const where = [];
  const args = [];
  const action = String(query.action || '').trim().slice(0, 60);
  if (action) { where.push('action = ?'); args.push(action); }
  const q = String(query.q || '').trim().slice(0, 100);
  if (q) {
    // Selain pelaku, ID sasaran, dan isi rincian, cari juga lewat NAMA sasaran (akun, customer, layanan)
    // karena log menyimpan ID, sedangkan yang diketik supervisor adalah nama.
    where.push(`(actor_name LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\'
      OR (target_type = 'user' AND target_id IN (SELECT CAST(id AS TEXT) FROM users WHERE name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\'))
      OR (target_type = 'customer' AND target_id IN (SELECT CAST(id AS TEXT) FROM customers WHERE name LIKE ? ESCAPE '\\' OR rm_no LIKE ? ESCAPE '\\'))
      OR (target_type = 'service' AND target_id IN (SELECT CAST(id AS TEXT) FROM services WHERE name LIKE ? ESCAPE '\\')))`);
    const p = likePattern(q);
    args.push(p, p, p, p, p, p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(...args).n;
  const rows = db.prepare(`
    SELECT id, at, actor_id, actor_name, action, target_type, target_id, detail, ip
    FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { rows: enrichAuditRows(rows), total, page, page_size: PAGE_SIZE };
});