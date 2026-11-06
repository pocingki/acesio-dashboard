// Fase 5: API WhatsApp tiruan, bot (pesan masuk), dan workflow harian dalam satu lingkungan tes.
// Tidak ada panggilan ke jaringan sungguhan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';

const DAY = '2026-11-06';
const SOAP = 'SOAP-RAHASIA-FASE5';
const MEDICAL = 'CATATAN-AWAL-RAHASIA';
const BOT_KEY = 'kunci-fase5-bot-0001';
const WA_KEY = `amk_fase5ab.${'k'.repeat(43)}`;
const PASS = 'Rahasia-Tes-123';

const gate = { mode: 'ok' };
const seen = [];
const hanging = new Set();
const wa = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const send = (code, obj) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${WA_KEY}`) return send(401, { error: 'API key salah', code: 'UNAUTHORIZED' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/ping') {
      return send(200, { ok: true, brand: 'Klinik Fase 5', app: { scopes: ['leads:write', 'events:write', 'messages:send'] }, wa: { status: 'connected' } });
    }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
    seen.push({ method: req.method, path: url.pathname, body, idem: req.headers['idempotency-key'] || '' });
    if (gate.mode === 'hang') { hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
    if (gate.mode === '400') return send(400, { error: 'data tidak valid', code: 'VALIDATION' });
    if (gate.mode === '401') return send(401, { error: 'kunci dicabut', code: 'UNAUTHORIZED' });
    if (gate.mode === '403') return send(403, { error: 'tidak boleh', code: 'FORBIDDEN' });
    if (gate.mode === '403block') return send(403, { error: 'nomor diblokir', code: 'BLOCKED' });
    if (gate.mode === '500') return send(500, { error: 'rusak', code: 'SERVER' });
    if (gate.mode === 'down') { res.destroy(); return; }
    return send(200, { ok: true });
  });
});
await new Promise((r) => wa.listen(0, '127.0.0.1', r));
const WA_URL = `http://127.0.0.1:${wa.address().port}`;
const code = `AMN1.${Buffer.from(JSON.stringify({ u: WA_URL, k: WA_KEY })).toString('base64url')}`;

let srv; let sv; let adm; let therapist; let therapistId; let clockFile; let dbPath;
const post = (p, body, who = sv, method = 'POST', headers) => srv.call(p, { method, body, cookie: who?.cookie, headers });
const bot = (path, { method = 'GET', body, key = BOT_KEY, headers = {} } = {}) => srv.call(path, {
  method, body, headers: { 'X-API-Key': key, ...headers },
});
const state = async () => (await srv.call('/api/sv/integration', { cookie: sv.cookie })).json;
const waitFor = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('waktu habis menunggu kondisi');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const openDb = () => new DatabaseSync(dbPath, { readOnly: true });
const outbox = () => {
  const db = openDb();
  try { return db.prepare('SELECT id, status, attempts, last_error, phone, payload, thanks FROM integration_outbox ORDER BY id').all(); }
  finally { db.close(); }
};
const recordCount = () => {
  const db = openDb();
  try { return db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(commission), 0) AS commission FROM records').get(); }
  finally { db.close(); }
};
const releaseDue = () => {
  const db = new DatabaseSync(dbPath);
  try { db.prepare("UPDATE integration_outbox SET next_at = 0 WHERE status = 'pending'").run(); }
  finally { db.close(); }
};
const setNow = (hhmm) => fs.writeFileSync(clockFile, `${DAY}T${hhmm}:00+07:00`);

async function customer(rm, { name = 'Siti Aminah', phone = '081234567801' } = {}) {
  const r = await post('/api/staff/customers', { rm_no: rm, name, phone, medical_note: MEDICAL });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}

