// Tes Akun 4: hapus data (aturan hari), idempotensi POST /api/records, migrasi DB v3 -> v4.
// Berdiri sendiri: menjalankan server sungguhan (PORT=0, DATA_DIR sementara) lewat child_process
// dan mengisi data lewat node:sqlite. Jika test/helpers.mjs (Akun 1) sudah menyediakan starter server,
// bagian startServer() di bawah boleh diganti dengan itu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Asia/Jakarta';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const daysAgo = (n) => dayFmt.format(new Date(Date.now() - n * 86400000));
const TODAY = daysAgo(0);
const PASS = 'rahasia-123';

const scryptHash = (pw) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};

let dataDir, proc, base, sdb;
const cookies = {};

function startServer(dir) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
      cwd: root,
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, APP_TZ: TZ, ADMIN_USERNAME: 'sv', ADMIN_PASSWORD: PASS, BOT_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server tidak siap: ${out}`)), 15000);
    p.stdout.on('data', (d) => {
      out += d;
      const m = /https?:\/\/[^\s:]+:(\d+)/.exec(out);
      if (m && Number(m[1]) > 0) { clearTimeout(timer); resolve({ p, port: Number(m[1]) }); }
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => reject(new Error(`server berhenti (${code}): ${out}`)));
  });
}

async function api(who, method, url, { body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function login(username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  cookies[username] = res.headers.get('set-cookie').split(';')[0];
}

const ids = {};
const count = (sql, ...a) => sdb.prepare(sql).get(...a).n;
const addOld = (userId, day, commission = 5000) => Number(sdb.prepare(
  "INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, 1, ?, 'web', ?, ?, '', ?)",
).run(userId, ids.cust, commission, new Date().toISOString(), day, crypto.randomUUID()).lastInsertRowid);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-rec-'));
  const s = await startServer(dataDir);
  proc = s.p;
  base = `http://127.0.0.1:${s.port}`;
  sdb = new DatabaseSync(path.join(dataDir, 'acesio.db'));
  sdb.exec('PRAGMA busy_timeout = 5000');
  const now = new Date().toISOString();
  const mkUser = (u, role) => Number(sdb.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(u, `Nama ${u}`, scryptHash(PASS), role, 'tetap', now).lastInsertRowid);
  ids.ua = mkUser('ua', 'user');
  ids.ub = mkUser('ub', 'user');
  ids.adm = mkUser('adm', 'admin');
  ids.sv = sdb.prepare("SELECT id FROM users WHERE username = 'sv'").get().id;
  ids.cust = Number(sdb.prepare("INSERT INTO customers (rm_no, name, phone, origin, created_at) VALUES ('RM-1', 'Budi Test', '628111111111', 'awal', ?)").run(now).lastInsertRowid);
  sdb.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, 1, 7000)').run(ids.ua);
  for (const u of ['ua', 'ub', 'adm', 'sv']) await login(u);
});

after(() => {
  try { sdb?.close(); } catch { /* */ }
  proc?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const auditRows = (action) => sdb.prepare('SELECT * FROM audit_log WHERE action = ?').all(action);

test('user tidak bisa menghapus data 3 hari lalu: 409 dan data tetap ada', async () => {
  const rid = addOld(ids.ua, daysAgo(3));
  const r = await api('ua', 'DELETE', `/api/records/${rid}`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /lampau/);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 1);
  assert.equal(auditRows('record.delete').filter((a) => a.target_id === String(rid)).length, 0);
});

test('user tidak bisa menghapus kemarin, walau hari itu belum di-approve', async () => {
  const rid = addOld(ids.ua, daysAgo(1));
  assert.equal(count('SELECT COUNT(*) AS n FROM day_reviews WHERE user_id = ? AND day = ?', ids.ua, daysAgo(1)), 0);
  assert.equal((await api('ua', 'DELETE', `/api/records/${rid}`)).status, 409);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 1);
});

