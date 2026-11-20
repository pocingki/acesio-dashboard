// Menu Integrasi (khusus supervisor): sambungkan Acesio ke WhatsApp, pilih yang dikirim, nyalakan.
// Kunci akses tidak pernah dikembalikan ke browser; yang tampil hanya petunjuk samar (amk_xxxx.••••).
import { add } from './index.js';
import { HttpError } from '../util.js';
import { clientIp } from '../auth.js';
import { logAudit } from '../audit.js';
import * as I from '../integration.js';
import { bookingConfig, saveBookingConfig } from '../booking.js';

const audit = (req, user, action, detail = {}) => logAudit({
  actor: { id: user.id, name: user.name }, action, targetType: 'integration', targetId: 'amnan', detail, ip: clientIp(req),
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

add('GET', '/api/sv/integration', 'sv', () => I.state());

add('POST', '/api/sv/integration/connect', 'sv', async ({ req, user, body }) => {
  if (!isObj(body)) throw new HttpError(400, 'Data tidak valid');
  const r = await I.connect({ code: body.code, url: body.url, key: body.key });
  audit(req, user, 'integration.connect', { brand: r.brand });
  return I.state();
}, { limit: 16 * 1024 });

add('POST', '/api/sv/integration/test', 'sv', async () => {
  const test = await I.retest();
  return { ...I.state(), test };
});

add('PUT', '/api/sv/integration', 'sv', ({ req, user, body }) => {
  if (!isObj(body)) throw new HttpError(400, 'Data tidak valid');
  const changed = I.update({ enabled: body.enabled, send_visit: body.send_visit, send_thanks: body.send_thanks, thanks_text: body.thanks_text });
  if (changed.length) audit(req, user, 'integration.update', Object.fromEntries(changed.map((k) => [k, k === 'thanks_text' ? '(diubah)' : body[k]])));
  return I.state();
}, { limit: 16 * 1024 });

add('POST', '/api/sv/integration/retry', 'sv', ({ req, user }) => {
  const n = I.retryFailed();
  if (n) audit(req, user, 'integration.retry', { count: n });
  return I.state();
});

add('POST', '/api/sv/integration/disconnect', 'sv', ({ req, user }) => {
  I.disconnect();
  audit(req, user, 'integration.disconnect');
  return I.state();
});

// Kunci untuk server WhatsApp: dibuat/diganti/dicabut dari dashboard. Kunci utuh hanya ada di respons pembuatan.
add('POST', '/api/sv/integration/bot-key', 'sv', ({ req, user }) => {
  const key = I.createBotKey();
  audit(req, user, 'integration.bot_key.create');
  return { ...I.state(), new_bot_key: key };
});

add('POST', '/api/sv/integration/bot-key/revoke', 'sv', ({ req, user }) => {
  I.revokeBotKey();
  audit(req, user, 'integration.bot_key.revoke');
  return I.state();
});

// Jam layanan untuk slot booking WhatsApp (diatur di dashboard, tanpa menyunting .env).
add('GET', '/api/sv/booking-hours', 'sv', () => bookingConfig());
add('PUT', '/api/sv/booking-hours', 'sv', ({ req, user, body }) => {
  if (!isObj(body)) throw new HttpError(400, 'Data tidak valid');
  const cfg = saveBookingConfig({ from: body.from, to: body.to, step: body.step });
  audit(req, user, 'integration.update', { booking_hours: `${cfg.from}-${cfg.to}/${cfg.step}` });
  return cfg;
}, { limit: 4 * 1024 });
