import { add, LIMITS } from './index.js';
import { db } from '../db.js';
import { HttpError, cleanName, saveDataUrlImage, removeUpload } from '../util.js';
import { login, cookieHeader, destroySession, changePassword, clientIp, isSecure } from '../auth.js';
import { accessInfo } from '../clock.js';
import { logAudit } from '../audit.js';

const tz = () => process.env.APP_TZ || 'Asia/Jakarta';
const publicUser = ({ id, username, name, role, photo }) => ({ id, username, name, role, photo: photo || null });
// Hanya role user yang punya batas jam akses (null bila ACCESS_HOURS=off).
const withAccess = (user) => (user.role === 'user' ? { access: accessInfo() } : {});

add('POST', '/api/auth/login', 'public', async ({ req, res, body }) => {
  // Throttle ada di dalam login(): melempar HttpError(429) bila terlalu banyak percobaan.
  const result = await login(String(body.username ?? ''), String(body.password ?? ''), { ip: clientIp(req) });
  if (!result) throw new HttpError(401, 'Username atau password salah');
  res.setHeader('Set-Cookie', cookieHeader(result.token, isSecure(req)));
  return { user: publicUser(result.user), tz: tz(), ...withAccess(result.user) };
}, { limit: LIMITS.login });

add('POST', '/api/auth/logout', 'user', ({ req, res, user }) => {
  destroySession(user.token);
  res.setHeader('Set-Cookie', cookieHeader('', isSecure(req)));
  return { ok: true };
});

add('GET', '/api/auth/me', 'user', ({ user }) => ({ user: publicUser(user), tz: tz(), ...withAccess(user) }));

add('POST', '/api/auth/password', 'user', async ({ req, user, body }) => {
  const next = String(body.next ?? '');
  if (next.length < 8) throw new HttpError(400, 'Password baru minimal 8 karakter');
  // Melempar HttpError(400) bila password lama salah; mencabut semua sesi lain milik user ini.
  await changePassword(user.id, String(body.current ?? ''), next, user.token);
  try {
    logAudit({
      actor: { id: user.id, name: user.name },
      action: 'auth.password_change',
      targetType: 'user',
      targetId: String(user.id),
      detail: {},
      ip: clientIp(req),
    });
  } catch (err) {
    console.error('Gagal menulis audit auth.password_change:', err);
  }
  return { ok: true };
});

// ---------- profil akun (semua peran, hanya akun sendiri) ----------
const PROFILE_COLS = 'id, username, name, role, employment, phone, email, birth_date, address, photo, created_at';
const readProfile = (id) => db.prepare(`SELECT ${PROFILE_COLS} FROM users WHERE id = ?`).get(id);

add('GET', '/api/auth/profile', 'user', ({ user }) => ({ profile: readProfile(user.id) }));

const text = (v, label, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `${label} maksimal ${max} karakter`);
  return s;
};

add('PATCH', '/api/auth/profile', 'user', ({ user, body }) => {
  const cur = readProfile(user.id);
  if (!cur) throw new HttpError(404, 'Akun tidak ditemukan');
  const has = (k) => body[k] !== undefined;
  const name = has('name') ? cleanName(body.name) : cur.name;
  if (!name) throw new HttpError(400, 'Nama wajib diisi (2–100 karakter)');
  const phone = has('phone') ? text(body.phone, 'No HP', 30) : cur.phone;
  if (phone && !/^[0-9+\-\s()]{6,30}$/.test(phone)) throw new HttpError(400, 'No HP hanya boleh angka, spasi, +, - dan tanda kurung');
  const email = has('email') ? text(body.email, 'Email', 120) : cur.email;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Format email tidak valid');
  const birth = has('birth_date') ? text(body.birth_date, 'Tanggal lahir', 10) : cur.birth_date;
  if (birth && (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(Date.parse(birth)) || birth > new Date().toISOString().slice(0, 10))) {
    throw new HttpError(400, 'Tanggal lahir tidak valid');
  }
  const address = has('address') ? String(body.address ?? '').trim().slice(0, 300) : cur.address;
  let photo = cur.photo;
  if (body.photo === null) photo = null;
  else if (typeof body.photo === 'string') photo = saveDataUrlImage(body.photo, `usr${user.id}`);
  db.prepare('UPDATE users SET name = ?, phone = ?, email = ?, birth_date = ?, address = ?, photo = ? WHERE id = ?')
    .run(name, phone, email, birth, address, photo, user.id);
  if (photo !== cur.photo) removeUpload(cur.photo);
  return { profile: readProfile(user.id) };
}, { limit: LIMITS.image });
