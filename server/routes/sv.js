// Rute supervisor: layanan, komisi, akun, pembatalan approve, dan log audit.
// Setiap perubahan data di sini dicatat lewat logAudit DI DALAM transaksi yang sama,
// jadi perubahan dan jejaknya berhasil atau gagal bersama.
import { db, tx, activeServiceCount, SERVICE_MAX } from '../db.js';
import { hashPassword, destroyUserSessions, clientIp, assertPassword } from '../auth.js';
import { logAudit } from '../audit.js';
import { enrichAuditRows } from '../auditview.js';
import { HttpError, cleanName, likePattern, isYmd, saveDataUrlImage, removeUpload } from '../util.js';
import { add, LIMITS } from './index.js';
import { sendExport } from './helpers.js';
import { commissionTemplate, parseCommissionImport, trimIssues } from '../commissions.js';

const nowIso = () => new Date().toISOString();
const ROLES = ['user', 'admin', 'supervisor'];
const EMPLOYMENT = ['tetap', 'part_time'];
const PAGE_SIZE = 50;
const JOB_TITLE_MAX = 60;

// Jabatan dan tanggal bergabung: hanya diisi supervisor. undefined = tidak diubah; '' = dikosongkan.
function jobFields(body, cur = { job_title: '', join_date: '' }) {
  let jobTitle = cur.job_title;
  if (body.job_title !== undefined) {
    jobTitle = String(body.job_title ?? '').replace(/\s+/g, ' ').trim();
    if (jobTitle.length > JOB_TITLE_MAX) throw new HttpError(400, `Jabatan maksimal ${JOB_TITLE_MAX} karakter`);
  }
  let joinDate = cur.join_date;
  if (body.join_date !== undefined) {
    joinDate = String(body.join_date ?? '').trim();
    if (joinDate !== '') {
      const t = Date.parse(`${joinDate}T00:00:00Z`);
      if (!isYmd(joinDate) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== joinDate || joinDate < '1950-01-01' || joinDate > '2100-12-31') {
        throw new HttpError(400, 'Tanggal bergabung tidak valid (format YYYY-MM-DD)');
      }
    }
  }
  return { job_title: jobTitle, join_date: joinDate };
}

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
  const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(idParam(params.id));
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

// ----- tambah dan hapus layanan -----
add('POST', '/api/sv/services', 'sv', ({ req, user, body }) => {
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'Nama layanan minimal 2 huruf');
  let photo = null;
  if (typeof body.photo === 'string') photo = saveDataUrlImage(body.photo, 'svcnew');
  try {
    return tx(() => {
      if (activeServiceCount() >= SERVICE_MAX) throw new HttpError(400, `Jumlah layanan maksimal ${SERVICE_MAX}`);
      const position = (db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM services WHERE active = 1').get().p) + 1;
      const id = Number(db.prepare('INSERT INTO services (position, name, photo, active) VALUES (?, ?, ?, 1)').run(position, name, photo).lastInsertRowid);
      audit(req, user, 'service.create', 'service', id, { position, name });
      return { service: { id, position, name, photo } };
    });
  } catch (err) {
    if (photo) removeUpload(photo);
    throw err;
  }
}, { limit: LIMITS.image }); // foto base64 di body JSON

// Hapus layanan. Layanan yang belum pernah dipakai dihapus bersih; yang sudah punya riwayat dinonaktifkan
// (riwayat dan laporan lama tetap utuh, komisi per user untuk layanan itu dibersihkan).
// Ditolak bila masih dipakai jadwal yang belum selesai, atau bila tinggal satu layanan aktif.
add('DELETE', '/api/sv/services/:id', 'sv', ({ req, user, params }) => {
  const id = idParam(params.id);
  let oldPhoto = null;
  const result = tx(() => {
    const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(id);
    if (!s) throw new HttpError(404, 'Layanan tidak ditemukan');
    if (activeServiceCount() <= 1) throw new HttpError(400, 'Minimal harus ada satu layanan');
    const open = db.prepare(`SELECT COUNT(*) AS n FROM schedule_services ss JOIN schedules sc ON sc.id = ss.schedule_id
      WHERE ss.service_id = ? AND sc.status IN ('baru','berjalan')`).get(s.id).n;
    if (open > 0) throw new HttpError(409, `Layanan ini masih dipakai di ${open} jadwal yang belum selesai. Ubah atau batalkan jadwal itu dulu.`, 'SERVICE_IN_USE');
    const used = db.prepare('SELECT COUNT(*) AS n FROM records WHERE service_id = ?').get(s.id).n
      + db.prepare('SELECT COUNT(*) AS n FROM schedule_services WHERE service_id = ?').get(s.id).n;
    let mode;
    if (used === 0) {
      db.prepare('DELETE FROM services WHERE id = ?').run(s.id); // komisi per user ikut (CASCADE)
      mode = 'deleted';
      oldPhoto = s.photo;
    } else {
      db.prepare('DELETE FROM user_commissions WHERE service_id = ?').run(s.id);
      db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(s.id);
      mode = 'archived';
    }
    // Penomoran ulang: layanan aktif tetap berurutan, yang nonaktif/terhapus keluar dari urutan.
    const keep = db.prepare('SELECT id FROM services WHERE active = 1 ORDER BY position, id').all().map((r) => r.id);
    db.prepare('UPDATE services SET position = -id').run();
    const upd = db.prepare('UPDATE services SET position = ? WHERE id = ?');
    keep.forEach((sid, i) => upd.run(i + 1, sid));
    audit(req, user, 'service.delete', 'service', s.id, { position: s.position, name: s.name, mode });
    return { ok: true, mode, remaining: keep.length };
  });
  if (oldPhoto) removeUpload(oldPhoto);
  return result;
});

