// Tes regresi untuk temuan audit. SATU tes per temuan; nama tes diawali ID temuan.
// Temuan klien (#6, #9, #10, #11) diuji manual: lihat test/e2e/README.md.
//
// Harness di bawah menjalankan server ASLI (proses anak, PORT=0, DATA_DIR sementara) dan memanggilnya lewat HTTP,
// jadi tes ini tidak bergantung pada bentuk modul internal. Jika test/helpers.mjs (Akun 1) sudah stabil,
// blok "HARNESS" bisa diganti dengan import dari sana tanpa mengubah isi tes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ======================= HARNESS =======================
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { username: 'admin', password: 'admin-pass-123' };
const PW = 'password-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, urlPath, { body, raw, headers = {}, cookie, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const hdrs = { ...headers };
    if (cookie) hdrs.Cookie = cookie;
    if (payload !== undefined) {
      hdrs['Content-Type'] ??= 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: hdrs, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* bukan JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout} ms: ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-test-'));
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir,
    ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, BOT_API_KEY: 'test-bot-key-0123456789',
    COOKIE_SECURE: 'false', TRUST_PROXY: 'false', APP_TZ: 'Asia/Jakarta', ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT; // supaya proses anak tidak ikut "mode runner tes"
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((r) => child.once('exit', r));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server tidak mencetak port dalam 15 detik. Output:\n${out}`)), 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /https?:\/\/[^\s:/]+:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server berhenti (kode ${code}). Output:\n${out}`)); });
  });

  const s = {
    port, dataDir, env,
    call: (method, p, opts) => request(port, method, p, opts),
    async kill() { child.kill('SIGKILL'); await exited; },
    async stop() { await s.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); },
    db() {
      const d = new DatabaseSync(path.join(dataDir, 'acesio.db'));
      d.exec('PRAGMA busy_timeout = 5000');
      return d;
    },
    async login(username, password, ip) {
      const res = await s.call('POST', '/api/auth/login', { body: { username, password }, headers: ip ? { 'X-Forwarded-For': ip } : {} });
      const setCookie = res.headers['set-cookie'];
      const cookie = res.status === 200 && setCookie ? String(setCookie[0] ?? setCookie).split(';')[0] : null;
      return { ...res, cookie };
    },
    async admin() {
      const r = await s.login(ADMIN.username, ADMIN.password);
      assert.equal(r.status, 200, `login admin gagal: ${r.text}`);
      return r.cookie;
    },
    async createUser(adminCookie, username, role = 'user') {
      const r = await s.call('POST', '/api/sv/accounts', { cookie: adminCookie, body: { username, name: `Nama ${username}`, password: PW, role } });
      assert.equal(r.status, 200, `buat akun ${username} gagal: ${r.text}`);
      return r.json.id;
    },
    async createCustomer(adminCookie, fields) {
      const r = await s.call('POST', '/api/staff/customers', { cookie: adminCookie, body: fields });
      assert.equal(r.status, 200, `buat customer gagal: ${r.text}`);
      return r.json.id;
    },
    async addRecord(cookie, rm, serviceIds, headers = {}) {
      return s.call('POST', '/api/records', { cookie, headers, body: { customer_rm: rm, service_ids: serviceIds } });
    },
  };
  return s;
}

async function withServer(env, fn) {
  const s = await startServer(env);
  try { return await fn(s); } finally { await s.stop(); }
}

// ZIP "stored" minimal untuk membuat XLSX uji.
function storedZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const xlsxWithSheet = (rowsXml) => storedZip([[
  'xl/worksheets/sheet1.xml',
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
]]);

// ======================= TES =======================

