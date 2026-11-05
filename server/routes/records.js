import { add } from './index.js';
import { HttpError } from '../util.js';
import { requireWorker } from './helpers.js';
import { clientIp } from '../auth.js';
import { withIdempotency } from '../idempotency.js';
import { deleteRecord } from '../records.js';
import { completeSchedule } from '../schedules.js';

// Input layanan oleh user WAJIB lewat jadwal (D3): customer dan layanan diambil dari jadwal, jadi
// customer_id / customer_rm / service_ids dari klien diabaikan. Header Idempotency-Key: permintaan ulang
// dengan key sama mengembalikan respons semula (header Idempotent-Replay: true) dan tidak membuat data baru.
// Pengecekan key, pembuatan record, status jadwal, dan penyimpanan hasilnya satu transaksi.
add('POST', '/api/records', 'user', ({ req, res, user, body }) => {
  requireWorker(user);
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.schedule_id;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new HttpError(400, 'Pilih jadwal dulu dari menu Jadwal Saya', 'SCHEDULE_REQUIRED');
  }
  const sid = typeof raw === 'boolean' ? NaN : Number(String(raw).trim());
  if (!Number.isInteger(sid) || sid < 1) throw new HttpError(400, 'ID jadwal tidak valid');
  const out = withIdempotency(user.id, req.headers['idempotency-key'], () => {
    const result = completeSchedule({ user, scheduleId: sid, soap: b.soap, ip: clientIp(req) });
    return { status: 200, body: { ok: true, count: result.count, customer: result.customer, schedule: result.schedule } };
  });
  if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
  return out.body;
});

add('DELETE', '/api/records/:id', 'user', ({ req, user, params }) => {
  if (!/^\d{1,15}$/.test(params.id) || Number(params.id) < 1) throw new HttpError(400, 'ID data tidak valid');
  deleteRecord({ actor: user, id: Number(params.id), ip: clientIp(req) });
  return { ok: true };
});
