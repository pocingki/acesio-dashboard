import { db } from '../db.js';
import { HttpError, likePattern, isYmd, formatDateTime } from '../util.js';
import { periodWhere, recordSelect, sendExport, stamp } from './helpers.js';
import { createLimiter } from '../ratelimit.js';
import { add } from './index.js';

const MAX_Q = 100;
const MINE_LIMIT = 1000;
const EXPORT_LIMIT = 100000;

// ---------- validasi kecil (dipakai juga oleh staff-report.js dan staff-customers.js) ----------
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

export function realYmd(v) {
  if (!isYmd(v)) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Mengembalikan {from, to} yang sudah divalidasi (undefined bila tidak diisi). Aman dipasang ke periodWhere().
export function readPeriod(query) {
  const from = blank(query.from) ? undefined : String(query.from).trim();
  const to = blank(query.to) ? undefined : String(query.to).trim();
  if (from !== undefined && !realYmd(from)) throw new HttpError(400, 'Tanggal awal tidak valid (format TTTT-BB-HH)');
  if (to !== undefined && !realYmd(to)) throw new HttpError(400, 'Tanggal akhir tidak valid (format TTTT-BB-HH)');
  if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, 'Tanggal awal tidak boleh setelah tanggal akhir');
  return { from, to };
}

// Bilangan bulat positif dari parameter jalur / query / body; selain itu 400.
export function parseId(v, label = 'ID') {
  const s = String(v ?? '').trim();
  if (!/^\d{1,15}$/.test(s) || Number(s) < 1) throw new HttpError(400, `${label} harus berupa angka`);
  return Number(s);
}

export function readFormat(query) {
  if (blank(query.format)) return 'csv';
  const f = String(query.format).trim().toLowerCase();
  if (f !== 'csv' && f !== 'xlsx') throw new HttpError(400, 'Format harus csv atau xlsx');
  return f;
}

export const cleanQ = (v) => String(v ?? '').trim().slice(0, MAX_Q).trim();

// No WA hanya ikut dicari bila q seluruhnya angka/spasi/strip/plus dengan minimal 3 digit.
// Nomor tersimpan dalam bentuk 62812..., jadi awalan 0 dicocokkan juga sebagai 62.
export function phonePatterns(q) {
  if (!/^[\d\s+-]+$/.test(q)) return [];
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return [];
  const out = [digits];
  if (digits.startsWith('00') && digits.length > 4) out.push(digits.slice(2));
  else if (digits.startsWith('0')) out.push(`62${digits.slice(1)}`);
  return [...new Set(out)];
}

// ---------- layanan & pencarian customer ----------
add('GET', '/api/services', 'user', () => ({
  services: db.prepare('SELECT id, position, name, photo FROM services ORDER BY position').all(),
}));

// Pencarian customer untuk input layanan: hanya lewat No RM, dan hanya mengembalikan No RM + nama.
const searchLimiter = createLimiter({ max: 60, windowMs: 60_000, maxKeys: 5000 });

add('GET', '/api/customers/search', 'user', ({ user, query, res }) => {
  const q = cleanQ(query.q);
  if (q.length < 2) return { customers: [] };
  const hit = searchLimiter.hit(String(user.id));
  if (!hit.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, hit.retryAfterSec || 1)));
    throw new HttpError(429, 'Terlalu banyak pencarian, coba lagi sebentar');
  }
  const rows = db.prepare(`
    SELECT id, rm_no, name FROM customers
    WHERE rm_no IS NOT NULL AND rm_no LIKE ? ESCAPE '\\'
    ORDER BY (rm_no = ?) DESC, (rm_no LIKE ? ESCAPE '\\') DESC, rm_no LIMIT 8
  `).all(likePattern(q), q, `${q.replace(/[\\%_]/g, '\\$&')}%`);
  return { customers: rows };
});

// ---------- riwayat user ----------
// Satu sumber filter untuk daftar, total, dan ekspor.
function mineFilter(userId, query) {
  const { where, args } = periodWhere(readPeriod(query));
  where.unshift('r.user_id = ?');
  args.unshift(userId);
  const q = cleanQ(query.q);
  if (q) {
    const conds = ["c.name LIKE ? ESCAPE '\\'", "c.rm_no LIKE ? ESCAPE '\\'", "s.name LIKE ? ESCAPE '\\'"];
    const qa = [likePattern(q), likePattern(q), likePattern(q)];
    for (const p of phonePatterns(q)) { conds.push("c.phone LIKE ? ESCAPE '\\'"); qa.push(likePattern(p)); }
    where.push(`(${conds.join(' OR ')})`);
    args.push(...qa);
  }
  return { where: where.join(' AND '), args };
}

function myRecords(userId, query, limit) {
  const { where, args } = mineFilter(userId, query);
  return db.prepare(`${recordSelect(false)} WHERE ${where} ORDER BY r.id DESC LIMIT ${limit}`).all(...args);
}

function myTotals(userId, query) {
  const { where, args } = mineFilter(userId, query);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT r.customer_id) AS customers, COUNT(*) AS services
    FROM records r
    JOIN customers c ON c.id = r.customer_id
    JOIN services s ON s.id = r.service_id
    WHERE ${where}`).get(...args);
  return { customers: row.customers, services: row.services };
}

const requireWorker = (user) => { if (user.role !== 'user') throw new HttpError(403, 'Hanya akun user yang menginput layanan'); };

add('GET', '/api/records/mine', 'user', ({ user, query }) => {
  requireWorker(user);
  // SOAP pada tabel Customer dikelola admin/supervisor; tidak dikirim ke user.
  const records = myRecords(user.id, query, MINE_LIMIT).map(({ note, ...r }) => r);
  const totals = myTotals(user.id, query);
  return { records, totals, truncated: totals.services > records.length };
});

add('GET', '/api/records/mine/export', 'user', ({ user, query, res }) => {
  requireWorker(user);
  const format = readFormat(query);
  const rows = myRecords(user.id, query, EXPORT_LIMIT);
  sendExport(res, {
    format,
    filename: `riwayat-customer-${stamp()}`,
    sheets: [{
      name: 'Riwayat Customer',
      headers: ['Tanggal', 'No RM', 'Nama Customer', 'No WA', 'Layanan'],
      rows: rows.map((r) => [formatDateTime(r.created_at), r.customer_rm || '', r.customer_name, r.customer_phone, r.service_name]),
    }],
  });
  return null;
});