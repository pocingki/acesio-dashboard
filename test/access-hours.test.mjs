// Jam akses akun user (D5): 06:00:00–22:59:59 WIB. Waktu dimajukan lewat APP_FAKE_NOW_FILE (khusus NODE_ENV=test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ADMIN } from './helpers.mjs';

const PW = 'Tes-Password-User-123';

// Zona APP_TZ default Asia/Jakarta (UTC+7): 05:59 WIB = 22:59Z hari sebelumnya.
const wib = (hhmm, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+07:00`).toISOString();

async function withClock(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-clock-'));
  const file = path.join(dir, 'now.txt');
  const setTime = (hhmm) => fs.writeFileSync(file, wib(hhmm));
  setTime('12:00');
  const s = await startServer({ env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: file, ...env } });
  try {
    return await fn(s, setTime);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createAccount(s, adminCookie, username, role) {
  const r = await s.call('/api/sv/accounts', { method: 'POST', cookie: adminCookie, body: { username, name: `Nama ${username}`, password: PW, role } });
  assert.equal(r.status, 200, `buat akun ${username} gagal: ${r.text}`);
}

const tryLogin = (s, username, password = PW) =>
  s.call('/api/auth/login', { method: 'POST', body: { username, password } });

const cookieOf = (r) => (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

test('batas jam login: 05:59 ditolak, 06:00 dan 22:59 boleh, 23:00 ditolak', () => withClock({ ACCESS_HOURS: '06:00-23:00' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis1', 'user');

  setTime('05:59');
  let r = await tryLogin(s, 'terapis1');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'OUTSIDE_HOURS');
  assert.match(r.json.error, /06\.00–23\.00/);
  assert.equal(r.headers.get('set-cookie'), null, 'tidak boleh membuat sesi');

  setTime('06:00');
  r = await tryLogin(s, 'terapis1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.access, { start: '06:00', end: '23:00' });

  setTime('22:59');
  r = await tryLogin(s, 'terapis1');
  assert.equal(r.status, 200);

  setTime('23:00');
  r = await tryLogin(s, 'terapis1');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'OUTSIDE_HOURS');
}));

test('password salah di luar jam tetap 401, dan penolakan jam tidak dihitung sebagai login gagal', () => withClock({ ACCESS_HOURS: '06:00-23:00' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis2', 'user');
  setTime('03:00');

  let r = await tryLogin(s, 'terapis2', 'password-salah-1');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, undefined);

  // Password benar berkali-kali di luar jam: selalu 403 (bukan 429), jadi tidak ikut throttle.
  for (let i = 0; i < 12; i++) {
    r = await tryLogin(s, 'terapis2');
    assert.equal(r.status, 403, `percobaan ${i + 1}`);
  }
  setTime('08:00');
  r = await tryLogin(s, 'terapis2');
  assert.equal(r.status, 200);
}));

test('sesi yang sudah login dicabut saat jam akses habis', () => withClock({ ACCESS_HOURS: '06:00-23:00' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis3', 'user');

  setTime('22:59');
  const first = await tryLogin(s, 'terapis3');
  assert.equal(first.status, 200);
  const cookie = cookieOf(first);
  assert.equal((await s.call('/api/auth/me', { cookie })).status, 200);

  setTime('23:00');
  const denied = await s.call('/api/auth/me', { cookie });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'OUTSIDE_HOURS');
  assert.match(denied.headers.get('set-cookie') || '', /acesio_sid=;.*Max-Age=0/, 'cookie dikosongkan seperti logout');

  // Sesi sudah dihapus: setelah jam akses dibuka lagi, cookie lama menghasilkan 401.
  setTime('06:30');
  assert.equal((await s.call('/api/auth/me', { cookie })).status, 401);

  const again = await tryLogin(s, 'terapis3');
  assert.equal(again.status, 200);
  assert.equal((await s.call('/api/auth/me', { cookie: cookieOf(again) })).status, 200);
}));

test('admin dan supervisor tidak dibatasi pukul 03:00, dan respons mereka tanpa field access', () => withClock({ ACCESS_HOURS: '06:00-23:00' }, async (s, setTime) => {
  const sup = (await s.login()).cookie;
  await createAccount(s, sup, 'adm1', 'admin');
  setTime('03:00');

  let r = await tryLogin(s, 'adm1');
  assert.equal(r.status, 200);
  assert.equal(r.json.access, undefined);
  assert.equal((await s.call('/api/auth/me', { cookie: cookieOf(r) })).status, 200);

  r = await tryLogin(s, ADMIN.username, ADMIN.password);
  assert.equal(r.status, 200);
  assert.equal((await s.call('/api/auth/me', { cookie: cookieOf(r) })).status, 200);
}));

test('ACCESS_HOURS=off: user bisa login pukul 03:00 dan access bernilai null', () => withClock({ ACCESS_HOURS: 'off' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis4', 'user');
  setTime('03:00');
  const r = await tryLogin(s, 'terapis4');
  assert.equal(r.status, 200);
  assert.equal(r.json.access, null);
  const me = await s.call('/api/auth/me', { cookie: cookieOf(r) });
  assert.equal(me.status, 200);
  assert.equal(me.json.access, null);
}));

test('ACCESS_HOURS rusak: server tetap jalan dengan default 06:00-23:00 dan mencetak satu peringatan', () => withClock({ ACCESS_HOURS: 'abc' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis5', 'user');

  setTime('05:59');
  assert.equal((await tryLogin(s, 'terapis5')).status, 403);
  setTime('06:00');
  const r = await tryLogin(s, 'terapis5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.access, { start: '06:00', end: '23:00' });

  const warnings = s.output().split('\n').filter((l) => l.includes('ACCESS_HOURS="abc"'));
  assert.equal(warnings.length, 1, `peringatan harus tepat satu kali:\n${s.output()}`);
}));

test('rentang kustom lewat ACCESS_HOURS dipakai untuk batas dan pesan', () => withClock({ ACCESS_HOURS: '08:30-17:15' }, async (s, setTime) => {
  const admin = (await s.login()).cookie;
  await createAccount(s, admin, 'terapis6', 'user');

  setTime('08:29');
  let r = await tryLogin(s, 'terapis6');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /08\.30–17\.15/);
  setTime('08:30');
  assert.equal((await tryLogin(s, 'terapis6')).status, 200);
  setTime('17:14');
  assert.equal((await tryLogin(s, 'terapis6')).status, 200);
  setTime('17:15');
  assert.equal((await tryLogin(s, 'terapis6')).status, 403);
}));

test('endpoint publik dan berkas statis tidak terpengaruh jam akses', () => withClock({ ACCESS_HOURS: '06:00-23:00' }, async (s, setTime) => {
  setTime('03:00');
  const page = await s.call('/');
  assert.equal(page.status, 200);
  const me = await s.call('/api/auth/me');
  assert.equal(me.status, 401);
}));
