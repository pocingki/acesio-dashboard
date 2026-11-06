import { db } from '../db.js';
import { HttpError, formatDateTime } from '../util.js';
import { ymd } from '../clock.js';
import { periodWhere, recordSelect, sendExport, stamp, EMP_LABEL } from './helpers.js';
import { logAudit } from '../audit.js';
import { clientIp } from '../auth.js';
import { add } from './index.js';
import { readPeriod, parseId, readFormat, realYmd } from './history.js';

const nowIso = () => new Date().toISOString();
const isSv = (u) => u.role === 'supervisor';
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

// Parameter opsional user_id: kosong = tidak difilter, selain angka = 400.
const optionalUserId = (query) => (blank(query.user_id) ? null : parseId(query.user_id, 'user_id'));

function readPaging(query, defSize = 50, maxSize = 200) {
  const num = (v, label, def, max) => {
    if (blank(v)) return def;
    const s = String(v).trim();
    if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new HttpError(400, `${label} harus berupa angka bulat positif`);
    return Math.min(Number(s), max);
  };
  return { page: num(query.page, 'page', 1, 1_000_000), pageSize: num(query.page_size, 'page_size', defSize, maxSize) };
}

// Periode untuk tabel day_reviews (kolom d.day), dengan from/to yang sudah divalidasi.
function reviewPeriod(period, alias = 'd') {
  const where = [];
  const args = [];
  if (period.from) { where.push(`${alias}.day >= ?`); args.push(period.from); }
  if (period.to) { where.push(`${alias}.day <= ?`); args.push(period.to); }
  return { where, args };
}

// ---------- laporan ----------
// Approve hanya berlaku pada hari yang sama. Hari yang sudah lewat tanpa approve
// TIDAK dihitung sebagai tepat waktu/terlambat (dan bukan lagi "menunggu"): masuk ke `expired`.
function lateCounts(period) {
  const rp = reviewPeriod(period, 'day_reviews');
  const w = rp.where.length ? `WHERE ${rp.where.join(' AND ')}` : '';
  const ok = db.prepare(`SELECT COALESCE(SUM(late = 1), 0) AS late, COALESCE(SUM(late = 0), 0) AS on_time FROM day_reviews ${w}`).get(...rp.args);
  const pw = periodWhere(period);
  const today = ymd();
  const unapproved = (op) => db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT r.user_id, r.day FROM records r
      LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
      WHERE d.day IS NULL AND r.day ${op} ? ${pw.where.length ? 'AND ' + pw.where.join(' AND ') : ''})`).get(today, ...pw.args).n;
  return { late: ok.late, on_time: ok.on_time, pending: unapproved('='), expired: unapproved('<') };
}

add('GET', '/api/staff/summary', 'staff', ({ user, query }) => {
  const period = readPeriod(query);
  const { where, args } = periodWhere(period);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT r.customer_id) AS customers, COUNT(r.id) AS services, COALESCE(SUM(r.commission), 0) AS commission
    FROM records r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args);
  if (!isSv(user)) delete row.commission;
  return { summary: row, attendance: lateCounts(period) };
});

function usageRows(period) {
  const { where, args } = periodWhere(period);
  return db.prepare(`
    SELECT s.id, s.position, s.name, COUNT(r.id) AS uses
    FROM services s LEFT JOIN records r ON r.service_id = s.id ${where.length ? 'AND ' + where.join(' AND ') : ''}
    GROUP BY s.id HAVING s.active = 1 OR uses > 0 ORDER BY uses DESC, s.position`).all(...args);
}
add('GET', '/api/staff/usage', 'staff', ({ query }) => ({ usage: usageRows(readPeriod(query)) }));

// Tabel "Data user": semua akun berperan user ATAU yang punya record pada periode itu
// (mis. user yang kemudian dijadikan admin), supaya jumlah barisnya sama dengan total pada summary.
add('GET', '/api/staff/users', 'staff', ({ user, query }) => {
  const period = readPeriod(query);
  const { where, args } = periodWhere(period);
  const join = where.length ? `AND ${where.join(' AND ')}` : '';
  const lp = reviewPeriod(period);
  const rows = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.active, u.employment,
           COUNT(DISTINCT r.customer_id) AS total_customers,
           COUNT(r.id) AS total_services,
           COALESCE(SUM(r.commission), 0) AS total_commission,
           (SELECT COUNT(*) FROM day_reviews d WHERE d.user_id = u.id AND d.late = 1 ${lp.where.length ? 'AND ' + lp.where.join(' AND ') : ''}) AS late_days
    FROM users u LEFT JOIN records r ON r.user_id = u.id ${join}
    WHERE u.role = 'user' OR r.id IS NOT NULL
    GROUP BY u.id ORDER BY u.name COLLATE NOCASE`).all(...lp.args, ...args);
  if (!isSv(user)) rows.forEach((r) => delete r.total_commission);
  return { users: rows };
});

