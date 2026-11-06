// Tes Supervisor + bot + seed. Handler rute dipanggil langsung (tanpa HTTP) dengan DATA_DIR sementara,
// jadi tes deterministik dan tidak bergantung pada urutan/timing permintaan.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `acesio-${p}-`));
const DATA = tmpDir('svbot');
const BOT_KEY = 'kunci-bot-rahasia-123';
process.env.DATA_DIR = DATA;
process.env.BOT_API_KEY = BOT_KEY;
process.env.NODE_ENV = 'test';
delete process.env.TRUST_PROXY;

const { db } = await import('../server/db.js');
const { hashPassword, verifyPassword, login } = await import('../server/auth.js');
const { logAudit } = await import('../server/audit.js');
const { ymd } = await import('../server/clock.js');
// Registry dulu, baru modul rute (modul rute mengimpor `add` dari registry; jangan dibalik).
const { routes } = await import('../server/routes/index.js');
await import('../server/routes/sv.js');
await import('../server/routes/bot.js');

const cleanup = [DATA];
after(() => {
  try { db.close(); } catch { /* sudah tertutup */ }
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

// Aktor supervisor "basi": tidak ada di tabel users. Meniru permintaan yang sesinya lolos
// sebelum akunnya diturunkan, jadi aturan supervisor-terakhir bisa diuji tanpa balapan timing.
const SV = { id: 99999, name: 'Penguji', role: 'supervisor' };

async function call(method, url, { user = SV, body = {}, headers = {}, ip = '127.0.0.1' } = {}) {
  const u = new URL(url, 'http://x');
  const route = routes.find((r) => r.method === method && r.rx.test(u.pathname));
  assert.ok(route, `rute ${method} ${u.pathname} tidak terdaftar`);
  const m = route.rx.exec(u.pathname);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  const req = { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: ip } };
  try {
    const out = await route.handler({ req, res, user, body, query: Object.fromEntries(u.searchParams), params });
    return { status: 200, body: out, res };
  } catch (e) {
    if (e && typeof e.status === 'number') return { status: e.status, body: { error: e.message }, res };
    throw e;
  }
}

async function insertUser(username, role = 'user', active = 1) {
  const hash = await hashPassword('password-awal-1');
  return Number(db.prepare('INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(username, `Nama ${username}`, hash, role, 'tetap', active, new Date().toISOString()).lastInsertRowid);
}
function insertCustomer(rm, name = 'Customer Uji') {
  return Number(db.prepare('INSERT INTO customers (rm_no, name, created_at) VALUES (?, ?, ?)').run(rm, name, new Date().toISOString()).lastInsertRowid);
}
function insertRecord(userId, customerId, serviceId, commission = 0) {
  const iso = new Date().toISOString();
  return Number(db.prepare('INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, customerId, serviceId, commission, 'web', iso, ymd(), '', `${iso}|${userId}|${customerId}`).lastInsertRowid);
}
const auditRows = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
const detailOf = (row) => (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail);
const countRecords = (customerId) => db.prepare('SELECT COUNT(*) AS n FROM records WHERE customer_id = ?').get(customerId).n;

// ---------- audit: komisi & akun ----------

test('perubahan komisi menghasilkan baris audit (nilai lama -> baru) tanpa password', async () => {
  const password = 'RahasiaUnik-123';
  const created = await call('POST', '/api/sv/accounts', { body: { username: 'terapis1', name: 'Terapis Satu', password, role: 'user' } });
  assert.equal(created.status, 200);
  const uid = created.body.id;
  const cust = insertCustomer('RM-T1');
  insertRecord(uid, cust, 1, 0);
  insertRecord(uid, cust, 1, 0);

  const r = await call('PUT', `/api/sv/commissions/${uid}`, { body: { amounts: { 1: 15000, 2: 20000 }, apply_to_history: true } });
  assert.equal(r.status, 200);
  const rows = auditRows('commission.update');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_name, SV.name);
  assert.equal(rows[0].target_id, String(uid));
  const d = detailOf(rows[0]);
  assert.equal(d.user_id, uid);
  assert.equal(d.apply_to_history, true);
  assert.equal(d.history_rows_changed, 2);
  assert.deepEqual(d.changes, { 1: { from: 0, to: 15000 }, 2: { from: 0, to: 20000 } });

  // nilai sama -> tidak ada perubahan -> tidak ada baris audit baru; hanya yang berubah dicatat
  await call('PUT', `/api/sv/commissions/${uid}`, { body: { amounts: { 1: 15000, 2: 20000 } } });
  assert.equal(auditRows('commission.update').length, 1);
  await call('PUT', `/api/sv/commissions/${uid}`, { body: { amounts: { 1: 15000, 2: 5000 } } });
  const last = auditRows('commission.update').at(-1);
  assert.deepEqual(detailOf(last).changes, { 2: { from: 20000, to: 5000 } });
  assert.equal(detailOf(last).apply_to_history, false);

  // pembuatan akun tercatat, dan password tidak muncul di baris audit mana pun
  const created1 = auditRows('account.create');
  assert.equal(created1.length, 1);
  assert.equal(detailOf(created1[0]).username, 'terapis1');
  const everything = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  assert.ok(!everything.includes(password), 'password bocor ke audit_log');
});

test('komisi: layanan yang tidak ada ditolak dan tidak meninggalkan jejak audit palsu', async () => {
  const uid = await insertUser('terapis-x');
  const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const r = await call('PUT', `/api/sv/commissions/${uid}`, { body: { amounts: { 1: 1000, 9999: 500 } } });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, before);
  assert.equal(db.prepare('SELECT amount FROM user_commissions WHERE user_id = ? AND service_id = 1').get(uid), undefined, 'perubahan harus ikut dibatalkan');
});

test('ganti password akun lain: tercatat tanpa password, dan sesinya dicabut', async () => {
  const uid = await insertUser('terapis2');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('hash-sesi-uji', uid, Date.now() + 3600_000);
  const baru = 'PasswordBaru-987';
  const r = await call('PATCH', `/api/sv/accounts/${uid}`, { body: { password: baru, name: 'Terapis Dua' } });
  assert.equal(r.status, 200);
  const row = auditRows('account.update').at(-1);
  const d = detailOf(row);
  assert.equal(d.changes.password_changed, true);
  assert.deepEqual(d.changes.name, { from: 'Nama terapis2', to: 'Terapis Dua' });
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(baru));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n, 0);
  assert.ok(await verifyPassword(baru, db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid).password_hash));
});