// ----- komisi per user -----
add('GET', '/api/sv/commissions', 'sv', () => ({
  users: db.prepare(`
    SELECT u.id, u.name, u.username, u.employment, u.active,
           (SELECT COUNT(*) FROM user_commissions c WHERE c.user_id = u.id AND c.amount > 0) AS filled
    FROM users u WHERE u.role = 'user' ORDER BY u.name COLLATE NOCASE`).all(),
  total_services: activeServiceCount(),
}));

add('GET', '/api/sv/commissions/:userId', 'sv', ({ params }) => {
  const u = db.prepare("SELECT id, name, username, employment FROM users WHERE id = ? AND role = 'user'").get(idParam(params.userId));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const items = db.prepare(`
    SELECT s.id AS service_id, s.position, s.name, COALESCE(c.amount, 0) AS amount
    FROM services s LEFT JOIN user_commissions c ON c.service_id = s.id AND c.user_id = ? WHERE s.active = 1 ORDER BY s.position`).all(u.id);
  return { user: u, items };
});

// Simpan komisi satu user (dipakai Atur komisi dan Impor komisi). Harus dipanggil di dalam tx().
// entries: [[serviceId, amount], ...]. Satu catatan audit per user, ditulis di transaksi yang sama.
function saveCommissions(req, user, userId, entries, applyToHistory) {
  const current = db.prepare('SELECT amount FROM user_commissions WHERE user_id = ? AND service_id = ?');
  const serviceExists = db.prepare('SELECT 1 FROM services WHERE id = ? AND active = 1');
  const upsert = db.prepare(`INSERT INTO user_commissions (user_id, service_id, amount) SELECT ?, id, ? FROM services WHERE id = ?
    ON CONFLICT (user_id, service_id) DO UPDATE SET amount = excluded.amount`);
  // "AND commission <> ?" supaya jumlah baris yang dilaporkan = baris yang benar-benar berubah.
  const history = db.prepare('UPDATE records SET commission = ? WHERE user_id = ? AND service_id = ? AND commission <> ?');
  const changes = {};
  let historyRows = 0;
  for (const [serviceId, amount] of entries) {
    if (!serviceExists.get(serviceId)) throw new HttpError(400, 'Ada layanan yang tidak ditemukan');
    const before = current.get(userId, serviceId)?.amount ?? 0;
    if (before !== amount) changes[serviceId] = { from: before, to: amount };
    upsert.run(userId, amount, serviceId);
    if (applyToHistory) historyRows += Number(history.run(amount, userId, serviceId, amount).changes);
  }
  const changed = Object.keys(changes).length;
  if (changed || historyRows) {
    audit(req, user, 'commission.update', 'user', userId, {
      user_id: userId, apply_to_history: applyToHistory, history_rows_changed: historyRows, changes,
    });
  }
  return { changed, historyRows };
}

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
    const { changed, historyRows } = saveCommissions(req, user, u.id, entries, applyToHistory);
    return { ok: true, changed, history_rows: historyRows };
  });
});

// ----- impor komisi per terapis (CSV/Excel), pola yang sama dengan impor data customer -----
// Template berisi komisi yang berlaku sekarang (satu baris per layanan, satu kolom per terapis aktif).
add('GET', '/api/sv/commission-template', 'sv', ({ query, res }) => {
  const format = query.format === 'xlsx' ? 'xlsx' : 'csv';
  const t = commissionTemplate();
  sendExport(res, {
    format,
    filename: 'template-komisi-terapis',
    sheets: [{ name: 'Komisi', headers: t.headers, rows: t.rows, intCols: t.intCols, widths: t.widths }],
  });
  return null;
});

