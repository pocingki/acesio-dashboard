// Ketepatan waktu (day_reviews) dan penyelesaian tugas (approve jadwal) berdiri sendiri.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const DAY = '2026-04-02';
const BOT_KEY = 'kunci-uji-bot-approve-01';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+07:00`).toISOString();

let srv; let sdb; let clockDir; let clockFile;
let uBudi; let uSari;
const cookies = {};
const setNow = (hhmm) => fs.writeFileSync(clockFile, at(hhmm));
const api = (who, method, url, body, headers) => srv.call(url, {
  method, body: body === undefined && method !== 'GET' ? {} : body, cookie: who ? cookies[who] : undefined, headers,
});
const one = (q, ...a) => sdb.prepare(q).get(...a);
const mk = (over = {}) => createVisit(srv, cookies.adm, { userId: uBudi, customerId: cust, day: DAY, startTime: '09:00', endTime: '09:30', ...over });
let cust;

async function ready(who, userId, serviceIds) {
  const s = await mk({ userId, serviceIds });
  assert.equal((await api(who, 'POST', `/api/my/schedules/${s.id}/start`)).status, 200);
  assert.equal((await api(who, 'POST', '/api/records', { schedule_id: s.id, soap: VALID_SOAP })).status, 200);
  return s.id;
}

before(async () => {
  clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-approve-'));
  clockFile = path.join(clockDir, 'now.txt');
  setNow('09:00');
  srv = await startServer({
    env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SESSION_TIMER: undefined, SESSION_MINUTES: '30', BOT_API_KEY: BOT_KEY },
  });
  cookies.sv = (await srv.login()).cookie;
  const mkAcc = async (username, role, name) => {
    const r = await api('sv', 'POST', '/api/sv/accounts', { username, name, password: PASS, role });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  await mkAcc('adm1', 'admin', 'Admin Satu');
  uBudi = await mkAcc('budi', 'user', 'Budi');
  uSari = await mkAcc('sari', 'user', 'Sari');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  cookies.sari = (await srv.login('sari', PASS)).cookie;
  const c = await api('adm', 'POST', '/api/staff/customers', { rm_no: 'RM-APR', name: 'Rina', phone: '081234567890' });
  assert.equal(c.status, 200, c.text);
  cust = c.json.id;
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  sdb.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, 1, 25000), (?, 2, 30000)').run(uBudi, uBudi);
  sdb.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, 1, 15000)').run(uSari);
});

after(async () => { sdb?.close(); await srv.stop(); fs.rmSync(clockDir, { recursive: true, force: true }); });

const reviewOf = (userId) => one('SELECT late FROM day_reviews WHERE user_id = ? AND day = ?', userId, DAY);
const commissionOf = (userId) => one('SELECT COALESCE(SUM(commission), 0) AS n, COUNT(*) AS rows FROM records WHERE user_id = ? AND day = ?', userId, DAY);
const statusOf = (id) => one('SELECT status FROM schedules WHERE id = ?', id).status;

test('ketepatan waktu dulu: tugas tetap bisa di-approve, komisi sekali, status kehadiran tidak berubah', async () => {
  setNow('09:00');
  const id = await ready('budi', uBudi, [1]);
  setNow('09:30');
  assert.equal(commissionOf(uBudi).rows, 0);

  const detailBefore = await api('adm', 'GET', `/api/staff/users/${uBudi}/detail?day=${DAY}`);
  assert.equal(detailBefore.status, 200, detailBefore.text);
  assert.equal(detailBefore.json.review, null);
  assert.ok(detailBefore.json.days.some((d) => d.day === DAY));

  const review = await api('adm', 'POST', '/api/staff/reviews', { user_id: uBudi, day: DAY, late: false });
  assert.equal(review.status, 200, review.text);
  assert.equal(statusOf(id), 'berjalan');
  assert.equal((await api('budi', 'GET', `/api/my/schedules/${id}`)).json.schedule.phase, 'menunggu');

  const ok = await api('adm', 'POST', `/api/staff/schedules/${id}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.schedule.status, 'selesai');
  assert.equal(commissionOf(uBudi).rows, 1);
  assert.equal(commissionOf(uBudi).n, 25000);
  assert.equal(reviewOf(uBudi).late, 0);
  assert.equal(one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule.approve' AND target_id = ?", String(id)).n, 1);
  assert.equal(one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'review.approve' AND target_id = ?", String(uBudi)).n, 1);

  const again = await api('adm', 'POST', `/api/staff/schedules/${id}/approve`);
  assert.equal(again.status, 409, again.text);
  assert.equal(commissionOf(uBudi).rows, 1);

  const bot = await api(null, 'POST', '/api/bot/records', {
    username: 'budi', customer_rm: 'RM-APR', service_ids: [1], request_id: 'bot-setelah-hadir',
  }, { 'X-API-Key': BOT_KEY });
  assert.equal(bot.status, 409, bot.text);
  assert.equal(commissionOf(uBudi).rows, 1);

  const fresh = await api('adm', 'GET', `/api/staff/users/${uBudi}/detail?day=${DAY}`);
  assert.equal(fresh.json.review.late, 0);
  assert.equal(fresh.json.records.length, 1);
  assert.equal((await api('adm', 'GET', `/api/staff/schedules/${id}`)).json.schedule.status, 'selesai');
});