test('user menghapus data hari ini: 200 dan tercatat di audit_log', async () => {
  const rid = addOld(ids.ua, TODAY, 7000);
  const r = await api('ua', 'DELETE', `/api/records/${rid}`);
  assert.equal(r.status, 200);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 0);
  const a = auditRows('record.delete').find((x) => x.target_id === String(rid));
  assert.ok(a, 'baris audit ada');
  assert.equal(a.actor_id, ids.ua);
  assert.equal(a.target_type, 'record');
  assert.deepEqual(JSON.parse(a.detail), { user_id: ids.ua, customer_id: ids.cust, service_id: 1, commission: 7000, day: TODAY });
});

test('data hari ini yang sudah di-approve tidak bisa dihapus user (409)', async () => {
  const rid = addOld(ids.ub, TODAY);
  sdb.prepare('INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, 0, ?, ?)').run(ids.ub, TODAY, ids.sv, new Date().toISOString());
  assert.equal((await api('ub', 'DELETE', `/api/records/${rid}`)).status, 409);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 1);
});

test('data milik user lain dan admin: 404, data tetap ada', async () => {
  const rid = addOld(ids.ua, TODAY);
  assert.equal((await api('ub', 'DELETE', `/api/records/${rid}`)).status, 404);
  assert.equal((await api('adm', 'DELETE', `/api/records/${rid}`)).status, 404);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 1);
  assert.equal((await api('ua', 'DELETE', `/api/records/${rid}`)).status, 200); // bersihkan
});

test('id bukan angka: 400; id tidak ada: 404', async () => {
  assert.equal((await api('ua', 'DELETE', '/api/records/abc')).status, 400);
  assert.equal((await api('ua', 'DELETE', '/api/records/0')).status, 400);
  assert.equal((await api('ua', 'DELETE', '/api/records/999999')).status, 404);
});

test('supervisor menghapus data lama (bahkan yang sudah di-approve): 200 dan tercatat', async () => {
  const old = daysAgo(10);
  const rid = addOld(ids.ua, old, 9000);
  sdb.prepare('INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, 1, ?, ?)').run(ids.ua, old, ids.sv, new Date().toISOString());
  const r = await api('sv', 'DELETE', `/api/records/${rid}`);
  assert.equal(r.status, 200);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE id = ?', rid), 0);
  const a = auditRows('record.delete').find((x) => x.target_id === String(rid));
  assert.ok(a);
  assert.equal(a.actor_id, ids.sv);
  assert.deepEqual(JSON.parse(a.detail), { user_id: ids.ua, customer_id: ids.cust, service_id: 1, commission: 9000, day: old });
});

const post = (who, key, extra = {}) => api(who, 'POST', '/api/records', {
  body: { customer_rm: 'RM-1', service_ids: [1, 2], ...extra },
  headers: key ? { 'Idempotency-Key': key } : {},
});
const nRecords = () => count("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND day = ? AND source = 'web'", ids.ua, TODAY);

test('dua POST dengan key sama: 1 kunjungan, respons sama, ada header Idempotent-Replay', async () => {
  const before = nRecords();
  const a = await post('ua', 'key-satu-aaaa');
  const b = await post('ua', 'key-satu-aaaa');
  assert.equal(a.status, 200);
  assert.equal(b.status, a.status);
  assert.deepEqual(b.json, a.json);
  assert.equal(a.headers.get('idempotent-replay'), null);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(nRecords() - before, 2, 'hanya 2 baris (2 layanan) dibuat, bukan 4');
  assert.equal(count('SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id = ? AND key = ?', ids.ua, 'key-satu-aaaa'), 1);
});

test('key berbeda dan tanpa key: masing-masing membuat data baru', async () => {
  const before = nRecords();
  assert.equal((await post('ua', 'key-beda-0001')).status, 200);
  assert.equal((await post('ua', 'key-beda-0002')).status, 200);
  assert.equal(nRecords() - before, 4);
  assert.equal((await post('ua', null)).status, 200);
  assert.equal((await post('ua', null)).status, 200);
  assert.equal(nRecords() - before, 8);
});

