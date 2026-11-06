// Integrasi WA bot (header: X-API-Key).
// Alur sama dengan user web: customer dicari lewat No RM dari data admin; bot tidak membuat customer baru.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { clientIp } from '../auth.js';
import { createLimiter } from '../ratelimit.js';
import { createRecords } from '../records.js';
import { requestFingerprint, withIdempotency } from '../idempotency.js';
import { recordLinkedSchedule } from '../schedules.js';
import { HttpError, normalizePhone, likePattern } from '../util.js';
import { ints } from './helpers.js';
import { add } from './index.js';

// ----- autentikasi API key -----
// 10 key salah per menit per IP, lalu 429. Selama diblokir, key yang benar pun ditolak
// (kalau tidak, penebak bisa membedakan tebakan benar dari 429 tanpa batas).
const failedKeys = createLimiter({ max: 10, windowMs: 60_000, maxKeys: 10_000 });
const blockedUntil = new Map();
const MAX_BLOCKED = 10_000;

const digest = (v) => crypto.createHash('sha256').update(v).digest();
const tooMany = (sec) => new HttpError(429, `Terlalu banyak API key salah. Coba lagi dalam ${sec} detik.`);

function rememberBlock(ip, retryAfterSec) {
  if (blockedUntil.size >= MAX_BLOCKED) blockedUntil.delete(blockedUntil.keys().next().value);
  blockedUntil.set(ip, Date.now() + Math.max(1, retryAfterSec) * 1000);
}

// true = key benar, false = key salah (pemanggil melempar 401). Melempar 503 / 429 sendiri.
export function botKeyValid(req) {
  const expected = process.env.BOT_API_KEY;
  if (!expected) throw new HttpError(503, 'Integrasi bot belum aktif (BOT_API_KEY belum diisi)');
  const ip = clientIp(req);
  const until = blockedUntil.get(ip);
  if (until) {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) throw tooMany(left);
    blockedUntil.delete(ip);
  }
  // SHA-256 di kedua sisi: panjang sama, jadi panjang key asli tidak bocor lewat timing.
  const given = digest(String(req.headers['x-api-key'] || ''));
  if (crypto.timingSafeEqual(given, digest(expected))) return true;
  const hit = failedKeys.hit(ip);
  if (!hit.allowed) {
    rememberBlock(ip, hit.retryAfterSec);
    throw tooMany(hit.retryAfterSec);
  }
  return false;
}

// Dicek lagi di tiap handler sebagai pengaman, walau index.js juga memanggil botKeyValid
// (kalau sudah lolos di sana, pengecekan ini murah dan tidak menghitung percobaan gagal).
const bot = (handler) => (ctx) => {
  if (!botKeyValid(ctx.req)) throw new HttpError(401, 'API key salah');
  return handler(ctx);
};

// ----- util -----
function resolveCustomer(body) {
  const cols = 'SELECT id, rm_no, name, phone FROM customers';
  let c = null;
  if (body.customer_id) c = db.prepare(`${cols} WHERE id = ?`).get(Number(body.customer_id));
  else if (String(body.customer_rm || '').trim()) c = db.prepare(`${cols} WHERE rm_no = ?`).get(String(body.customer_rm).trim());
  else throw new HttpError(400, 'Isi No RM lalu pilih customer yang sesuai');
  if (!c) throw new HttpError(404, 'Customer tidak ditemukan. Laporkan ke admin untuk memasukkan data customer baru.');
  return c;
}

const botCustomer = (c) => {
  const stats = db.prepare('SELECT COUNT(DISTINCT batch) AS visits, MAX(created_at) AS last_visit FROM records WHERE customer_id = ?').get(c.id);
  return { id: c.id, rm_no: c.rm_no, name: c.name, phone: c.phone, visits: stats.visits, last_visit: stats.last_visit };
};

const KEY_RX = /^[A-Za-z0-9_-]{8,100}$/;
// Kunci idempotensi wajib: body.request_id atau header Idempotency-Key (kalau dua-duanya ada, harus sama).
function requestKey(req, body) {
  const raw = body.request_id;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new HttpError(400, 'request_id harus berupa teks');
  const fromBody = raw || '';
  const fromHeader = String(req.headers['idempotency-key'] || '').trim();
  if (fromBody && fromHeader && fromBody !== fromHeader) throw new HttpError(400, 'request_id dan header Idempotency-Key harus sama');
  const key = fromBody || fromHeader;
  if (!key) throw new HttpError(400, 'request_id wajib (8–100 karakter) supaya pengiriman ulang tidak menggandakan komisi', 'REQUEST_ID_REQUIRED');
  if (!KEY_RX.test(key)) throw new HttpError(400, 'request_id / Idempotency-Key harus 8–100 karakter: huruf, angka, strip, garis bawah');
  return key;
}

