import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_MS = (Number(process.env.SESSION_HOURS) || 12) * 3600 * 1000;
const COOKIE = 'acesio_sid';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

const DUMMY = hashPassword('dummy-password-for-timing');

export function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, keyHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY);
  if (!user || !ok || !user.active) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, Date.now() + SESSION_MS);
  return { token, user };
}

export function cookieHeader(token, secure) {
  const maxAge = token ? Math.floor(SESSION_MS / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.name, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(sha(token), Date.now());
  return row ? { ...row, token } : null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Pembatas percobaan login: 8 kali gagal / 15 menit per IP + username.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
export function loginBlocked(key) {
  const a = attempts.get(key);
  return !!a && a.until > Date.now() && a.count >= 8;
}
export function loginFailed(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { count: 1, until: now + WINDOW });
  else a.count++;
}
export function loginSucceeded(key) {
  attempts.delete(key);
}
