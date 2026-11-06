import crypto from 'node:crypto';
import { db, tx } from './db.js';
import { HttpError } from './util.js';

const TTL_MS = 24 * 3600 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// Sidik permintaan: ID yang sama dengan isi berbeda ditolak, bukan diputar ulang.
export function requestFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Hapus entri yang lebih dari 24 jam. Dipanggil saat start dan tiap jam.
export function cleanupIdempotency() {
  try {
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(Date.now() - TTL_MS);
  } catch { /* DB sudah ditutup */ }
}
cleanupIdempotency();
setInterval(cleanupIdempotency, 3600 * 1000).unref();

// fn HARUS sinkron dan mengembalikan { status, body } (atau langsung body, dianggap status 200).
// Dengan key: pengecekan key, fn, dan penyimpanan hasil berjalan dalam SATU transaksi, jadi
// data yang dibuat fn dan catatan idempotensinya selalu tersimpan atau batal bersama-sama.
// Jika fn melempar error, tidak ada yang tersimpan dan key boleh dipakai lagi.
// Tanpa key (kosong): fn dijalankan biasa. Mengembalikan { status, body, replayed }.
// fingerprint: hash isi permintaan. Kosong = tidak dibandingkan (pemanggil lama).
// Dua permintaan kunci sama yang masuk bersamaan diantri oleh transaksi: yang kedua melihat hasil yang pertama.
export function withIdempotency(userId, key, fn, fingerprint = '') {
  const normalize = (out) => (out && typeof out === 'object' && Number.isInteger(out.status) && 'body' in out
    ? { status: out.status, body: out.body }
    : { status: 200, body: out });
  const fp = String(fingerprint || '');

  if (key === undefined || key === null || key === '') return { ...normalize(fn()), replayed: false };
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new HttpError(400, 'Idempotency-Key harus 8–100 karakter: huruf, angka, strip, atau garis bawah');
  }

  return tx(() => {
    const row = db.prepare('SELECT status, body, created_at, fingerprint FROM idempotency_keys WHERE user_id = ? AND key = ?').get(userId, key);
    if (row && row.created_at >= Date.now() - TTL_MS) {
      if (fp && row.fingerprint && row.fingerprint !== fp) {
        throw new HttpError(409, 'ID ini sudah dipakai untuk permintaan yang isinya berbeda', 'IDEMPOTENCY_CONFLICT');
      }
      return { status: row.status, body: JSON.parse(row.body), replayed: true };
    }
    if (row) db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?').run(userId, key);
    const out = normalize(fn());
    if (out && typeof out.then === 'function') throw new Error('withIdempotency: fn tidak boleh async');
    db.prepare('INSERT INTO idempotency_keys (user_id, key, status, body, created_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, key, out.status, JSON.stringify(out.body), Date.now(), fp);
    return { ...out, replayed: false };
  });
}