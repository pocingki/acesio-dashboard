import { add, LIMITS } from './index.js';
import { HttpError } from '../util.js';
import { login, cookieHeader, destroySession, changePassword, clientIp, isSecure } from '../auth.js';
import { logAudit } from '../audit.js';

const tz = () => process.env.APP_TZ || 'Asia/Jakarta';
const publicUser = ({ id, username, name, role }) => ({ id, username, name, role });

add('POST', '/api/auth/login', 'public', async ({ req, res, body }) => {
  // Throttle ada di dalam login(): melempar HttpError(429) bila terlalu banyak percobaan.
  const result = await login(String(body.username ?? ''), String(body.password ?? ''), { ip: clientIp(req) });
  if (!result) throw new HttpError(401, 'Username atau password salah');
  res.setHeader('Set-Cookie', cookieHeader(result.token, isSecure(req)));
  return { user: publicUser(result.user), tz: tz() };
}, { limit: LIMITS.login });

add('POST', '/api/auth/logout', 'user', ({ req, res, user }) => {
  destroySession(user.token);
  res.setHeader('Set-Cookie', cookieHeader('', isSecure(req)));
  return { ok: true };
});

add('GET', '/api/auth/me', 'user', ({ user }) => ({ user: publicUser(user), tz: tz() }));

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
