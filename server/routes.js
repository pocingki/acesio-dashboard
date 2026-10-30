import crypto from 'node:crypto';
import { db, tx } from './db.js';
import {
  hashPassword, verifyPassword, login, cookieHeader, destroySession, destroyUserSessions,
  loginBlocked, loginFailed, loginSucceeded,
} from './auth.js';
import {
  HttpError, normalizePhone, cleanName, likePattern, isYmd, formatDateTime, saveDataUrlImage, removeUpload,
} from './util.js';
import { toCsv, toXlsx } from './exporter.js';
import { ymd } from './clock.js';

const nowIso = () => new Date().toISOString();
const isSv = (u) => u.role === 'supervisor';
const ROLES = ['user', 'admin', 'supervisor'];
const EMPLOYMENT = ['tetap', 'part_time'];
const EMP_LABEL = { tetap: 'Karyawan tetap', part_time: 'Part time' };
const ints = (arr, max = 50) => {
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > max) return null;
  const out = [...new Set(arr.map(Number))];
  return out.every((n) => Number.isInteger(n) && n > 0) ? out : null;
};
const requireWorker = (user) => { if (user.role !== 'user') throw new HttpError(403, 'Hanya akun user yang menginput layanan'); };
const cleanNote = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000);

// Periode memakai kolom `day` (tanggal zona Jakarta), jadi konsisten dengan approve harian.
function periodWhere(query, alias = 'r') {
  const where = [];
  const args = [];
  if (isYmd(query.from)) { where.push(`${alias}.day >= ?`); args.push(query.from); }
  if (isYmd(query.to)) { where.push(`${alias}.day <= ?`); args.push(query.to); }
  return { where, args };
}

// Komisi hanya ikut dikirim untuk supervisor.
function recordSelect(withCommission) {
  return `SELECT r.id, r.created_at, r.day, r.note, r.batch, r.source, ${withCommission ? 'r.commission,' : ''}
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         s.id AS service_id, s.name AS service_name, u.id AS user_id, u.name AS user_name,
         (dr.day IS NOT NULL) AS locked
  FROM records r
  JOIN customers c ON c.id = r.customer_id
  JOIN services s ON s.id = r.service_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN day_reviews dr ON dr.user_id = r.user_id AND dr.day = r.day`;
}

function findOrCreateCustomer(name, phone) {
  const existing = db.prepare('SELECT id, name, phone FROM customers WHERE name = ? AND phone = ?').get(name, phone);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)').run(name, phone, nowIso());
  return { id: Number(info.lastInsertRowid), name, phone };
}

function createRecords({ userId, customer, serviceIds, source, note }) {
  return tx(() => {
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
      ins.run(userId, customer.id, id, price.get(userId, id)?.amount ?? 0, source, when, day, note, batch);
    }
    return serviceIds.length;
  });
}

function resolveCustomer(body) {
  if (body.customer_id) {
    const c = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(Number(body.customer_id));
    if (!c) throw new HttpError(400, 'Customer tidak ditemukan');
    return c;
  }
  const name = cleanName(body.customer_name);
  const phone = normalizePhone(body.customer_phone);
  if (!name) throw new HttpError(400, 'Nama customer minimal 2 huruf');
  if (!phone) throw new HttpError(400, 'Nomor WA tidak valid');
  return findOrCreateCustomer(name, phone);
}

function sendExport(res, { format, filename, sheets }) {
  if (format === 'xlsx') {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
    });
    res.end(toXlsx(sheets));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}.csv"` });
    res.end(toCsv(sheets[0].headers, sheets[0].rows));
  }
}
const stamp = () => ymd();

// ---------- daftar rute ----------
// akses: public | user (semua yang login) | staff (admin & supervisor) | sv (supervisor) | bot
export const routes = [];
const add = (method, pattern, access, handler) => {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, access, handler });
};

