// Tes hapus akun dan hapus tugas oleh supervisor. Handler rute dipanggil langsung dengan DATA_DIR sementara.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-svdel-'));
process.env.DATA_DIR = DATA;
process.env.NODE_ENV = 'test';

const { db, SERVICE_COUNT } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { ymd } = await import('../server/clock.js');
const { routes } = await import('../server/routes/index.js');
await import('../server/routes/sv.js');
await import('../server/routes/history.js');

after(() => {
  try { db.close(); } catch { /* sudah tertutup */ }
  fs.rmSync(DATA, { recursive: true, force: true });
});

async function call(method, url, { user, body = {} }) {
  const u = new URL(url, 'http://x');
  const route = routes.find((r) => r.method === method && r.rx.test(u.pathname));
  assert.ok(route, `rute ${method} ${u.pathname} tidak terdaftar`);
  const m = route.rx.exec(u.pathname);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  try {
    return { status: 200, body: await route.handler({ req, res: { setHeader() {} }, user, body, query: {}, params }) };
  } catch (e) {
    if (e && typeof e.status === 'number') return { status: e.status, body: { error: e.message } };
    throw e;
  }
}

const hash = await hashPassword('password-awal-1');
const mkUser = (username, role) => Number(db.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
  .run(username, `Nama ${username}`, hash, role, 'tetap', new Date().toISOString()).lastInsertRowid);
const svId = mkUser('sv1', 'supervisor');
const sv2Id = mkUser('sv2', 'supervisor');
const SV = { id: svId, name: 'Nama sv1', role: 'supervisor' };
const cust = Number(db.prepare("INSERT INTO customers (rm_no, name, created_at) VALUES ('RM-1', 'Siti', ?)").run(new Date().toISOString()).lastInsertRowid);
const audit = (a) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(a);

function mkSchedule(userId, status, { batch = '', createdBy = svId, approvedBy = null } = {}) {
  const id = Number(db.prepare(`INSERT INTO schedules (user_id, customer_id, day, start_time, status, created_by, created_at, batch, approved_by, soap_s)
    VALUES (?, ?, ?, '09:00', ?, ?, ?, ?, ?, 'rahasia')`).run(userId, cust, ymd(), status, createdBy, new Date().toISOString(), batch, approvedBy).lastInsertRowid);
  db.prepare('INSERT INTO schedule_services (schedule_id, service_id) VALUES (?, 1)').run(id);
  return id;
}
function mkRecord(userId, batch) {
  db.prepare("INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, 1, 5000, 'web', ?, ?, '', ?)")
    .run(userId, cust, new Date().toISOString(), ymd(), batch);
}
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

test('hanya supervisor: rute hapus terdaftar dengan akses sv', () => {
  for (const [m, p] of [['DELETE', '/api/sv/accounts/1'], ['DELETE', '/api/sv/schedules/1']]) {
    const r = routes.find((x) => x.method === m && x.rx.test(p));
    assert.ok(r, p);
    assert.equal(r.access, 'sv');
  }
});

test('hapus akun user: data kerja ikut hilang, tercatat di audit', async () => {
  const uid = mkUser('terapis1', 'user');
  mkSchedule(uid, 'selesai', { batch: 'b-u1' });
  mkRecord(uid, 'b-u1');
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('t1', ?, 9999999999)").run(uid);
  const other = mkUser('terapis2', 'user');
  mkRecord(other, 'b-o');

  const r = await call('DELETE', `/api/sv/accounts/${uid}`, { user: SV });
  assert.equal(r.status, 200);
  assert.equal(r.body.records_deleted, 1);
  assert.equal(r.body.schedules_deleted, 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', uid), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE user_id = ?', uid), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', uid), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE user_id = ?', other), 1, 'data user lain utuh');
  const a = audit('account.delete').at(-1);
  assert.equal(a.target_id, String(uid));
  assert.equal(JSON.parse(a.detail).username, 'terapis1');
  assert.ok(!a.detail.includes('password'));
});