function readScheduleId(body) {
  if (body.schedule_id === undefined || body.schedule_id === null || body.schedule_id === '') return null;
  const n = Number(body.schedule_id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'schedule_id tidak valid');
  return n;
}

function botFingerprint(userId, body) {
  const ids = Array.isArray(body.service_ids) ? body.service_ids.map(Number) : body.service_ids;
  const serviceIds = Array.isArray(ids) && ids.every((n) => Number.isInteger(n)) ? [...ids].sort((a, b) => a - b) : ids;
  const scheduleRaw = body.schedule_id;
  const scheduleId = scheduleRaw === undefined || scheduleRaw === null || scheduleRaw === '' ? null : Number(scheduleRaw);
  return requestFingerprint({
    user_id: userId,
    customer_id: body.customer_id == null || body.customer_id === '' ? null : Number(body.customer_id),
    customer_rm: String(body.customer_rm || '').trim(),
    service_ids: serviceIds,
    schedule_id: Number.isInteger(scheduleId) ? scheduleId : (scheduleRaw ?? null),
  });
}

// createRecords boleh mengembalikan angka (lama) atau objek {count, ids}; id dicari dari DB bila tidak dikembalikan.
function recordIdsFrom(result, userId, customerId, count) {
  const given = result && typeof result === 'object' ? (result.ids || result.recordIds || result.record_ids) : null;
  if (Array.isArray(given)) return given;
  return db.prepare('SELECT id FROM records WHERE user_id = ? AND customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, customerId, count).map((r) => r.id).reverse();
}

// ----- rute -----
add('GET', '/api/bot/services', 'bot', bot(() => ({ services: db.prepare('SELECT id, position, name FROM services WHERE active = 1 ORDER BY position').all() })));

add('GET', '/api/bot/customers', 'bot', bot(({ query }) => {
  const q = String(query.q || '').trim();
  const rm = String(query.rm || '').trim();
  const phone = normalizePhone(query.phone);
  const cols = 'SELECT id, rm_no, name, phone FROM customers';
  let rows;
  if (rm) rows = db.prepare(`${cols} WHERE rm_no = ? LIMIT 1`).all(rm);
  else if (phone) rows = db.prepare(`${cols} WHERE phone = ? ORDER BY name LIMIT 20`).all(phone);
  else if (q.length >= 2) rows = db.prepare(`${cols} WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20`).all(likePattern(q));
  else throw new HttpError(400, 'Isi ?rm=... , ?phone=... atau ?q=... (minimal 2 huruf)');
  return { customers: rows.map(botCustomer) };
}));

add('GET', '/api/bot/customers/:id/history', 'bot', bot(({ params }) => {
  const c = db.prepare('SELECT id, rm_no, name, phone FROM customers WHERE id = ?').get(Number(params.id));
  if (!c) throw new HttpError(404, 'Customer tidak ditemukan');
  const history = db.prepare(`
    SELECT r.id, r.created_at, s.name AS service, u.name AS served_by
    FROM records r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
    WHERE r.customer_id = ? ORDER BY r.id DESC LIMIT 100`).all(c.id);
  return { customer: botCustomer(c), history };
}));

add('POST', '/api/bot/records', 'bot', bot(({ req, res, body }) => {
  const u = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'user' AND active = 1").get(String(body.username || ''));
  if (!u) throw new HttpError(400, 'username petugas tidak ditemukan');
  const key = requestKey(req, body);
  const fingerprint = botFingerprint(u.id, body);

  // run() HARUS sinkron: withIdempotency menyimpan hasil pemanggilan langsung (Promise akan tersimpan sebagai {}).
  // Seluruh validasi ada di dalam run(): permintaan ulang dengan key sama mendapat respons semula.
  // Kegagalan di dalam run membatalkan kunci, jadi percobaan berikutnya dengan ID yang sama masih bisa berhasil.
  const run = () => {
    const serviceIds = ints(body.service_ids);
    if (!serviceIds) throw new HttpError(400, 'service_ids wajib berisi daftar id layanan');
    const customer = resolveCustomer(body);
    const scheduleId = readScheduleId(body);
    if (scheduleId) {
      const claimed = recordLinkedSchedule({ userId: u.id, scheduleId, customerId: customer.id, serviceIds });
      return { status: 200, body: { ok: true, count: claimed.count, record_ids: claimed.record_ids, customer } };
    }
    const result = createRecords({ userId: u.id, customer, serviceIds, source: 'bot', note: '' });
    const count = typeof result === 'number' ? result : result?.count ?? serviceIds.length;
    const recordIds = recordIdsFrom(result, u.id, customer.id, count);
    return { status: 200, body: { ok: true, count, record_ids: recordIds, customer } };
  };

  const out = withIdempotency(u.id, key, run, fingerprint);
  if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
  return out.body;
}));