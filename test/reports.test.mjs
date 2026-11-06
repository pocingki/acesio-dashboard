// Tes Akun 6: laporan dan pencarian. Menjalankan server sungguhan (PORT=0, DATA_DIR sementara),
// lalu menyiapkan data besar langsung lewat node:sqlite supaya tes cepat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TZ = 'Asia/Jakarta';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const OLD_DAY = '2025-01-15'; // hari lampau, supaya tes konsistensi tidak tercampur data lain

let proc, base, dataDir, sqlite;
const sessions = {};

async function api(who, method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who && sessions[who]) headers.Cookie = sessions[who];
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON (CSV) */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(name, username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username} gagal`);
  sessions[name] = res.headers.getSetCookie()[0].split(';')[0];
}

async function makeUser(username, role = 'user', employment = 'tetap') {
  const r = await api('sv', 'POST', '/api/sv/accounts', { username, name: `Nama ${username}`, password: 'rahasia123', role, employment });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await login(username, username, 'rahasia123');
  return r.json.id;
}

const auditRows = (action) => sqlite.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action)
  .map((r) => {
    let d = r.detail;
    while (typeof d === 'string') d = JSON.parse(d);
    return { ...r, detail: d };
  });

let nextCustomer = 1;
function addCustomer({ rm, name, phone = '' }) {
  const now = new Date().toISOString();
  const info = sqlite.prepare("INSERT INTO customers (rm_no, name, phone, origin, created_at, updated_at) VALUES (?, ?, ?, 'awal', ?, ?)")
    .run(rm ?? `RMX-${String(nextCustomer++).padStart(5, '0')}`, name, phone, now, now);
  return Number(info.lastInsertRowid);
}
function addRecord({ userId, customerId, serviceId, day = today, commission = 0, batch }) {
  sqlite.prepare('INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, customerId, serviceId, commission, 'web', new Date().toISOString(), day, '', batch ?? `b-${userId}-${customerId}-${day}-${serviceId}`);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-reports-'));
  proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, APP_TZ: TZ, ACCESS_HOURS: 'off', SESSION_TIMER: 'off', ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'rahasia-boss-1', BOT_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Server tidak mencetak port dalam 15 detik')), 15000);
    proc.stdout.on('data', (c) => {
      buf += c;
      const m = /https?:\/\/[^\s:]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.on('exit', (code) => reject(new Error(`Server berhenti lebih awal (kode ${code})`)));
  });
  sqlite = new DatabaseSync(path.join(dataDir, 'acesio.db'));
  sqlite.exec('PRAGMA busy_timeout = 5000');
  await login('sv', 'boss', 'rahasia-boss-1');
});

after(() => {
  proc?.removeAllListeners('exit');
  proc?.kill();
  try { sqlite?.close(); } catch { /* sudah tertutup */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- pencarian riwayat (#7) ----------
test('pencarian "Layanan 9" tidak cocok ke nomor telepon, nomor 3 digit cocok ke No WA', async () => {
  const uid = await makeUser('cari1');
  const cid = addCustomer({ rm: 'RMT-001', name: 'Pelanggan Satu', phone: '628129999999' });
  addRecord({ userId: uid, customerId: cid, serviceId: 1 }); // hanya Layanan 1

  const bug = await api('cari1', 'GET', '/api/records/mine?q=' + encodeURIComponent('Layanan 9'));
  assert.equal(bug.status, 200);
  assert.equal(bug.json.records.length, 0, 'angka 9 jangan dicocokkan ke No WA');
  assert.deepEqual(bug.json.totals, { customers: 0, services: 0 });

  const ctrl = await api('cari1', 'GET', '/api/records/mine?q=' + encodeURIComponent('Layanan 1'));
  assert.equal(ctrl.json.records.length, 1, 'kontrol: nama layanan tetap cocok');

  const byRm = await api('cari1', 'GET', '/api/records/mine?q=rmt-001');
  assert.equal(byRm.json.records.length, 1, 'No RM tanpa peduli huruf besar/kecil');

  const phone3 = await api('cari1', 'GET', '/api/records/mine?q=812');
  assert.equal(phone3.json.records.length, 1, 'angka murni 3 digit cocok ke No WA');

  const phone0 = await api('cari1', 'GET', '/api/records/mine?q=' + encodeURIComponent('0812-99'));
  assert.equal(phone0.json.records.length, 1, 'awalan 0 dicocokkan sebagai 62');

  const short = await api('cari1', 'GET', '/api/records/mine?q=12');
  assert.equal(short.json.records.length, 0, 'angka kurang dari 3 digit tidak mencari No WA');

  const mixed = await api('cari1', 'GET', '/api/records/mine?q=' + encodeURIComponent('Pelanggan 812'));
  assert.equal(mixed.json.records.length, 0, 'campuran huruf+angka tidak mencari No WA');
});

test('ekspor riwayat memakai pencarian yang sama', async () => {
  const bug = await api('cari1', 'GET', '/api/records/mine/export?format=csv&q=' + encodeURIComponent('Layanan 9'));
  assert.equal(bug.status, 200);
  assert.equal(bug.text.trim().split(/\r?\n/).length, 1, 'hanya baris judul');
  const ok = await api('cari1', 'GET', '/api/records/mine/export?format=csv&q=812');
  assert.equal(ok.text.trim().split(/\r?\n/).length, 2);
  const bad = await api('cari1', 'GET', '/api/records/mine/export?format=pdf');
  assert.equal(bad.status, 400);
});

// ---------- batas 1000 baris ----------
test('totals tidak terpotong pada 1200 record; records 1000 dan truncated=true', async () => {
  const uid = await makeUser('besar1');
  sqlite.exec('BEGIN');
  for (let i = 0; i < 400; i++) {
    const cid = addCustomer({ name: `Massal ${i}`, phone: '' });
    for (const sid of [1, 2, 3]) addRecord({ userId: uid, customerId: cid, serviceId: sid, batch: `big-${i}` });
  }
  sqlite.exec('COMMIT');

  const r = await api('besar1', 'GET', '/api/records/mine');
  assert.equal(r.status, 200);
  assert.equal(r.json.records.length, 1000);
  assert.deepEqual(r.json.totals, { customers: 400, services: 1200 });
  assert.equal(r.json.truncated, true);

  const small = await api('cari1', 'GET', '/api/records/mine');
  assert.equal(small.json.truncated, false);
  assert.deepEqual(small.json.totals, { customers: 1, services: 1 });

  const exp = await api('besar1', 'GET', '/api/records/mine/export?format=csv');
  assert.equal(exp.text.trim().split(/\r?\n/).length, 1201, 'ekspor memuat semua 1200 baris + judul');
});

// ---------- validasi parameter ----------
test('from > to dan id bukan angka dibalas 400 di semua endpoint', async () => {
  const bad = '?from=2026-02-10&to=2026-02-01';
  for (const url of ['/api/staff/summary', '/api/staff/usage', '/api/staff/users', '/api/staff/attendance', '/api/staff/charts', '/api/staff/export']) {
    const r = await api('sv', 'GET', url + bad);
    assert.equal(r.status, 400, url);
    assert.equal(r.json.error, 'Tanggal awal tidak boleh setelah tanggal akhir', url);
  }
  assert.equal((await api('besar1', 'GET', '/api/records/mine' + bad)).status, 400);
  assert.equal((await api('besar1', 'GET', '/api/records/mine/export' + bad)).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/summary?from=bukan-tanggal')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/summary?from=2026-02-30')).status, 400);

  assert.equal((await api('sv', 'GET', '/api/staff/export?user_id=abc')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/export?user_id=1abc')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/users/abc/detail')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/users/1/detail?day=kemarin')).status, 400);
  assert.equal((await api('sv', 'POST', '/api/staff/reviews', { user_id: 'abc', day: today, late: false })).status, 400);
  assert.equal((await api('sv', 'PATCH', '/api/staff/customers/abc', { rm_no: 'X', name: 'Xx' })).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/customers/abc/visits')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/customers?page=abc')).status, 400);
  assert.equal((await api('sv', 'GET', '/api/staff/attendance?page=0')).status, 400);

  // parameter yang sah tetap lolos
  assert.equal((await api('sv', 'GET', '/api/staff/summary?from=2026-02-01&to=2026-02-01')).status, 200);
  assert.equal((await api('sv', 'GET', '/api/staff/summary?from=&to=')).status, 200);
});

test('attendance berpaging: {rows,total,page,page_size,today}', async () => {
  const uid = await makeUser('hadir1');
  const cid = addCustomer({ name: 'Hadir Satu' });
  for (let d = 1; d <= 7; d++) addRecord({ userId: uid, customerId: cid, serviceId: 1, day: `2024-03-0${d}` });
  const q = '&from=2024-03-01&to=2024-03-31';
  const p1 = await api('sv', 'GET', '/api/staff/attendance?page=1&page_size=3' + q);
  assert.equal(p1.status, 200);
  assert.equal(p1.json.total, 7);
  assert.equal(p1.json.page, 1);
  assert.equal(p1.json.page_size, 3);
  assert.equal(p1.json.rows.length, 3);
  assert.equal(p1.json.today, today);
  assert.equal(p1.json.rows[0].day, '2024-03-07');
  const p3 = await api('sv', 'GET', '/api/staff/attendance?page=3&page_size=3' + q);
  assert.equal(p3.json.rows.length, 1);
  assert.equal(p3.json.rows[0].day, '2024-03-01');
  const def = await api('sv', 'GET', '/api/staff/attendance?' + q.slice(1));
  assert.equal(def.json.page_size, 50);
});

// ---------- pembatas pencarian customer ----------
test('61 pencarian customer dalam semenit -> 429 pada yang ke-61', async () => {
  await makeUser('limit1');
  addCustomer({ rm: 'LIM-001', name: 'Limit Satu' });
  const codes = [];
  for (let i = 0; i < 61; i++) codes.push((await api('limit1', 'GET', '/api/customers/search?q=LIM')).status);
  assert.equal(codes.slice(0, 60).every((c) => c === 200), true, '60 pertama lolos');
  assert.equal(codes[60], 429);
  const again = await api('limit1', 'GET', '/api/customers/search?q=LIM');
  assert.equal(again.status, 429);
  assert.equal(again.json.error, 'Terlalu banyak pencarian, coba lagi sebentar');
  // batas per user: user lain tidak terkena
  const other = await api('cari1', 'GET', '/api/customers/search?q=LIM');
  assert.equal(other.status, 200);
  assert.equal(other.json.customers.length, 1);
});

test('pencarian customer: q dipotong 100 karakter dan hasil maksimal 8', async () => {
  for (let i = 0; i < 12; i++) addCustomer({ rm: `ZZ-${i}`, name: `Zed ${i}` });
  const r = await api('cari1', 'GET', '/api/customers/search?q=ZZ-');
  assert.equal(r.json.customers.length, 8);
  // q 5000 karakter tidak membuat query meledak; diperlakukan sebagai 100 karakter
  const long = await api('cari1', 'GET', '/api/customers/search?q=' + 'ZZ-'.repeat(2000));
  assert.equal(long.status, 200);
  assert.equal((await api('cari1', 'GET', '/api/customers/search?q=Z')).json.customers.length, 0, 'minimal 2 karakter');
});

// ---------- customer: balapan No RM + audit ----------
test('dua POST customer bersamaan dengan No RM sama: satu berhasil, satu 409', async () => {
  const body = { rm_no: 'BAL-001', name: 'Balapan Satu', origin: 'awal' };
  const [a, b] = await Promise.all([api('sv', 'POST', '/api/staff/customers', body), api('sv', 'POST', '/api/staff/customers', body)]);
  const codes = [a.status, b.status].sort();
  assert.equal([200, 201].includes(codes[0]), true, `status: ${codes}`);
  assert.equal(codes[1], 409);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.error, 'No RM sudah terdaftar');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE rm_no = 'BAL-001'").get().n, 1);
});

test('pelanggaran UNIQUE dari SQLite (lolos pengecekan awal) dibalas 409, bukan 500', async () => {
  // Pemicu ini menyisipkan baris pesaing tepat sebelum INSERT, meniru proses lain yang menang balapan.
  sqlite.exec(`CREATE TRIGGER race_rm BEFORE INSERT ON customers WHEN NEW.rm_no = 'BAL-TRIG'
    BEGIN INSERT INTO customers (rm_no, name, created_at, updated_at) VALUES ('BAL-TRIG', 'Pesaing', 'x', 'x'); END`);
  try {
    const r = await api('sv', 'POST', '/api/staff/customers', { rm_no: 'BAL-TRIG', name: 'Kalah Balapan' });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, 'No RM sudah terdaftar');
  } finally {
    sqlite.exec('DROP TRIGGER race_rm');
  }
});

test('audit: customer.create, customer.update, customer.import', async () => {
  const made = await api('sv', 'POST', '/api/staff/customers', { rm_no: 'AUD-001', name: 'Audit Satu', phone: '081200001111' });
  assert.equal(made.status, 200);
  const create = auditRows('customer.create').find((r) => r.target_id === String(made.json.id));
  assert.ok(create, 'baris customer.create ada');
  assert.equal(create.detail.rm_no, 'AUD-001');
  assert.equal(create.actor_name, 'Supervisor');

  const upd = await api('sv', 'PATCH', `/api/staff/customers/${made.json.id}`, { rm_no: 'AUD-001', name: 'Audit Satu Ubah', phone: '081200001111' });
  assert.equal(upd.status, 200);
  const u = auditRows('customer.update').find((r) => r.target_id === String(made.json.id));
  assert.ok(u, 'baris customer.update ada');
  assert.deepEqual(u.detail.fields, ['name']);

  const csv = 'No,No RM,Nama\n1,AUD-001,Audit Satu Ubah\n2,AUD-002,Audit Dua\n3,,Tanpa RM\n';
  const imp = await api('sv', 'POST', '/api/staff/customers/import', { format: 'csv', content: csv });
  assert.equal(imp.status, 200);
  const i = auditRows('customer.import').at(-1);
  assert.ok(i, 'baris customer.import ada');
  assert.deepEqual(i.detail, { added: 1, updated: 1, skipped: 1 });
});

test('PATCH customer dengan No RM milik customer lain -> 409', async () => {
  const id = addCustomer({ rm: 'PAT-001', name: 'Patch Satu' });
  const r = await api('sv', 'PATCH', `/api/staff/customers/${id}`, { rm_no: 'AUD-001', name: 'Patch Satu' });
  assert.equal(r.status, 409);
});

test('pencarian data customer: huruf+angka tidak mencari No WA; q dipotong', async () => {
  addCustomer({ rm: 'TLP-001', name: 'Telepon Uji', phone: '628777123456' });
  const pure = await api('sv', 'GET', '/api/staff/customers?q=777123');
  assert.equal(pure.json.customers.some((c) => c.rm_no === 'TLP-001'), true);
  const mixed = await api('sv', 'GET', '/api/staff/customers?q=' + encodeURIComponent('Budi 777123'));
  assert.equal(mixed.json.customers.some((c) => c.rm_no === 'TLP-001'), false);
  assert.equal((await api('sv', 'GET', '/api/staff/customers?q=' + 'x'.repeat(5000))).status, 200);
});

// ---------- konsistensi summary dan Data user ----------
test('summary dan Data user konsisten setelah satu user diturunkan ke admin', async () => {
  const a = await makeUser('kons_a');
  const b = await makeUser('kons_b');
  const cid = addCustomer({ name: 'Konsisten' });
  for (const sid of [1, 2]) addRecord({ userId: a, customerId: cid, serviceId: sid, day: OLD_DAY, commission: 1000 });
  for (const sid of [1, 2, 3]) addRecord({ userId: b, customerId: cid, serviceId: sid, day: OLD_DAY, commission: 2500 });
  const q = `?from=${OLD_DAY}&to=${OLD_DAY}`;

  const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
  const before = await Promise.all([api('sv', 'GET', '/api/staff/summary' + q), api('sv', 'GET', '/api/staff/users' + q)]);
  assert.equal(before[0].json.summary.commission, 1000 * 2 + 2500 * 3);
  assert.equal(sum(before[1].json.users, 'total_commission'), before[0].json.summary.commission);

  const patch = await api('sv', 'PATCH', `/api/sv/accounts/${a}`, { role: 'admin' });
  assert.equal(patch.status, 200);

  const [s, u] = await Promise.all([api('sv', 'GET', '/api/staff/summary' + q), api('sv', 'GET', '/api/staff/users' + q)]);
  assert.equal(s.json.summary.commission, 1000 * 2 + 2500 * 3);
  assert.equal(s.json.summary.services, 5);
  assert.equal(sum(u.json.users, 'total_commission'), s.json.summary.commission, 'total komisi = jumlah baris');
  assert.equal(sum(u.json.users, 'total_services'), s.json.summary.services);
  const demoted = u.json.users.find((r) => r.id === a);
  assert.ok(demoted, 'akun yang sudah jadi admin tetap tampil karena punya record di periode itu');
  assert.equal(demoted.role, 'admin');

  // Di luar periode itu, admin tanpa record tidak muncul.
  const none = await api('sv', 'GET', '/api/staff/users?from=2030-01-01&to=2030-01-02');
  assert.equal(none.json.users.some((r) => r.id === a), false);

  // Barisnya bisa dibuka: detail tidak 404 untuk akun yang sudah jadi admin.
  const det = await api('sv', 'GET', `/api/staff/users/${a}/detail?day=${OLD_DAY}`);
  assert.equal(det.status, 200);
  assert.equal(det.json.records.length, 2);
});

// ---------- audit approve ----------
test('POST /api/staff/reviews mencatat review.approve lalu review.change', async () => {
  const uid = await makeUser('appr1');
  const cid = addCustomer({ name: 'Approve Satu' });
  addRecord({ userId: uid, customerId: cid, serviceId: 1 });

  const ok = await api('sv', 'POST', '/api/staff/reviews', { user_id: uid, day: today, late: false });
  assert.equal(ok.status, 200);
  const approve = auditRows('review.approve').filter((r) => r.target_id === String(uid));
  assert.equal(approve.length, 1);
  assert.equal(approve[0].detail.day, today);
  assert.equal(auditRows('review.change').filter((r) => r.target_id === String(uid)).length, 0);

  const ch = await api('sv', 'POST', '/api/staff/reviews', { user_id: uid, day: today, late: true });
  assert.equal(ch.status, 200);
  const change = auditRows('review.change').filter((r) => r.target_id === String(uid));
  assert.equal(change.length, 1);
  assert.deepEqual([change[0].detail.from_late, change[0].detail.to_late], [false, true]);

  // status sama: tidak ada perubahan, tidak ada baris audit baru
  await api('sv', 'POST', '/api/staff/reviews', { user_id: uid, day: today, late: true });
  assert.equal(auditRows('review.change').filter((r) => r.target_id === String(uid)).length, 1);
  assert.equal(auditRows('review.approve').filter((r) => r.target_id === String(uid)).length, 1);
});

// ---------- batas ukuran body ----------
test('impor customer di atas batas body biasa (CSV ~3,9 MB) tetap diterima, bukan 413', async () => {
  const pad = 'x'.repeat(80);
  const lines = ['No,No RM,Nama,Referensi'];
  for (let i = 0; i < 15000; i++) lines.push(`${i + 1},IMP-${String(i).padStart(6, '0')},Impor ${i} ${pad},${'r'.repeat(150)}`);
  const content = lines.join('\n');
  assert.ok(content.length > 3.5 * 1024 * 1024, `bahan uji harus > 3,5 MB, sekarang ${content.length}`);
  const r = await api('sv', 'POST', '/api/staff/customers/import', { format: 'csv', content });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.result.added, 15000);
});