// ----- auth -----
add('POST', '/api/auth/login', 'public', ({ req, res, body }) => {
  const key = `${req.socket.remoteAddress}|${String(body.username || '').toLowerCase()}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
  const result = login(body.username, body.password);
  if (!result) { loginFailed(key); throw new HttpError(401, 'Username atau password salah'); }
  loginSucceeded(key);
  const secure = process.env.COOKIE_SECURE === 'true' || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', cookieHeader(result.token, secure));
  const { id, username, name, role } = result.user;
  return { user: { id, username, name, role } };
});
add('POST', '/api/auth/logout', 'user', ({ req, res, user }) => {
  destroySession(user.token);
  res.setHeader('Set-Cookie', cookieHeader('', req.headers['x-forwarded-proto'] === 'https'));
  return { ok: true };
});
add('GET', '/api/auth/me', 'user', ({ user }) => ({ user: { id: user.id, username: user.username, name: user.name, role: user.role } }));
add('POST', '/api/auth/password', 'user', ({ user, body }) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Password saat ini salah');
  const next = String(body.next || '');
  if (next.length < 8) throw new HttpError(400, 'Password baru minimal 8 karakter');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  return { ok: true };
});

// ----- layanan & customer (semua yang login; tanpa komisi) -----
add('GET', '/api/services', 'user', () => ({
  services: db.prepare('SELECT id, position, name, photo FROM services ORDER BY position').all(),
}));

// Akun user hanya melihat customer yang pernah dilayani dirinya sendiri (bukan data global).
add('GET', '/api/customers/search', 'user', ({ user, query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 2) return { customers: [] };
  const digits = q.replace(/\D/g, '');
  const withPhone = digits.length >= 3;
  const own = user.role === 'user' ? 'AND id IN (SELECT customer_id FROM records WHERE user_id = ?)' : '';
  const rows = db.prepare(`
    SELECT id, name, phone FROM customers
    WHERE (name LIKE ? ESCAPE '\\' ${withPhone ? "OR phone LIKE ? ESCAPE '\\'" : ''}) ${own}
    ORDER BY (name LIKE ? ESCAPE '\\') DESC, name LIMIT 8
  `).all(...[likePattern(q), ...(withPhone ? [likePattern(digits)] : []), ...(own ? [user.id] : []), `${q.replace(/[\\%_]/g, '\\$&')}%`]);
  return { customers: rows };
});

// ----- input & riwayat user -----
add('POST', '/api/records', 'user', ({ user, body }) => {
  requireWorker(user);
  const serviceIds = ints(body.service_ids);
  if (!serviceIds) throw new HttpError(400, 'Pilih minimal satu layanan');
  const customer = resolveCustomer(body);
  const count = createRecords({ userId: user.id, customer, serviceIds, source: 'web', note: cleanNote(body.note) });
  return { ok: true, count, customer };
});

function myRecords(userId, query, limit = 1000) {
  const { where, args } = periodWhere(query);
  where.unshift('r.user_id = ?');
  args.unshift(userId);
  const q = String(query.q || '').trim();
  if (q) {
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q.replace(/\D/g, '') || q), likePattern(q));
  }
  return db.prepare(`${recordSelect(false)} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ${limit}`).all(...args);
}

add('GET', '/api/records/mine', 'user', ({ user, query }) => {
  requireWorker(user);
  const rows = myRecords(user.id, query);
  return { records: rows, totals: { customers: new Set(rows.map((r) => r.customer_id)).size, services: rows.length } };
});

add('GET', '/api/records/mine/export', 'user', ({ user, query, res }) => {
  requireWorker(user);
  const rows = myRecords(user.id, query, 100000);
  sendExport(res, {
    format: query.format,
    filename: `riwayat-customer-${stamp()}`,
    sheets: [{
      name: 'Riwayat Customer',
      headers: ['Tanggal', 'Nama Customer', 'No WA', 'Layanan'],
      rows: rows.map((r) => [formatDateTime(r.created_at), r.customer_name, r.customer_phone, r.service_name]),
    }],
  });
  return null;
});

add('DELETE', '/api/records/:id', 'user', ({ user, params }) => {
  const r = db.prepare(`SELECT r.id, r.user_id, (dr.day IS NOT NULL) AS locked FROM records r
    LEFT JOIN day_reviews dr ON dr.user_id = r.user_id AND dr.day = r.day WHERE r.id = ?`).get(Number(params.id));
  if (!r || user.role === 'admin' || (user.role === 'user' && r.user_id !== user.id)) throw new HttpError(404, 'Data tidak ditemukan');
  if (r.locked && user.role !== 'supervisor') throw new HttpError(409, 'Data sudah di-approve dan dikunci');
  db.prepare('DELETE FROM records WHERE id = ?').run(r.id);
  return { ok: true };
});

// ----- staff: laporan -----
// Approve hanya berlaku pada hari yang sama. Hari yang sudah lewat tanpa approve
// TIDAK dihitung sebagai tepat waktu/terlambat (dan bukan lagi "menunggu"): masuk ke `expired`.
function lateCounts(query) {
  const where = [];
  const args = [];
  if (isYmd(query.from)) { where.push('day >= ?'); args.push(query.from); }
  if (isYmd(query.to)) { where.push('day <= ?'); args.push(query.to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ok = db.prepare(`SELECT COALESCE(SUM(late = 1), 0) AS late, COALESCE(SUM(late = 0), 0) AS on_time FROM day_reviews ${w}`).get(...args);
  const pw = periodWhere(query);
  const today = ymd();
  const unapproved = (op) => db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT r.user_id, r.day FROM records r
      LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
      WHERE d.day IS NULL AND r.day ${op} ? ${pw.where.length ? 'AND ' + pw.where.join(' AND ') : ''})`).get(today, ...pw.args).n;
  return { late: ok.late, on_time: ok.on_time, pending: unapproved('='), expired: unapproved('<') };
}