test('#1 user tidak bisa menghapus data hari lampau (409); hari ini boleh; supervisor boleh', async () => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createUser(admin, 'terapis1');
    await s.createCustomer(admin, { rm_no: 'RM-001', name: 'Rina Wulandari' });
    const { cookie } = await s.login('terapis1', PW);
    assert.equal((await s.addRecord(cookie, 'RM-001', [1])).status, 200);
    assert.equal((await s.addRecord(cookie, 'RM-001', [2])).status, 200);
    const mine = (await s.call('GET', '/api/records/mine', { cookie })).json.records;
    const old = mine.find((r) => r.service_id === 1);
    const today = mine.find((r) => r.service_id === 2);

    const d = s.db();
    d.prepare("UPDATE records SET day = '2000-01-01' WHERE id = ?").run(old.id); // pura-pura data kemarin
    d.close();

    const del = await s.call('DELETE', `/api/records/${old.id}`, { cookie });
    assert.equal(del.status, 409, `hapus data hari lampau harus 409, dapat ${del.status}: ${del.text}`);
    const after = (await s.call('GET', '/api/records/mine', { cookie })).json.records;
    assert.ok(after.some((r) => r.id === old.id), 'data hari lampau harus tetap ada');

    assert.equal((await s.call('DELETE', `/api/records/${today.id}`, { cookie })).status, 200, 'data hari ini milik sendiri masih boleh dihapus');
    assert.equal((await s.call('DELETE', `/api/records/${old.id}`, { cookie: admin })).status, 200, 'supervisor boleh menghapus data lampau');
  });
});

test('#2 ganti password mencabut sesi lain, sesi yang dipakai tetap hidup', async () => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createUser(admin, 'terapis2');
    const a = (await s.login('terapis2', PW)).cookie;
    const b = (await s.login('terapis2', PW)).cookie;
    assert.equal((await s.call('GET', '/api/auth/me', { cookie: b })).status, 200);

    const ch = await s.call('POST', '/api/auth/password', { cookie: a, body: { current: PW, next: 'password-baru-456' } });
    assert.equal(ch.status, 200, ch.text);

    assert.equal((await s.call('GET', '/api/auth/me', { cookie: a })).status, 200, 'sesi yang dipakai mengganti password harus tetap hidup');
    assert.equal((await s.call('GET', '/api/auth/me', { cookie: b })).status, 401, 'sesi lain harus dicabut');
    assert.equal((await s.login('terapis2', PW)).status, 401, 'password lama harus ditolak');
    assert.equal((await s.login('terapis2', 'password-baru-456')).status, 200, 'password baru harus bisa dipakai');
  });
});

test('#3 lockout per ip+username; username 2,5 MB tidak membengkakkan memori (413 + limiter); 30 login paralel tidak memblokir event loop', async (t) => {
  await t.test('lockout hanya untuk ip+username yang gagal (TRUST_PROXY=true)', async () => {
    await withServer({ TRUST_PROXY: 'true' }, async (s) => {
      const admin = await s.admin();
      await s.createUser(admin, 'alice');
      await s.createUser(admin, 'bob');
      let last;
      for (let i = 0; i < 10; i++) last = await s.login('alice', 'salah-terus', '203.0.113.5');
      assert.equal(last.status, 429, 'setelah banyak gagal, alice dari IP itu harus kena 429');
      assert.equal((await s.login('alice', PW, '203.0.113.5')).status, 429, 'selama lockout, password benar pun ditolak');
      assert.equal((await s.login('alice', PW, '203.0.113.9')).status, 200, 'alice dari IP lain tidak boleh ikut terkunci');
      assert.equal((await s.login('bob', PW, '203.0.113.5')).status, 200, 'bob dari IP yang sama tidak boleh ikut terkunci');
    });
  });

  await t.test('tanpa TRUST_PROXY, X-Forwarded-For palsu tidak bisa menghindari lockout', async () => {
    await withServer({ TRUST_PROXY: 'false' }, async (s) => {
      let last;
      for (let i = 0; i < 12; i++) last = await s.login(ADMIN.username, 'salah-terus', `198.51.100.${i + 1}`);
      assert.equal(last.status, 429, 'header X-Forwarded-For harus diabaikan bila TRUST_PROXY bukan true');
    });
  });

  await t.test('username 2,5 MB: ditolak 413 oleh batas body login (bukan 401/500), server tetap hidup', async () => {
    // Batas body login 16 KB (PDF). Kode lama menerima sampai 3 MB lalu menyimpan username utuh di Map limiter.
    await withServer({}, async (s) => {
      const r = await s.call('POST', '/api/auth/login', { body: { username: 'a'.repeat(2_500_000), password: 'x' }, timeout: 20000 });
      assert.equal(r.status, 413, `username 2,5 MB harus 413, dapat ${r.status}`);
      assert.equal(typeof r.json?.error, 'string', 'respons harus JSON {"error": "..."}');
      assert.equal((await s.call('GET', '/api/auth/me')).status, 401, 'server harus tetap hidup');
    });
  });

  await t.test('limiter (modul): kunci dipotong 200 karakter, tidak disimpan utuh; maxKeys tidak membuat error', async () => {
    // Kontrak C: createLimiter({max, windowMs, maxKeys}) -> {hit(key), reset(key)}; key dipotong 200 karakter.
    // Diuji langsung di modul karena lewat HTTP kunci sepanjang itu sudah ditolak 413.
    const { createLimiter } = await import('../server/ratelimit.js');
    const lim = createLimiter({ max: 3, windowMs: 60_000, maxKeys: 1000 });
    const huge = 'x'.repeat(2_500_000);
    for (let i = 0; i < 3; i++) assert.equal(lim.hit(`${huge}A`).allowed, true, `hit ke-${i + 1} harus diizinkan`);
    const blocked = lim.hit(`${huge}B`); // beda hanya setelah karakter ke-200 -> bucket yang sama
    assert.equal(blocked.allowed, false, 'kunci yang sama di 200 karakter pertama harus berbagi bucket');
    assert.ok(blocked.retryAfterSec > 0, 'retryAfterSec harus positif');
    lim.reset(`${huge}C`);
    assert.equal(lim.hit(`${huge}D`).allowed, true, 'reset harus membersihkan bucket yang dibagi');

    const small = createLimiter({ max: 1, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 500; i++) {
      const r = small.hit(`kunci-${i}`);
      assert.equal(typeof r.allowed, 'boolean', 'hit selalu mengembalikan {allowed}');
    }
    assert.equal(typeof small.hit('kunci-baru').allowed, 'boolean', 'limiter tetap berfungsi setelah melewati maxKeys');
  });

  await t.test('30 login paralel tidak memblokir event loop (ping tetap cepat)', async () => {
    await withServer({ TRUST_PROXY: 'true' }, async (s) => {
      let done = false;
      let maxLatency = 0;
      const pinger = (async () => {
        while (!done) {
          const t0 = Date.now();
          await s.call('GET', '/api/auth/me');
          maxLatency = Math.max(maxLatency, Date.now() - t0);
          await sleep(10);
        }
      })();
      await sleep(150);
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        s.login(`tidak-ada-${i}`, 'password-salah', `192.0.2.${i + 1}`)));
      done = true;
      await pinger;
      assert.ok(results.every((r) => r.status === 401), `semua harus 401, dapat: ${results.map((r) => r.status).join(',')}`);
      assert.ok(maxLatency < 500, `event loop terblokir: ping terlama ${maxLatency} ms (batas 500 ms)`);
    });
  });
});

