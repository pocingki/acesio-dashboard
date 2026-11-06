import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR sementara harus di-set SEBELUM db.js diimpor.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-auth-'));
process.env.DATA_DIR = tmp;
process.env.ACCESS_HOURS = 'off'; // login() memeriksa jam akses role user; tes ini tidak boleh bergantung pada jam
delete process.env.TRUST_PROXY;
delete process.env.COOKIE_SECURE;

const { db } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { createLimiter } = await import('../server/ratelimit.js');

const {
  hashPassword, verifyPassword, login, changePassword, sessionUser, parseCookies,
  clientIp, isSecure, cleanupExpiredSessions, createSemaphore,
} = auth;

after(() => {
  try { db.close(); } catch { /* sudah tertutup */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reqWith = (cookie, extra = {}) => ({ headers: { cookie, ...extra }, socket: { remoteAddress: '10.0.0.1' } });
const sessionCount = (userId) => db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(userId).n;

let seq = 0;
async function makeUser(password = 'password-awal-1') {
  const username = `tester${++seq}`;
  const id = Number(db.prepare(
    "INSERT INTO users (username, name, password_hash, role, active, created_at) VALUES (?, ?, ?, 'user', 1, ?)",
  ).run(username, `Tester ${seq}`, await hashPassword(password), new Date().toISOString()).lastInsertRowid);
  return { id, username, password };
}

test('hash/verify password async dan kompatibel dengan format lama', async () => {
  const stored = await hashPassword('rahasia123');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('rahasia123', stored), true);
  assert.equal(await verifyPassword('salah', stored), false);
  assert.equal(await verifyPassword('x', 'rusak'), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('parseCookies tidak melempar untuk cookie dengan encoding rusak', () => {
  let out;
  assert.doesNotThrow(() => { out = parseCookies('acesio_sid=%E0%A4%A; lain=ok%20ya; __proto__=x'); });
  assert.equal(out.acesio_sid, undefined);
  assert.equal(out.lain, 'ok ya');
  assert.doesNotThrow(() => parseCookies(undefined));
  assert.equal(sessionUser(reqWith('acesio_sid=%E0%A4%A')), null);
});

test('limiter: hit, batas, reset, dan retryAfterSec', () => {
  const lim = createLimiter({ max: 2, windowMs: 60_000, maxKeys: 100 });
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, true);
  const third = lim.hit('a');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSec >= 1 && third.retryAfterSec <= 60);
  assert.equal(lim.hit('b').allowed, true);
  lim.reset('a');
  assert.equal(lim.hit('a').allowed, true);
});

test('limiter: key dipotong 200 karakter', () => {
  const lim = createLimiter({ max: 1, windowMs: 60_000, maxKeys: 100 });
  const base = 'u'.repeat(200);
  assert.equal(lim.hit(base + 'AAA').allowed, true);
  assert.equal(lim.hit(base + 'BBB').allowed, false); // key sama setelah dipotong
  assert.equal(lim.size(), 1);
});

test('limiter: jumlah key dibatasi maxKeys (yang tertua dibuang)', () => {
  const lim = createLimiter({ max: 1, windowMs: 60_000, maxKeys: 50 });
  for (let i = 0; i < 5000; i++) lim.hit(`k${i}`);
  assert.equal(lim.size(), 50);
  // key tertua sudah dibuang -> mulai dari nol lagi; key terbaru masih tercatat
  assert.equal(lim.hit('k0').allowed, true);
  assert.equal(lim.hit('k4999').allowed, false);
});

test('limiter: entri kedaluwarsa dipangkas otomatis oleh timer berkala', async () => {
  const lim = createLimiter({ max: 5, windowMs: 40, maxKeys: 10000 });
  for (let i = 0; i < 200; i++) lim.hit(`t${i}`);
  assert.equal(lim.size(), 200);
  await sleep(250);
  assert.equal(lim.size(), 0);
});

test('semaphore: maksimal N tugas berjalan bersamaan, sisanya antre', async () => {
  const sem = createSemaphore(4);
  let running = 0;
  let peak = 0;
  const done = [];
  await Promise.all(Array.from({ length: 20 }, (_, i) => sem.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(10);
    running--;
    done.push(i);
  })));
  assert.equal(done.length, 20);
  assert.equal(peak, 4);
});

test('login berhasil membuat sesi; user nonaktif dan password salah ditolak', async () => {
  const u = await makeUser();
  assert.equal(await login(u.username, 'salah', { ip: 'ip-login-1' }), null);
  const ok = await login(u.username.toUpperCase(), u.password, { ip: 'ip-login-1' });
  assert.ok(ok && ok.token && ok.user.id === u.id);
  assert.equal(sessionUser(reqWith(`acesio_sid=${ok.token}`)).id, u.id);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  assert.equal(await login(u.username, u.password, { ip: 'ip-login-2' }), null);
});

test('changePassword mencabut sesi lain tetapi mempertahankan sesi sekarang', async () => {
  const u = await makeUser();
  const a = await login(u.username, u.password, { ip: 'ip-cp' });
  const b = await login(u.username, u.password, { ip: 'ip-cp' });
  const c = await login(u.username, u.password, { ip: 'ip-cp' });
  assert.equal(sessionCount(u.id), 3);

  await changePassword(u.id, u.password, 'password-baru-99', a.token);

  assert.ok(sessionUser(reqWith(`acesio_sid=${a.token}`)), 'sesi sekarang harus tetap hidup');
  assert.equal(sessionUser(reqWith(`acesio_sid=${b.token}`)), null);
  assert.equal(sessionUser(reqWith(`acesio_sid=${c.token}`)), null);
  assert.equal(sessionCount(u.id), 1);
  assert.equal(await login(u.username, u.password, { ip: 'ip-cp' }), null, 'password lama tidak berlaku lagi');
  assert.ok(await login(u.username, 'password-baru-99', { ip: 'ip-cp' }));
});

test('changePassword: validasi password', async () => {
  const u = await makeUser();
  const rejects = (cur, next, re) => assert.rejects(
    () => changePassword(u.id, cur, next, 'tok'),
    (e) => e.status === 400 && re.test(e.message),
  );
  await rejects('salah-total', 'password-baru-99', /saat ini salah/);
  await rejects(u.password, 'pendek', /minimal 8/);
  await rejects(u.password, 'x'.repeat(201), /maksimal 200/);
  await rejects(u.password, u.password, /tidak boleh sama/);
  await rejects(u.password, 'hurufsaja', /huruf dan angka/);
  // batas tepat 200 karakter diterima bila ada huruf dan angka
  await changePassword(u.id, u.password, `${'y'.repeat(199)}1`, 'tok');
});

test('changePassword: salah password lama berulang kena throttle 429', async () => {
  const u = await makeUser();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => changePassword(u.id, 'salah', 'password-baru-99', 't'), (e) => e.status === 400);
  }
  await assert.rejects(() => changePassword(u.id, u.password, 'password-baru-99', 't'), (e) => e.status === 429);
});

