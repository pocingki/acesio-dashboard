import { add } from './index.js';
import { HttpError } from '../util.js';
import { ints, requireWorker, resolveCustomer } from './helpers.js';
import { clientIp } from '../auth.js';
import { withIdempotency } from '../idempotency.js';
import { createRecords, deleteRecord } from '../records.js';

// Input layanan. Header Idempotency-Key: permintaan ulang dengan key sama mengembalikan respons
// semula (header Idempotent-Replay: true) dan tidak membuat data baru. Pengecekan key, pembuatan
// record, dan penyimpanan hasilnya satu transaksi.
add('POST', '/api/records', 'user', ({ req, res, user, body }) => {
  requireWorker(user);
  const serviceIds = ints(body.service_ids);
  if (!serviceIds) throw new HttpError(400, 'Pilih minimal satu layanan');
  const out = withIdempotency(user.id, req.headers['idempotency-key'], () => {
    const customer = resolveCustomer(body);
    const count = createRecords({ userId: user.id, customer, serviceIds, source: 'web', note: '' });
    return { status: 200, body: { ok: true, count, customer } };
  });
  if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
  return out.body;
});

add('DELETE', '/api/records/:id', 'user', ({ req, user, params }) => {
  if (!/^\d{1,15}$/.test(params.id) || Number(params.id) < 1) throw new HttpError(400, 'ID data tidak valid');
  deleteRecord({ actor: user, id: Number(params.id), ip: clientIp(req) });
  return { ok: true };
});