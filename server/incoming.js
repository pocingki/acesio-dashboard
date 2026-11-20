// Permohonan customer dari WA-AMN. Bot hanya menaruh baris pending.
// Customer baru dibuat saat staf menerima, atau dihubungkan ke customer yang nomornya sudah ada.
import { db, tx } from './db.js';
import { HttpError, normalizePhone, cleanName } from './util.js';
import { cleanCustomer, insertCustomer, findByRm, nextRmNo, parseGender, parseBirthDate } from './customers.js';
import { createSchedule } from './schedules.js';
import { notifyStaff } from './notifications.js';
import { bookingOf, workerBusy, bookingConfig } from './booking.js';

const nowIso = () => new Date().toISOString();
const clip = (v, max) => String(v ?? '').trim().slice(0, max);


// Data rinci dari formulir WhatsApp. Nilai yang tidak valid dibuang satu per satu (tidak menggagalkan terima).
const FORM_TEXT = { occupation: 100, domicile: 150, month: 40 };
function formExtras(rawJson) {
  let d = {};
  try { d = JSON.parse(rawJson || '{}') || {}; } catch { d = {}; }
  const out = {};
  const g = parseGender(d.gender);
  if (g) out.gender = g;
  const b = parseBirthDate(d.birth_date);
  if (b) out.birth_date = b;
  for (const [k, max] of Object.entries(FORM_TEXT)) {
    const v = clip(d[k], max);
    if (v) out[k] = v;
  }
  return out;
}

