// Tes Fase 4: jadwal bagian user (daftar, detail, mulai) dan POST /api/records berbasis jadwal dengan SOAP wajib.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, createVisit, VALID_SOAP, todayYmd } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const TODAY = todayYmd();
const TOMORROW = todayYmd(1);
const YESTERDAY = todayYmd(-1);

let srv; let sdb;
let uBudi; let uSari; let custRina; let custAndi;
const cookies = {};

const api = (who, method, url, body, headers) => srv.call(url, {
  method, body: body === undefined && method !== 'GET' ? {} : body, cookie: who ? cookies[who] : undefined, headers,
});
const sql = (q, ...a) => sdb.prepare(q).all(...a);
const one = (q, ...a) => sdb.prepare(q).get(...a);
const notifs = (userId, type) => sql(`SELECT type, title, body, schedule_id FROM notifications WHERE user_id = ?${type ? ' AND type = ?' : ''} ORDER BY id`, ...(type ? [userId, type] : [userId]));
const statusOf = (id) => one('SELECT status FROM schedules WHERE id = ?', id).status;
const recordsOf = (userId) => one('SELECT COUNT(*) AS n FROM records WHERE user_id = ?', userId).n;

async function mkAccount(username, role, name) {
  const r = await api('sv', 'POST', '/api/sv/accounts', { username, name, password: PASS, role });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
async function mkCustomer(rm, name) {
  const r = await api('adm', 'POST', '/api/staff/customers', { rm_no: rm, name, phone: '081234567890', medical_note: 'CATATAN-AWAL-ADMIN' });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
// Jadwal baru (status baru) untuk user; opsi default: Budi, Rina, hari ini, layanan [1].
const mk = (over = {}) => createVisit(srv, cookies.adm, { userId: uBudi, customerId: custRina, ...over });
const complete = (who, scheduleId, extra = {}, headers) => api(who, 'POST', '/api/records', { schedule_id: scheduleId, soap: VALID_SOAP, ...extra }, headers);

before(async () => {
  srv = await startServer();
  cookies.sv = (await srv.login()).cookie;
  await mkAccount('adm1', 'admin', 'Admin Satu');
  uBudi = await mkAccount('budi', 'user', 'Budi');
  uSari = await mkAccount('sari', 'user', 'Sari');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  cookies.sari = (await srv.login('sari', PASS)).cookie;
  custRina = await mkCustomer('RM-001', 'Rina');
  custAndi = await mkCustomer('RM-002', 'Andi');
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  sdb.exec('PRAGMA busy_timeout = 5000');
});

after(async () => {
  try { sdb?.close(); } catch { /* */ }
  await srv.stop();
});

// ---------------------------------------------------------------------------------------------
test('GET /api/my/schedules: bawaan hari ini saja, hanya milik sendiri, summary dan today benar', async () => {
  const a = await mk({ startTime: '10:00' });
  const b = await mk({ startTime: '08:00', customerId: custAndi, serviceIds: [1, 2] });
  const tomorrow = await mk({ day: TOMORROW });
  const sari = await mk({ userId: uSari });
  await api('budi', 'POST', `/api/my/schedules/${b.id}/start`);

  const r = await api('budi', 'GET', '/api/my/schedules');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.today, TODAY);
  assert.equal(r.json.truncated, false);
  const got = r.json.schedules.map((s) => s.id);
  assert.ok(got.includes(a.id) && got.includes(b.id));
  assert.ok(!got.includes(tomorrow.id), 'jadwal besok tidak muncul pada tampilan bawaan');
  assert.ok(!got.includes(sari.id), 'jadwal user lain tidak muncul');
  assert.ok(r.json.schedules.every((s) => s.day === TODAY && s.user.id === uBudi));
  // urutan day, start_time, id
  const times = r.json.schedules.map((s) => s.start_time);
  assert.deepEqual(times, [...times].sort());
  assert.deepEqual(Object.keys(r.json.summary), ['total', 'baru', 'berjalan', 'selesai', 'batal']);
  assert.equal(r.json.summary.total, r.json.schedules.length);
  assert.equal(r.json.summary.berjalan, 1);
  assert.equal(r.json.summary.baru, r.json.schedules.length - 1);
  const first = r.json.schedules.find((s) => s.id === b.id);
  assert.equal(first.services.length, 2);
  assert.equal(first.customer.name, 'Andi');
  assert.ok(!('soap' in first), 'daftar tidak membawa SOAP');
  assert.equal(first.overdue, false);
});

test('GET /api/my/schedules: from/to, all=1, rentang terbalik 400, tanggal tidak valid 400', async () => {
  const tom = await mk({ day: TOMORROW });
  const old = await mk({ startTime: '07:00' });
  sdb.prepare('UPDATE schedules SET day = ? WHERE id = ?').run(YESTERDAY, old.id); // jadwal lampau (API staff menolak tanggal lampau)

  const ids = (r) => r.json.schedules.map((s) => s.id);
  const rangeTomorrow = await api('budi', 'GET', `/api/my/schedules?from=${TOMORROW}&to=${TOMORROW}`);
  assert.equal(rangeTomorrow.status, 200);
  assert.ok(ids(rangeTomorrow).includes(tom.id));
  assert.ok(rangeTomorrow.json.schedules.every((s) => s.day === TOMORROW));

  const wide = await api('budi', 'GET', `/api/my/schedules?from=${YESTERDAY}&to=${TOMORROW}`);
  assert.ok(ids(wide).includes(tom.id) && ids(wide).includes(old.id));

  const fromOnly = await api('budi', 'GET', `/api/my/schedules?from=${TOMORROW}`);
  assert.ok(fromOnly.json.schedules.every((s) => s.day >= TOMORROW));
  assert.ok(!ids(fromOnly).includes(old.id));

  const all = await api('budi', 'GET', '/api/my/schedules?all=1');
  assert.ok(ids(all).includes(tom.id) && ids(all).includes(old.id));
  assert.ok(all.json.schedules.every((s) => s.user.id === uBudi));
  const days = all.json.schedules.map((s) => s.day);
  assert.deepEqual(days, [...days].sort(), 'urut menurut tanggal');
  assert.equal(all.json.summary.total, all.json.schedules.length);

  assert.equal((await api('budi', 'GET', `/api/my/schedules?from=${TOMORROW}&to=${YESTERDAY}`)).status, 400);
  assert.equal((await api('budi', 'GET', '/api/my/schedules?from=bukan-tanggal')).status, 400);
});

test('overdue: jadwal lampau yang belum selesai bertanda terlewat; yang selesai tidak', async () => {
  const stale = await mk({ startTime: '06:30' });
  const done = await mk({ startTime: '06:45' });
  assert.equal((await complete('budi', done.id)).status, 200);
  sdb.prepare('UPDATE schedules SET day = ? WHERE id IN (?, ?)').run(YESTERDAY, stale.id, done.id);

  const r = await api('budi', 'GET', `/api/my/schedules?from=${YESTERDAY}&to=${YESTERDAY}`);
  const byId = Object.fromEntries(r.json.schedules.map((s) => [s.id, s]));
  assert.equal(byId[stale.id].overdue, true);
  assert.equal(byId[stale.id].status, 'baru');
  assert.equal(byId[done.id].overdue, false);
  assert.equal(byId[done.id].status, 'selesai');
  // jadwal terlewat hanya bisa dilihat
  const st = await api('budi', 'POST', `/api/my/schedules/${stale.id}/start`);
  assert.equal(st.status, 409);
  assert.equal(st.json.code, 'SCHEDULE_NOT_TODAY');
  const cp = await complete('budi', stale.id);
  assert.equal(cp.status, 409);
  assert.equal(cp.json.code, 'SCHEDULE_NOT_TODAY');
});

test('GET /api/my/schedules/:id: milik sendiri 200 (dengan soap null), milik user lain atau tidak ada 404', async () => {
  const s = await mk();
  const r = await api('budi', 'GET', `/api/my/schedules/${s.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.id, s.id);
  assert.equal(r.json.schedule.soap, null);
  assert.equal(r.json.schedule.has_soap, false);
  assert.equal((await api('sari', 'GET', `/api/my/schedules/${s.id}`)).status, 404);
  assert.equal((await api('budi', 'GET', '/api/my/schedules/999999')).status, 404);
  assert.equal((await api('budi', 'GET', '/api/my/schedules/abc')).status, 400);
});

// ---------------------------------------------------------------------------------------------
test('start: baru -> berjalan + satu notifikasi; panggil lagi tidak menambah; audit schedule.start sekali', async () => {
  const s = await mk();
  const before = notifs(uBudi, 'tugas_berjalan').length;
  const r = await api('budi', 'POST', `/api/my/schedules/${s.id}/start`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'berjalan');
  assert.ok(r.json.schedule.started_at);
  const n = notifs(uBudi, 'tugas_berjalan');
  assert.equal(n.length - before, 1);
  assert.equal(n.at(-1).title, 'Tugas sedang dijalani');
  assert.equal(n.at(-1).body, `Rina · ${TODAY} 09:00`);
  assert.equal(n.at(-1).schedule_id, s.id);

  const again = await api('budi', 'POST', `/api/my/schedules/${s.id}/start`);
  assert.equal(again.status, 200);
  assert.equal(again.json.schedule.status, 'berjalan');
  assert.equal(again.json.schedule.started_at, r.json.schedule.started_at, 'waktu mulai tidak berubah');
  assert.equal(notifs(uBudi, 'tugas_berjalan').length - before, 1, 'tidak ada notifikasi tambahan');
  assert.equal(sql("SELECT id FROM audit_log WHERE action = 'schedule.start' AND target_id = ?", String(s.id)).length, 1);
});

test('start: jadwal besok 409 SCHEDULE_NOT_TODAY; batal 409 SCHEDULE_STATE; selesai 409; milik orang lain 404', async () => {
  const tom = await mk({ day: TOMORROW });
  let r = await api('budi', 'POST', `/api/my/schedules/${tom.id}/start`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SCHEDULE_NOT_TODAY');
  assert.equal(statusOf(tom.id), 'baru');

  const cancelled = await mk();
  assert.equal((await api('adm', 'POST', `/api/staff/schedules/${cancelled.id}/cancel`)).status, 200);
  r = await api('budi', 'POST', `/api/my/schedules/${cancelled.id}/start`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SCHEDULE_STATE');
  assert.equal(statusOf(cancelled.id), 'batal');

  const done = await mk();
  assert.equal((await complete('budi', done.id)).status, 200);
  r = await api('budi', 'POST', `/api/my/schedules/${done.id}/start`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SCHEDULE_STATE');

  const sari = await mk({ userId: uSari });
  assert.equal((await api('budi', 'POST', `/api/my/schedules/${sari.id}/start`)).status, 404);
  assert.equal(statusOf(sari.id), 'baru');
  assert.equal((await api('budi', 'POST', '/api/my/schedules/999999/start')).status, 404);
});

// ---------------------------------------------------------------------------------------------
test('POST /api/records tanpa schedule_id: 400 SCHEDULE_REQUIRED, tidak ada record', async () => {
  const before = recordsOf(uBudi);
  for (const body of [{}, { customer_rm: 'RM-001', service_ids: [1] }, { schedule_id: '', soap: VALID_SOAP }, { schedule_id: null, soap: VALID_SOAP }]) {
    const r = await api('budi', 'POST', '/api/records', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'SCHEDULE_REQUIRED');
    assert.match(r.json.error, /Jadwal Saya/);
  }
  assert.equal((await api('budi', 'POST', '/api/records', { schedule_id: 'abc', soap: VALID_SOAP })).status, 400);
  assert.equal(recordsOf(uBudi), before);
});

test('SOAP kurang satu bagian: 400 SOAP_REQUIRED bernama bagian pertama yang kosong; tidak ada record; jadwal tetap', async () => {
  const s = await mk({ serviceIds: [1, 2] });
  const before = recordsOf(uBudi);
  const cases = [
    [{ s: 'ok', o: 'ROM terbatas', a: 'Frozen shoulder', p: 'Latihan' }, 'Subjective'],
    [{ s: 'Nyeri bahu', o: '   ', a: 'Frozen shoulder', p: 'Latihan' }, 'Objective'],
    [{ s: 'Nyeri bahu', o: 'ROM terbatas', a: '', p: 'Latihan' }, 'Assessment'],
    [{ s: 'Nyeri bahu', o: 'ROM terbatas', a: 'Frozen shoulder' }, 'Planning'],
    [{ s: 'Nyeri bahu', o: 'ROM terbatas', a: 'Frozen shoulder', p: 12345 }, 'Planning'],
    [{ s: '', o: '', a: '', p: '' }, 'Subjective'],
    [null, 'Subjective'],
    ['teks biasa', 'Subjective'],
  ];
  for (const [soap, part] of cases) {
    const r = await api('budi', 'POST', '/api/records', { schedule_id: s.id, soap });
    assert.equal(r.status, 400, JSON.stringify(soap));
    assert.equal(r.json.code, 'SOAP_REQUIRED');
    assert.equal(r.json.error, `SOAP bagian ${part} wajib diisi (minimal 3 karakter)`);
  }
  const noSoap = await api('budi', 'POST', '/api/records', { schedule_id: s.id });
  assert.equal(noSoap.json.code, 'SOAP_REQUIRED');
  const tooLong = await complete('budi', s.id, { soap: { ...VALID_SOAP, a: 'x'.repeat(2001) } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.code, 'SOAP_REQUIRED');
  assert.equal((await complete('budi', s.id, { soap: { ...VALID_SOAP, a: 'x'.repeat(2000) } })).status, 200, 'tepat 2000 karakter diterima');

  // kegagalan sebelumnya tidak meninggalkan apa pun: hanya sukses terakhir yang membuat 2 record
  assert.equal(recordsOf(uBudi) - before, 2);
});

test('SOAP gagal: tidak ada record, status jadwal dan notifikasi tidak berubah', async () => {
  const s = await mk({ serviceIds: [1, 2, 3] });
  const rec = recordsOf(uBudi);
  const nf = notifs(uBudi).length;
  const r = await complete('budi', s.id, { soap: { ...VALID_SOAP, o: '' } });
  assert.equal(r.status, 400);
  assert.equal(recordsOf(uBudi), rec);
  assert.equal(notifs(uBudi).length, nf);
  assert.equal(statusOf(s.id), 'baru');
  const row = one('SELECT batch, soap_s, soap_o, soap_a, soap_p, completed_at FROM schedules WHERE id = ?', s.id);
  assert.deepEqual({ ...row }, { batch: '', soap_s: '', soap_o: '', soap_a: '', soap_p: '', completed_at: '' });
});

test('sukses: selesai, SOAP dirapikan dan tersimpan, batch terisi, satu record per layanan, data palsu klien diabaikan, notifikasi', async () => {
  const s = await mk({ serviceIds: [3, 1, 2], customerId: custRina });
  await api('budi', 'POST', `/api/my/schedules/${s.id}/start`);
  const startedAt = one('SELECT started_at FROM schedules WHERE id = ?', s.id).started_at;
  const recBefore = recordsOf(uBudi);
  const doneBefore = notifs(uBudi, 'tugas_selesai').length;

  const r = await api('budi', 'POST', '/api/records', {
    schedule_id: s.id,
    soap: { s: '  Nyeri   bahu\r\n\r\n\r\n\r\nkanan  ', o: 'ROM terbatas', a: 'Frozen shoulder', p: 'Latihan 2x seminggu' },
    customer_id: custAndi, customer_rm: 'RM-002', service_ids: [5, 6, 7, 8], // dari klien: harus diabaikan
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.count, 3, 'jumlah record = jumlah layanan pada jadwal');
  assert.equal(r.json.customer.id, custRina);
  assert.equal(r.json.customer.name, 'Rina');
  assert.equal(r.json.schedule.id, s.id);
  assert.equal(r.json.schedule.status, 'selesai');
  assert.ok(r.json.schedule.completed_at);
  assert.equal(r.json.schedule.has_soap, true);
  assert.deepEqual(r.json.schedule.soap, { s: 'Nyeri bahu\n\nkanan', o: 'ROM terbatas', a: 'Frozen shoulder', p: 'Latihan 2x seminggu' });

  const row = one('SELECT * FROM schedules WHERE id = ?', s.id);
  assert.equal(row.status, 'selesai');
  assert.equal(row.started_at, startedAt, 'started_at yang sudah ada tidak ditimpa');
  assert.ok(row.completed_at);
  assert.ok(row.batch, 'batch terisi');
  assert.equal(row.soap_s, 'Nyeri bahu\n\nkanan');
  assert.equal(row.soap_p, 'Latihan 2x seminggu');

  const recs = sql('SELECT customer_id, service_id, batch, source, day FROM records WHERE batch = ? ORDER BY service_id', row.batch);
  assert.equal(recordsOf(uBudi) - recBefore, 3);
  assert.deepEqual(recs.map((x) => x.service_id), [1, 2, 3]);
  assert.ok(recs.every((x) => x.customer_id === custRina && x.source === 'web' && x.day === TODAY));
  assert.equal(sql('SELECT 1 FROM records WHERE customer_id = ? AND batch = ?', custAndi, row.batch).length, 0, 'customer dari klien diabaikan');

  const n = notifs(uBudi, 'tugas_selesai');
  assert.equal(n.length - doneBefore, 1);
  assert.equal(n.at(-1).title, 'Tugas selesai');
  assert.equal(n.at(-1).body, `Rina · ${TODAY} 09:00`);
  assert.equal(sql("SELECT id FROM audit_log WHERE action = 'schedule.complete' AND target_id = ?", String(s.id)).length, 1);
});

test('jadwal baru boleh langsung diselesaikan: started_at terisi', async () => {
  const s = await mk();
  const r = await complete('budi', s.id);
  assert.equal(r.status, 200, r.text);
  const row = one('SELECT started_at, completed_at, status FROM schedules WHERE id = ?', s.id);
  assert.equal(row.status, 'selesai');
  assert.ok(row.started_at && row.completed_at);
  assert.equal(notifs(uBudi, 'tugas_berjalan').filter((x) => x.schedule_id === s.id).length, 0, 'tanpa mulai tidak ada notifikasi berjalan');
});

test('Idempotency-Key sama: respons sama, tidak ada record ganda; key berbeda pada jadwal selesai: 409 SCHEDULE_STATE', async () => {
  const s = await mk({ serviceIds: [1, 2] });
  const before = recordsOf(uBudi);
  const h = { 'Idempotency-Key': 'kunci-jadwal-0001' };
  const a = await complete('budi', s.id, {}, h);
  const b = await complete('budi', s.id, {}, h);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200);
  assert.deepEqual(b.json, a.json);
  assert.equal(a.headers.get('idempotent-replay'), null);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(recordsOf(uBudi) - before, 2, 'tidak ada record ganda');
  assert.equal(notifs(uBudi, 'tugas_selesai').filter((x) => x.schedule_id === s.id).length, 1);

  const c = await complete('budi', s.id, {}, { 'Idempotency-Key': 'kunci-jadwal-0002' });
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'SCHEDULE_STATE');
  const d = await complete('budi', s.id); // tanpa key
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'SCHEDULE_STATE');
  assert.equal(recordsOf(uBudi) - before, 2);
});

test('POST /api/records: milik user lain atau tidak ada 404; besok SCHEDULE_NOT_TODAY; batal SCHEDULE_STATE', async () => {
  const sari = await mk({ userId: uSari });
  const rec = recordsOf(uBudi) + recordsOf(uSari);
  assert.equal((await complete('budi', sari.id)).status, 404);
  assert.equal((await complete('budi', 999999)).status, 404);
  assert.equal(statusOf(sari.id), 'baru');

  const tom = await mk({ day: TOMORROW });
  const t = await complete('budi', tom.id);
  assert.equal(t.status, 409);
  assert.equal(t.json.code, 'SCHEDULE_NOT_TODAY');

  const cancelled = await mk();
  await api('adm', 'POST', `/api/staff/schedules/${cancelled.id}/cancel`);
  const c = await complete('budi', cancelled.id);
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'SCHEDULE_STATE');
  assert.equal(recordsOf(uBudi) + recordsOf(uSari), rec);
});

test('ketepatan waktu tidak mengunci penyelesaian tugas, dan komisi tidak ganda', async () => {
  const lock = await mkAccount('lock', 'user', 'User Terkunci');
  cookies.lock = (await srv.login('lock', PASS)).cookie;
  const s = await mk({ userId: lock, serviceIds: [1, 2] });
  await api('lock', 'POST', `/api/my/schedules/${s.id}/start`);
  const svId = one("SELECT id FROM users WHERE username = 'admin'").id;
  sdb.prepare('INSERT INTO day_reviews (user_id, day, late, reviewed_by, reviewed_at) VALUES (?, ?, 0, ?, ?)').run(lock, TODAY, svId, new Date().toISOString());

  const r = await complete('lock', s.id, {}, { 'Idempotency-Key': 'kunci-terkunci-01' });
  assert.equal(r.status, 200, r.text);
  assert.equal(recordsOf(lock), 2);
  assert.equal(statusOf(s.id), 'selesai');
  assert.equal(one('SELECT late FROM day_reviews WHERE user_id = ? AND day = ?', lock, TODAY).late, 0);
  assert.equal(notifs(lock, 'tugas_selesai').length, 1);

  const again = await complete('lock', s.id, {}, { 'Idempotency-Key': 'kunci-terkunci-02' });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'SCHEDULE_STATE');
  assert.equal(recordsOf(lock), 2);
});

test('admin dan supervisor tidak bisa memakai endpoint my/* dan POST /api/records (403)', async () => {
  const s = await mk();
  for (const who of ['adm', 'sv']) {
    assert.equal((await api(who, 'GET', '/api/my/schedules')).status, 403, who);
    assert.equal((await api(who, 'GET', `/api/my/schedules/${s.id}`)).status, 403, who);
    assert.equal((await api(who, 'POST', `/api/my/schedules/${s.id}/start`)).status, 403, who);
    assert.equal((await complete(who, s.id)).status, 403, who);
  }
  assert.equal((await api(null, 'GET', '/api/my/schedules')).status, 401);
  assert.equal(statusOf(s.id), 'baru');
});

// ---------------------------------------------------------------------------------------------
test('SOAP tidak bocor: tidak di /api/records/mine, tidak di log audit, tidak di daftar; admin membacanya lewat API staff', async () => {
  const SECRET = { s: 'RAHASIA-S-QWERTY', o: 'RAHASIA-O-QWERTY', a: 'RAHASIA-A-QWERTY', p: 'RAHASIA-P-QWERTY' };
  const s = await mk({ serviceIds: [1] });
  const r = await complete('budi', s.id, { soap: SECRET });
  assert.equal(r.status, 200, r.text);

  const mine = await api('budi', 'GET', '/api/records/mine');
  assert.equal(mine.status, 200);
  assert.ok(!mine.text.includes('QWERTY'), 'SOAP bocor ke /api/records/mine');
  assert.ok(!(await api('budi', 'GET', '/api/records/mine/export')).text.includes('QWERTY'));

  const audit = JSON.stringify(sql('SELECT * FROM audit_log'));
  assert.ok(!audit.includes('QWERTY'), 'SOAP bocor ke audit_log');
  const rows = sql("SELECT detail FROM audit_log WHERE action = 'schedule.complete' AND target_id = ?", String(s.id));
  assert.deepEqual(JSON.parse(rows[0].detail).soap_parts, ['s', 'o', 'a', 'p']);
  const view = await api('sv', 'GET', '/api/sv/audit?action=schedule.complete');
  assert.equal(view.status, 200, view.text);
  assert.ok(view.json.rows.length >= 1);
  assert.ok(!view.text.includes('QWERTY'), 'SOAP bocor ke tampilan audit');
  const types = JSON.stringify(sql('SELECT * FROM notifications'));
  assert.ok(!types.includes('QWERTY'), 'SOAP bocor ke notifikasi');

  // daftar jadwal (user dan staff) tidak membawa SOAP, hanya has_soap
  const list = await api('budi', 'GET', '/api/my/schedules');
  assert.ok(!list.text.includes('QWERTY'));
  assert.equal(list.json.schedules.find((x) => x.id === s.id).has_soap, true);
  const staffList = await api('adm', 'GET', '/api/staff/schedules');
  assert.ok(!staffList.text.includes('QWERTY'));

  // pemilik jadwal dan staff bisa membaca; user lain tidak
  assert.deepEqual((await api('budi', 'GET', `/api/my/schedules/${s.id}`)).json.schedule.soap, SECRET);
  assert.deepEqual((await api('adm', 'GET', `/api/staff/schedules/${s.id}`)).json.schedule.soap, SECRET);
  assert.deepEqual((await api('sv', 'GET', `/api/staff/schedules/${s.id}`)).json.schedule.soap, SECRET);
  assert.equal((await api('sari', 'GET', `/api/my/schedules/${s.id}`)).status, 404);
});

test('catatan awal customer (kolom SOAP di tabel Customer) tidak terlihat user lewat jadwal', async () => {
  const s = await mk();
  const r = await api('budi', 'GET', `/api/my/schedules/${s.id}`);
  assert.ok(!r.text.includes('CATATAN-AWAL-ADMIN'));
  assert.ok(!(await api('budi', 'GET', '/api/my/schedules?all=1')).text.includes('CATATAN-AWAL-ADMIN'));
});

// ---------------------------------------------------------------------------------------------
// Pelengkap tes Fase 3: status "berjalan" kini bisa dicapai lewat API.
test('jadwal berjalan: ubah (PATCH) ditolak 409; admin tidak bisa membatalkan; supervisor bisa dan user diberi tahu', async () => {
  const s = await mk();
  await api('budi', 'POST', `/api/my/schedules/${s.id}/start`);
  assert.equal(statusOf(s.id), 'berjalan');

  const patch = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { note: 'ubah' });
  assert.equal(patch.status, 409);
  assert.equal(patch.json.code, 'SCHEDULE_STATE');
  const svc = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { service_ids: [2] });
  assert.equal(svc.status, 409);
  assert.equal(svc.json.code, 'SCHEDULE_STATE');

  const adminCancel = await api('adm', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  assert.equal(adminCancel.status, 409);
  assert.equal(adminCancel.json.code, 'SCHEDULE_STATE');
  assert.equal(statusOf(s.id), 'berjalan');

  const before = notifs(uBudi, 'tugas_dibatalkan').length;
  const svCancel = await api('sv', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  assert.equal(svCancel.status, 200, svCancel.text);
  assert.equal(svCancel.json.schedule.status, 'batal');
  assert.equal(notifs(uBudi, 'tugas_dibatalkan').length - before, 1);

  // setelah batal, user tidak bisa menyelesaikan
  const c = await complete('budi', s.id);
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'SCHEDULE_STATE');
  // dan yang sudah selesai tidak bisa dibatalkan siapa pun
  const done = await mk();
  await complete('budi', done.id);
  const dc = await api('sv', 'POST', `/api/staff/schedules/${done.id}/cancel`);
  assert.equal(dc.status, 409);
  assert.equal(dc.json.code, 'SCHEDULE_STATE');
});

test('D9: menghapus record oleh user tidak mengubah status jadwal (tetap selesai)', async () => {
  const s = await mk({ serviceIds: [1] });
  const r = await complete('budi', s.id);
  assert.equal(r.status, 200, r.text);
  const batch = one('SELECT batch FROM schedules WHERE id = ?', s.id).batch;
  const rid = one('SELECT id FROM records WHERE batch = ?', batch).id;
  assert.equal((await api('budi', 'DELETE', `/api/records/${rid}`)).status, 200);
  assert.equal(statusOf(s.id), 'selesai');
});

test('audit: schedule.start dan schedule.complete punya ringkasan yang bisa dibaca supervisor (bukan JSON mentah)', async () => {
  const s = await mk();
  await api('budi', 'POST', `/api/my/schedules/${s.id}/start`);
  await complete('budi', s.id);
  for (const [action, text] of [['schedule.start', /Memulai jadwal/], ['schedule.complete', /Menyelesaikan jadwal/]]) {
    const r = await api('sv', 'GET', `/api/sv/audit?action=${action}`);
    assert.equal(r.status, 200, r.text);
    const row = r.json.rows.find((x) => x.target_id === String(s.id));
    assert.ok(row, action);
    assert.match(row.summary, text);
    assert.equal(row.target_label, `Jadwal #${s.id}`);
    assert.ok(row.summary.includes('Rina'), 'nama customer tampil, bukan ID');
  }
  const done = (await api('sv', 'GET', '/api/sv/audit?action=schedule.complete')).json.rows.find((x) => x.target_id === String(s.id));
  assert.ok(done.items.some((i) => i.label === 'Bagian SOAP terisi' && i.value === 'Subjective, Objective, Assessment, Planning'));
});