test('key yang sama dipakai user lain tidak dianggap replay', async () => {
  const a = await post('ub', 'key-dipakai-bersama');
  // ub hari ini sudah di-approve (tes sebelumnya) -> 409; pakai ua untuk membuktikan keterpisahan
  assert.ok([200, 409].includes(a.status));
  const b = await post('ua', 'key-dipakai-bersama');
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('idempotent-replay'), null);
});

test('10 POST paralel dengan key sama: tepat 1 kunjungan', async () => {
  const before = nRecords();
  const rs = await Promise.all(Array.from({ length: 10 }, () => post('ua', 'key-paralel-xyz')));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => r.headers.get('idempotent-replay') === null).length, 1);
  assert.equal(rs.filter((r) => r.headers.get('idempotent-replay') === 'true').length, 9);
  assert.equal(nRecords() - before, 2);
  assert.equal(new Set(rs.map((r) => JSON.stringify(r.json))).size, 1);
});

test('key tidak valid: 400 dan tidak ada data dibuat', async () => {
  const before = nRecords();
  for (const k of ['pendek', 'x'.repeat(101), 'ada spasi di sini', 'tanda/miring-aaaa', "kutip'aaaaaaaa"]) {
    const r = await post('ua', k);
    assert.equal(r.status, 400, `key "${k}"`);
  }
  assert.equal(nRecords(), before);
});

test('gagal di tengah (layanan tidak ada): tidak ada record, key tidak tersimpan, key bisa dipakai ulang', async () => {
  const before = nRecords();
  const bad = await post('ua', 'key-gagal-0001', { service_ids: [1, 9999] });
  assert.equal(bad.status, 400);
  assert.equal(nRecords(), before, 'layanan 1 tidak boleh tertinggal');
  assert.equal(count('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?', 'key-gagal-0001'), 0);
  const ok = await post('ua', 'key-gagal-0001', { service_ids: [1] });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('idempotent-replay'), null);
  assert.equal(nRecords() - before, 1);
});