test('8 login gagal -> 429 untuk ip+username itu, IP lain tetap bisa login', async () => {
  const u = await makeUser();
  const victimIp = '203.0.113.7';
  for (let i = 0; i < 8; i++) {
    assert.equal(await login(u.username, 'salah', { ip: victimIp }), null);
  }
  await assert.rejects(() => login(u.username, 'salah', { ip: victimIp }), (e) => e.status === 429 && e.retryAfterSec > 0);
  // password benar dari kombinasi yang sama pun ditahan
  await assert.rejects(() => login(u.username, u.password, { ip: victimIp }), (e) => e.status === 429);
  // penyerang tidak bisa mengunci pemilik akun dari IP lain
  const legit = await login(u.username, u.password, { ip: '198.51.100.9' });
  assert.ok(legit && legit.token);
  // username lain dari IP yang terkunci tidak ikut terkunci (batas per IP baru 8 dari 30)
  const other = await makeUser();
  assert.ok(await login(other.username, other.password, { ip: victimIp }));
});

test('login sukses mereset hitungan gagal ip+username', async () => {
  const u = await makeUser();
  const ip = '192.0.2.50';
  for (let i = 0; i < 7; i++) assert.equal(await login(u.username, 'salah', { ip }), null);
  assert.ok(await login(u.username, u.password, { ip }));
  for (let i = 0; i < 7; i++) assert.equal(await login(u.username, 'salah', { ip }), null);
  assert.ok(await login(u.username, u.password, { ip }), 'belum terkunci karena hitungan sudah direset');
});