test('#4 dua POST dengan Idempotency-Key sama membuat tepat 1 record', async (t) => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createUser(admin, 'terapis4');
    await s.createCustomer(admin, { rm_no: 'RM-004', name: 'Dimas Prakoso' });
    const { cookie } = await s.login('terapis4', PW);
    const count = async () => (await s.call('GET', '/api/records/mine', { cookie })).json.records.length;

    await t.test('kunci sama berurutan -> respons semula + Idempotent-Replay, 1 record', async () => {
      const before = await count();
      const h = { 'Idempotency-Key': 'kunci-uji-0001' };
      const r1 = await s.addRecord(cookie, 'RM-004', [1], h);
      const r2 = await s.addRecord(cookie, 'RM-004', [1], h);
      assert.equal(r1.status, 200, r1.text);
      assert.equal(r2.status, r1.status);
      assert.equal(r1.headers['idempotent-replay'], undefined, 'permintaan pertama bukan replay');
      assert.equal(r2.headers['idempotent-replay'], 'true', 'permintaan ulang harus bertanda Idempotent-Replay: true');
      assert.deepEqual(r2.json, r1.json, 'badan respons ulang harus sama dengan yang pertama');
      assert.equal(await count(), before + 1, 'hanya boleh bertambah 1 record');
    });

    await t.test('kunci sama dikirim bersamaan -> tetap hanya 1 record baru', async () => {
      const before = await count();
      const h = { 'Idempotency-Key': 'kunci-uji-0002' };
      const [x, y] = await Promise.all([s.addRecord(cookie, 'RM-004', [2], h), s.addRecord(cookie, 'RM-004', [2], h)]);
      assert.equal(x.status, 200, x.text);
      assert.equal(y.status, 200, y.text);
      assert.equal(await count(), before + 1, 'hanya boleh bertambah 1 record, bukan 2');
    });

    await t.test('kunci berbeda -> record baru; kunci tidak valid -> 400', async () => {
      const before = await count();
      assert.equal((await s.addRecord(cookie, 'RM-004', [3], { 'Idempotency-Key': 'kunci-uji-0003' })).status, 200);
      assert.equal(await count(), before + 1);
      const bad = await s.addRecord(cookie, 'RM-004', [4], { 'Idempotency-Key': 'abc' });
      assert.equal(bad.status, 400, 'kunci < 8 karakter harus 400');
      assert.equal(await count(), before + 1, 'permintaan dengan kunci tidak valid tidak boleh membuat data');
    });
  });
});