add('GET', '/api/staff/attendance', 'staff', ({ query }) => {
  const period = readPeriod(query);
  const { page, pageSize } = readPaging(query);
  const { where, args } = periodWhere(period);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM records r ${w} GROUP BY r.day, r.user_id)`).get(...args).n;
  const rows = db.prepare(`
    SELECT r.day, u.id AS user_id, u.name AS user_name, u.employment,
           COUNT(r.id) AS services, COUNT(DISTINCT r.customer_id) AS customers,
           d.late, rv.name AS reviewed_by, d.reviewed_at
    FROM records r JOIN users u ON u.id = r.user_id
    LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    LEFT JOIN users rv ON rv.id = d.reviewed_by
    ${w}
    GROUP BY r.day, r.user_id ORDER BY r.day DESC, u.name COLLATE NOCASE, r.user_id
    LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  return { rows, total, page, page_size: pageSize, today: ymd() };
});

add('GET', '/api/staff/users/:id/detail', 'staff', ({ user, params, query }) => {
  const id = parseId(params.id, 'ID user');
  if (!blank(query.day) && !realYmd(String(query.day).trim())) throw new HttpError(400, 'Tanggal tidak valid (format TTTT-BB-HH)');
  // Akun yang sudah dijadikan admin tetap bisa dibuka selama masih punya data.
  const u = db.prepare(`SELECT id, name, username, employment FROM users
    WHERE id = ? AND (role = 'user' OR EXISTS (SELECT 1 FROM records WHERE user_id = users.id))`).get(id);
  if (!u) throw new HttpError(404, 'User tidak ditemukan');
  const days = db.prepare(`
    SELECT r.day, COUNT(r.id) AS services, COUNT(DISTINCT r.customer_id) AS customers, d.late
    FROM records r LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    WHERE r.user_id = ? GROUP BY r.day ORDER BY r.day DESC LIMIT 90`).all(u.id);
  const day = blank(query.day) ? days[0]?.day || null : String(query.day).trim();
  let records = [];
  let review = null;
  if (day) {
    records = db.prepare(`${recordSelect(isSv(user))} WHERE r.user_id = ? AND r.day = ? ORDER BY r.id DESC`).all(u.id, day);
    review = db.prepare(`SELECT d.late, d.reviewed_at, rv.name AS reviewed_by FROM day_reviews d JOIN users rv ON rv.id = d.reviewed_by
      WHERE d.user_id = ? AND d.day = ?`).get(u.id, day) || null;
  }
  return { user: u, days, day, records, review, today: ymd() };
});

add('POST', '/api/staff/reviews', 'staff', ({ req, user, body }) => {
  const userId = parseId(body.user_id, 'user_id');
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) throw new HttpError(404, 'User tidak ditemukan');
  if (!realYmd(body.day)) throw new HttpError(400, 'Tanggal tidak valid');
  if (typeof body.late !== 'boolean') throw new HttpError(400, 'Pilih dulu: tepat waktu atau terlambat');
  if (!db.prepare('SELECT 1 FROM records WHERE user_id = ? AND day = ?').get(target.id, body.day)) throw new HttpError(400, 'User ini tidak punya data pada tanggal itu');
  const existing = db.prepare('SELECT late FROM day_reviews WHERE user_id = ? AND day = ?').get(target.id, body.day);
  if (existing && !isSv(user)) throw new HttpError(403, 'Sudah di-approve. Hanya supervisor yang bisa mengubahnya.');
  // Approve baru hanya pada hari yang sama. Supervisor boleh mengubah status approve yang sudah ada (termasuk hari lalu).
  if (!existing && body.day !== ymd()) throw new HttpError(409, 'Approve hanya bisa dilakukan pada hari yang sama. Data tanggal yang sudah lewat tidak bisa di-approve.');
  const late = body.late ? 1 : 0;
  // Supervisor mengirim status yang sama: tidak ada yang berubah, jadi tidak ditulis dan tidak dicatat.
  if (existing && existing.late === late) return { ok: true, unchanged: true };
  db.prepare(`INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET late = excluded.late, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`)
    .run(target.id, body.day, late, user.id, nowIso());
  logAudit({
    actor: { id: user.id, name: user.name },
    action: existing ? 'review.change' : 'review.approve',
    targetType: 'user',
    targetId: String(target.id),
    detail: existing ? { day: body.day, from_late: !!existing.late, to_late: !!late } : { day: body.day, late: !!late },
    ip: clientIp(req),
  });
  return { ok: true };
});

