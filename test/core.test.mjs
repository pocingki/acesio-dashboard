import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startServer, ADMIN, ROOT } from './helpers.mjs';

// Tes yang MEMBUTUHKAN login hanya bisa lulus bila server.auth.js sudah mengikuti kontrak C (Akun 2).
// Tes tanpa login ditandai "(tanpa login)". Semua tes butuh auth.js yang mengekspor isSecure/clientIp/changePassword.

describe('server inti', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test('PORT=0 dipakai dan port aktual dicetak (tanpa login)', () => {
    assert.ok(s.port > 1023 && s.port !== 3000, `port acak diharapkan, dapat ${s.port}`);
    assert.match(s.output(), new RegExp(`http://localhost:${s.port}`));
  });

  test('body JSON bukan objek -> 400, bukan 500 (tanpa login)', async () => {
    for (const body of ['null', '123', '[]', '[1,2]', '"abc"', 'true']) {
      const r = await s.call('/api/auth/login', { method: 'POST', body });
      assert.equal(r.status, 400, `body ${body}`);
      assert.ok(r.json?.error, `body ${body} harus berisi pesan error JSON`);
    }
  });

  test('JSON rusak tetap 400 dan Content-Type salah tetap 415 (tanpa login)', async () => {
    assert.equal((await s.call('/api/auth/login', { method: 'POST', body: '{rusak' })).status, 400);
    const r = await s.call('/api/auth/login', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
  });

  test('body kosong dianggap objek kosong -> 401 login, bukan 500 (tanpa login)', async () => {
    const r = await s.call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' });
    assert.equal(r.status, 401);
  });

  test('URL tidak valid -> 400, bukan 500 (tanpa login)', async () => {
    for (const target of ['//', '//evil.example/api/auth/me', '/\\evil.example/x', '/%E0%A4%A', '/uploads/%zz']) {
      const r = await s.raw(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.equal(r.status, 400, `target ${target}`);
      assert.equal(JSON.parse(r.body).error, 'URL tidak valid');
    }
    // server masih hidup
    assert.equal((await s.call('/api/auth/me')).status, 401);
  });

  test('path traversal dan null byte -> 404 (tanpa login)', async () => {
    for (const target of ['/..%2f..%2fserver%2findex.js', '/%00', '/js/../../package.json']) {
      const r = await s.raw(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.equal(r.status, 404, `target ${target}`);
    }
  });

  test('body melebihi batas login 16 KB -> klien menerima 413 JSON + Connection: close (tanpa login)', async () => {
    const big = JSON.stringify({ username: 'a', password: 'x'.repeat(20 * 1024) });
    const r = await s.call('/api/auth/login', { method: 'POST', body: big });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(r.headers.get('connection'), 'close');
    assert.equal((await s.call('/api/auth/me')).status, 401); // server tetap sehat
  });

  test('413 juga untuk body besar tanpa Content-Length (chunked) dan yang sangat besar (tanpa login)', async () => {
    const chunked = await s.raw(
      'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
      + `${(40 * 1024).toString(16)}\r\n${'a'.repeat(40 * 1024)}\r\n0\r\n\r\n`,
    );
    assert.equal(chunked.status, 413);
    const r = await s.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ p: 'x'.repeat(8 * 1024 * 1024) }) });
    assert.equal(r.status, 413);
  });

  test('header keamanan ada dan HSTS tidak ada di HTTP biasa (tanpa login)', async () => {
    const r = await s.call('/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('strict-transport-security'), null);
  });

  test('semua /api/* (sukses maupun error) memakai Cache-Control: no-store (tanpa login)', async () => {
    for (const [p, opts] of [['/api/auth/me', {}], ['/api/tidak-ada', {}], ['/api/auth/login', { method: 'POST', body: 'null' }], ['/api/auth/me', { method: 'DELETE' }]]) {
      const r = await s.call(p, opts);
      assert.match(r.headers.get('cache-control') || '', /no-store/, `${opts.method || 'GET'} ${p} (${r.status})`);
    }
  });

  test('405 menyertakan Allow, 404 endpoint tak dikenal (tanpa login)', async () => {
    const r = await s.call('/api/auth/me', { method: 'DELETE' });
    assert.equal(r.status, 405);
    assert.match(r.headers.get('allow'), /GET/);
    assert.equal((await s.call('/api/tidak-ada')).status, 404);
  });

  test('file statis: ETag + no-cache, lalu 304 bila sama (tanpa login)', async () => {
    for (const p of ['/', '/js/app.js']) {
      const first = await s.call(p);
      assert.equal(first.status, 200, p);
      const etag = first.headers.get('etag');
      assert.ok(etag, `${p} harus punya ETag`);
      assert.equal(first.headers.get('cache-control'), 'no-cache');
      const again = await s.call(p, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304, p);
      assert.equal(again.text, '');
      assert.equal(again.headers.get('etag'), etag);
      assert.equal((await s.call(p, { headers: { 'If-None-Match': '"lain"' } })).status, 200);
      assert.equal((await s.call(p, { headers: { 'If-None-Match': `"x", ${etag}` } })).status, 304);
    }
  });

  test('HEAD didukung: header ada, body kosong (tanpa login)', async () => {
    const r = await s.call('/', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    assert.ok(Number(r.headers.get('content-length')) > 0);
    assert.equal((await s.call('/api/auth/me', { method: 'HEAD' })).status, 401);
  });

  test('/uploads tetap max-age, file tak ada -> 404 JSON (tanpa login)', async () => {
    fs.writeFileSync(path.join(s.dataDir, 'uploads', 'tes.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await s.call('/uploads/tes.png');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /max-age=86400/);
    const missing = await s.call('/uploads/tidak-ada.png');
    assert.equal(missing.status, 404);
    assert.ok(missing.json.error);
  });

  test('login: respons membawa tz dan cookie HttpOnly', async () => {
    const r = await s.call('/api/auth/login', { method: 'POST', body: ADMIN });
    assert.equal(r.status, 200);
    assert.equal(r.json.tz, 'Asia/Jakarta');
    assert.equal(r.json.user.username, ADMIN.username);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await s.call('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: 'salah' } })).status, 401);
  });

  test('login memakai kredensial non-string -> 401, bukan 500', async () => {
    for (const body of [{ username: {}, password: [] }, { username: null, password: null }, {}]) {
      assert.equal((await s.call('/api/auth/login', { method: 'POST', body })).status, 401);
    }
  });

  test('/api/auth/me membawa tz; ekspor tetap no-store; batas umum 1 MB; foto layanan lolos sampai 3 MB', async () => {
    const { cookie } = await s.login();
    const me = await s.call('/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.tz, 'Asia/Jakarta');

    const tpl = await s.call('/api/staff/customers/template?format=csv', { cookie });
    assert.equal(tpl.status, 200);
    assert.match(tpl.headers.get('content-type'), /text\/csv/);
    assert.match(tpl.headers.get('cache-control'), /no-store/);

    const over = await s.call('/api/auth/password', { method: 'POST', cookie, body: JSON.stringify({ current: 'x', next: 'y'.repeat(1.2 * 1024 * 1024) }) });
    assert.equal(over.status, 413);

    // 2 MB (< 3 MB): lolos pembacaan body, lalu ditolak oleh validasi foto (400), bukan 413
    const photo = await s.call('/api/sv/services/1', { method: 'PATCH', cookie, body: { photo: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024) } });
    assert.equal(photo.status, 400);
    const huge = await s.call('/api/sv/services/1', { method: 'PATCH', cookie, body: { photo: 'A'.repeat(3.2 * 1024 * 1024) } });
    assert.equal(huge.status, 413);
  });

  test('impor customer boleh sampai 30 MB (5 MB bukan 413), di atas itu 413', async () => {
    const { cookie } = await s.login();
    const mid = await s.call('/api/staff/customers/import', { method: 'POST', cookie, body: JSON.stringify({ format: 'csv', content: 'x'.repeat(5 * 1024 * 1024) }) });
    assert.notEqual(mid.status, 413);
    assert.ok(mid.status < 500, `status ${mid.status}`);
    const over = await s.call('/api/staff/customers/import', { method: 'POST', cookie, body: JSON.stringify({ format: 'csv', content: 'x'.repeat(31 * 1024 * 1024) }) });
    assert.equal(over.status, 413);
  });

  test('klien memutus koneksi di tengah body -> server tetap hidup (tanpa login)', async () => {
    await assert.rejects(s.raw(
      'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"username":"a"',
      { timeoutMs: 300 },
    ), /waktu habis/); // server menunggu sisa body; koneksi lalu kita putus oleh timeout raw()
    assert.equal((await s.call('/api/auth/me')).status, 401);
  });

  test('ganti password: password pendek 400, lama salah 400, sukses mencabut sesi lain', async () => {
    const a = await s.login();
    const b = await s.login();
    assert.equal((await s.call('/api/auth/password', { method: 'POST', cookie: a.cookie, body: { current: ADMIN.password, next: 'pendek' } })).status, 400);
    assert.equal((await s.call('/api/auth/password', { method: 'POST', cookie: a.cookie, body: { current: 'salah-banget', next: 'password-baru-123' } })).status, 400);
    const ok = await s.call('/api/auth/password', { method: 'POST', cookie: a.cookie, body: { current: ADMIN.password, next: 'password-baru-123' } });
    assert.equal(ok.status, 200);
    assert.equal((await s.call('/api/auth/me', { cookie: a.cookie })).status, 200); // sesi sekarang bertahan
    assert.equal((await s.call('/api/auth/me', { cookie: b.cookie })).status, 401); // sesi lain dicabut
    // kembalikan supaya tes lain tidak terpengaruh
    await s.call('/api/auth/password', { method: 'POST', cookie: a.cookie, body: { current: 'password-baru-123', next: ADMIN.password } });
  });

  test('logout menghapus cookie', async () => {
    const { cookie } = await s.login();
    const r = await s.call('/api/auth/logout', { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await s.call('/api/auth/me', { cookie })).status, 401);
  });
});

describe('HSTS dan proxy', () => {
  test('HSTS hanya bila koneksi dianggap aman (TRUST_PROXY + X-Forwarded-Proto) (tanpa login)', async () => {
    const trusted = await startServer({ env: { TRUST_PROXY: 'true' } });
    try {
      const https = await trusted.call('/', { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(https.headers.get('strict-transport-security'), /max-age=\d+/);
      assert.equal((await trusted.call('/')).headers.get('strict-transport-security'), null);
    } finally { await trusted.stop(); }

    const untrusted = await startServer();
    try {
      const r = await untrusted.call('/', { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(r.headers.get('strict-transport-security'), null);
    } finally { await untrusted.stop(); }
  });
});

describe('kredensial awal dan siklus hidup', () => {
  test('tanpa ADMIN_PASSWORD: password acak ke berkas 0600, tidak dicetak (tanpa login)', async () => {
    const s = await startServer({ env: { ADMIN_PASSWORD: undefined } });
    try {
      const file = path.join(s.dataDir, 'first-run-credentials.txt');
      assert.ok(fs.existsSync(file));
      const text = fs.readFileSync(file, 'utf8');
      const password = /password : (\S+)/.exec(text)?.[1];
      assert.ok(password && password.length >= 12);
      assert.ok(s.output().includes(file), 'lokasi berkas harus dicetak');
      assert.ok(!s.output().includes(password), 'password TIDAK boleh muncul di stdout/stderr');
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const r = await s.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password } });
      assert.equal(r.status, 200);
    } finally { await s.stop(); }
  });

  test('ADMIN_PASSWORD pendek -> peringatan; panjang -> tanpa peringatan; password tidak dicetak (tanpa login)', async () => {
    const short = await startServer({ env: { ADMIN_PASSWORD: 'pendek123' } });
    try {
      assert.match(short.output(), /kurang dari 12 karakter/);
      assert.ok(!short.output().includes('pendek123'));
      assert.ok(!fs.existsSync(path.join(short.dataDir, 'first-run-credentials.txt')));
    } finally { await short.stop(); }
    const long = await startServer();
    try { assert.doesNotMatch(long.output(), /kurang dari 12 karakter/); } finally { await long.stop(); }
  });

  test('PORT tidak valid -> keluar dengan pesan jelas (tanpa login)', async () => {
    await assert.rejects(startServer({ env: { PORT: 'abc' } }), /PORT tidak valid/);
  });

  test('SIGTERM: server menutup diri dengan rapi, kode keluar 0 (tanpa login)', async () => {
    const s = await startServer();
    const info = await s.stop();
    assert.equal(info.code, 0);
    assert.match(s.output(), /Server ditutup/);
  });
});

describe('inventaris endpoint', () => {
  // 37 endpoint sebelum pemecahan routes.js. Fase 2 boleh MENAMBAH rute, tidak boleh menghilangkan ini.
  const LEGACY = [
    'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me', 'POST /api/auth/password',
    'GET /api/services', 'GET /api/customers/search',
    'POST /api/records', 'GET /api/records/mine', 'GET /api/records/mine/export', 'DELETE /api/records/:id',
    'GET /api/staff/summary', 'GET /api/staff/usage', 'GET /api/staff/users', 'GET /api/staff/attendance',
    'GET /api/staff/users/:id/detail', 'POST /api/staff/reviews', 'DELETE /api/sv/reviews',
    'GET /api/staff/export', 'GET /api/staff/charts',
    'GET /api/staff/customers', 'GET /api/staff/customers/export', 'GET /api/staff/customers/template',
    'POST /api/staff/customers/import', 'POST /api/staff/customers', 'PATCH /api/staff/customers/:id',
    'GET /api/staff/customers/:id/visits',
    'PATCH /api/sv/services/:id', 'GET /api/sv/commissions', 'GET /api/sv/commissions/:userId',
    'PUT /api/sv/commissions/:userId', 'GET /api/sv/accounts', 'POST /api/sv/accounts', 'PATCH /api/sv/accounts/:id',
    'GET /api/bot/services', 'GET /api/bot/customers', 'GET /api/bot/customers/:id/history', 'POST /api/bot/records',
  ];

  test('semua endpoint lama masih terdaftar (tanpa login)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-inv-'));
    try {
      const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/routes/index.js')).href)});
        await m.loadRoutes(); console.log(JSON.stringify(m.routes.map((r) => r.method + ' ' + r.pattern)));`;
      const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
        cwd: dataDir, env: { PATH: process.env.PATH, DATA_DIR: dataDir }, encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      const have = new Set(JSON.parse(run.stdout.trim().split('\n').pop()));
      assert.deepEqual(LEGACY.filter((r) => !have.has(r)), [], 'endpoint lama yang hilang');
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