test('supervisor mengubah username akun mana pun; login lama berhenti, sesi yang ada tetap', async () => {
  const uid = await insertUser('terapis-lama');
  const adminId = await insertUser('admin-lama', 'admin');
  const svId = await insertUser('sv-lama', 'supervisor');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('hash-username', uid, Date.now() + 3600_000);
  const bad = await call('PATCH', `/api/sv/accounts/${uid}`, { body: { username: 'ab' } });
  assert.equal(bad.status, 400);
  const taken = await call('PATCH', `/api/sv/accounts/${uid}`, { body: { username: 'admin-lama' } });
  assert.equal(taken.status, 409);
  const r = await call('PATCH', `/api/sv/accounts/${uid}`, { body: { username: 'terapis-baru' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(uid).username, 'terapis-baru');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n, 1, 'ganti username tidak mencabut sesi');
  const d = detailOf(auditRows('account.update').at(-1));
  assert.deepEqual(d.changes.username, { from: 'terapis-lama', to: 'terapis-baru' });
  assert.equal(d.username, 'terapis-baru');
  const { enrichAuditRows } = await import('../server/auditview.js');
  const shown = enrichAuditRows([auditRows('account.update').at(-1)])[0];
  assert.match(shown.summary, /username/);
  assert.ok(shown.items.some((i) => i.label === 'Username' && i.value === 'terapis-lama → terapis-baru'));
  assert.equal((await call('PATCH', `/api/sv/accounts/${adminId}`, { body: { username: 'admin-baru' } })).status, 200);
  assert.equal((await call('PATCH', `/api/sv/accounts/${svId}`, { body: { username: 'sv-baru' } })).status, 200);
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(adminId).username, 'admin-baru');
  assert.equal(await login('admin-lama', 'password-awal-1', { ip: '10.9.9.9' }), null);
  const signed = await login('admin-baru', 'password-awal-1', { ip: '10.9.9.9' });
  assert.equal(signed.user.id, adminId);
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(svId).username, 'sv-baru');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(svId);
  const same = await call('PATCH', `/api/sv/accounts/${uid}`, { body: { username: 'terapis-baru' } });
  assert.equal(same.status, 200);
  assert.equal(auditRows('account.update').filter((row) => detailOf(row).changes?.username?.to === 'terapis-baru').length, 1);
});

