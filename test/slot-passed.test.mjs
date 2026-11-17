// Admin dan supervisor tidak bisa membuat jadwal untuk waktu yang sudah lewat (tanggal + jam mulai, WIB).
// Mengubah tanggal/jam ke waktu yang sudah lewat juga ditolak; mengubah catatan atau layanan jadwal lama tetap boleh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, createVisit } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const DAY = '2026-03-10';
const setAt = (day, hhmm) => fs.writeFileSync(clockFile, new Date(`${day}T${hhmm}:00+07:00`).toISOString());

let srv; let clockDir; let clockFile; let uBudi; let cust;
const cookies = {};
const api = (who, method, url, body) => srv.call(url, { method, body: body === undefined && method !== 'GET' ? {} : body, cookie: cookies[who] });
const create = (who, over = {}) => api(who, 'POST', '/api/staff/schedules', { user_id: uBudi, customer_id: cust, day: DAY, start_time: '15:00', end_time: '', note: '', service_ids: [1], ...over });

before(async () => {
  clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-slot-'));
  clockFile = path.join(clockDir, 'now.txt');
  setAt(DAY, '14:30');
  srv = await startServer({ env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SLOT_CHECK: undefined } });
  cookies.sv = (await srv.login()).cookie;
  const mkAcc = async (username, role, name) => {
    const r = await api('sv', 'POST', '/api/sv/accounts', { username, name, password: PASS, role });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  await mkAcc('adm1', 'admin', 'Admin Satu');
  uBudi = await mkAcc('budi', 'user', 'Budi');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cust = (await api('adm', 'POST', '/api/staff/customers', { rm_no: 'RM-S1', name: 'Rina' })).json.id;
});
after(async () => { await srv.stop(); fs.rmSync(clockDir, { recursive: true, force: true }); });

test('buat jadwal: jam mulai yang sudah lewat hari ini ditolak untuk admin dan supervisor', async () => {
  for (const who of ['adm', 'sv']) {
    const r = await create(who, { start_time: '14:29' });
    assert.equal(r.status, 400, `${who}: ${r.text}`);
    assert.equal(r.json.code, 'SLOT_PASSED');
    assert.match(r.json.error, /sudah lewat/);
  }
  const count = (await api('adm', 'GET', `/api/staff/schedules?from=${DAY}&to=${DAY}`)).json.schedules.length;
  assert.equal(count, 0, 'tidak ada jadwal yang terbuat');
});

test('buat jadwal: jam sekarang, nanti hari ini, dan hari mendatang diterima', async () => {
  assert.equal((await create('adm', { start_time: '14:30' })).status, 200, 'jam yang sama dengan menit sekarang masih boleh');
  assert.equal((await create('sv', { start_time: '23:59' })).status, 200);
  assert.equal((await create('adm', { day: '2026-03-11', start_time: '00:00' })).status, 200, 'besok jam berapa pun boleh');
});

test('buat jadwal: tanggal kemarin tetap ditolak', async () => {
  const r = await create('adm', { day: '2026-03-09', start_time: '23:00' });
  assert.equal(r.status, 400);
});

test('ubah jadwal: pindah ke waktu yang sudah lewat ditolak; ubah catatan pada jadwal lama tetap boleh', async () => {
  setAt(DAY, '14:00');
  const s = (await create('adm', { start_time: '14:10' })).json.schedule;
  setAt(DAY, '16:00'); // jam 14.10 kini sudah lewat
  const note = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { note: 'Catatan baru' });
  assert.equal(note.status, 200, note.text);
  const same = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '14:10', note: 'Lagi' });
  assert.equal(same.status, 200, 'jam tidak berubah = tidak diperiksa');
  const moved = await api('sv', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '15:00' });
  assert.equal(moved.status, 400, moved.text);
  assert.equal(moved.json.code, 'SLOT_PASSED');
  const ok = await api('sv', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '17:00' });
  assert.equal(ok.status, 200, ok.text);
  const day = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { day: '2026-03-09' });
  assert.equal(day.status, 400);
});

test('user tidak punya jalur membuat jadwal (403)', async () => {
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  assert.equal((await create('budi')).status, 403);
});