add('GET', '/api/staff/summary', 'staff', ({ user, query }) => {
  const { where, args } = periodWhere(query);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT r.customer_id) AS customers, COUNT(r.id) AS services, COALESCE(SUM(r.commission), 0) AS commission
    FROM records r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args);
  if (!isSv(user)) delete row.commission;
  return { summary: row, attendance: lateCounts(query) };
});

function usageRows(query) {
  const { where, args } = periodWhere(query);
  return db.prepare(`
    SELECT s.id, s.position, s.name, COUNT(r.id) AS uses
    FROM services s LEFT JOIN records r ON r.service_id = s.id ${where.length ? 'AND ' + where.join(' AND ') : ''}
    GROUP BY s.id ORDER BY uses DESC, s.position`).all(...args);
}
add('GET', '/api/staff/usage', 'staff', ({ query }) => ({ usage: usageRows(query) }));

add('GET', '/api/staff/users', 'staff', ({ user, query }) => {
  const { where, args } = periodWhere(query);
  const join = where.length ? `AND ${where.join(' AND ')}` : '';
  const lw = [];
  const la = [];
  if (isYmd(query.from)) { lw.push('d.day >= ?'); la.push(query.from); }
  if (isYmd(query.to)) { lw.push('d.day <= ?'); la.push(query.to); }
  const rows = db.prepare(`
    SELECT u.id, u.username, u.name, u.active, u.employment,
           COUNT(DISTINCT r.customer_id) AS total_customers,
           COUNT(r.id) AS total_services,
           COALESCE(SUM(r.commission), 0) AS total_commission,
           (SELECT COUNT(*) FROM day_reviews d WHERE d.user_id = u.id AND d.late = 1 ${lw.length ? 'AND ' + lw.join(' AND ') : ''}) AS late_days
    FROM users u LEFT JOIN records r ON r.user_id = u.id ${join}
    WHERE u.role = 'user' GROUP BY u.id ORDER BY u.name COLLATE NOCASE`).all(...la, ...args);
  if (!isSv(user)) rows.forEach((r) => delete r.total_commission);
  return { users: rows };
});