test('#5 seed-demo menolak database yang sudah berisi data', async () => {
  // Kontrol positif: database kosong boleh diisi.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-seed-empty-'));
  const env = (dir) => { const e = { ...process.env, DATA_DIR: dir }; delete e.NODE_TEST_CONTEXT; return e; };
  const run = (dir) => spawnSync(process.execPath, ['--no-warnings', 'scripts/seed-demo.js'], { cwd: ROOT, env: env(dir), encoding: 'utf8', timeout: 60000 });
  try {
    const ok = run(empty);
    assert.equal(ok.status, 0, `seed pada database kosong harus berhasil: ${ok.stderr}`);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }

  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createCustomer(admin, { rm_no: 'RM-REAL-1', name: 'Customer Sungguhan' });
    await s.kill();
    const d0 = s.db();
    const usersBefore = d0.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    d0.close();
    const r = run(s.dataDir);
    assert.notEqual(r.status, 0, `seed harus menolak database berisi data (exit ${r.status}). Output: ${r.stdout}${r.stderr}`);
    const d = s.db();
    const usersAfter = d.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const records = d.prepare('SELECT COUNT(*) AS n FROM records').get().n;
    const cust = d.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    d.close();
    assert.equal(usersAfter, usersBefore, 'akun demo tidak boleh dibuat di database berisi data');
    assert.equal(records, 0, 'data layanan demo tidak boleh dibuat');
    assert.equal(cust, 1, 'data customer asli tidak boleh berubah');
  });
});

test('#7 pencarian riwayat "Layanan 9" tidak cocok ke nomor telepon', async () => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createUser(admin, 'terapis7');
    // 0812-3456-7890 -> 6281234567890 (mengandung digit 9)
    await s.createCustomer(admin, { rm_no: 'RM-007', name: 'Rina Wulandari', phone: '0812-3456-7890' });
    const { cookie } = await s.login('terapis7', PW);
    assert.equal((await s.addRecord(cookie, 'RM-007', [1])).status, 200); // "Layanan 1"
    const search = async (q) => (await s.call('GET', `/api/records/mine?q=${encodeURIComponent(q)}`, { cookie })).json.records.length;

    assert.equal(await search('Layanan 9'), 0, '"Layanan 9" tidak boleh cocok ke nomor telepon yang mengandung 9');
    assert.equal(await search('9'), 0, 'satu digit (< 3 digit) tidak boleh mencocokkan No WA');
    assert.equal(await search('Layanan 1'), 1, 'pencarian nama layanan tetap bekerja');
    assert.equal(await search('Rina'), 1, 'pencarian nama customer tetap bekerja');
    assert.equal(await search('RM-007'), 1, 'pencarian No RM tetap bekerja');
    assert.equal(await search('+62 812-3456'), 1, 'q berisi angka saja (>= 3 digit) tetap mencocokkan No WA');
  });
});

test('#8 nama "-Andi" utuh setelah ekspor CSV lalu impor; sel formula tetap dinetralkan di CSV', async () => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    await s.createCustomer(admin, { rm_no: 'RM-NEG-1', name: '-Andi' });
    await s.createCustomer(admin, { rm_no: 'RM-NEG-2', name: '=SUM(1+1) Budi' });

    const exp = await s.call('GET', '/api/staff/customers/export?format=csv', { cookie: admin });
    assert.equal(exp.status, 200);
    assert.doesNotMatch(exp.text, /(^|,)=SUM/m, 'sel yang diawali "=" harus dinetralkan di file CSV');

    const imp = await s.call('POST', '/api/staff/customers/import', { cookie: admin, body: { format: 'csv', content: exp.text } });
    assert.equal(imp.status, 200, imp.text);
    assert.equal(imp.json.result.updated, 2, `dua customer harus diperbarui: ${imp.text}`);

    const names = (await s.call('GET', '/api/staff/customers', { cookie: admin })).json.customers.map((c) => c.name);
    assert.ok(names.includes('-Andi'), `nama harus tetap "-Andi", dapat: ${JSON.stringify(names)}`);
    assert.ok(names.includes('=SUM(1+1) Budi'), `nama formula harus kembali utuh, dapat: ${JSON.stringify(names)}`);
  });
});