export function receiveIncoming(body) {
  const name = cleanName(body?.name);
  if (!name) throw new HttpError(400, 'Nama customer wajib diisi');
  const phoneRaw = String(body?.phone ?? '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  if (phoneRaw && !phone) throw new HttpError(400, 'Nomor WhatsApp tidak valid');
  const waLeadId = clip(body?.wa_lead_id, 100);
  if (waLeadId) {
    const existing = db.prepare(`
      SELECT id FROM incoming_leads
      WHERE wa_lead_id = ? AND status IN ('pending', 'accepted')
      ORDER BY id DESC LIMIT 1`).get(waLeadId);
    if (existing) {
      return { ok: true, id: Number(existing.id), replayed: true, message: 'Permohonan ini sudah ada di Acesio' };
    }
  }
  const info = db.prepare(`
    INSERT INTO incoming_leads (wa_lead_id, name, phone, platform, keyword, note, raw_data, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    waLeadId,
    name,
    phone || '',
    clip(body?.platform || 'WhatsApp', 50) || 'WhatsApp',
    clip(body?.keyword, 100),
    clip(body?.note, 1000),
    JSON.stringify(body?.data && typeof body.data === 'object' ? body.data : {}),
    nowIso(),
  );
  const bk = bookingOf(JSON.stringify(body?.data && typeof body.data === 'object' ? body.data : {}));
  notifyStaff({
    type: 'pengajuan_baru',
    body: [name, phone || null, bk.day ? `${bk.day}${bk.time ? ` ${bk.time}` : ''}` : null].filter(Boolean).join(' · '),
  });
  return { ok: true, id: Number(info.lastInsertRowid), replayed: false, message: 'Permohonan customer baru berhasil diterima di Acesio' };
}

export function listPending(limit = 50) {
  return db.prepare(`
    SELECT id, wa_lead_id, name, phone, platform, keyword, note, created_at, raw_data
    FROM incoming_leads WHERE status = 'pending' ORDER BY id LIMIT ?`).all(limit)
    .map(({ raw_data, ...r }) => ({ ...r, booking: bookingOf(raw_data) }));
}

function takePending(id) {
  const row = db.prepare('SELECT * FROM incoming_leads WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Permohonan tidak ditemukan');
  if (row.status !== 'pending') throw new HttpError(409, 'Permohonan ini sudah diproses');
  return row;
}

export function acceptIncoming(id, user, rawRm = '', sched = null, ip = '') {
  return tx(() => {
    const row = takePending(id);
    let customerId = null;
    let rm = '';
    let linked = false;
    if (row.phone) {
      const found = db.prepare('SELECT id, rm_no FROM customers WHERE phone = ? ORDER BY id LIMIT 1').get(row.phone);
      if (found) {
        customerId = found.id;
        rm = found.rm_no || '';
        linked = true;
        // Customer lama: hanya kolom yang masih kosong yang diisi; data yang sudah ada tidak ditimpa.
        const have = db.prepare('SELECT gender, birth_date, occupation, domicile, month FROM customers WHERE id = ?').get(found.id) || {};
        const extra = formExtras(row.raw_data);
        for (const [k, v] of Object.entries(extra)) {
          if (!String(have[k] ?? '').trim()) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, found.id);
        }
      }
    }
    if (!customerId) {
      const wanted = clip(rawRm, 40);
      const { value, warnings } = cleanCustomer({
        rm_no: wanted || nextRmNo(),
        name: row.name,
        phone: row.phone,
        reference: row.platform || 'WhatsApp',
        ...formExtras(row.raw_data),
      });
      if (warnings.length) throw new HttpError(400, warnings[0]);
      if (findByRm(value.rm_no)) throw new HttpError(409, 'No RM sudah terdaftar');
      customerId = insertCustomer(value, 'baru');
      rm = value.rm_no;
    }
    // Jadwal: bila petugas/tanggal/jam/layanan diisi, semuanya wajib dan jadwal dibuat dalam transaksi yang sama.
    // Gagal (mis. jam sudah lewat) -> customer juga tidak dibuat dan pengajuan tetap pending.
    let scheduleId = null;
    let schedule = null;
    if (sched) {
      const s = createScheduleFor(customerId, sched, user, ip);
      scheduleId = s.id;
      schedule = { id: s.id, day: s.day, start_time: s.start_time, worker: s.user?.name || '' };
    }
    const changed = db.prepare(`
      UPDATE incoming_leads
      SET status = 'accepted', rm_no = ?, customer_id = ?, schedule_id = ?, processed_at = ?, processed_by = ?
      WHERE id = ? AND status = 'pending'`).run(rm, customerId, scheduleId, nowIso(), user.id, id);
    if (!changed.changes) throw new HttpError(409, 'Permohonan ini sudah diproses');
    return { ok: true, id, customer_id: customerId, rm_no: rm, linked, schedule };
  });
}

function createScheduleFor(customerId, sched, user, ip) {
  const cfg = bookingConfig();
  const start = String(sched.start_time ?? '').slice(0, 5);
  if (/^\d{2}:\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(String(sched.day ?? '')) && sched.user_id
    && workerBusy(sched.user_id, sched.day, start, sched.end_time || '', cfg.step)) {
    throw new HttpError(409, 'Petugas itu sudah punya jadwal pada jam tersebut. Pilih petugas atau jam lain.');
  }
  return createSchedule({
    user_id: sched.user_id, day: sched.day, start_time: start, end_time: sched.end_time || '',
    note: clip(sched.note || 'Dari pengajuan WhatsApp', 500), service_ids: sched.service_ids, customer_id: customerId,
  }, user, ip);
}

/** Dari isi permintaan terima: null bila tidak ada satu pun kolom jadwal; selain itu objek (validasi di createSchedule). */
export function scheduleFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  if (!['user_id', 'day', 'start_time', 'service_ids'].some((k) => has(body[k]))) return null;
  return { user_id: body.user_id, day: body.day, start_time: body.start_time, end_time: body.end_time, service_ids: body.service_ids, note: body.note };
}

export function rejectIncoming(id, user, reason = '') {
  return tx(() => {
    takePending(id);
    const text = clip(reason, 300);
    const changed = db.prepare(`
      UPDATE incoming_leads
      SET status = 'rejected', rejection_reason = ?, processed_at = ?, processed_by = ?
      WHERE id = ? AND status = 'pending'`).run(text, nowIso(), user.id, id);
    if (!changed.changes) throw new HttpError(409, 'Permohonan ini sudah diproses');
    return { ok: true, id };
  });
}