test('tugas dulu: ketepatan waktu tetap bisa di-approve dan tidak menambah komisi', async () => {
  setNow('10:00');
  const id = await ready('sari', uSari, [1]);
  setNow('10:30');
  const ok = await api('adm', 'POST', `/api/staff/schedules/${id}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(commissionOf(uSari).n, 15000);

  const review = await api('sv', 'POST', '/api/staff/reviews', { user_id: uSari, day: DAY, late: true });
  assert.equal(review.status, 200, review.text);
  assert.equal(statusOf(id), 'selesai');
  assert.equal(commissionOf(uSari).rows, 1);
  assert.equal(reviewOf(uSari).late, 1);
  assert.equal((await api('adm', 'GET', `/api/staff/schedules/${id}`)).json.schedule.status, 'selesai');
});

test('dua tugas menunggu: keduanya bisa diproses, batal salah satu tidak mengubah yang lain', async () => {
  setNow('11:00');
  const keep = await ready('budi', uBudi, [2]);
  const drop = await ready('budi', uBudi, [2]);
  setNow('11:30');
  assert.equal((await api('budi', 'GET', `/api/my/schedules/${keep}`)).json.schedule.phase, 'menunggu');
  assert.equal((await api('budi', 'GET', `/api/my/schedules/${drop}`)).json.schedule.phase, 'menunggu');

  const before = commissionOf(uBudi).n;
  const done = await api('adm', 'POST', `/api/staff/schedules/${keep}/approve`);
  assert.equal(done.status, 200, done.text);
  assert.equal(commissionOf(uBudi).n, before + 30000);
  assert.equal(reviewOf(uBudi).late, 0, 'approve tugas tidak mengubah ketepatan waktu');

  const cancel = await api('sv', 'POST', `/api/staff/schedules/${drop}/cancel`);
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(statusOf(drop), 'batal');
  assert.equal(statusOf(keep), 'selesai');
  assert.equal(reviewOf(uBudi).late, 0);
  assert.equal(commissionOf(uBudi).n, before + 30000);

  const late = await api('adm', 'POST', `/api/staff/schedules/${drop}/approve`);
  assert.equal(late.status, 409);
  assert.equal(commissionOf(uBudi).n, before + 30000);
});

test('tanpa jadwal dan tanpa data, ketepatan waktu ditolak', async () => {
  const r = await api('adm', 'POST', '/api/staff/reviews', { user_id: uSari, day: '2026-04-03', late: false });
  assert.equal(r.status, 400, r.text);
});
