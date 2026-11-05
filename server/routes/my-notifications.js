import { add } from './index.js';
import { HttpError } from '../util.js';
import { requireWorker } from './helpers.js';
import { listNotifications, markRead, pruneOldNotifications } from '../notifications.js';

// Notifikasi milik user yang login (ikon lonceng). Admin/supervisor mendapat 403 (requireWorker).
// Logika ada di server/notifications.js.

// Bersih-bersih sekali saat server start (tanpa pengatur waktu). Kegagalan tidak boleh menghentikan server.
try { pruneOldNotifications(90); } catch { /* abaikan */ }

add('GET', '/api/my/notifications', 'user', ({ user, query }) => {
  requireWorker(user);
  return listNotifications(user.id, { limit: query.limit });
});

add('POST', '/api/my/notifications/read', 'user', ({ user, body }) => {
  requireWorker(user);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Kirim { ids: [...] } atau { all: true }');
  }
  if (body.all === undefined && body.ids === undefined) {
    throw new HttpError(400, 'Kirim { ids: [...] } atau { all: true }');
  }
  const unread = markRead(user.id, { ids: body.ids, all: body.all });
  return { ok: true, unread };
});