test('R1 body JSON bukan objek (null, array, string, angka, boolean) -> 400', async () => {
  await withServer({}, async (s) => {
    for (const raw of ['null', '[]', '"teks"', '123', 'true']) {
      const r = await s.call('POST', '/api/auth/login', { raw });
      assert.equal(r.status, 400, `body ${raw} harus 400, dapat ${r.status}: ${r.text}`);
      assert.equal(typeof r.json?.error, 'string', 'respons harus JSON {"error": "..."}');
    }
    assert.equal((await s.call('GET', '/api/auth/me')).status, 401, 'server harus tetap hidup');
  });
});

test('R2 cookie rusak (encoding persen tidak valid) -> 401, bukan 500', async () => {
  await withServer({}, async (s) => {
    for (const cookie of ['acesio_sid=%E0%A4%A', 'acesio_sid=%', 'foo=%zz; acesio_sid=abc']) {
      const r = await s.call('GET', '/api/auth/me', { headers: { Cookie: cookie } });
      assert.equal(r.status, 401, `cookie "${cookie}" harus 401, dapat ${r.status}: ${r.text}`);
    }
  });
});

test('R3 URL "//" -> 400 dan server tetap hidup', async () => {
  await withServer({}, async (s) => {
    const r = await s.call('GET', '//');
    assert.equal(r.status, 400, `harus 400, dapat ${r.status}: ${r.text}`);
    assert.equal((await s.call('GET', '/')).status, 200, 'halaman utama tetap bisa dibuka');
  });
});

test('R4 XLSX dengan sel ZZZZZZ1 -> 400 cepat (tanpa menghabiskan memori)', async () => {
  await withServer({}, async (s) => {
    const admin = await s.admin();
    // Kontrol: file sehat harus bisa diimpor, supaya jelas yang diuji memang sel ZZZZZZ1.
    const good = xlsxWithSheet(`<row r="1">${inline('A1', 'No RM')}${inline('B1', 'Nama')}</row><row r="2">${inline('A2', 'RM-X1')}${inline('B2', 'Customer Excel')}</row>`);
    const ok = await s.call('POST', '/api/staff/customers/import', { cookie: admin, body: { format: 'xlsx', content: good.toString('base64') } });
    assert.equal(ok.status, 200, `file XLSX sehat harus bisa diimpor: ${ok.text}`);
    assert.equal(ok.json.result.added, 1);

    const evil = xlsxWithSheet(`<row r="1">${inline('A1', 'No RM')}${inline('B1', 'Nama')}${inline('ZZZZZZ1', 'x')}</row>`);
    const t0 = Date.now();
    const r = await s.call('POST', '/api/staff/customers/import', { cookie: admin, body: { format: 'xlsx', content: evil.toString('base64') }, timeout: 8000 });
    const ms = Date.now() - t0;
    assert.equal(r.status, 400, `harus 400, dapat ${r.status}: ${r.text}`);
    assert.ok(ms < 2000, `harus ditolak cepat, butuh ${ms} ms`);
  });
});

test('R5 body terlalu besar -> 413 yang terbaca klien (bukan koneksi terputus)', async () => {
  await withServer({}, async (s) => {
    const size = 4 * 1024 * 1024; // batas bawaan 3 MB
    const res = await new Promise((resolve, reject) => {
      let got = false;
      const req = http.request({
        host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/auth/login', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': size },
      }, (r) => {
        got = true;
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        r.on('error', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.on('error', (e) => { if (!got) reject(new Error(`koneksi terputus sebelum respons terbaca: ${e.code || e.message}`)); });
      req.write(Buffer.alloc(size, 0x20));
      req.end();
    });
    assert.equal(res.status, 413, `harus 413, dapat ${res.status}`);
    assert.equal(typeof JSON.parse(res.text).error, 'string', 'badan 413 harus JSON {"error": "..."}');
    assert.equal((await s.call('GET', '/api/auth/me')).status, 401, 'server harus tetap hidup');
  });
});