test('hapus akun admin: jejak buatannya dialihkan ke supervisor, jadwal user lain tetap ada', async () => {
  const adminId = mkUser('admin1', 'admin');
  const uid = mkUser('terapis3', 'user');
  const sid = mkSchedule(uid, 'selesai', { createdBy: adminId, approvedBy: adminId });
  db.prepare('INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, 0, ?, ?)').run(uid, '2020-01-01', adminId, new Date().toISOString());

  const r = await call('DELETE', `/api/sv/accounts/${adminId}`, { user: SV });
  assert.equal(r.status, 200);
  const s = db.prepare('SELECT created_by, approved_by FROM schedules WHERE id = ?').get(sid);
  assert.equal(s.created_by, svId);
  assert.equal(s.approved_by, svId);
  assert.equal(db.prepare('SELECT reviewed_by FROM day_reviews WHERE user_id = ?').get(uid).reviewed_by, svId);
});

test('hapus akun ditolak: diri sendiri, supervisor lain, id tak ada, id tak valid', async () => {
  assert.equal((await call('DELETE', `/api/sv/accounts/${svId}`, { user: SV })).status, 400);
  assert.equal((await call('DELETE', `/api/sv/accounts/${sv2Id}`, { user: SV })).status, 400);
  assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', sv2Id), 1);
  assert.equal((await call('DELETE', '/api/sv/accounts/987654', { user: SV })).status, 404);
  assert.equal((await call('DELETE', '/api/sv/accounts/abc', { user: SV })).status, 400);
});

test('daftar akun memuat jumlah data kerja', async () => {
  const uid = mkUser('terapis4', 'user');
  mkSchedule(uid, 'baru');
  mkRecord(uid, 'b-4');
  const { accounts } = (await call('GET', '/api/sv/accounts', { user: SV })).body;
  const a = accounts.find((x) => x.id === uid);
  assert.equal(a.records_count, 1);
  assert.equal(a.schedules_count, 1);
});

test('hapus tugas selesai: jadwal, layanan jadwal, dan komisi dari batch-nya terhapus', async () => {
  const uid = mkUser('terapis5', 'user');
  const sid = mkSchedule(uid, 'selesai', { batch: 'b-5' });
  mkRecord(uid, 'b-5');
  mkRecord(uid, 'b-lain'); // layanan dari tugas lain tidak boleh ikut terhapus
  const r = await call('DELETE', `/api/sv/schedules/${sid}`, { user: SV });
  assert.equal(r.status, 200);
  assert.equal(r.body.records_deleted, 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM schedules WHERE id = ?', sid), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM schedule_services WHERE schedule_id = ?', sid), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM records WHERE batch = 'b-5'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM records WHERE batch = 'b-lain'"), 1);
  const a = audit('schedule.delete').at(-1);
  assert.equal(a.target_id, String(sid));
  assert.ok(!a.detail.includes('rahasia'), 'isi SOAP tidak masuk audit');
});

test('hapus tugas sedang dijalani diizinkan; baru dan batal ditolak 409', async () => {
  const uid = mkUser('terapis6', 'user');
  const run = mkSchedule(uid, 'berjalan');
  assert.equal((await call('DELETE', `/api/sv/schedules/${run}`, { user: SV })).status, 200);
  for (const st of ['baru', 'batal']) {
    const id = mkSchedule(uid, st);
    const r = await call('DELETE', `/api/sv/schedules/${id}`, { user: SV });
    assert.equal(r.status, 409, st);
    assert.equal(count('SELECT COUNT(*) AS n FROM schedules WHERE id = ?', id), 1);
  }
  assert.equal((await call('DELETE', '/api/sv/schedules/987654', { user: SV })).status, 404);
});

// ---------- tambah / hapus layanan ----------
const posList = () => db.prepare('SELECT position FROM services WHERE active = 1 ORDER BY position').all().map((r) => r.position);