// Semua atau tidak sama sekali: file dibaca penuh dulu, lalu semua terapis disimpan dalam satu transaksi.
// Sel kosong tidak mengubah apa pun; baris/sel bermasalah dilewati dan dilaporkan.
add('POST', '/api/sv/commissions/import', 'sv', ({ req, user, body }) => {
  const parsed = parseCommissionImport(String(body.format || ''), body.content);
  const applyToHistory = body.apply_to_history === true;
  const result = tx(() => {
    let changed = 0;
    let unchanged = 0;
    let historyRows = 0;
    let users = 0;
    for (const { user: w, amounts } of parsed.perUser.values()) {
      if (!amounts.size) continue;
      const r = saveCommissions(req, user, w.id, [...amounts.entries()], applyToHistory);
      users++;
      changed += r.changed;
      unchanged += amounts.size - r.changed;
      historyRows += r.historyRows;
    }
    audit(req, user, 'commission.import', 'user', '', {
      users, changed, unchanged, skipped: parsed.issues.filter((i) => i.skipped).length,
      apply_to_history: applyToHistory, history_rows_changed: historyRows,
    });
    return { users, changed, unchanged, history_rows: historyRows };
  });
  const skipped = parsed.issues.filter((i) => i.skipped).length;
  return { result: { ...result, skipped, issues: trimIssues(parsed.issues) } };
}, { limit: LIMITS.import });

// ----- akun -----
// ----- akun -----
add('GET', '/api/sv/accounts', 'sv', () => ({
  accounts: db.prepare(`SELECT u.id, u.username, u.name, u.role, u.employment, u.active, u.created_at, u.job_title, u.join_date,
      (SELECT COUNT(*) FROM records r WHERE r.user_id = u.id) AS records_count,
      (SELECT COUNT(*) FROM schedules s WHERE s.user_id = u.id) AS schedules_count
    FROM users u ORDER BY CASE u.role WHEN 'supervisor' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name COLLATE NOCASE`).all(),
}));

add('POST', '/api/sv/accounts', 'sv', async ({ req, user, body }) => {
  const username = String(body.username || '').trim();
  const name = cleanName(body.name);
  const password = String(body.password || '');
  const role = body.role === undefined ? 'user' : body.role;
  const employment = body.employment === undefined ? 'tetap' : body.employment;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username 3–32 karakter: huruf, angka, titik, strip');
  if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');
  assertPassword(password);
  if (!ROLES.includes(role)) throw new HttpError(400, 'Jenis akun tidak valid');
  if (!EMPLOYMENT.includes(employment)) throw new HttpError(400, 'Status kerja tidak valid');
  const { job_title: jobTitle, join_date: joinDate } = jobFields(body);
  const hash = await hashPassword(password);
  const id = tx(() => {
    // Dicek ulang di dalam transaksi karena hashPassword async (ada jeda sebelum insert).
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username sudah dipakai');
    const info = db.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at, job_title, join_date) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(username, name, hash, role, employment, nowIso(), jobTitle, joinDate);
    const newId = Number(info.lastInsertRowid);
    audit(req, user, 'account.create', 'user', newId, { username, name, role, employment, job_title: jobTitle, join_date: joinDate });
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
    assertPassword(body.password);
    hash = await hashPassword(String(body.password));
  }

  const revoke = tx(() => {
    // Baca ulang di dalam transaksi: state bisa berubah selama menunggu hashPassword.
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Akun tidak ditemukan');
    const name = body.name === undefined ? u.name : cleanName(body.name);
    if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');
    let username = u.username;
    if (body.username !== undefined) {
      username = String(body.username).trim();
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username 3–32 karakter: huruf, angka, titik, strip');
      if (username.toLowerCase() !== u.username.toLowerCase()
        && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, u.id)) {
        throw new HttpError(409, 'Username sudah dipakai');
      }
    }
    const active = body.active === undefined ? u.active : body.active ? 1 : 0;
    const role = body.role === undefined ? u.role : body.role;
    const employment = body.employment === undefined ? u.employment : body.employment;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Jenis akun tidak valid');
    if (!EMPLOYMENT.includes(employment)) throw new HttpError(400, 'Status kerja tidak valid');
    const job = jobFields(body, u);
    if (u.id === user.id && (!active || role !== u.role)) throw new HttpError(400, 'Anda tidak bisa menonaktifkan atau mengubah jenis akun sendiri');
    if (u.role === 'supervisor' && u.active && (role !== 'supervisor' || !active)) {
      const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'supervisor' AND active = 1 AND id <> ?").get(u.id).n;
      if (others === 0) throw new HttpError(400, 'Tidak bisa menurunkan atau menonaktifkan supervisor aktif terakhir. Angkat supervisor lain dulu.');
    }

    const changes = {};
    if (name !== u.name) changes.name = { from: u.name, to: name };
    if (username !== u.username) changes.username = { from: u.username, to: username };
    if (active !== u.active) changes.active = { from: !!u.active, to: !!active };
    if (role !== u.role) changes.role = { from: u.role, to: role };
    if (employment !== u.employment) changes.employment = { from: u.employment, to: employment };
    if (job.job_title !== u.job_title) changes.job_title = { from: u.job_title, to: job.job_title };
    if (job.join_date !== u.join_date) changes.join_date = { from: u.join_date, to: job.join_date };
    if (changePassword) changes.password_changed = true; // nilai password TIDAK pernah dicatat
    if (!Object.keys(changes).length) return false;

    db.prepare('UPDATE users SET username = ?, name = ?, active = ?, role = ?, employment = ?, job_title = ?, join_date = ?, password_hash = ? WHERE id = ?')
      .run(username, name, active, role, employment, job.job_title, job.join_date, changePassword ? hash : u.password_hash, u.id);
    audit(req, user, 'account.update', 'user', u.id, { username, changes });
    return !active || changePassword || role !== u.role;
  });
  // Sesi dicabut setelah commit: password diganti, dinonaktifkan, atau peran berubah.
  if (revoke) destroyUserSessions(id);
  return { ok: true };
});

