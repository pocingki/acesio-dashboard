// Tes hapus akun dan hapus tugas oleh supervisor. Handler rute dipanggil langsung dengan DATA_DIR sementara.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-svdel-'));
process.env.DATA_DIR = DATA;
process.env.NODE_ENV = 'test';

const { db } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { ymd } = await import('../server/clock.js');
const { routes } = await import('../server/routes/index.js');
await import('../server/routes/sv.js');

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
