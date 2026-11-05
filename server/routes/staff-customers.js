import { db, tx } from '../db.js';
import { HttpError, likePattern } from '../util.js';
import { sendExport, stamp } from './helpers.js';
import {
  CUSTOMER_HEADERS, CUSTOMER_FIELDS as FIELDS, cleanCustomer, insertCustomer, updateCustomer, findByRm, importCustomers, customerExportRow,
} from '../customers.js';
import { logAudit } from '../audit.js';
import { clientIp } from '../auth.js';
import { resolveReference, platformNames } from '../platforms.js';
import { add, LIMITS } from './index.js';
import { parseId, readFormat, cleanQ, phonePatterns } from './history.js';

const CUSTOMER_COLS = 'c.id, c.rm_no, c.reimburse, c.name, c.gender, c.birth_date, c.phone, c.occupation, c.domicile, c.month, c.reference, c.medical_note, c.origin';
const SEARCH_COLS = ['c.rm_no', 'c.name', 'c.reimburse', 'c.occupation', 'c.domicile', 'c.month', 'c.reference', 'c.medical_note'];
const PAGE_SIZE = 50;
const WIDTHS = [6, 16, 14, 28, 15, 13, 18, 20, 20, 14, 22, 50];
const DUP_RM = 'No RM sudah terdaftar';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

// Pelanggaran UNIQUE dari SQLite (dua permintaan berebut No RM yang sama) dibalas 409, bukan 500.
const isUniqueViolation = (err) => !!err && (
  err.errcode === 2067 || err.errcode === 1555 || /UNIQUE constraint failed/i.test(String(err.message || ''))
);
function orConflict(fn, message = DUP_RM) {
  try {
    return fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, message);
    throw err;
  }
}

// No WA ikut dicari hanya bila q murni angka (>= 3 digit), sama dengan pencarian riwayat user.
function customerFilter(query) {
  const q = cleanQ(query.q);
  if (!q) return { where: '', args: [] };
  const conds = SEARCH_COLS.map((col) => `${col} LIKE ? ESCAPE '\\'`);
  const args = SEARCH_COLS.map(() => likePattern(q));
  for (const p of phonePatterns(q)) { conds.push("c.phone LIKE ? ESCAPE '\\'"); args.push(likePattern(p)); }
  return { where: `WHERE (${conds.join(' OR ')})`, args };
}

function readPage(query) {
  if (blank(query.page)) return 1;
  const s = String(query.page).trim();
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new HttpError(400, 'page harus berupa angka bulat positif');
  return Number(s);
}

add('GET', '/api/staff/customers', 'staff', ({ query }) => {
  const page = readPage(query);
  const { where, args } = customerFilter(query);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...args).n;
  const offset = (page - 1) * PAGE_SIZE;
  const customers = db.prepare(`
    SELECT ${CUSTOMER_COLS},
           (SELECT COUNT(DISTINCT batch) FROM records WHERE customer_id = c.id) AS visits,
           (SELECT MAX(created_at) FROM records WHERE customer_id = c.id) AS last_visit
    FROM customers c ${where} ORDER BY c.id LIMIT ? OFFSET ?`).all(...args, PAGE_SIZE, offset);
  return { customers, total, page, page_size: PAGE_SIZE, offset };
});

// Tarik data: kolom sama persis dengan tabel Customer (No | No RM | Reimburse | Nama | ... | Referensi | SOAP).
add('GET', '/api/staff/customers/export', 'staff', ({ query, res }) => {
  const format = readFormat(query);
  const { where, args } = customerFilter(query);
  const rows = db.prepare(`SELECT ${CUSTOMER_COLS} FROM customers c ${where} ORDER BY c.id LIMIT 200000`).all(...args);
  sendExport(res, {
    format,
    filename: `data-customer-${stamp()}`,
    sheets: [{
      name: 'Data Customer', headers: CUSTOMER_HEADERS, intCols: [0], wrapCols: [11], widths: WIDTHS,
      rows: rows.map((c, i) => customerExportRow(c, i + 1)),
    }],
  });
  return null;
});