test('perubahan layanan tercatat (service.update); tanpa perubahan tidak dicatat', async () => {
  const s = db.prepare('SELECT name FROM services WHERE id = 3').get();
  const r = await call('PATCH', '/api/sv/services/3', { body: { name: 'Terapi Baru' } });
  assert.equal(r.status, 200);
  const rows = auditRows('service.update');
  assert.equal(rows.length, 1);
  assert.deepEqual(detailOf(rows[0]).changes.name, { from: s.name, to: 'Terapi Baru' });
  await call('PATCH', '/api/sv/services/3', { body: { name: 'Terapi Baru' } });
  assert.equal(auditRows('service.update').length, 1);
});

// ---------- aturan supervisor terakhir ----------

test('supervisor aktif terakhir tidak bisa diturunkan atau dinonaktifkan', async () => {
  const a = await insertUser('svA', 'supervisor');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'supervisor' AND active = 1").get().n, 1);

  const demote = await call('PATCH', `/api/sv/accounts/${a}`, { body: { role: 'admin' } });
  assert.equal(demote.status, 400);
  assert.match(demote.body.error, /terakhir/);
  const off = await call('PATCH', `/api/sv/accounts/${a}`, { body: { active: false } });
  assert.equal(off.status, 400);
  const row = db.prepare('SELECT role, active FROM users WHERE id = ?').get(a);
  assert.deepEqual({ ...row }, { role: 'supervisor', active: 1 });

  // ada supervisor aktif lain -> boleh; setelah itu yang tersisa jadi yang terakhir -> ditolak lagi
  const b = await insertUser('svB', 'supervisor');
  assert.equal((await call('PATCH', `/api/sv/accounts/${a}`, { body: { role: 'admin' } })).status, 200);
  const again = await call('PATCH', `/api/sv/accounts/${b}`, { body: { active: false } });
  assert.equal(again.status, 400);
  assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(b).active, 1);
});

// ---------- DELETE /api/sv/reviews ----------

