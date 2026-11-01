import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './util.js';
import { createLimiter } from './ratelimit.js';

const COOKIE = 'acesio_sid';
const MAX_SESSIONS_PER_USER = 10;
const SCRYPT_KEYLEN = 64;
const SCRYPT_CONCURRENCY = 4;
const SCRYPT_MAX_QUEUE = 256;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// Env dibaca saat dipanggil (bukan saat impor) supaya perubahan konfigurasi dan tes langsung berlaku.
const sessionMs = () => (Number(process.env.SESSION_HOURS) || 12) * 3600 * 1000;
const trustProxy = () => process.env.TRUST_PROXY === 'true';

// ---------- scrypt async + antrean ----------

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Semaphore: paling banyak `max` tugas berjalan bersamaan, sisanya mengantre (tidak memblokir event loop).
// Antrean dibatasi supaya banjir request tidak menumpuk tanpa batas.
export function createSemaphore(max, maxQueue = Infinity) {
  let running = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return {
    async run(fn) {
      if (running >= max) {
        if (waiting.length >= maxQueue) throw new HttpError(429, 'Server sedang sibuk. Coba lagi sebentar lagi.');
        await new Promise((resolve) => waiting.push(resolve)); // slot dioper langsung dari release()
      } else {
        running++;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

const scryptSlots = createSemaphore(SCRYPT_CONCURRENCY, SCRYPT_MAX_QUEUE);

// ---------- hash password ----------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, keyHex] = String(stored).split('$');
    if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length < 16) return false;
    const actual = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Hash tiruan untuk username yang tidak ada (menyamakan waktu respons). Dibuat sekali, secara lazy.
let dummyPromise = null;
const dummyHash = () => (dummyPromise ??= hashPassword('dummy-password-for-timing'));

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---------- cookie, IP, HTTPS ----------

export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // encoding rusak: abaikan cookie ini, jangan melempar
    }
  }
  return out;
}

// X-Forwarded-For hanya dipercaya bila TRUST_PROXY=true. Yang dipakai adalah entri ke-N dari kanan
// (N = TRUST_PROXY_HOPS, default 1 = satu reverse proxy), sebab entri kiri bisa dipalsukan klien.
export function clientIp(req) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (!trustProxy()) return remote;
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (!raw) return remote;
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return remote;
  const hops = Math.max(1, Math.floor(Number(process.env.TRUST_PROXY_HOPS)) || 1);
  return parts[Math.max(0, parts.length - hops)].slice(0, 64);
}

export function isSecure(req) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (!trustProxy()) return false;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function cookieHeader(token, secure) {
  const maxAge = token ? Math.floor(sessionMs() / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// ---------- throttle login ----------
// Hanya login GAGAL yang dihitung. Kunci ip+username mencegah penyerang mengunci akun orang dari IP lain;
// batas per IP menghentikan penebakan banyak username dari satu sumber.

const userLimiter = createLimiter({ max: 8, windowMs: LOGIN_WINDOW_MS, maxKeys: 10000 });
const ipLimiter = createLimiter({ max: 30, windowMs: LOGIN_WINDOW_MS, maxKeys: 10000 });
const passwordLimiter = createLimiter({ max: 5, windowMs: LOGIN_WINDOW_MS, maxKeys: 10000 });

function throttleError(...results) {
  const sec = Math.max(...results.map((r) => r.retryAfterSec));
  const err = new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.max(1, Math.ceil(sec / 60))} menit.`);
  err.retryAfterSec = sec;
  return err;
}

export async function login(username, password, { ip } = {}) {
  const name = String(username ?? '').slice(0, 200);
  const pw = String(password ?? '');
  const ipKey = String(ip || 'unknown');
  const userKey = `${ipKey}|${name.toLowerCase().slice(0, 64)}`;

  const check = () => {
    const a = ipLimiter.peek(ipKey);
    const b = userLimiter.peek(userKey);
    if (!a.allowed || !b.allowed) throw throttleError(a, b);
  };
  check();

  const user = await scryptSlots.run(async () => {
    check(); // cek ulang setelah antre: request paralel tidak boleh lolos hanya karena masuk bersamaan
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    const ok = await verifyPassword(pw, row ? row.password_hash : await dummyHash());
    return row && ok && row.active ? row : null;
  });

  if (!user) {
    userLimiter.hit(userKey);
    ipLimiter.hit(ipKey);
    return null;
  }

  userLimiter.reset(userKey);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, now + sessionMs());
  trimUserSessions(user.id);
  return { token, user };
}

// ---------- ganti password ----------

export async function changePassword(userId, current, next, currentToken) {
  const gate = passwordLimiter.peek(`pw:${userId}`);
  if (!gate.allowed) throw throttleError(gate);

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND active = 1').get(userId);
  if (!row) throw new HttpError(401, 'Sesi tidak valid. Silakan login ulang.');

  const cur = String(current ?? '');
  const ok = await scryptSlots.run(() => verifyPassword(cur, row.password_hash));
  if (!ok) {
    passwordLimiter.hit(`pw:${userId}`);
    throw new HttpError(400, 'Password saat ini salah');
  }
  passwordLimiter.reset(`pw:${userId}`);

  const nxt = String(next ?? '');
  if (nxt.length < PASSWORD_MIN) throw new HttpError(400, `Password baru minimal ${PASSWORD_MIN} karakter`);
  if (nxt.length > PASSWORD_MAX) throw new HttpError(400, `Password baru maksimal ${PASSWORD_MAX} karakter`);
  if (nxt === cur) throw new HttpError(400, 'Password baru tidak boleh sama dengan password lama');

  const hash = await scryptSlots.run(() => hashPassword(nxt));

  // Simpan + cabut sesi lain dalam satu transaksi (sinkron, tidak ada await di dalamnya).
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    if (currentToken) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(String(currentToken)));
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- sesi ----------

// Simpan paling banyak MAX_SESSIONS_PER_USER sesi terbaru per user; sisanya (tertua) dihapus.
// expires_at naik seiring waktu pembuatan, rowid memutus seri.
function trimUserSessions(userId) {
  db.prepare(`
    DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (
      SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY expires_at DESC, rowid DESC LIMIT ?
    )
  `).run(userId, userId, MAX_SESSIONS_PER_USER);
}

export function cleanupExpiredSessions() {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes);
}

const sweeper = setInterval(() => {
  try { cleanupExpiredSessions(); } catch { /* db mungkin sedang ditutup */ }
}, 3600 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();
try { cleanupExpiredSessions(); } catch { /* abaikan */ }

export function sessionUser(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.name, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(sha(token), Date.now());
  return row ? { ...row, token } : null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(String(token)));
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}