// Template kosong (hanya baris judul) untuk diisi lalu diupload.
add('GET', '/api/staff/customers/template', 'staff', ({ query, res }) => {
  const format = readFormat(query);
  sendExport(res, {
    format,
    filename: 'template-data-customer',
    sheets: [{ name: 'Data Customer', headers: CUSTOMER_HEADERS, intCols: [0], widths: WIDTHS, rows: [] }],
  });
  return null;
});

// File impor (CSV/Excel base64) jauh lebih besar dari body biasa, jadi memakai batas khusus LIMITS.import.
add('POST', '/api/staff/customers/import', 'staff', ({ req, user, body }) => {
  const result = orConflict(() => importCustomers(String(body.format || ''), body.content));
  logAudit({
    actor: { id: user.id, name: user.name },
    action: 'customer.import',
    targetType: 'customer',
    targetId: '',
    detail: { added: result.added, updated: result.updated, skipped: result.skipped },
    ip: clientIp(req),
  });
  return { result };
}, { limit: LIMITS.import });

const customerBody = (body) => {
  const { value, warnings } = cleanCustomer({
    rm_no: body.rm_no, reimburse: body.reimburse, name: body.name, gender: body.gender, birth_date: body.birth_date,
    phone: body.phone, occupation: body.occupation, domicile: body.domicile, month: body.month, reference: body.reference,
    medical_note: body.medical_note,
  });
  if (warnings.length) throw new HttpError(400, warnings[0]);
  return value;
};

add('POST', '/api/staff/customers', 'staff', ({ req, user, body }) => {
  const value = customerBody(body);
  // Data awal masuk lewat Upload (origin 'awal'). Customer yang ditambahkan lewat form ini sudah
  // setelah data awal ada, jadi selalu 'baru'. Isian origin dari klien diabaikan.
  const origin = 'baru';
  const id = orConflict(() => tx(() => {
    if (findByRm(value.rm_no)) throw new HttpError(409, DUP_RM);
    return insertCustomer(value, origin);
  }));
  logAudit({
    actor: { id: user.id, name: user.name },
    action: 'customer.create',
    targetType: 'customer',
    targetId: String(id),
    detail: { rm_no: value.rm_no, origin },
    ip: clientIp(req),
  });
  return { ok: true, id, reference: value.reference };
});

add('PATCH', '/api/staff/customers/:id', 'staff', ({ req, user, params, body }) => {
  const id = parseId(params.id, 'ID customer');
  const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!before) throw new HttpError(404, 'Customer tidak ditemukan');
  const value = customerBody(body);
  orConflict(() => tx(() => {
    if (db.prepare('SELECT 1 FROM customers WHERE rm_no = ? AND id <> ?').get(value.rm_no, id)) throw new HttpError(409, DUP_RM);
    updateCustomer(id, value);
  }));
  // Hanya nama kolom yang berubah yang dicatat, bukan isinya (data pribadi customer).
  const fields = FIELDS.filter((f) => String(before[f] ?? '') !== String(value[f] ?? ''));
  logAudit({
    actor: { id: user.id, name: user.name },
    action: 'customer.update',
    targetType: 'customer',
    targetId: String(id),
    detail: { rm_no: value.rm_no, fields },
    ip: clientIp(req),
  });
  return { ok: true, reference: value.reference };
});

// Daftar platform baku (dari keywords.json bersama bot WA) untuk saran di kolom Referensi.
add('GET', '/api/staff/platforms', 'staff', () => ({ platforms: platformNames() }));
// Pratinjau: "fb" -> { value: "Facebook", matched: true }. Penyimpanan tetap memakai cleanCustomer di server.
add('GET', '/api/staff/platforms/resolve', 'staff', ({ query }) => {
  const q = String(query.q ?? '').slice(0, 150);
  const value = resolveReference(q.replace(/\s+/g, ' ').trim());
  return { value, matched: value !== q.replace(/\s+/g, ' ').trim() };
});

add('GET', '/api/staff/customers/:id/visits', 'staff', ({ params }) => {
  const id = parseId(params.id, 'ID customer');
  const c = db.prepare(`SELECT ${CUSTOMER_COLS} FROM customers c WHERE c.id = ?`).get(id);
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