test('30 gagal per IP (username berbeda-beda) -> percobaan ke-31 kena 429', async () => {
  const ip = '192.0.2.99';
  for (let i = 0; i < 30; i++) assert.equal(await login(`hantu-${i}`, 'x', { ip }), null);
  await assert.rejects(() => login('hantu-baru', 'x', { ip }), (e) => e.status === 429);
});

test('30 login paralel dengan username acak tidak membuat jeda event loop > 200 ms', async () => {
  await dummyWarm();
  let last = performance.now();
  let maxLag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  try {
    const names = Array.from({ length: 30 }, (_, i) => `acak-${Math.random().toString(36).slice(2)}-${i}`);
    const results = await Promise.all(names.map((n) => login(n, 'pw-salah', { ip: 'ip-lag-test' })));
    assert.ok(results.every((r) => r === null));
  } finally {
    clearInterval(timer);
  }
  assert.ok(maxLag < 200, `jeda event loop terlalu besar: ${maxLag.toFixed(0)} ms`);
});

// pemanasan modul (JIT, threadpool) di luar pengukuran, memakai IP lain
async function dummyWarm() {
  await login('pemanasan', 'x', { ip: 'ip-warm' });
}

test('maksimal 10 sesi aktif per user; yang tertua dihapus', async () => {
  const u = await makeUser();
  const tokens = [];
  for (let i = 0; i < 12; i++) tokens.push((await login(u.username, u.password, { ip: 'ip-sesi' })).token);
  assert.equal(sessionCount(u.id), 10);
  assert.equal(sessionUser(reqWith(`acesio_sid=${tokens[0]}`)), null);
  assert.equal(sessionUser(reqWith(`acesio_sid=${tokens[1]}`)), null);
  assert.ok(sessionUser(reqWith(`acesio_sid=${tokens[2]}`)));
  assert.ok(sessionUser(reqWith(`acesio_sid=${tokens[11]}`)));
});

test('sesi kedaluwarsa dibersihkan oleh cleanupExpiredSessions', async () => {
  const u = await makeUser();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('basi-1', u.id, Date.now() - 1000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('basi-2', u.id, Date.now() - 5000);
  assert.ok(cleanupExpiredSessions() >= 2);
  assert.equal(sessionCount(u.id), 0);
});

test('clientIp dan isSecure hanya mempercayai header proxy bila TRUST_PROXY=true', () => {
  const req = {
    headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4', 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  delete process.env.TRUST_PROXY;
  assert.equal(clientIp(req), '10.0.0.1');
  assert.equal(isSecure(req), false);

  process.env.TRUST_PROXY = 'true';
  try {
    assert.equal(clientIp(req), '1.2.3.4', 'entri paling kanan (ditambahkan proxy tepercaya), bukan yang bisa dipalsukan klien');
    assert.equal(isSecure(req), true);
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
    assert.equal(isSecure({ headers: { 'x-forwarded-proto': 'http' } }), false);
  } finally {
    delete process.env.TRUST_PROXY;
  }

  process.env.COOKIE_SECURE = 'true';
  try {
    assert.equal(isSecure({ headers: {} }), true);
  } finally {
    delete process.env.COOKIE_SECURE;
  }
});