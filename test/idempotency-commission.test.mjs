// Satu aktivitas — bot, webhook ulang, atau penyelesaian jadwal — hanya satu komisi.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const BOT_KEY = 'kunci-uji-bot-idem-01';
const DAY = '2026-05-04';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+07:00`).toISOString();

let srv; let sdb; let uBudi; let cust;
const cookies = {};
const api = (who, method, url, body, headers) => srv.call(url, {
  method, body: body === undefined && method !== 'GET' ? {} : body, cookie: who ? cookies[who] : undefined, headers,
});
const one = (q, ...a) => sdb.prepare(q).get(...a);
const stats = () => one('SELECT COUNT(*) AS rows, COALESCE(SUM(commission), 0) AS commission FROM records WHERE user_id = ?', uBudi);
const bot = (body, headers = {}) => api(null, 'POST', '/api/bot/records', {
  username: 'budi', customer_rm: 'RM-IDEM', service_ids: [1, 2], ...body,
}, { 'X-API-Key': BOT_KEY, ...headers });

describe('idempotensi komisi bot dan jadwal', { concurrency: 1 }, () => {
before(async () => {
  srv = await startServer({ env: { BOT_API_KEY: BOT_KEY } });
  cookies.sv = (await srv.login()).cookie;
  const acc = await api('sv', 'POST', '/api/sv/accounts', { username: 'budi', name: 'Budi', password: PASS, role: 'user' });
  assert.equal(acc.status, 200, acc.text);
  uBudi = acc.json.id;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  const c = await api('sv', 'POST', '/api/staff/customers', { rm_no: 'RM-IDEM', name: 'Rina', phone: '081234567890' });
  assert.equal(c.status, 200, c.text);
  cust = c.json.id;
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  sdb.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, 1, 25000), (?, 2, 30000)').run(uBudi, uBudi);
});

after(async () => { sdb?.close(); await srv?.stop(); });

test('permintaan baru tercatat sekali, pengiriman ulang dan webhook kedua tidak menggandakan', async () => {
  const before = stats();
  const first = await bot({ request_id: 'webhook-sekali-01' });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.count, 2);
  assert.equal(first.headers.get('idempotent-replay'), null);
  const retry = await bot({ request_id: 'webhook-sekali-01' });
  const again = await bot({ request_id: 'webhook-sekali-01' });
  assert.equal(retry.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(again.json, first.json);
  assert.equal(stats().rows, before.rows + 2);
  assert.equal(stats().commission, before.commission + 55000);
});

test('tanpa request_id ditolak dan tidak mencatat', async () => {
  const before = stats();
  const missing = await bot({});
  assert.equal(missing.status, 400, missing.text);
  assert.equal(missing.json.code, 'REQUEST_ID_REQUIRED');
  assert.deepEqual(stats(), before);
});

test('ID sama dengan isi berbeda ditolak', async () => {
  const before = stats();
  const ok = await bot({ request_id: 'konflik-isi-0001', service_ids: [1] });
  assert.equal(ok.status, 200, ok.text);
  const clash = await bot({ request_id: 'konflik-isi-0001', service_ids: [2] });
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(stats().rows, before.rows + 1);
  assert.equal(stats().commission, before.commission + 25000);
});

test('dua permintaan identik bersamaan hanya menghasilkan satu pencatatan', async () => {
  const before = stats();
  const body = { request_id: 'bersamaan-0001' };
  const [a, b] = await Promise.all([bot(body), bot(body)]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(a.json.record_ids, b.json.record_ids);
  assert.equal([a, b].filter((r) => r.headers.get('idempotent-replay') === 'true').length, 1);
  assert.equal(stats().rows, before.rows + 2);
});

test('dua request_id berbeda untuk jadwal yang sama, datang bersamaan, tetap satu komisi', async () => {
  const visit = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1, 2] });
  const before = stats();
  const [a, b] = await Promise.all([
    bot({ request_id: 'race-jadwal-a01', schedule_id: visit.id }),
    bot({ request_id: 'race-jadwal-b01', schedule_id: visit.id }),
  ]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual([...a.json.record_ids].sort((x, y) => x - y), [...b.json.record_ids].sort((x, y) => x - y));
  assert.equal(stats().rows, before.rows + 2);
  assert.equal(stats().commission, before.commission + 55000);
});

test('proses gagal lalu dicoba ulang tidak meninggalkan komisi separuh', async () => {
  const before = stats();
  sdb.prepare('UPDATE services SET active = 0 WHERE id = 2').run();
  const fail = await bot({ request_id: 'gagal-lalu-ulang' });
  assert.equal(fail.status, 400, fail.text);
  assert.deepEqual(stats(), before);
  assert.equal(one('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?', 'gagal-lalu-ulang').n, 0);
  sdb.prepare('UPDATE services SET active = 1 WHERE id = 2').run();
  const ok = await bot({ request_id: 'gagal-lalu-ulang' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(stats().rows, before.rows + 2);
  const replay = await bot({ request_id: 'gagal-lalu-ulang' });
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(stats().rows, before.rows + 2);
});

test('bot lalu jadwal, dan jadwal lalu bot, untuk schedule yang sama hanya satu komisi', async () => {
  const visitA = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1, 2] });
  const before = stats();
  const posted = await bot({ request_id: 'bot-dulu-jadwal', schedule_id: visitA.id });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(stats().rows, before.rows + 2);
  const done = await api('budi', 'POST', '/api/records', { schedule_id: visitA.id, soap: VALID_SOAP });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.schedule.status, 'selesai');
  assert.equal(stats().rows, before.rows + 2);
  assert.equal(stats().commission, before.commission + 55000);
  const otherId = await bot({ request_id: 'bot-setelah-jadwal-lain', schedule_id: visitA.id });
  assert.equal(otherId.status, 200, otherId.text);
  assert.deepEqual(otherId.json.record_ids, posted.json.record_ids);
  assert.equal(stats().rows, before.rows + 2);

  const visitB = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1] });
  const mid = stats();
  const soap = await api('budi', 'POST', '/api/records', { schedule_id: visitB.id, soap: VALID_SOAP });
  assert.equal(soap.status, 200, soap.text);
  const afterSchedule = await bot({ request_id: 'jadwal-dulu-bot', schedule_id: visitB.id, service_ids: [1] });
  assert.equal(afterSchedule.status, 200, afterSchedule.text);
  assert.equal(stats().rows, mid.rows + 1);
  assert.equal(stats().commission, mid.commission + 25000);
});

test('dua jadwal sah pada hari yang sama tetap dua komisi', async () => {
  const before = stats();
  const a = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1] });
  const b = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1] });
  assert.equal((await bot({ request_id: 'jadwal-a-0001', schedule_id: a.id, service_ids: [1] })).status, 200);
  assert.equal((await bot({ request_id: 'jadwal-b-0001', schedule_id: b.id, service_ids: [1] })).status, 200);
  assert.equal(stats().rows, before.rows + 2);
  assert.equal(stats().commission, before.commission + 50000);
});

test('Idempotency-Key web yang sama dengan SOAP berbeda ditolak', async () => {
  const visit = await createVisit(srv, cookies.sv, { userId: uBudi, customerId: cust, serviceIds: [1] });
  const before = stats();
  const headers = { 'Idempotency-Key': 'soap-kunci-0001' };
  const ok = await api('budi', 'POST', '/api/records', { schedule_id: visit.id, soap: VALID_SOAP }, headers);
  assert.equal(ok.status, 200, ok.text);
  const clash = await api('budi', 'POST', '/api/records', {
    schedule_id: visit.id, soap: { ...VALID_SOAP, p: 'Rencana berbeda' },
  }, headers);
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(stats().rows, before.rows + 1);
});

test('approve tugas setelah bot, dan bot setelah approve, tidak menggandakan komisi', async () => {
  const clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-idem-'));
  const clockFile = path.join(clockDir, 'now.txt');
  const setNow = (hhmm) => fs.writeFileSync(clockFile, at(hhmm));
  setNow('09:00');
  const timed = await startServer({
    env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SESSION_TIMER: undefined, SESSION_MINUTES: '30', BOT_API_KEY: BOT_KEY },
  });
  const db = new DatabaseSync(path.join(timed.dataDir, 'acesio.db'));
  try {
    const sv = (await timed.login()).cookie;
    const acc = await timed.call('/api/sv/accounts', { method: 'POST', cookie: sv, body: { username: 'budi', name: 'Budi', password: PASS, role: 'user' } });
    assert.equal(acc.status, 200, acc.text);
    const userId = acc.json.id;
    const user = (await timed.login('budi', PASS)).cookie;
    const customer = await timed.call('/api/staff/customers', { method: 'POST', cookie: sv, body: { rm_no: 'RM-TMR', name: 'Rina', phone: '081111111111' } });
    assert.equal(customer.status, 200, customer.text);
    db.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, 1, 25000)').run(userId);
    const sum = () => db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(commission), 0) AS commission FROM records WHERE user_id = ?').get(userId);

    const first = await createVisit(timed, sv, { userId, customerId: customer.json.id, serviceIds: [1], day: DAY, startTime: '09:00', endTime: '09:30' });
    assert.equal((await timed.call(`/api/my/schedules/${first.id}/start`, { method: 'POST', cookie: user, body: {} })).status, 200);
    const soap = await timed.call('/api/records', { method: 'POST', cookie: user, body: { schedule_id: first.id, soap: VALID_SOAP } });
    assert.equal(soap.status, 200, soap.text);
    assert.equal(sum().rows, 0);
    const posted = await timed.call('/api/bot/records', {
      method: 'POST',
      headers: { 'X-API-Key': BOT_KEY },
      body: { username: 'budi', customer_rm: 'RM-TMR', service_ids: [1], request_id: 'bot-sebelum-approve', schedule_id: first.id },
    });
    assert.equal(posted.status, 200, posted.text);
    assert.equal(sum().rows, 1);
    assert.equal(sum().commission, 25000);
    setNow('09:30');
    const approved = await timed.call(`/api/staff/schedules/${first.id}/approve`, { method: 'POST', cookie: sv, body: {} });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.schedule.status, 'selesai');
    assert.equal(sum().rows, 1);

    const second = await createVisit(timed, sv, { userId, customerId: customer.json.id, serviceIds: [1], day: DAY, startTime: '11:00', endTime: '11:30' });
    setNow('11:00');
    assert.equal((await timed.call(`/api/my/schedules/${second.id}/start`, { method: 'POST', cookie: user, body: {} })).status, 200);
    assert.equal((await timed.call('/api/records', { method: 'POST', cookie: user, body: { schedule_id: second.id, soap: VALID_SOAP } })).status, 200);
    setNow('11:30');
    const approvedFirst = await timed.call(`/api/staff/schedules/${second.id}/approve`, { method: 'POST', cookie: sv, body: {} });
    assert.equal(approvedFirst.status, 200, approvedFirst.text);
    const after = sum();
    const follow = await timed.call('/api/bot/records', {
      method: 'POST',
      headers: { 'X-API-Key': BOT_KEY },
      body: { username: 'budi', customer_rm: 'RM-TMR', service_ids: [1], request_id: 'bot-setelah-approve', schedule_id: second.id },
    });
    assert.equal(follow.status, 200, follow.text);
    assert.equal(sum().rows, after.rows);
    assert.equal(sum().commission, after.commission);
  } finally {
    db.close();
    await timed.stop();
    fs.rmSync(clockDir, { recursive: true, force: true });
  }
});
});