add('GET', '/api/staff/attendance', 'staff', ({ query }) => {
  const { where, args } = periodWhere(query);
  const rows = db.prepare(`
    SELECT r.day, u.id AS user_id, u.name AS user_name, u.employment,
           COUNT(r.id) AS services, COUNT(DISTINCT r.customer_id) AS customers,
           d.late, rv.name AS reviewed_by, d.reviewed_at
    FROM records r JOIN users u ON u.id = r.user_id
    LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    LEFT JOIN users rv ON rv.id = d.reviewed_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY r.day, r.user_id ORDER BY r.day DESC, u.name COLLATE NOCASE LIMIT 500`).all(...args);
  return { rows, today: ymd() };
});

add('GET', '/api/staff/users/:id/detail', 'staff', ({ user, params, query }) => {
  const u = db.prepare("SELECT id, name, username, employment FROM users WHERE id = ? AND role = 'user'").get(Number(params.id));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const days = db.prepare(`
    SELECT r.day, COUNT(r.id) AS services, COUNT(DISTINCT r.customer_id) AS customers, d.late
    FROM records r LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    WHERE r.user_id = ? GROUP BY r.day ORDER BY r.day DESC LIMIT 90`).all(u.id);
  const day = isYmd(query.day) ? query.day : days[0]?.day || null;
  let records = [];
  let review = null;
  if (day) {
    records = db.prepare(`${recordSelect(isSv(user))} WHERE r.user_id = ? AND r.day = ? ORDER BY r.id DESC`).all(u.id, day);
    review = db.prepare(`SELECT d.late, d.reviewed_at, rv.name AS reviewed_by FROM day_reviews d JOIN users rv ON rv.id = d.reviewed_by
      WHERE d.user_id = ? AND d.day = ?`).get(u.id, day) || null;
  }
  return { user: u, days, day, records, review, today: ymd() };
});

add('POST', '/api/staff/reviews', 'staff', ({ user, body }) => {
  const target = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(Number(body.user_id));
  if (!target) throw new HttpError(404, 'User tidak ditemukan');
  if (!isYmd(body.day)) throw new HttpError(400, 'Tanggal tidak valid');
  if (typeof body.late !== 'boolean') throw new HttpError(400, 'Pilih dulu: tepat waktu atau terlambat');
  if (!db.prepare('SELECT 1 FROM records WHERE user_id = ? AND day = ?').get(target.id, body.day)) throw new HttpError(400, 'User ini tidak punya data pada tanggal itu');
  const existing = db.prepare('SELECT 1 FROM day_reviews WHERE user_id = ? AND day = ?').get(target.id, body.day);
  if (existing && !isSv(user)) throw new HttpError(403, 'Sudah di-approve. Hanya supervisor yang bisa mengubahnya.');
  // Approve baru hanya pada hari yang sama. Supervisor boleh mengubah status approve yang sudah ada (termasuk hari lalu).
  if (!existing && body.day !== ymd()) throw new HttpError(409, 'Approve hanya bisa dilakukan pada hari yang sama. Data tanggal yang sudah lewat tidak bisa di-approve.');
  db.prepare(`INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET late = excluded.late, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`)
    .run(target.id, body.day, body.late ? 1 : 0, user.id, nowIso());
  return { ok: true };
});

add('DELETE', '/api/sv/reviews', 'sv', ({ query }) => {
  db.prepare('DELETE FROM day_reviews WHERE user_id = ? AND day = ?').run(Number(query.user_id), String(query.day));
  return { ok: true };
});