test('layanan awal 29 dan tambah layanan memberi nomor berikutnya', async () => {
  assert.equal(SERVICE_COUNT, 29);
  assert.equal(posList().length, 29);
  const r = await call('POST', '/api/sv/services', { user: SV, body: { name: 'Layanan Baru' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.service.position, 30);
  assert.equal(posList().length, 30);
  assert.equal((await call('POST', '/api/sv/services', { user: SV, body: { name: ' ' } })).status, 400);
  assert.equal(audit('service.create').at(-1).target_id, String(r.body.service.id));
});

test('hapus layanan yang belum pernah dipakai: dihapus bersih, nomor dirapatkan', async () => {
  const add = (await call('POST', '/api/sv/services', { user: SV, body: { name: 'Sementara' } })).body.service;
  const first = db.prepare('SELECT id FROM services WHERE position = 1').get().id;
  db.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, ?, 1000)').run(svId, add.id);
  const r = await call('DELETE', `/api/sv/services/${add.id}`, { user: SV });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'deleted');
  assert.equal(count('SELECT COUNT(*) AS n FROM services WHERE id = ?', add.id), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM user_commissions WHERE service_id = ?', add.id), 0);
  assert.equal(db.prepare('SELECT id FROM services WHERE position = 1').get().id, first);
  assert.deepEqual(posList(), Array.from({ length: posList().length }, (_, i) => i + 1));
});

test('hapus layanan yang punya riwayat: dinonaktifkan, riwayat utuh, nomor dirapatkan, tidak muncul lagi', async () => {
  const uid = mkUser('terapis7', 'user');
  const target = db.prepare('SELECT id FROM services WHERE position = 3').get().id;
  const after4 = db.prepare('SELECT id FROM services WHERE position = 4').get().id;
  db.prepare("INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, ?, 7000, 'web', ?, ?, '', 'b-svc')")
    .run(uid, cust, target, new Date().toISOString(), ymd());
  db.prepare('INSERT INTO user_commissions (user_id, service_id, amount) VALUES (?, ?, 7000)').run(uid, target);
  const before = posList().length;

  const r = await call('DELETE', `/api/sv/services/${target}`, { user: SV });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'archived');
  assert.equal(count('SELECT COUNT(*) AS n FROM records WHERE service_id = ?', target), 1, 'riwayat utuh');
  assert.equal(db.prepare('SELECT active FROM services WHERE id = ?').get(target).active, 0);
  assert.equal(posList().length, before - 1);
  assert.equal(db.prepare('SELECT position FROM services WHERE id = ?').get(after4).position, 3, 'nomor bergeser naik');
  const list = (await call('GET', '/api/services', { user: SV })).body.services;
  assert.ok(!list.some((x) => x.id === target));
  const comm = (await call('GET', `/api/sv/commissions/${uid}`, { user: SV })).body.items;
  assert.ok(!comm.some((x) => x.service_id === target));
  // tidak bisa dipakai untuk jadwal baru atau diubah/dihapus lagi
  assert.equal((await call('DELETE', `/api/sv/services/${target}`, { user: SV })).status, 404);
  assert.equal((await call('PATCH', `/api/sv/services/${target}`, { user: SV, body: { name: 'Hantu' } })).status, 404);
});

test('hapus layanan ditolak bila dipakai jadwal yang belum selesai', async () => {
  const uid = mkUser('terapis8', 'user');
  const sid = mkSchedule(uid, 'baru'); // memakai layanan id 1
  const r = await call('DELETE', '/api/sv/services/1', { user: SV });
  assert.equal(r.status, 409);
  assert.equal(db.prepare('SELECT active FROM services WHERE id = 1').get().active, 1);
  db.prepare("UPDATE schedules SET status = 'batal' WHERE status IN ('baru','berjalan')").run(); // termasuk jadwal sisa tes lain
  assert.ok(sid);
  assert.equal((await call('DELETE', '/api/sv/services/1', { user: SV })).status, 200);
});

test('layanan terakhir tidak bisa dihapus; seed awal tidak mengisi ulang setelah restart', async () => {
  const ids = db.prepare('SELECT id FROM services WHERE active = 1').all().map((r) => r.id);
  for (const id of ids.slice(1)) assert.equal((await call('DELETE', `/api/sv/services/${id}`, { user: SV })).status, 200);
  assert.equal((await call('DELETE', `/api/sv/services/${ids[0]}`, { user: SV })).status, 400);
  assert.equal(posList().length, 1);
  // Server dimulai ulang: layanan yang sudah dihapus tidak boleh muncul lagi.
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    "const { db } = await import(process.env.DB_URL); console.log(db.prepare('SELECT COUNT(*) AS n FROM services WHERE active = 1').get().n);"],
  { env: { ...process.env, DB_URL: new URL('../server/db.js', import.meta.url).href }, encoding: 'utf8' });
  assert.equal(r.stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim(), '1', r.stderr);
});