async function task({ rm, serviceIds = [1], start = '09:00', end = '09:01' }) {
  return createVisit(srv, sv.cookie, {
    userId: therapistId, customerRm: rm, serviceIds, day: DAY, startTime: start, endTime: end,
  });
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-fase5-'));
  clockFile = path.join(dir, 'now.txt');
  setNow('09:00');
  srv = await startServer({
    env: {
      NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SESSION_TIMER: undefined, SESSION_MINUTES: '30',
      BOT_API_KEY: BOT_KEY,
    },
  });
  dbPath = path.join(srv.dataDir, 'acesio.db');
  sv = await srv.login();
  const admin = await post('/api/sv/accounts', { username: 'adm1', name: 'Admin Satu', password: PASS, role: 'admin' });
  assert.equal(admin.status, 200, admin.text);
  adm = await srv.login('adm1', PASS);
  const user = await post('/api/sv/accounts', { username: 'budi', name: 'Budi Santoso', password: PASS, role: 'user' });
  assert.equal(user.status, 200, user.text);
  therapistId = user.json.id;
  therapist = await srv.login('budi', PASS);
  assert.equal((await post('/api/sv/services/1', { name: 'Fisioterapi' }, sv, 'PATCH')).status, 200);
  const comm = await post(`/api/sv/commissions/${therapistId}`, { amounts: { 1: 25000 } }, sv, 'PUT');
  assert.equal(comm.status, 200, comm.text);
});

after(async () => {
  for (const res of hanging) res.destroy();
  await srv?.stop();
  wa.close();
});

test('login menolak password salah dan membatasi peran', async () => {
  assert.equal((await srv.call('/api/auth/login', { method: 'POST', body: { username: 'budi', password: 'salah-sekali' } })).status, 401);
  assert.equal((await srv.call('/api/auth/me', { cookie: therapist.cookie })).json.user.role, 'user');
  assert.equal((await srv.call('/api/sv/integration', { cookie: adm.cookie })).status, 403);
  assert.equal((await srv.call('/api/sv/integration', { cookie: therapist.cookie })).status, 403);
  assert.equal((await srv.call('/api/sv/integration')).status, 401);
});

test('sambungan API: kunci salah ditolak, sambungan benar tersimpan tanpa membocorkan kunci', async () => {
  const bad = await post('/api/sv/integration/connect', { code: WA_KEY, url: WA_URL.replace(WA_KEY, '') && 'http://127.0.0.1:1' });
  assert.equal(bad.status, 400);
  const ok = await post('/api/sv/integration/connect', { code });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.connected, true);
  assert.equal(ok.json.brand, 'Klinik Fase 5');
  assert.ok(!ok.text.includes(WA_KEY.slice(-12)), 'kunci bocor ke respons');
  const on = await post('/api/sv/integration', { enabled: true, send_visit: true, send_thanks: true, thanks_text: 'Halo {nama}, terima kasih.' }, sv, 'PUT');
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.send_thanks, true);
  assert.equal(on.json.thanks_text, 'Halo {nama}, terima kasih.');
  const audit = await srv.call('/api/sv/audit?action=integration.connect', { cookie: sv.cookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.json.rows.some((a) => a.action === 'integration.connect'));
  assert.ok(!audit.text.includes(WA_KEY.slice(-12)));
});

