import crypto from 'node:crypto';
import { db, tx, SERVICE_COUNT } from './db.js';
import { HttpError, isYmd, likePattern } from './util.js';
import { ymd } from './clock.js';
import { logAudit } from './audit.js';
import { createNotification, NOTIFICATION_TYPES as NT } from './notifications.js';
import { resolveCustomer, ints } from './routes/helpers.js';
import { createRecords } from './records.js';

// Logika bisnis jadwal (tanpa HTTP). Dipakai rute staff (Fase 3) dan alur user (Fase 4).
// Isi catatan (note) dan SOAP tidak pernah masuk log audit.

export const SCHEDULE_STATUSES = Object.freeze(['baru', 'berjalan', 'selesai', 'batal']);
export const NOTE_MAX = 500;
export const PAGE_SIZE = 50;
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- validasi ----------
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function realYmd(v) {
  if (!isYmd(v)) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function readDay(v) {
  const day = String(v ?? '').trim();
  if (!realYmd(day)) throw new HttpError(400, 'Tanggal tidak valid (format TTTT-BB-HH)');
  return day;
}

function readStart(v) {
  const t = String(v ?? '').trim();
  if (!TIME_RX.test(t)) throw new HttpError(400, 'Jam mulai tidak valid (format JJ:MM, 24 jam)');
  return t;
}

function readEnd(v) {
  if (blank(v)) return '';
  const t = String(v).trim();
  if (!TIME_RX.test(t)) throw new HttpError(400, 'Jam selesai tidak valid (format JJ:MM, 24 jam)');
  return t;
}

function readNote(v) {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (n.length > NOTE_MAX) throw new HttpError(400, `Catatan maksimal ${NOTE_MAX} karakter`);
  return n;
}

function readServiceIds(v) {
  const bad = () => new HttpError(400, `Pilih 1–${SERVICE_COUNT} layanan yang berbeda dan valid`);
  if (!Array.isArray(v) || v.length === 0 || v.length > SERVICE_COUNT) throw bad();
  // Hanya angka atau teks angka; true/null/'' dan duplikat ditolak.
  if (!v.every((x) => (typeof x === 'number' && Number.isInteger(x)) || (typeof x === 'string' && /^\d{1,15}$/.test(x.trim())))) throw bad();
  const list = ints(v, SERVICE_COUNT);
  if (!list || list.length !== v.length) throw bad();
  const found = db.prepare(`SELECT COUNT(*) AS n FROM services WHERE id IN (${list.map(() => '?').join(',')})`).get(...list).n;
  if (found !== list.length) throw bad();
  return list;
}

function readWorker(v) {
  const id = Number(v);
  const u = Number.isInteger(id) && id > 0 && typeof v !== 'boolean'
    ? db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(id) : null;
  if (!u || u.role !== 'user' || !u.active) throw new HttpError(400, 'User harus akun aktif dengan peran user');
  return u;
}

const hasCustomerRef = (b) => !blank(b.customer_id) || !blank(b.customer_rm);

// ---------- bentuk API ----------
// Dasar SELECT (dipakai ulang Fase 4): kolom jadwal + nama user, data customer, dan nama pembuat.
export const SCHEDULE_SELECT = `SELECT s.*, u.name AS user_name,
  c.rm_no AS customer_rm, c.name AS customer_name, c.phone AS customer_phone, cb.name AS created_by_name
  FROM schedules s
  JOIN users u ON u.id = s.user_id
  JOIN customers c ON c.id = s.customer_id
  LEFT JOIN users cb ON cb.id = s.created_by`;

function servicesOf(ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT ss.schedule_id, sv.id, sv.name FROM schedule_services ss
    JOIN services sv ON sv.id = ss.service_id
    WHERE ss.schedule_id IN (${ids.map(() => '?').join(',')}) ORDER BY sv.position`).all(...ids);
  for (const r of rows) map.get(r.schedule_id).push({ id: r.id, name: r.name });
  return map;
}

// row = baris dari SCHEDULE_SELECT. services boleh diberikan (hasil servicesOf) agar daftar tidak N+1.
export function toApi(row, { detail = false, staff = false, services } = {}) {
  const svc = services ?? servicesOf([row.id]).get(row.id);
  const hasSoap = !!(row.soap_s || row.soap_o || row.soap_a || row.soap_p);
  const out = {
    id: row.id,
    day: row.day,
    start_time: row.start_time,
    end_time: row.end_time,
    note: row.note,
    status: row.status,
    overdue: (row.status === 'baru' || row.status === 'berjalan') && row.day < ymd(),
    user: { id: row.user_id, name: row.user_name },
    customer: { id: row.customer_id, rm_no: row.customer_rm, name: row.customer_name, phone: row.customer_phone },
    has_soap: hasSoap,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    services: svc,
  };
  if (detail) out.soap = hasSoap ? { s: row.soap_s, o: row.soap_o, a: row.soap_a, p: row.soap_p } : null;
  if (staff) out.created_by_name = row.created_by_name || '';
  return out;
}

export function toApiList(rows, opts = {}) {
  const map = servicesOf(rows.map((r) => r.id));
  return rows.map((r) => toApi(r, { ...opts, services: map.get(r.id) }));
}

export const notifBody = (customerName, day, startTime) => `${customerName} · ${day} ${startTime}`;

export function getScheduleRow(id) {
  return db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(Number(id));
}

// Detail untuk staff (dengan SOAP); 404 bila tidak ada.
export function getSchedule(id) {
  const row = getScheduleRow(id);
  if (!row) throw new HttpError(404, 'Jadwal tidak ditemukan');
  return toApi(row, { detail: true, staff: true });
}

// ---------- daftar ----------
// filter: { from, to, userId, status, q, page } (from/to/status sudah divalidasi oleh rute).
export function listSchedules({ from, to, userId, status, q, page = 1 } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('s.day >= ?'); args.push(from); }
  if (to) { where.push('s.day <= ?'); args.push(to); }
  if (userId) { where.push('s.user_id = ?'); args.push(Number(userId)); }
  if (status) { where.push('s.status = ?'); args.push(status); }
  if (q) {
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.rm_no LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')");
    const p = likePattern(q);
    args.push(p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const join = 'FROM schedules s JOIN users u ON u.id = s.user_id JOIN customers c ON c.id = s.customer_id';
  const total = db.prepare(`SELECT COUNT(*) AS n ${join} ${w}`).get(...args).n;
  const rows = db.prepare(`${SCHEDULE_SELECT} ${w} ORDER BY s.day, s.start_time, s.id LIMIT ? OFFSET ?`)
    .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { schedules: toApiList(rows, { staff: true }), total, page, pageSize: PAGE_SIZE };
}

export function listWorkers() {
  return db.prepare("SELECT id, name, username FROM users WHERE role = 'user' AND active = 1 ORDER BY name COLLATE NOCASE, id").all();
}

// ---------- tulis ----------
const audit = (actor, ip, action, id, detail) => logAudit({
  actor: { id: actor.id, name: actor.name }, action, targetType: 'schedule', targetId: id, detail, ip,
});

function setServices(scheduleId, ids) {
  db.prepare('DELETE FROM schedule_services WHERE schedule_id = ?').run(scheduleId);
  const ins = db.prepare('INSERT INTO schedule_services (schedule_id, service_id) VALUES (?, ?)');
  for (const sid of ids) ins.run(scheduleId, sid);
}

export function createSchedule(body, actor, ip = '') {
  const worker = readWorker(body.user_id);
  const day = readDay(body.day);
  if (day < ymd()) throw new HttpError(400, 'Tanggal jadwal tidak boleh sudah lewat');
  const start = readStart(body.start_time);
  const end = readEnd(body.end_time);
  if (end && end < start) throw new HttpError(400, 'Jam selesai tidak boleh sebelum jam mulai');
  const note = readNote(body.note);
  const serviceIds = readServiceIds(body.service_ids);
  const customer = resolveCustomer(body);
  return tx(() => {
    const info = db.prepare(`INSERT INTO schedules (user_id, customer_id, day, start_time, end_time, note, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'baru', ?, ?, '')`).run(worker.id, customer.id, day, start, end, note, actor.id, new Date().toISOString());
    const id = Number(info.lastInsertRowid);
    setServices(id, serviceIds);
    audit(actor, ip, 'schedule.create', id, { user_id: worker.id, customer_id: customer.id, day, start_time: start, services: serviceIds.length });
    createNotification({ userId: worker.id, type: NT.tugas_baru, scheduleId: id, body: notifBody(customer.name, day, start) });
    return getSchedule(id);
  });
}

export function updateSchedule(id, body, actor, ip = '') {
  const cur = getScheduleRow(id);
  if (!cur) throw new HttpError(404, 'Jadwal tidak ditemukan');
  if (cur.status !== 'baru') throw new HttpError(409, 'Jadwal hanya bisa diubah selama statusnya Baru', 'SCHEDULE_STATE');

  const next = { user_id: cur.user_id, customer_id: cur.customer_id, day: cur.day, start_time: cur.start_time, end_time: cur.end_time, note: cur.note };
  let customerName = cur.customer_name;
  let serviceIds = null;
  if (body.user_id !== undefined) next.user_id = readWorker(body.user_id).id;
  if (hasCustomerRef(body)) {
    const c = resolveCustomer(body);
    next.customer_id = c.id;
    customerName = c.name;
  }
  if (body.day !== undefined) {
    next.day = readDay(body.day);
    if (next.day !== cur.day && next.day < ymd()) throw new HttpError(400, 'Tanggal jadwal tidak boleh sudah lewat');
  }
  if (body.start_time !== undefined) next.start_time = readStart(body.start_time);
  if (body.end_time !== undefined) next.end_time = readEnd(body.end_time);
  if (body.note !== undefined) next.note = readNote(body.note);
  if (next.end_time && next.end_time < next.start_time) throw new HttpError(400, 'Jam selesai tidak boleh sebelum jam mulai');
  if (body.service_ids !== undefined) serviceIds = readServiceIds(body.service_ids);

  return tx(() => {
    const changed = Object.keys(next).filter((k) => next[k] !== cur[k]);
    if (serviceIds) {
      const old = db.prepare('SELECT service_id FROM schedule_services WHERE schedule_id = ? ORDER BY service_id').all(cur.id).map((r) => r.service_id);
      const sorted = [...serviceIds].sort((a, b) => a - b);
      if (old.length !== sorted.length || old.some((v, i) => v !== sorted[i])) changed.push('service_ids');
    }
    if (!changed.length) return getSchedule(cur.id); // tidak ada perubahan: tanpa audit dan notifikasi

    db.prepare(`UPDATE schedules SET user_id = ?, customer_id = ?, day = ?, start_time = ?, end_time = ?, note = ?, updated_at = ? WHERE id = ?`)
      .run(next.user_id, next.customer_id, next.day, next.start_time, next.end_time, next.note, new Date().toISOString(), cur.id);
    if (changed.includes('service_ids')) setServices(cur.id, serviceIds);
    audit(actor, ip, 'schedule.update', cur.id, { fields: changed });

    const text = notifBody(customerName, next.day, next.start_time);
    if (next.user_id !== cur.user_id) {
      createNotification({ userId: cur.user_id, type: NT.tugas_dibatalkan, scheduleId: cur.id, body: notifBody(cur.customer_name, cur.day, cur.start_time) });
      createNotification({ userId: next.user_id, type: NT.tugas_baru, scheduleId: cur.id, body: text });
    } else {
      createNotification({ userId: cur.user_id, type: NT.tugas_diubah, scheduleId: cur.id, body: text });
    }
    return getSchedule(cur.id);
  });
}

// Admin hanya dari baru; supervisor dari baru atau berjalan.
export function cancelSchedule(id, actor, ip = '') {
  return tx(() => {
    const cur = getScheduleRow(id);
    if (!cur) throw new HttpError(404, 'Jadwal tidak ditemukan');
    const allowed = actor.role === 'supervisor' ? ['baru', 'berjalan'] : ['baru'];
    if (!allowed.includes(cur.status)) {
      throw new HttpError(409, cur.status === 'berjalan'
        ? 'Jadwal yang sedang dijalani hanya bisa dibatalkan supervisor'
        : 'Jadwal ini tidak bisa dibatalkan', 'SCHEDULE_STATE');
    }
    db.prepare("UPDATE schedules SET status = 'batal', updated_at = ? WHERE id = ?").run(new Date().toISOString(), cur.id);
    audit(actor, ip, 'schedule.cancel', cur.id, { user_id: cur.user_id, customer_id: cur.customer_id, day: cur.day, from: cur.status });
    createNotification({ userId: cur.user_id, type: NT.tugas_dibatalkan, scheduleId: cur.id, body: notifBody(cur.customer_name, cur.day, cur.start_time) });
    return getSchedule(cur.id);
  });
}

// =====================================================================
// Bagian user (Fase 4): daftar milik sendiri, mulai, dan selesai dengan SOAP.
// =====================================================================
export const MINE_LIMIT = 500;
export const SOAP_MAX = 2000;
export const SOAP_MIN = 3;
const SOAP_PARTS = [['s', 'Subjective'], ['o', 'Objective'], ['a', 'Assessment'], ['p', 'Planning']];

// from/to sudah divalidasi rute (YYYY-MM-DD); all=true berarti tanpa batas tanggal.
// Tanpa from/to/all = hari ini saja. summary dihitung untuk seluruh hasil filter (bukan hanya 500 baris).
export function listMine(userId, { from, to, all = false } = {}) {
  const today = ymd();
  if (!all && from && to && from > to) throw new HttpError(400, 'Tanggal awal tidak boleh setelah tanggal akhir');
  const where = ['s.user_id = ?'];
  const args = [Number(userId)];
  if (!all) {
    if (!from && !to) { where.push('s.day = ?'); args.push(today); }
    if (from) { where.push('s.day >= ?'); args.push(from); }
    if (to) { where.push('s.day <= ?'); args.push(to); }
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const summary = { total: 0, baru: 0, berjalan: 0, selesai: 0, batal: 0 };
  for (const r of db.prepare(`SELECT s.status, COUNT(*) AS n FROM schedules s ${w} GROUP BY s.status`).all(...args)) {
    if (r.status in summary) { summary[r.status] = r.n; summary.total += r.n; }
  }
  const rows = db.prepare(`${SCHEDULE_SELECT} ${w} ORDER BY s.day, s.start_time, s.id LIMIT ?`).all(...args, MINE_LIMIT);
  return { schedules: toApiList(rows), summary, today, truncated: summary.total > rows.length };
}

// Detail milik sendiri (dengan SOAP). Milik orang lain atau tidak ada: 404 yang sama.
export function getMine(userId, id) {
  const row = getScheduleRow(id);
  if (!row || row.user_id !== Number(userId)) throw new HttpError(404, 'Jadwal tidak ditemukan');
  return toApi(row, { detail: true });
}

// Pemeriksaan bersama mulai/selesai: milik user (404), hari ini, status baru/berjalan.
function loadRunnable(user, id) {
  const row = getScheduleRow(id);
  if (!row || row.user_id !== user.id) throw new HttpError(404, 'Jadwal tidak ditemukan');
  if (row.day !== ymd()) throw new HttpError(409, 'Jadwal hanya bisa dijalankan pada tanggalnya', 'SCHEDULE_NOT_TODAY');
  if (row.status !== 'baru' && row.status !== 'berjalan') {
    throw new HttpError(409, row.status === 'selesai' ? 'Jadwal ini sudah selesai' : 'Jadwal ini sudah dibatalkan', 'SCHEDULE_STATE');
  }
  return row;
}

// baru -> berjalan (notifikasi + audit). berjalan -> tidak ada perubahan (tanpa notifikasi/audit).
export function startSchedule({ user, id, ip = '' }) {
  return tx(() => {
    const row = loadRunnable(user, id);
    if (row.status === 'baru') {
      const now = new Date().toISOString();
      db.prepare("UPDATE schedules SET status = 'berjalan', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
      audit(user, ip, 'schedule.start', row.id, { customer_id: row.customer_id, day: row.day });
      createNotification({ userId: row.user_id, type: NT.tugas_berjalan, scheduleId: row.id, body: notifBody(row.customer_name, row.day, row.start_time) });
    }
    return toApi(getScheduleRow(row.id), { detail: true });
  });
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Sama dengan cleanNote di server/customers.js, tetapi tanpa memotong diam-diam (batas diperiksa terpisah).
const cleanText = (v) => String(v).replace(/\r\n?/g, '\n').replace(CTRL, '')
  .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Mengembalikan {s,o,a,p} yang sudah dirapikan, atau melempar 400 SOAP_REQUIRED (bagian pertama yang bermasalah).
export function validateSoap(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [key, label] of SOAP_PARTS) {
    const raw = src[key];
    const text = typeof raw === 'string' ? cleanText(raw) : '';
    if (text.length < SOAP_MIN) throw new HttpError(400, `SOAP bagian ${label} wajib diisi (minimal ${SOAP_MIN} karakter)`, 'SOAP_REQUIRED');
    if (text.length > SOAP_MAX) throw new HttpError(400, `SOAP bagian ${label} terlalu panjang (maksimal ${SOAP_MAX} karakter)`, 'SOAP_REQUIRED');
    out[key] = text;
  }
  return out;
}

// Dipakai POST /api/records. Seluruh langkah satu transaksi (ikut transaksi withIdempotency):
// validasi -> record per layanan jadwal -> status selesai + SOAP -> notifikasi -> audit (tanpa isi SOAP).
// customer dan layanan SELALU dari jadwal; apa pun dari klien diabaikan oleh pemanggil.
export function completeSchedule({ user, scheduleId, soap, ip = '' }) {
  return tx(() => {
    const row = loadRunnable(user, scheduleId);
    const clean = validateSoap(soap);
    const serviceIds = db.prepare(`SELECT ss.service_id FROM schedule_services ss JOIN services sv ON sv.id = ss.service_id
      WHERE ss.schedule_id = ? ORDER BY sv.position`).all(row.id).map((r) => r.service_id);
    if (!serviceIds.length) throw new HttpError(409, 'Jadwal ini tidak punya layanan. Hubungi admin.', 'SCHEDULE_STATE');
    const customer = { id: row.customer_id, rm_no: row.customer_rm, name: row.customer_name, phone: row.customer_phone };

    const { count, batch } = createRecords({ userId: user.id, customer, serviceIds, source: 'web', note: '', batch: crypto.randomUUID() });

    const now = new Date().toISOString();
    db.prepare(`UPDATE schedules SET status = 'selesai', completed_at = ?, started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END,
      batch = ?, soap_s = ?, soap_o = ?, soap_a = ?, soap_p = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, batch, clean.s, clean.o, clean.a, clean.p, now, row.id);
    audit(user, ip, 'schedule.complete', row.id, { customer_id: row.customer_id, day: row.day, services: count, soap_parts: SOAP_PARTS.map(([k]) => k) });
    createNotification({ userId: row.user_id, type: NT.tugas_selesai, scheduleId: row.id, body: notifBody(row.customer_name, row.day, row.start_time) });
    return { count, customer, schedule: toApi(getScheduleRow(row.id), { detail: true }) };
  });
}