add('GET', '/api/staff/export', 'staff', ({ user, query, res }) => {
  const sv = isSv(user);
  const { where, args } = periodWhere(query);
  if (query.user_id) { where.push('r.user_id = ?'); args.push(Number(query.user_id)); }
  const rows = db.prepare(`${recordSelect(sv)} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 100000`).all(...args);
  const usage = usageRows(query).filter((s) => s.uses > 0);
  const att = db.prepare(`
    SELECT r.day, u.name, u.employment, COUNT(r.id) AS services, d.late
    FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY r.day, r.user_id ORDER BY r.day DESC, u.name`).all(...args);
  sendExport(res, {
    format: query.format,
    filename: `laporan-acesio-${stamp()}`,
    sheets: [
      {
        name: 'Laporan',
        headers: ['Tanggal', 'User', 'Nama Customer', 'No WA', 'Layanan', ...(sv ? ['Komisi (Rp)'] : [])],
        rpCols: sv ? [5] : [],
        rows: rows.map((r) => [formatDateTime(r.created_at), r.user_name, r.customer_name, r.customer_phone, r.service_name, ...(sv ? [r.commission] : [])]),
      },
      {
        name: 'Layanan Terpopuler',
        headers: ['Nama Layanan', 'Jumlah Pemakaian'],
        intCols: [1],
        rows: usage.map((s) => [s.name, s.uses]),
        chart: { title: 'Layanan yang paling sering dipakai' },
      },
      {
        name: 'Keterlambatan',
        headers: ['Tanggal', 'User', 'Status Kerja', 'Jumlah Pelayanan', 'Status'],
        intCols: [3],
        rows: att.map((a) => [a.day, a.name, EMP_LABEL[a.employment], a.services, a.late === null ? (a.day === ymd() ? 'Menunggu approve' : 'Tidak di-approve') : a.late ? 'Terlambat' : 'Tepat waktu']),
      },
    ],
  });
  return null;
});

// ----- staff: customer global -----
add('GET', '/api/staff/customers', 'staff', ({ query }) => {
  const q = String(query.q || '').trim();
  const where = [];
  const args = [];
  if (q) {
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q.replace(/\D/g, '') || q));
  }
  const customers = db.prepare(`
    SELECT c.id, c.name, c.phone, COUNT(r.id) AS total_services, COUNT(DISTINCT r.batch) AS visits, MAX(r.created_at) AS last_visit
    FROM customers c JOIN records r ON r.customer_id = c.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY c.id ORDER BY last_visit DESC LIMIT 300`).all(...args);
  if (customers.length) {
    const ids = customers.map((c) => c.id);
    const svc = db.prepare(`
      SELECT r.customer_id, s.name, COUNT(*) AS n FROM records r JOIN services s ON s.id = r.service_id
      WHERE r.customer_id IN (${ids.map(() => '?').join(',')}) GROUP BY r.customer_id, r.service_id ORDER BY n DESC, s.position`).all(...ids);
    const map = new Map();
    for (const row of svc) { if (!map.has(row.customer_id)) map.set(row.customer_id, []); map.get(row.customer_id).push({ name: row.name, n: row.n }); }
    for (const c of customers) c.services = map.get(c.id) || [];
    // Catatan medis lengkap dari semua input. Satu catatan yang dipakai untuk beberapa layanan (satu input)
    // tersimpan di tiap baris layanan, jadi digabung per (customer, tanggal, user, isi) agar tidak dobel.
    const notes = db.prepare(`
      SELECT r.customer_id, r.day, MIN(r.created_at) AS created_at, u.name AS therapist, r.note,
             GROUP_CONCAT(DISTINCT s.name) AS services
      FROM records r JOIN users u ON u.id = r.user_id JOIN services s ON s.id = r.service_id
      WHERE r.customer_id IN (${ids.map(() => '?').join(',')}) AND TRIM(r.note) <> ''
      GROUP BY r.customer_id, r.day, r.user_id, r.note
      ORDER BY created_at DESC`).all(...ids);
    const nmap = new Map();
    for (const n of notes) {
      if (!nmap.has(n.customer_id)) nmap.set(n.customer_id, []);
      nmap.get(n.customer_id).push({ day: n.day, created_at: n.created_at, therapist: n.therapist, note: n.note, services: n.services.split(',') });
    }
    for (const c of customers) c.notes = nmap.get(c.id) || [];
  }
  return { customers };
});