test('workflow harian: jadwal, SOAP gagal di tengah, dua approve terpisah, komisi, laporan, WhatsApp tanpa SOAP', async () => {
  seen.length = 0;
  gate.mode = 'ok';
  const id = await customer('RM-F5-1');
  const sch = await task({ rm: 'RM-F5-1' });
  const edited = await post(`/api/staff/schedules/${sch.id}`, { note: 'datang pagi' }, sv, 'PATCH');
  assert.equal(edited.status, 200, edited.text);
  const mine = await srv.call('/api/my/schedules', { cookie: therapist.cookie });
  assert.ok(mine.json.schedules.some((s) => s.id === sch.id));

  assert.equal((await post(`/api/my/schedules/${sch.id}/start`, {}, therapist)).status, 200);
  const badSoap = await post('/api/records', { schedule_id: sch.id, soap: { s: '', o: 'x', a: 'y', p: 'z' } }, therapist);
  assert.equal(badSoap.status, 400);
  assert.equal(recordCount().n, 0);
  assert.equal(seen.length, 0, 'SOAP gagal tidak boleh mengirim WhatsApp');

  const saved = await post('/api/records', { schedule_id: sch.id, soap: { ...VALID_SOAP, s: SOAP } }, therapist);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(recordCount().n, 0, 'SOAP belum mencatat komisi sebelum approve tugas');
  const early = await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv);
  assert.equal(early.status, 409, 'approve tugas ditolak selama hitung mundur');

  const review = await post('/api/staff/reviews', { user_id: therapistId, day: DAY, late: false }, adm);
  assert.equal(review.status, 200, review.text);
  assert.equal(recordCount().n, 0, 'approve ketepatan waktu tidak mencatat komisi');

  setNow('09:05');
  const approved = await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.schedule.status, 'selesai');
  const stats = recordCount();
  assert.equal(stats.n, 1);
  assert.equal(stats.commission, 25000);
  const changed = await post('/api/staff/reviews', { user_id: therapistId, day: DAY, late: true }, sv);
  assert.equal(changed.status, 200, changed.text);
  assert.equal(recordCount().n, 1, 'ubah ketepatan waktu tidak menambah transaksi');

  await waitFor(() => seen.filter((x) => x.path === '/api/v1/messages').length === 1);
  const contact = seen.find((x) => x.path.startsWith('/api/v1/contacts/'));
  const event = seen.find((x) => x.path === '/api/v1/events');
  const msg = seen.find((x) => x.path === '/api/v1/messages');
  assert.equal(contact.path, '/api/v1/contacts/6281234567801');
  assert.equal(contact.body.name, 'Siti Aminah');
  assert.equal(contact.body.data.rmNo, 'RM-F5-1');
  assert.equal(contact.body.data.visits, 1);
  assert.equal(event.body.phone, '6281234567801');
  assert.equal(event.body.type, 'acesio.visit_recorded');
  assert.equal(msg.body.phone, '6281234567801');
  assert.equal(msg.body.text, 'Halo Siti Aminah, terima kasih.');
  assert.ok(contact.idem && event.idem && msg.idem);
  const blob = JSON.stringify(seen) + JSON.stringify(outbox());
  assert.ok(!blob.includes(SOAP) && !blob.includes(MEDICAL), 'SOAP bocor ke WhatsApp atau antrean');

  const summary = await srv.call(`/api/staff/summary?from=${DAY}&to=${DAY}`, { cookie: sv.cookie });
  assert.equal(summary.json.summary.services, 1);
  assert.equal(summary.json.summary.customers, 1);
  assert.equal(summary.json.summary.commission, 25000);
  assert.equal(summary.json.attendance.late, 1);
  const detail = await srv.call(`/api/staff/customers/${id}/visits`, { cookie: sv.cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.visits.length, 1);
  assert.deepEqual(detail.json.visits[0].services, ['Fisioterapi']);
  const listed = await srv.call('/api/staff/customers?q=RM-F5-1', { cookie: sv.cookie });
  assert.ok(listed.text.includes('Siti Aminah'));
  const again = await srv.call('/api/sv/integration', { cookie: sv.cookie });
  assert.equal(again.json.thanks_text, 'Halo {nama}, terima kasih.');
  const log = await srv.call('/api/sv/audit?action=schedule.approve', { cookie: sv.cookie });
  assert.equal(log.status, 200);
  assert.ok(!log.text.includes(SOAP));
});

test('pesan masuk lewat API bot: nomor dikenali, pesan tidak valid ditolak, pesan yang sama tidak dobel, SOAP tidak ikut', async () => {
  const found = await bot('/api/bot/customers?phone=081234567801');
  assert.equal(found.status, 200, found.text);
  assert.equal(found.json.customers.length, 1);
  assert.equal(found.json.customers[0].rm_no, 'RM-F5-1');
  assert.ok(!found.text.includes(MEDICAL));
  const badPhone = await bot('/api/bot/customers?phone=123');
  assert.equal(badPhone.status, 400);
  const noKey = await bot('/api/bot/services', { key: '' });
  assert.equal(noKey.status, 401);
  assert.ok(!noKey.text.includes(BOT_KEY));
  const wrong = await bot('/api/bot/services', { key: 'bukan-kunci' });
  assert.equal(wrong.status, 401);
  const missing = await bot('/api/bot/records', { method: 'POST', body: { username: 'budi', customer_rm: 'RM-F5-1', service_ids: [1] } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'REQUEST_ID_REQUIRED');
  const unknown = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-TIDAK-ADA', service_ids: [1], request_id: 'pesan-tidak-ada' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(recordCount().n, 1);
  const before = recordCount();
  const first = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-2', service_ids: [1], request_id: 'pesan-masuk-01' },
  });
  assert.equal(first.status, 404);
  assert.equal(recordCount().n, before.n);
  await customer('RM-F5-2', { name: 'Budi Pelanggan', phone: '081234567802' });
  const locked = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-2', service_ids: [1], request_id: 'pesan-terkunci-01' },
  });
  assert.equal(locked.status, 409);
  assert.match(locked.json.error, /dikunci/);
  assert.equal(recordCount().n, before.n);
  assert.equal((await srv.call(`/api/sv/reviews?user_id=${therapistId}&day=${DAY}`, { method: 'DELETE', cookie: sv.cookie })).status, 200);
  const real = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-2', service_ids: [1], request_id: 'pesan-masuk-02' },
  });
  assert.equal(real.status, 200, real.text);
  const replay = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-2', service_ids: [1], request_id: 'pesan-masuk-02' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(recordCount().n, before.n + 1);
  const hist = await bot(`/api/bot/customers/${real.json.customer.id}/history`);
  assert.equal(hist.status, 200);
  assert.ok(!hist.text.includes(SOAP) && !hist.text.includes(MEDICAL));
  assert.equal((await srv.call('/api/webhook', { method: 'POST', body: { text: 'halo' } })).status, 404);
});