test('entri idempotensi lebih dari 24 jam dibersihkan saat start', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-idem-'));
  try {
    const first = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', "await import('./server/db.js')"], { cwd: root, env: { ...process.env, DATA_DIR: d } });
    assert.equal(first.status, 0, String(first.stderr));
    const raw = new DatabaseSync(path.join(d, 'acesio.db'));
    raw.prepare("INSERT INTO idempotency_keys (user_id, key, status, body, created_at) VALUES (1, 'lama-lama-1', 200, '{}', ?)").run(Date.now() - 25 * 3600 * 1000);
    raw.prepare("INSERT INTO idempotency_keys (user_id, key, status, body, created_at) VALUES (1, 'baru-baru-1', 200, '{}', ?)").run(Date.now() - 3600 * 1000);
    raw.close();
    const second = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', "await import('./server/idempotency.js')"], { cwd: root, env: { ...process.env, DATA_DIR: d } });
    assert.equal(second.status, 0, String(second.stderr));
    const chk = new DatabaseSync(path.join(d, 'acesio.db'));
    assert.deepEqual(chk.prepare('SELECT key FROM idempotency_keys').all().map((r) => r.key), ['baru-baru-1']);
    chk.close();
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- migrasi ----------
const V3_DDL = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','admin','supervisor')), employment TEXT NOT NULL DEFAULT 'tetap' CHECK (employment IN ('tetap','part_time')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, photo TEXT);
CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, rm_no TEXT COLLATE NOCASE, reimburse TEXT NOT NULL DEFAULT '', name TEXT NOT NULL COLLATE NOCASE,
  gender TEXT NOT NULL DEFAULT '' CHECK (gender IN ('','L','P')), birth_date TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', occupation TEXT NOT NULL DEFAULT '',
  domicile TEXT NOT NULL DEFAULT '', month TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'awal' CHECK (origin IN ('awal','baru')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_id INTEGER NOT NULL REFERENCES services(id), commission INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'web', created_at TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', batch TEXT NOT NULL DEFAULT '');
CREATE TABLE user_commissions (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, service_id));
CREATE TABLE day_reviews (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, late INTEGER NOT NULL CHECK (late IN (0,1)),
  reviewed_by INTEGER NOT NULL REFERENCES users(id), reviewed_at TEXT NOT NULL, PRIMARY KEY (user_id, day));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_customers_rm ON customers(rm_no) WHERE rm_no IS NOT NULL;
`;

const probe = `
const { db, closeDb } = await import('./server/db.js');
const q = (s) => db.prepare(s).all();
console.log(JSON.stringify({
  version: db.prepare('PRAGMA user_version').get().user_version,
  tables: q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name),
  indexes: q("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name),
  users: q('SELECT username FROM users').map((r) => r.username),
  customers: q('SELECT rm_no, name FROM customers'),
  records: q('SELECT id, commission, day FROM records'),
  reviews: q('SELECT day FROM day_reviews').length,
  auditCols: q("SELECT name FROM pragma_table_info('audit_log')").map((r) => r.name),
  idemCols: q("SELECT name FROM pragma_table_info('idempotency_keys')").map((r) => r.name),
}));
closeDb();
`;
const runProbe = (dir) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe], { cwd: root, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
const makeV3 = (version) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-mig-'));
  const raw = new DatabaseSync(path.join(d, 'acesio.db'));
  raw.exec(V3_DDL);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (username, name, password_hash, role, created_at) VALUES ('lama', 'User Lama', 'x', 'user', ?)").run(now);
  raw.prepare("INSERT INTO services (position, name) VALUES (1, 'Layanan 1')").run();
  raw.prepare("INSERT INTO customers (rm_no, name, created_at) VALUES ('RM-9', 'Cust Lama', ?)").run(now);
  raw.prepare("INSERT INTO records (user_id, customer_id, service_id, commission, created_at, day) VALUES (1, 1, 1, 1234, ?, '2026-01-02')").run(now);
  raw.prepare("INSERT INTO records (user_id, customer_id, service_id, commission, created_at, day) VALUES (1, 1, 1, 4321, ?, '2026-01-03')").run(now);
  raw.prepare("INSERT INTO day_reviews VALUES (1, '2026-01-02', 0, 1, ?)").run(now);
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.close();
  return d;
};

test('migrasi DB versi 3 -> 4: tabel & indeks baru ada, data lama utuh, idempoten saat start ulang', () => {
  const d = makeV3(3);
  try {
    const a = runProbe(d);
    assert.equal(a.version, 4);
    for (const t of ['audit_log', 'idempotency_keys']) assert.ok(a.tables.includes(t), t);
    for (const i of ['idx_audit_at', 'idx_audit_action']) assert.ok(a.indexes.includes(i), i);
    assert.deepEqual(a.auditCols, ['id', 'at', 'actor_id', 'actor_name', 'action', 'target_type', 'target_id', 'detail', 'ip']);
    assert.deepEqual(a.idemCols, ['user_id', 'key', 'status', 'body', 'created_at']);
    assert.deepEqual(a.users, ['lama']);
    assert.deepEqual(a.customers, [{ rm_no: 'RM-9', name: 'Cust Lama' }]);
    assert.deepEqual(a.records.map((r) => r.commission), [1234, 4321]);
    assert.equal(a.reviews, 1);
    assert.deepEqual(runProbe(d), a, 'start kedua tidak mengubah apa pun');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('DB dengan user_version lebih baru tidak diturunkan; DB baru langsung versi 4', () => {
  const d = makeV3(7);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-fresh-'));
  try {
    assert.equal(runProbe(d).version, 7);
    const f = runProbe(fresh);
    assert.equal(f.version, 4);
    assert.ok(f.tables.includes('audit_log') && f.tables.includes('idempotency_keys'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(fresh, { recursive: true, force: true }); }
});