add('GET', '/api/staff/customers/:id/visits', 'staff', ({ params }) => {
  const c = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(Number(params.id));
  if (!c) throw new HttpError(404, 'Customer tidak ditemukan');
  const rows = db.prepare(`
    SELECT r.batch, r.created_at, r.day, r.note, s.name AS service, u.name AS therapist
    FROM records r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
    WHERE r.customer_id = ? ORDER BY r.created_at DESC, s.position`).all(c.id);
  const visits = [];
  const idx = new Map();
  for (const r of rows) {
    if (!idx.has(r.batch)) { idx.set(r.batch, visits.length); visits.push({ created_at: r.created_at, day: r.day, therapist: r.therapist, note: r.note, services: [] }); }
    visits[idx.get(r.batch)].services.push(r.service);
  }
  return { customer: c, visits };
});

// ----- supervisor: layanan (nama & foto) -----
add('PATCH', '/api/sv/services/:id', 'sv', ({ params, body }) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id));
  if (!s) throw new HttpError(404, 'Layanan tidak ditemukan');
  const name = body.name === undefined ? s.name : cleanName(body.name);
  if (!name) throw new HttpError(400, 'Nama layanan minimal 2 huruf');
  let photo = s.photo;
  if (body.photo === null) photo = null;
  else if (typeof body.photo === 'string') photo = saveDataUrlImage(body.photo, `svc${s.id}`);
  db.prepare('UPDATE services SET name = ?, photo = ? WHERE id = ?').run(name, photo, s.id);
  if (photo !== s.photo) removeUpload(s.photo);
  return { service: { id: s.id, position: s.position, name, photo } };
});

// ----- supervisor: komisi per user -----
add('GET', '/api/sv/commissions', 'sv', () => ({
  users: db.prepare(`
    SELECT u.id, u.name, u.username, u.employment, u.active,
           (SELECT COUNT(*) FROM user_commissions c WHERE c.user_id = u.id AND c.amount > 0) AS filled
    FROM users u WHERE u.role = 'user' ORDER BY u.name COLLATE NOCASE`).all(),
  total_services: db.prepare('SELECT COUNT(*) AS n FROM services').get().n,
}));

add('GET', '/api/sv/commissions/:userId', 'sv', ({ params }) => {
  const u = db.prepare("SELECT id, name, username, employment FROM users WHERE id = ? AND role = 'user'").get(Number(params.userId));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const items = db.prepare(`
    SELECT s.id AS service_id, s.position, s.name, COALESCE(c.amount, 0) AS amount
    FROM services s LEFT JOIN user_commissions c ON c.service_id = s.id AND c.user_id = ? ORDER BY s.position`).all(u.id);
  return { user: u, items };
});

add('PUT', '/api/sv/commissions/:userId', 'sv', ({ params, body }) => {
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(Number(params.userId));
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const amounts = body.amounts;
  if (!amounts || typeof amounts !== 'object') throw new HttpError(400, 'Data komisi tidak valid');
  const entries = Object.entries(amounts).map(([k, v]) => [Number(k), Number(v)]);
  if (!entries.every(([k, v]) => Number.isInteger(k) && k > 0 && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000)) {
    throw new HttpError(400, 'Komisi harus angka bulat 0 atau lebih');
  }
  tx(() => {
    const up = db.prepare(`INSERT INTO user_commissions (user_id, service_id, amount) SELECT ?, id, ? FROM services WHERE id = ?
      ON CONFLICT (user_id, service_id) DO UPDATE SET amount = excluded.amount`);
    const hist = db.prepare('UPDATE records SET commission = ? WHERE user_id = ? AND service_id = ?');
    for (const [sid, amount] of entries) {
      up.run(u.id, amount, sid);
      if (body.apply_to_history === true) hist.run(amount, u.id, sid);
    }
  });
  return { ok: true };
});

// ----- supervisor: akun -----
add('GET', '/api/sv/accounts', 'sv', () => ({
  accounts: db.prepare('SELECT id, username, name, role, employment, active, created_at FROM users ORDER BY CASE role WHEN \'supervisor\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, name COLLATE NOCASE').all(),
}));