test('DELETE /api/sv/reviews: validasi user_id & day, lalu tercatat sebagai review.cancel', async () => {
  for (const q of ['', 'user_id=abc&day=2026-10-30', 'user_id=1.5&day=2026-10-30', 'user_id=-3&day=2026-10-30', 'user_id=1', 'user_id=1&day=2026-1-5', 'user_id=1&day=kemarin', 'day=2026-10-30']) {
    const r = await call('DELETE', `/api/sv/reviews?${q}`);
    assert.equal(r.status, 400, `query "${q}" harus 400`);
  }
  const uid = await insertUser('terapis3');
  const reviewer = await insertUser('admin-uji', 'admin');
  const day = '2026-10-29';
  db.prepare('INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, 1, ?, ?)').run(uid, day, reviewer, new Date().toISOString());
  const r = await call('DELETE', `/api/sv/reviews?user_id=${uid}&day=${day}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM day_reviews WHERE user_id = ?').get(uid).n, 0);
  const rows = auditRows('review.cancel');
  assert.equal(rows.length, 1);
  assert.deepEqual({ user_id: detailOf(rows[0]).user_id, day: detailOf(rows[0]).day, late: detailOf(rows[0]).late }, { user_id: uid, day, late: true });
  // membatalkan yang tidak ada: tidak error, tidak ada jejak baru
  assert.equal((await call('DELETE', `/api/sv/reviews?user_id=${uid}&day=${day}`)).status, 200);
  assert.equal(auditRows('review.cancel').length, 1);
});

// ---------- GET /api/sv/audit ----------

test('GET /api/sv/audit: filter action, pencarian ber-ESCAPE, 50 per halaman, terbaru dulu, page divalidasi', async () => {
  for (const p of ['abc', '0', '-1', '1.5']) assert.equal((await call('GET', `/api/sv/audit?page=${p}`)).status, 400, `page=${p}`);

  logAudit({ actor: { id: 1, name: 'Pencari' }, action: 'test.like', targetType: 'x', targetId: 'x%y', detail: { a: 1 }, ip: '1.1.1.1' });
  logAudit({ actor: { id: 1, name: 'Pencari' }, action: 'test.like', targetType: 'x', targetId: 'xzzy', detail: { a: 2 }, ip: '1.1.1.1' });
  const lit = await call('GET', `/api/sv/audit?action=test.like&q=${encodeURIComponent('x%y')}`);
  assert.equal(lit.body.total, 1, '% harus dicari apa adanya, bukan wildcard');
  assert.equal(lit.body.rows[0].target_id, 'x%y');
  assert.equal((await call('GET', `/api/sv/audit?action=test.like&q=Pencari`)).body.total, 2);
  assert.equal((await call('GET', `/api/sv/audit?action=test.like&q=${encodeURIComponent('"a":2')}`)).body.total, 1, 'q juga mencari di detail');

  for (let i = 0; i < 55; i++) logAudit({ actor: { id: 1, name: 'Massal' }, action: 'test.bulk', targetType: 'x', targetId: `b${i}`, detail: {}, ip: null });
  const p1 = await call('GET', '/api/sv/audit?action=test.bulk');
  const p2 = await call('GET', '/api/sv/audit?action=test.bulk&page=2');
  assert.equal(p1.body.total, 55);
  assert.equal(p1.body.page_size, 50);
  assert.equal(p1.body.rows.length, 50);
  assert.equal(p2.body.rows.length, 5);
  assert.equal(p2.body.page, 2);
  assert.equal(p1.body.rows[0].target_id, 'b54', 'terbaru dulu');
  const ids = p1.body.rows.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => y - x));
});

// ---------- bot: API key ----------

test('11 percobaan API key salah -> 429; key benar dari IP lain tetap bekerja', async () => {
  const ip = '10.1.1.1';
  for (let i = 1; i <= 10; i++) {
    const r = await call('GET', '/api/bot/services', { ip, headers: { 'X-API-Key': `salah-${i}` } });
    assert.equal(r.status, 401, `percobaan ${i}`);
  }
  const eleventh = await call('GET', '/api/bot/services', { ip, headers: { 'X-API-Key': 'salah-11' } });
  assert.equal(eleventh.status, 429);
  // selama diblokir, key yang benar dari IP yang sama pun ditolak
  assert.equal((await call('GET', '/api/bot/services', { ip, headers: { 'X-API-Key': BOT_KEY } })).status, 429);
  // IP lain tidak terpengaruh
  const ok = await call('GET', '/api/bot/services', { ip: '10.1.1.2', headers: { 'X-API-Key': BOT_KEY } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.services.length, 29);
});

test('key bot benar bekerja; key kosong, kepanjangan, atau awalan key ditolak 401', async () => {
  const ip = '10.1.2.1';
  assert.equal((await call('GET', '/api/bot/services', { ip, headers: { 'x-api-key': BOT_KEY } })).status, 200);
  for (const bad of ['', BOT_KEY.slice(0, -1), `${BOT_KEY}x`, 'x'.repeat(5000)]) {
    assert.equal((await call('GET', '/api/bot/services', { ip, headers: { 'x-api-key': bad } })).status, 401);
  }
  assert.equal((await call('GET', '/api/bot/services', { ip: '10.1.2.2' })).status, 401, 'tanpa header sama sekali');
});

// ---------- bot: idempotensi ----------

test('request_id / Idempotency-Key sama dua kali -> satu record, respons sama, header replay', async () => {
  const ip = '10.2.2.2';
  const headers = { 'X-API-Key': BOT_KEY };
  await insertUser('petugas-bot');
  const cust = insertCustomer('RM-BOT1', 'Customer Bot');
  const post = (extra = {}, h = {}) => call('POST', '/api/bot/records', { ip, headers: { ...headers, ...h }, body: { username: 'petugas-bot', customer_rm: 'RM-BOT1', service_ids: [1, 2], ...extra } });

  const first = await post({ request_id: 'req-abc-12345' });
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 2);
  assert.equal(first.body.record_ids.length, 2);
  assert.equal(first.res.headers['Idempotent-Replay'], undefined);
  const second = await post({ request_id: 'req-abc-12345' });
  assert.deepEqual(second.body, JSON.parse(JSON.stringify(first.body))); // replay = body yang tersimpan sebagai JSON
  assert.equal(second.res.headers['Idempotent-Replay'], 'true');
  assert.equal(countRecords(cust), 2, 'permintaan ulang tidak boleh membuat data baru');
  const clash = await post({ request_id: 'req-abc-12345', service_ids: [3] });
  assert.equal(clash.status, 409);
  assert.equal(countRecords(cust), 2, 'ID sama dengan isi berbeda tidak boleh mencatat layanan baru');
  const dbIds = db.prepare('SELECT id FROM records WHERE customer_id = ? ORDER BY id').all(cust).map((r) => r.id);
  assert.deepEqual([...first.body.record_ids].sort((a, b) => a - b), dbIds);

  // key berbeda = permintaan baru
  await post({ request_id: 'req-abc-99999' });
  assert.equal(countRecords(cust), 4);

  // lewat header Idempotency-Key
  await post({}, { 'Idempotency-Key': 'hdr-key-12345' });
  const replay = await post({}, { 'Idempotency-Key': 'hdr-key-12345' });
  assert.equal(replay.res.headers['Idempotent-Replay'], 'true');
  assert.equal(countRecords(cust), 6);

  // tanpa request_id: ditolak, tidak ada baris baru
  assert.equal((await post()).status, 400);
  assert.equal((await post()).status, 400);
  assert.equal(countRecords(cust), 6);

  // key rusak / bentrok
  assert.equal((await post({ request_id: 'pendek' })).status, 400);
  assert.equal((await post({ request_id: 'spasi tidak boleh' })).status, 400);
  assert.equal((await post({ request_id: 123456789 })).status, 400);
  assert.equal((await post({ request_id: 'req-abc-11111' }, { 'Idempotency-Key': 'req-abc-22222' })).status, 400);
  assert.equal(countRecords(cust), 6);
});

// ---------- seed ----------

function runSeed(dir, { args = [], env = {}, input = '' } = {}) {
  return spawnSync(process.execPath, ['--no-warnings', 'scripts/seed-demo.js', ...args], {
    cwd: ROOT, input, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test', ...env },
  });
}
const demoPassword = (out) => /Password\s*:\s*(\S+)/.exec(out)?.[1];

test('seed menolak NODE_ENV=production, bahkan dengan --force, tanpa menyentuh database', () => {
  const dir = tmpDir('seed-prod'); cleanup.push(dir);
  for (const args of [[], ['--force']]) {
    const r = runSeed(dir, { args, env: { NODE_ENV: 'production' }, input: 'SAYA YAKIN\n' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /production/);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'acesio.db')), 'database tidak boleh dibuat');
});

test('seed di database kosong: password acak per eksekusi (bukan demo12345) dan berfungsi', async () => {
  const d1 = tmpDir('seed-a'); const d2 = tmpDir('seed-b'); cleanup.push(d1, d2);
  const r1 = runSeed(d1); const r2 = runSeed(d2);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const p1 = demoPassword(r1.stdout); const p2 = demoPassword(r2.stdout);
  assert.ok(p1 && p1.length >= 8);
  assert.notEqual(p1, 'demo12345');
  assert.notEqual(p1, p2, 'password harus berbeda tiap eksekusi');
  assert.ok(!r1.stdout.includes('demo12345'));
  const seeded = new DatabaseSync(path.join(d1, 'acesio.db'));
  try {
    for (const u of ['sari', 'budi', 'dewi']) {
      const row = seeded.prepare('SELECT password_hash FROM users WHERE username = ?').get(u);
      assert.ok(await verifyPassword(p1, row.password_hash), `password ${u}`);
      assert.ok(!(await verifyPassword('demo12345', row.password_hash)));
    }
    // 40 record acak + satu record per layanan pada jadwal demo yang diselesaikan seed (terhubung lewat schedules.batch).
    const viaJadwal = seeded.prepare("SELECT COUNT(*) AS n FROM records WHERE batch IN (SELECT batch FROM schedules WHERE batch <> '')").get().n;
    assert.ok(viaJadwal >= 1, 'jadwal selesai demo harus punya record');
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM records').get().n, 40 + viaJadwal);
    const sch = seeded.prepare('SELECT status, COUNT(*) AS n FROM schedules GROUP BY status').all();
    const byStatus = Object.fromEntries(sch.map((r) => [r.status, r.n]));
    assert.ok(byStatus.baru && byStatus.berjalan && byStatus.selesai && byStatus.batal, `jadwal demo harus campuran status: ${JSON.stringify(byStatus)}`);
    assert.equal(seeded.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'selesai' AND soap_s <> '' AND soap_o <> '' AND soap_a <> '' AND soap_p <> ''").get().n, byStatus.selesai, 'jadwal selesai demo lengkap dengan SOAP');
    assert.equal(seeded.prepare('SELECT COUNT(*) AS n FROM schedules s WHERE NOT EXISTS (SELECT 1 FROM schedule_services x WHERE x.schedule_id = s.id)').get().n, 0, 'setiap jadwal punya layanan');
    assert.ok(seeded.prepare('SELECT COUNT(*) AS n FROM notifications').get().n >= sch.length, 'notifikasi awal dibuat');
  } finally { seeded.close(); }
});

test('seed menolak database yang sudah berisi data; --force butuh "SAYA YAKIN" persis', () => {
  const dir = tmpDir('seed-filled'); cleanup.push(dir);
  assert.equal(runSeed(dir).status, 0);
  const count = () => { const c = new DatabaseSync(path.join(dir, 'acesio.db')); const n = c.prepare('SELECT COUNT(*) AS n FROM records').get().n; c.close(); return n; };
  const before = count();

  const again = runSeed(dir);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /DITOLAK/);
  // --force saja tidak cukup
  for (const input of ['', 'ya\n', 'saya yakin\n', 'SAYA YAKIN BANGET\n']) {
    const r = runSeed(dir, { args: ['--force'], input });
    assert.notEqual(r.status, 0, `input "${input.trim()}" harus ditolak`);
  }
  assert.equal(count(), before, 'tidak ada data yang berubah');
  const forced = runSeed(dir, { args: ['--force'], input: 'SAYA YAKIN\n' });
  assert.equal(forced.status, 0, forced.stderr);
});

test('seed menolak database dengan records walau users hanya berisi supervisor awal', () => {
  const dir = tmpDir('seed-real'); cleanup.push(dir);
  const dbUrl = new URL('../server/db.js', import.meta.url).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbUrl)});
    const now = new Date().toISOString();
    const uid = Number(db.prepare("INSERT INTO users (username, name, password_hash, role, active, created_at) VALUES ('admin', 'Supervisor', 'x', 'supervisor', 1, ?)").run(now).lastInsertRowid);
    const cid = Number(db.prepare("INSERT INTO customers (rm_no, name, created_at) VALUES ('RM-ASLI', 'Customer Asli', ?)").run(now).lastInsertRowid);
    db.prepare("INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, 1, 0, 'web', ?, '2026-10-30', '', 'b')").run(uid, cid, now);
  `;
  const setup = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
  assert.equal(setup.status, 0, setup.stderr);
  const r = runSeed(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /records/);
  const c = new DatabaseSync(path.join(dir, 'acesio.db'));
  try { assert.equal(c.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1); } finally { c.close(); }
});