test('bot pada jadwal yang sama tidak menambah komisi kedua, approve sesudahnya juga tidak', async () => {
  const before = recordCount();
  const sch = await task({ rm: 'RM-F5-1', start: '11:00', end: '11:01' });
  const hit = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-1', service_ids: [1], schedule_id: sch.id, request_id: 'bot-jadwal-01' },
  });
  assert.equal(hit.status, 200, hit.text);
  const again = await bot('/api/bot/records', {
    method: 'POST',
    body: { username: 'budi', customer_rm: 'RM-F5-1', service_ids: [1], schedule_id: sch.id, request_id: 'bot-jadwal-02' },
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(recordCount().n, before.n + 1);
  assert.equal((await post(`/api/my/schedules/${sch.id}/start`, {}, therapist)).status, 200);
  assert.equal((await post('/api/records', { schedule_id: sch.id, soap: VALID_SOAP }, therapist)).status, 200);
  setNow('11:05');
  const approved = await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.schedule.status, 'selesai');
  assert.equal(recordCount().n, before.n + 1);
  assert.equal(recordCount().commission, before.commission + 25000);
});

test('API 400 dicatat gagal tetap; 403 blokir dilewati; 500 diulang tanpa dobel; 401 menolak akses', async () => {
  gate.mode = '400';
  seen.length = 0;
  await customer('RM-F5-400', { name: 'Empat Ratus', phone: '081234567803' });
  const sch = await task({ rm: 'RM-F5-400', start: '13:00', end: '13:01' });
  assert.equal((await post(`/api/my/schedules/${sch.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch.id, soap: VALID_SOAP }, therapist);
  setNow('13:05');
  const approved = await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv);
  assert.equal(approved.status, 200, 'pencatatan tidak gagal saat WhatsApp menolak');
  const failed = await waitFor(() => {
    const row = outbox().find((r) => r.phone === '6281234567803');
    return row?.status === 'failed' ? row : null;
  });
  assert.match(failed.last_error, /tidak valid/);
  const idem = seen.find((x) => x.path.startsWith('/api/v1/contacts/'))?.idem;
  assert.ok(idem);
  seen.length = 0;
  gate.mode = 'ok';
  const retry = await post('/api/sv/integration/retry', {});
  assert.equal(retry.status, 200);
  await waitFor(() => seen.some((x) => x.idem === idem));
  assert.equal(outbox().filter((r) => r.phone === '6281234567803').length, 1, 'retry tidak membuat antrean baru');

  gate.mode = '403block';
  seen.length = 0;
  await customer('RM-F5-403', { name: 'Diblokir', phone: '081234567804' });
  const sch2 = await task({ rm: 'RM-F5-403', start: '14:00', end: '14:01' });
  assert.equal((await post(`/api/my/schedules/${sch2.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch2.id, soap: VALID_SOAP }, therapist);
  setNow('14:05');
  assert.equal((await post(`/api/staff/schedules/${sch2.id}/approve`, {}, sv)).status, 200);
  const skipped = await waitFor(() => {
    const row = outbox().find((r) => r.phone === '6281234567804');
    return row?.status === 'skipped' ? row : null;
  });
  assert.match(skipped.last_error, /diblokir/);

  gate.mode = '500';
  seen.length = 0;
  await customer('RM-F5-500', { name: 'Lima Ratus', phone: '081234567805' });
  const sch3 = await task({ rm: 'RM-F5-500', start: '15:00', end: '15:01' });
  assert.equal((await post(`/api/my/schedules/${sch3.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch3.id, soap: VALID_SOAP }, therapist);
  setNow('15:05');
  assert.equal((await post(`/api/staff/schedules/${sch3.id}/approve`, {}, sv)).status, 200);
  const pending = await waitFor(() => {
    const row = outbox().find((r) => r.phone === '6281234567805');
    return row?.status === 'pending' && row.attempts >= 1 ? row : null;
  });
  assert.match(pending.last_error, /bermasalah/);
  gate.mode = 'ok';
  releaseDue();
  await waitFor(() => outbox().find((r) => r.phone === '6281234567805' && r.status === 'sent'));
  const keys = seen.filter((x) => x.path.startsWith('/api/v1/contacts/6281234567805')).map((x) => x.idem);
  assert.equal(new Set(keys).size, 1, 'pengiriman ulang memakai kunci yang sama');

  gate.mode = '401';
  seen.length = 0;
  await customer('RM-F5-401', { name: 'Tak Berhak', phone: '081234567806' });
  const sch4 = await task({ rm: 'RM-F5-401', start: '16:00', end: '16:01' });
  assert.equal((await post(`/api/my/schedules/${sch4.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch4.id, soap: VALID_SOAP }, therapist);
  setNow('16:05');
  assert.equal((await post(`/api/staff/schedules/${sch4.id}/approve`, {}, sv)).status, 200);
  const denied = await waitFor(() => {
    const row = outbox().find((r) => r.phone === '6281234567806');
    return row?.attempts >= 1 ? row : null;
  });
  assert.match(denied.last_error, /ditolak|Kunci/);
  const live = await state();
  assert.match(live.last_error, /ditolak|Kunci/);
  gate.mode = 'ok';
});

test('timeout dan server mati tidak menggagalkan pencatatan dan tidak membekukan API', async () => {
  const hold = new DatabaseSync(dbPath);
  try { hold.prepare("UPDATE integration_outbox SET next_at = ? WHERE status = 'pending'").run(Date.now() + 86_400_000); }
  finally { hold.close(); }
  gate.mode = 'hang';
  seen.length = 0;
  await customer('RM-F5-TO', { name: 'Waktu Habis', phone: '081234567807' });
  const sch = await task({ rm: 'RM-F5-TO', start: '17:00', end: '17:01' });
  assert.equal((await post(`/api/my/schedules/${sch.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch.id, soap: VALID_SOAP }, therapist);
  setNow('17:05');
  const t0 = Date.now();
  const approved = await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv);
  assert.equal(approved.status, 200, approved.text);
  assert.ok(Date.now() - t0 < 3000, 'approve tidak menunggu WhatsApp');
  const still = await srv.call('/api/auth/me', { cookie: sv.cookie });
  assert.equal(still.status, 200);
  const row = await waitFor(() => {
    const r = outbox().find((x) => x.phone === '6281234567807');
    return r?.attempts >= 1 ? r : null;
  }, 15000);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /tidak bisa dijangkau/);
  assert.equal(recordCount().n > 0, true);

  gate.mode = 'down';
  releaseDue();
  const again = await waitFor(() => {
    const r = outbox().find((x) => x.phone === '6281234567807');
    return r?.attempts >= 2 ? r : null;
  }, 12000);
  assert.equal(again.status, 'pending');
  assert.match(again.last_error, /tidak bisa dijangkau/);
  gate.mode = 'ok';
});

test('nomor tidak valid tidak dikirim; ucapan kosong ditolak sebelum disimpan', async () => {
  gate.mode = 'ok';
  const before = seen.length;
  await customer('RM-F5-NOPHONE', { name: 'Tanpa Nomor', phone: '' });
  const sch = await task({ rm: 'RM-F5-NOPHONE', start: '18:00', end: '18:01' });
  assert.equal((await post(`/api/my/schedules/${sch.id}/start`, {}, therapist)).status, 200);
  await post('/api/records', { schedule_id: sch.id, soap: VALID_SOAP }, therapist);
  setNow('18:05');
  assert.equal((await post(`/api/staff/schedules/${sch.id}/approve`, {}, sv)).status, 200);
  const row = await waitFor(() => outbox().find((r) => {
    try { return JSON.parse(r.payload).name === 'Tanpa Nomor'; } catch { return false; }
  }));
  assert.equal(row.status, 'skipped');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(seen.length, before);
  const bad = await post('/api/sv/integration', { thanks_text: '' }, sv, 'PUT');
  assert.equal(bad.status, 400);
  assert.equal((await state()).thanks_text, 'Halo {nama}, terima kasih.');
});