add('GET', '/api/staff/export', 'staff', ({ user, query, res }) => {
  const sv = isSv(user);
  const period = readPeriod(query);
  const userId = optionalUserId(query);
  const format = readFormat(query);
  const { where, args } = periodWhere(period);
  if (userId !== null) { where.push('r.user_id = ?'); args.push(userId); }
  const rows = db.prepare(`${recordSelect(sv)} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 100000`).all(...args);
  const usage = usageRows(period).filter((s) => s.uses > 0);
  const att = db.prepare(`
    SELECT r.day, u.name, u.employment, COUNT(r.id) AS services, d.late
    FROM records r JOIN users u ON u.id = r.user_id LEFT JOIN day_reviews d ON d.user_id = r.user_id AND d.day = r.day
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY r.day, r.user_id ORDER BY r.day DESC, u.name`).all(...args);
  sendExport(res, {
    format,
    filename: `laporan-acesio-${stamp()}`,
    sheets: [
      {
        name: 'Laporan',
        headers: ['Tanggal', 'User', 'No RM', 'Nama Customer', 'No WA', 'Layanan', ...(sv ? ['Komisi (Rp)'] : [])],
        rpCols: sv ? [6] : [],
        rows: rows.map((r) => [formatDateTime(r.created_at), r.user_name, r.customer_rm || '', r.customer_name, r.customer_phone, r.service_name, ...(sv ? [r.commission] : [])]),
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

// ---------- grafik donat ----------
// Dikelompokkan: 5 terbesar + "Lainnya" supaya donat tetap terbaca.
function donut(items, topN = 5) {
  const rows = items.filter((i) => i.value > 0);
  const total = rows.reduce((a, i) => a + i.value, 0);
  if (rows.length > topN + 1) {
    const rest = rows.slice(topN).reduce((a, i) => a + i.value, 0);
    return { total, items: [...rows.slice(0, topN), { label: 'Lainnya', value: rest }] };
  }
  return { total, items: rows };
}

add('GET', '/api/staff/charts', 'staff', ({ query }) => {
  const period = readPeriod(query);
  const { where, args } = periodWhere(period);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Kunjungan = satu kali input (satu customer, satu waktu), walau memilih beberapa layanan.
  const visits = db.prepare(`
    SELECT u.name AS label, COUNT(DISTINCT r.batch) AS value FROM records r JOIN users u ON u.id = r.user_id
    ${w} GROUP BY u.id ORDER BY value DESC, u.name COLLATE NOCASE`).all(...args);
  const services = usageRows(period).map((s) => ({ label: s.name, value: s.uses }));
  const origin = Object.fromEntries(db.prepare('SELECT origin, COUNT(*) AS n FROM customers GROUP BY origin').all().map((r) => [r.origin, r.n]));
  // Customer baru pada periode terpilih (hari bisnis di APP_TZ dari created_at). Dipakai angka di tengah donat.
  const newInPeriod = db.prepare("SELECT created_at FROM customers WHERE origin = 'baru'").all()
    .filter((r) => { const d = ymd(new Date(r.created_at)); return (!period.from || d >= period.from) && (!period.to || d <= period.to); }).length;
  const gender = Object.fromEntries(db.prepare('SELECT gender, COUNT(*) AS n FROM customers GROUP BY gender').all().map((r) => [r.gender, r.n]));
  return {
    charts: {
      visits: donut(visits),
      services: donut(services),
      customers: { ...donut([{ label: 'Customer baru', value: newInPeriod }, { label: 'Data awal', value: origin.awal || 0 }]), center: newInPeriod },
      gender: donut([{ label: 'Laki-laki', value: gender.L || 0 }, { label: 'Perempuan', value: gender.P || 0 }, { label: 'Belum diisi', value: gender[''] || 0 }]),
    },
  };
});