// Permohonan customer dari WA-AMN. Bot hanya menaruh baris pending.
// Customer baru dibuat saat staf menerima, atau dihubungkan ke customer yang nomornya sudah ada.
import { db, tx } from './db.js';
import { HttpError, normalizePhone, cleanName } from './util.js';
import { cleanCustomer, insertCustomer, findByRm, nextRmNo } from './customers.js';

const nowIso = () => new Date().toISOString();
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

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
  return { ok: true, id: Number(info.lastInsertRowid), replayed: false, message: 'Permohonan customer baru berhasil diterima di Acesio' };
}

export function listPending(limit = 50) {
  return db.prepare(`
    SELECT id, wa_lead_id, name, phone, platform, keyword, note, created_at
    FROM incoming_leads WHERE status = 'pending' ORDER BY id LIMIT ?`).all(limit);
}

function takePending(id) {
  const row = db.prepare('SELECT * FROM incoming_leads WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Permohonan tidak ditemukan');
  if (row.status !== 'pending') throw new HttpError(409, 'Permohonan ini sudah diproses');
  return row;
}

export function acceptIncoming(id, user, rawRm = '') {
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
      }
    }
    if (!customerId) {
      const wanted = clip(rawRm, 40);
      const { value, warnings } = cleanCustomer({
        rm_no: wanted || nextRmNo(),
        name: row.name,
        phone: row.phone,
        reference: row.platform || 'WhatsApp',
      });
      if (warnings.length) throw new HttpError(400, warnings[0]);
      if (findByRm(value.rm_no)) throw new HttpError(409, 'No RM sudah terdaftar');
      customerId = insertCustomer(value, 'baru');
      rm = value.rm_no;
    }
    const changed = db.prepare(`
      UPDATE incoming_leads
      SET status = 'accepted', rm_no = ?, customer_id = ?, processed_at = ?, processed_by = ?
      WHERE id = ? AND status = 'pending'`).run(rm, customerId, nowIso(), user.id, id);
    if (!changed.changes) throw new HttpError(409, 'Permohonan ini sudah diproses');
    return { ok: true, id, customer_id: customerId, rm_no: rm, linked };
  });
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
