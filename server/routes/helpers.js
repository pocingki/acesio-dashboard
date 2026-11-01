// Pembantu bersama untuk berkas rute. Dibekukan setelah Fase 1.
import { db } from '../db.js';
import { HttpError, isYmd } from '../util.js';
import { toCsv, toXlsx } from '../exporter.js';
import { ymd } from '../clock.js';

export const EMP_LABEL = { tetap: 'Karyawan tetap', part_time: 'Part time' };

export const ints = (arr, max = 50) => {
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > max) return null;
  const out = [...new Set(arr.map(Number))];
  return out.every((n) => Number.isInteger(n) && n > 0) ? out : null;
};

export const stamp = () => ymd();

// Tambahan di luar daftar kontrak A (dipakai lebih dari satu berkas rute):
export const nowIso = () => new Date().toISOString();
export const isSv = (u) => u.role === 'supervisor';
export const requireWorker = (user) => { if (user.role !== 'user') throw new HttpError(403, 'Hanya akun user yang menginput layanan'); };

// Customer hanya dicocokkan dengan data yang sudah dimasukkan admin (lewat id atau No RM).
// Customer yang belum ada tidak dibuat otomatis: user wajib melapor ke admin.
export function resolveCustomer(body) {
  const cols = 'SELECT id, rm_no, name, phone FROM customers';
  let c = null;
  if (body.customer_id) c = db.prepare(`${cols} WHERE id = ?`).get(Number(body.customer_id));
  else if (String(body.customer_rm || '').trim()) c = db.prepare(`${cols} WHERE rm_no = ?`).get(String(body.customer_rm).trim());
  else throw new HttpError(400, 'Isi No RM lalu pilih customer yang sesuai');
  if (!c) throw new HttpError(404, 'Customer tidak ditemukan. Laporkan ke admin untuk memasukkan data customer baru.');
  return c;
}

// Periode memakai kolom `day` (tanggal zona Jakarta), jadi konsisten dengan approve harian.
export function periodWhere(query, alias = 'r') {
  const where = [];
  const args = [];
  if (isYmd(query.from)) { where.push(`${alias}.day >= ?`); args.push(query.from); }
  if (isYmd(query.to)) { where.push(`${alias}.day <= ?`); args.push(query.to); }
  return { where, args };
}

// Komisi hanya ikut dikirim untuk supervisor.
export function recordSelect(withCommission) {
  return `SELECT r.id, r.created_at, r.day, r.note, r.batch, r.source, ${withCommission ? 'r.commission,' : ''}
         c.id AS customer_id, c.rm_no AS customer_rm, c.name AS customer_name, c.phone AS customer_phone,
         s.id AS service_id, s.name AS service_name, u.id AS user_id, u.name AS user_name,
         (dr.day IS NOT NULL) AS locked
  FROM records r
  JOIN customers c ON c.id = r.customer_id
  JOIN services s ON s.id = r.service_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN day_reviews dr ON dr.user_id = r.user_id AND dr.day = r.day`;
}

export function sendExport(res, { format, filename, sheets }) {
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