add('POST', '/api/sv/accounts', 'sv', ({ body }) => {
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
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username sudah dipakai');
  const info = db.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(username, name, hashPassword(password), role, employment, nowIso());
  return { id: Number(info.lastInsertRowid) };
});

add('PATCH', '/api/sv/accounts/:id', 'sv', ({ params, body, user }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!u) throw new HttpError(404, 'Akun tidak ditemukan');
  const name = body.name === undefined ? u.name : cleanName(body.name);
  if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');
  const active = body.active === undefined ? u.active : body.active ? 1 : 0;
  const role = body.role === undefined ? u.role : body.role;
  const employment = body.employment === undefined ? u.employment : body.employment;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Jenis akun tidak valid');
  if (!EMPLOYMENT.includes(employment)) throw new HttpError(400, 'Status kerja tidak valid');
  if (u.id === user.id && (!active || role !== u.role)) throw new HttpError(400, 'Anda tidak bisa menonaktifkan atau mengubah jenis akun sendiri');
  let hash = u.password_hash;
  if (body.password !== undefined && body.password !== '') {
    if (String(body.password).length < 8) throw new HttpError(400, 'Password minimal 8 karakter');
    hash = hashPassword(String(body.password));
  }
  db.prepare('UPDATE users SET name = ?, active = ?, role = ?, employment = ?, password_hash = ? WHERE id = ?').run(name, active, role, employment, hash, u.id);
  if (!active || hash !== u.password_hash || role !== u.role) destroyUserSessions(u.id);
  return { ok: true };
});

// ----- integrasi WA bot (header: X-API-Key) -----
const botCustomer = (c) => {
  const stats = db.prepare('SELECT COUNT(DISTINCT batch) AS visits, MAX(created_at) AS last_visit FROM records WHERE customer_id = ?').get(c.id);
  return { id: c.id, name: c.name, phone: c.phone, visits: stats.visits, last_visit: stats.last_visit };
};
add('GET', '/api/bot/services', 'bot', () => ({ services: db.prepare('SELECT id, position, name FROM services ORDER BY position').all() }));
add('GET', '/api/bot/customers', 'bot', ({ query }) => {
  const q = String(query.q || '').trim();
  const phone = normalizePhone(query.phone);
  let rows;
  if (phone) rows = db.prepare('SELECT id, name, phone FROM customers WHERE phone = ? ORDER BY name LIMIT 20').all(phone);
  else if (q.length >= 2) rows = db.prepare("SELECT id, name, phone FROM customers WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20").all(likePattern(q));
  else throw new HttpError(400, 'Isi ?phone=... atau ?q=... (minimal 2 huruf)');
  return { customers: rows.map(botCustomer) };
});
add('GET', '/api/bot/customers/:id/history', 'bot', ({ params }) => {
  const c = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(Number(params.id));
  if (!c) throw new HttpError(404, 'Customer tidak ditemukan');
  const history = db.prepare(`
    SELECT r.id, r.created_at, s.name AS service, u.name AS served_by
    FROM records r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
    WHERE r.customer_id = ? ORDER BY r.id DESC LIMIT 100`).all(c.id);
  return { customer: botCustomer(c), history };
});
add('POST', '/api/bot/records', 'bot', ({ body }) => {
  const u = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'user' AND active = 1").get(String(body.username || ''));
  if (!u) throw new HttpError(400, 'username petugas tidak ditemukan');
  const serviceIds = ints(body.service_ids);
  if (!serviceIds) throw new HttpError(400, 'service_ids wajib berisi daftar id layanan');
  const customer = resolveCustomer(body);
  const count = createRecords({ userId: u.id, customer, serviceIds, source: 'bot', note: cleanNote(body.note) });
  return { ok: true, count, customer };
});

export function botKeyValid(req) {
  const expected = process.env.BOT_API_KEY;
  if (!expected) throw new HttpError(503, 'Integrasi bot belum aktif (BOT_API_KEY belum diisi)');
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}