// ----- hapus akun (admin dan user; supervisor tidak bisa dihapus lewat jalur ini) -----
// Data kerja milik akun yang dihapus (layanan/komisi, jadwal beserta SOAP, approve harian) ikut dihapus.
// Jejak buatan akun itu pada data orang lain (pembuat jadwal, yang meng-approve) dialihkan ke supervisor
// yang menghapus, supaya riwayat user lain tetap utuh. Semua dalam satu transaksi bersama catatan audit.
add('DELETE', '/api/sv/accounts/:id', 'sv', ({ req, user, params }) => {
  const id = idParam(params.id);
  let photo = null;
  const result = tx(() => {
    const u = db.prepare('SELECT id, username, name, role, employment, photo FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Akun tidak ditemukan');
    if (u.id === user.id) throw new HttpError(400, 'Anda tidak bisa menghapus akun sendiri');
    if (u.role === 'supervisor') throw new HttpError(400, 'Akun supervisor tidak bisa dihapus. Ubah dulu jenis akunnya jika memang perlu dihapus.');

    const records = Number(db.prepare('DELETE FROM records WHERE user_id = ?').run(u.id).changes);
    const schedules = Number(db.prepare('DELETE FROM schedules WHERE user_id = ?').run(u.id).changes); // layanan jadwal & notifikasi ikut (CASCADE)
    db.prepare('UPDATE schedules SET created_by = ? WHERE created_by = ?').run(user.id, u.id);
    db.prepare('UPDATE schedules SET approved_by = ? WHERE approved_by = ?').run(user.id, u.id);
    db.prepare('UPDATE day_reviews SET reviewed_by = ? WHERE reviewed_by = ?').run(user.id, u.id);
    db.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // sesi, komisi, approve harian, notifikasi ikut (CASCADE)
    audit(req, user, 'account.delete', 'user', u.id, {
      username: u.username, name: u.name, role: u.role, employment: u.employment,
      records_deleted: records, schedules_deleted: schedules,
    });
    photo = u.photo;
    return { ok: true, records_deleted: records, schedules_deleted: schedules };
  });
  removeUpload(photo);
  return result;
});

// ----- hapus tugas (jadwal) yang sudah dijalani user -----
// Hanya jadwal berstatus Sedang dijalani atau Selesai. Layanan/komisi yang tercatat dari jadwal itu
// (records dengan batch yang sama) ikut dihapus supaya komisi tidak tertinggal. Isi SOAP tidak masuk audit.
add('DELETE', '/api/sv/schedules/:id', 'sv', ({ req, user, params }) => {
  const id = idParam(params.id);
  return tx(() => {
    const s = db.prepare('SELECT id, user_id, customer_id, day, status, batch FROM schedules WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Jadwal tidak ditemukan');
    if (s.status !== 'berjalan' && s.status !== 'selesai') {
      throw new HttpError(409, 'Hanya tugas yang sudah dijalani user (Sedang dijalani atau Selesai) yang bisa dihapus', 'SCHEDULE_STATE');
    }
    const records = s.batch
      ? Number(db.prepare('DELETE FROM records WHERE batch = ? AND user_id = ?').run(s.batch, s.user_id).changes)
      : 0;
    db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id); // layanan jadwal & notifikasi ikut (CASCADE)
    audit(req, user, 'schedule.delete', 'schedule', s.id, {
      user_id: s.user_id, customer_id: s.customer_id, day: s.day, from: s.status, records_deleted: records,
    });
    return { ok: true, records_deleted: records };
  });
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