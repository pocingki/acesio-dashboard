// Tes Fase 3: jadwal untuk staff (database + API /api/staff/schedules), notifikasi, dan audit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });
const plusDays = (n) => dayFmt.format(new Date(Date.now() + n * 86400000));
const TODAY = plusDays(0);
const TOMORROW = plusDays(1);
const NEXT_WEEK = plusDays(7);
const YESTERDAY = plusDays(-1);
const SECRET_NOTE = 'RAHASIA-CATATAN-JADWAL-XYZ';

let srv, sv, adm, budi, sdb;
let userBudi, userSari, userOff, adminId, customerRina, customerAndi;
const cookies = {};

const api = (who, method, url, body) => srv.call(url, {
  method, body: body === undefined && method !== 'GET' ? {} : body, cookie: who ? cookies[who] : undefined,
});
const sql = (q, ...a) => sdb.prepare(q).all(...a);
const notifs = (userId) => sql('SELECT type, title, body, schedule_id FROM notifications WHERE user_id = ? ORDER BY id', userId);

async function mkAccount(username, role, name) {
  const r = await api('sv', 'POST', '/api/sv/accounts', { username, name, password: PASS, role });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
async function mkCustomer(rm, name) {
  const r = await api('adm', 'POST', '/api/staff/customers', { rm_no: rm, name, phone: '081234567890' });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
const valid = (over = {}) => ({
  user_id: userBudi, customer_id: customerRina, service_ids: [1, 2], day: TOMORROW, start_time: '09:00', end_time: '10:00', note: 'Bawa alat', ...over,
});
const mk = async (over, who = 'adm') => {
  const r = await api(who, 'POST', '/api/staff/schedules', valid(over));
  assert.equal(r.status, 200, r.text);
  return r.json.schedule;
};

before(async () => {
  srv = await startServer();
  cookies.sv = (await srv.login()).cookie;
  adminId = await mkAccount('adm1', 'admin', 'Admin Satu');
  userBudi = await mkAccount('budi', 'user', 'Budi');
  userSari = await mkAccount('sari', 'user', 'Sari');
  userOff = await mkAccount('off', 'user', 'Nonaktif');
  await mkAccount('adm2', 'admin', 'Admin Dua');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  const off = await api('sv', 'PATCH', `/api/sv/accounts/${userOff}`, { active: false });
  assert.equal(off.status, 200, off.text);
  customerRina = await mkCustomer('RM-001', 'Rina');
  customerAndi = await mkCustomer('RM-002', 'Andi');
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  sdb.exec('PRAGMA busy_timeout = 5000');
});

after(async () => { try { sdb?.close(); } catch { /* sudah tertutup */ } await srv?.stop(); });

test('admin dan supervisor membuat jadwal; bentuk Schedule sesuai kontrak', async () => {
  const s = await mk({ service_ids: [3, 1] });
  assert.equal(s.day, TOMORROW);
  assert.equal(s.start_time, '09:00');
  assert.equal(s.end_time, '10:00');
  assert.equal(s.note, 'Bawa alat');
  assert.equal(s.status, 'baru');
  assert.equal(s.overdue, false);
  assert.deepEqual(s.user, { id: userBudi, name: 'Budi' });
  assert.equal(s.customer.rm_no, 'RM-001');
  assert.equal(s.customer.name, 'Rina');
  assert.match(s.customer.phone, /^62/);
  assert.equal(s.has_soap, false);
  assert.deepEqual(s.soap, null);
  assert.equal(s.started_at, '');
  assert.equal(s.completed_at, '');
  assert.ok(s.created_at);
  assert.equal(s.created_by_name, 'Admin Satu');
  assert.deepEqual(s.services, [{ id: 1, name: 'Layanan 1' }, { id: 3, name: 'Layanan 3' }]); // urut position
  const bySv = await mk({ customer_id: undefined, customer_rm: 'RM-002' }, 'sv');
  assert.equal(bySv.customer.name, 'Andi');
  assert.ok(bySv.created_by_name);
  const got = await api('adm', 'GET', `/api/staff/schedules/${s.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.schedule.id, s.id);
  assert.equal(got.json.schedule.soap, null);
});

test('jadwal tanpa jam selesai dan tanpa catatan diterima; catatan dirapikan', async () => {
  const s = await mk({ end_time: undefined, note: '  a   b \n c ' });
  assert.equal(s.end_time, '');
  assert.equal(s.note, 'a b c');
  const t = await mk({ day: TODAY, note: undefined });
  assert.equal(t.note, '');
});

test('service_ids kosong, hilang, tidak ada, duplikat, atau bukan angka -> 400', async () => {
  const cases = [[], null, 'abc', [999], [1, 1], ['x'], [true], [0], [-1], [1.5], [''], Array.from({ length: 30 }, (_, i) => i + 1)];
  for (const ids of cases) {
    const r = await api('adm', 'POST', '/api/staff/schedules', valid({ service_ids: ids }));
    assert.equal(r.status, 400, `service_ids=${JSON.stringify(ids)} -> ${r.status}`);
  }
  const body = valid(); delete body.service_ids;
  assert.equal((await api('adm', 'POST', '/api/staff/schedules', body)).status, 400);
  const all = await mk({ service_ids: Array.from({ length: 29 }, (_, i) => i + 1) });
  assert.equal(all.services.length, 29);
});

test('ubah service_ids pada jadwal baru mengganti seluruh daftar', async () => {
  const s = await mk({ service_ids: [1, 2] });
  const r = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { service_ids: [5, 4, 6] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.schedule.services.map((x) => x.id), [4, 5, 6]);
  assert.equal(sql('SELECT COUNT(*) AS n FROM schedule_services WHERE schedule_id = ?', s.id)[0].n, 3);
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { service_ids: [] })).status, 400);
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { service_ids: [4, 4] })).status, 400);
  assert.deepEqual((await api('adm', 'GET', `/api/staff/schedules/${s.id}`)).json.schedule.services.map((x) => x.id), [4, 5, 6]);
});

test('akses: user biasa 403, tanpa login 401', async () => {
  for (const [m, u] of [['GET', '/api/staff/schedules'], ['GET', '/api/staff/schedules/1'], ['POST', '/api/staff/schedules'],
    ['PATCH', '/api/staff/schedules/1'], ['POST', '/api/staff/schedules/1/cancel'], ['GET', '/api/staff/schedule-workers']]) {
    assert.equal((await api('budi', m, u, m === 'GET' ? undefined : {})).status, 403, `${m} ${u} user`);
    assert.equal((await api(null, m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u} anonim`);
  }
});

test('validasi: tanggal, jam, user, customer', async () => {
  const bad = async (over, status) => {
    const r = await api('adm', 'POST', '/api/staff/schedules', valid(over));
    assert.equal(r.status, status, `${JSON.stringify(over)} -> ${r.status} ${r.text}`);
  };
  await bad({ day: YESTERDAY }, 400);
  await bad({ day: '2026-02-30' }, 400);
  await bad({ day: 'besok' }, 400);
  await bad({ day: undefined }, 400);
  await bad({ start_time: '25:00' }, 400);
  await bad({ start_time: undefined }, 400);
  await bad({ end_time: '08:59' }, 400);
  await bad({ end_time: '9' }, 400);
  await bad({ note: 'x'.repeat(501) }, 400);
  await bad({ user_id: userOff }, 400); // nonaktif
  await bad({ user_id: adminId }, 400); // bukan role user
  await bad({ user_id: 999999 }, 400);
  await bad({ user_id: undefined }, 400);
  await bad({ customer_id: 999999 }, 404);
  await bad({ customer_id: undefined, customer_rm: 'TIDAK-ADA' }, 404);
  await bad({ customer_id: undefined }, 400); // tanpa rujukan customer
  const ok = await api('adm', 'POST', '/api/staff/schedules', valid({ note: 'x'.repeat(500), end_time: '09:00' }));
  assert.equal(ok.status, 200, ok.text);
});

test('daftar: filter tanggal, user, status, q, paginasi, rentang terbalik', async () => {
  const a = await mk({ user_id: userSari, customer_id: customerAndi, day: NEXT_WEEK, start_time: '08:00' });
  const sari = await api('adm', 'GET', `/api/staff/schedules?user_id=${userSari}`);
  assert.equal(sari.status, 200, sari.text);
  assert.ok(sari.json.schedules.length >= 1);
  assert.ok(sari.json.schedules.every((x) => x.user.id === userSari));
  assert.ok(sari.json.schedules.some((x) => x.id === a.id));
  assert.equal(sari.json.page, 1);
  assert.equal(typeof sari.json.pageSize, 'number');
  assert.equal(sari.json.total, sari.json.schedules.length);
  assert.ok(!('soap' in sari.json.schedules[0]));
  assert.ok('created_by_name' in sari.json.schedules[0]);

  const day = await api('adm', 'GET', `/api/staff/schedules?from=${NEXT_WEEK}&to=${NEXT_WEEK}`);
  assert.ok(day.json.schedules.length >= 1 && day.json.schedules.every((x) => x.day === NEXT_WEEK));
  const none = await api('adm', 'GET', `/api/staff/schedules?from=${plusDays(300)}`);
  assert.equal(none.json.total, 0);

  assert.ok((await api('adm', 'GET', '/api/staff/schedules?status=baru')).json.schedules.every((x) => x.status === 'baru'));
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?status=batal')).json.total, 0);
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?status=selesai-ya')).status, 400);

  for (const q of ['Andi', 'RM-002', 'sari']) {
    const r = await api('adm', 'GET', `/api/staff/schedules?q=${encodeURIComponent(q)}`);
    assert.ok(r.json.schedules.some((x) => x.id === a.id), `q=${q}`);
  }
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?q=tidak-ada-sama-sekali')).json.total, 0);

  assert.equal((await api('adm', 'GET', `/api/staff/schedules?from=${NEXT_WEEK}&to=${TODAY}`)).status, 400);
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?from=bukan-tanggal')).status, 400);
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?page=0')).status, 400);
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?user_id=abc')).status, 400);

  // urutan day, start_time, id
  const all = (await api('adm', 'GET', '/api/staff/schedules')).json.schedules;
  const keys = all.map((x) => `${x.day} ${x.start_time}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('paginasi: halaman 2 berisi sisa, halaman melewati batas kosong', async () => {
  const before = (await api('adm', 'GET', '/api/staff/schedules')).json.total;
  const need = 52 - before > 0 ? 52 - before : 0;
  for (let i = 0; i < need; i++) await mk({ day: plusDays(30), start_time: '07:00' });
  const p1 = (await api('adm', 'GET', '/api/staff/schedules?page=1')).json;
  const p2 = (await api('adm', 'GET', '/api/staff/schedules?page=2')).json;
  assert.equal(p1.schedules.length, p1.pageSize);
  assert.ok(p1.total > p1.pageSize);
  assert.equal(p2.schedules.length, p2.total - p2.pageSize);
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?page=99')).json.schedules.length, 0);
});

test('daftar pekerja: hanya user aktif role user, urut nama', async () => {
  const r = await api('adm', 'GET', '/api/staff/schedule-workers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.workers.map((w) => w.name), ['Budi', 'Sari']);
  assert.deepEqual(Object.keys(r.json.workers[0]).sort(), ['id', 'name', 'username']);
});

test('ubah jadwal baru: sukses, tugas_diubah; tanpa perubahan tidak ada notifikasi', async () => {
  const s = await mk({ user_id: userSari });
  const n0 = notifs(userSari).length;
  const r = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '11:30', end_time: '12:30', note: 'Ganti jam' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.start_time, '11:30');
  assert.equal(r.json.schedule.note, 'Ganti jam');
  const n1 = notifs(userSari);
  assert.equal(n1.length, n0 + 1);
  assert.equal(n1.at(-1).type, 'tugas_diubah');
  assert.equal(n1.at(-1).title, 'Jadwal diubah');
  assert.equal(n1.at(-1).body, `Rina · ${TOMORROW} 11:30`);
  assert.equal(n1.at(-1).schedule_id, s.id);
  // permintaan yang tidak mengubah apa pun
  const same = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '11:30' });
  assert.equal(same.status, 200);
  assert.equal(notifs(userSari).length, n0 + 1);
  // validasi pada ubah
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { end_time: '10:00' })).status, 400); // < start 11:30
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { day: YESTERDAY })).status, 400);
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { customer_id: 999999 })).status, 404);
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { user_id: userOff })).status, 400);
  assert.equal((await api('adm', 'PATCH', '/api/staff/schedules/999999', { note: 'x' })).status, 404);
  assert.equal((await api('adm', 'PATCH', '/api/staff/schedules/abc', { note: 'x' })).status, 400);
  const c = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { customer_rm: 'RM-002', end_time: '' });
  assert.equal(c.json.schedule.customer.name, 'Andi');
  assert.equal(c.json.schedule.end_time, '');
});

test('ganti user: user lama tugas_dibatalkan, user baru tugas_baru', async () => {
  const s = await mk({ user_id: userBudi });
  const b0 = notifs(userBudi).length;
  const s0 = notifs(userSari).length;
  const r = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { user_id: userSari });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.user.id, userSari);
  const b = notifs(userBudi);
  const sa = notifs(userSari);
  assert.equal(b.length, b0 + 1);
  assert.equal(sa.length, s0 + 1);
  assert.equal(b.at(-1).type, 'tugas_dibatalkan');
  assert.equal(b.at(-1).title, 'Tugas dibatalkan');
  assert.equal(sa.at(-1).type, 'tugas_baru');
  assert.equal(sa.at(-1).title, 'Tugas baru');
});

test('buat jadwal menghasilkan notifikasi tugas_baru', async () => {
  const n0 = notifs(userBudi).length;
  const s = await mk({ user_id: userBudi, start_time: '14:15', end_time: '15:00' });
  const n = notifs(userBudi);
  assert.equal(n.length, n0 + 1);
  assert.deepEqual({ ...n.at(-1) }, { type: 'tugas_baru', title: 'Tugas baru', body: `Rina · ${TOMORROW} 14:15`, schedule_id: s.id });
});

test('ubah jadwal non-baru -> 409 SCHEDULE_STATE', async () => {
  for (const st of ['berjalan', 'selesai', 'batal']) {
    const s = await mk();
    sdb.prepare('UPDATE schedules SET status = ? WHERE id = ?').run(st, s.id);
    const r = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { note: 'ubah' });
    assert.equal(r.status, 409, st);
    assert.equal(r.json.code, 'SCHEDULE_STATE');
  }
});

test('batalkan: admin dari baru sukses, admin dari berjalan 409, supervisor dari berjalan sukses', async () => {
  const a = await mk({ user_id: userSari });
  const n0 = notifs(userSari).length;
  const ok = await api('adm', 'POST', `/api/staff/schedules/${a.id}/cancel`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.schedule.status, 'batal');
  const n = notifs(userSari);
  assert.equal(n.length, n0 + 1);
  assert.equal(n.at(-1).type, 'tugas_dibatalkan');
  const again = await api('adm', 'POST', `/api/staff/schedules/${a.id}/cancel`);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'SCHEDULE_STATE');

  const b = await mk();
  sdb.prepare("UPDATE schedules SET status = 'berjalan' WHERE id = ?").run(b.id);
  const no = await api('adm', 'POST', `/api/staff/schedules/${b.id}/cancel`);
  assert.equal(no.status, 409);
  assert.equal(no.json.code, 'SCHEDULE_STATE');
  const yes = await api('sv', 'POST', `/api/staff/schedules/${b.id}/cancel`);
  assert.equal(yes.status, 200, yes.text);
  assert.equal(yes.json.schedule.status, 'batal');

  const c = await mk();
  sdb.prepare("UPDATE schedules SET status = 'selesai' WHERE id = ?").run(c.id);
  for (const who of ['adm', 'sv']) {
    const r = await api(who, 'POST', `/api/staff/schedules/${c.id}/cancel`);
    assert.equal(r.status, 409, who);
    assert.equal(r.json.code, 'SCHEDULE_STATE');
  }
  assert.equal((await api('adm', 'POST', '/api/staff/schedules/999999/cancel')).status, 404);
});

test('overdue: jadwal baru dengan tanggal lampau bertanda overdue', async () => {
  const s = await mk({ day: TODAY });
  sdb.prepare('UPDATE schedules SET day = ? WHERE id = ?').run(YESTERDAY, s.id);
  const r = await api('adm', 'GET', `/api/staff/schedules/${s.id}`);
  assert.equal(r.json.schedule.overdue, true);
  sdb.prepare("UPDATE schedules SET status = 'selesai' WHERE id = ?").run(s.id);
  assert.equal((await api('adm', 'GET', `/api/staff/schedules/${s.id}`)).json.schedule.overdue, false);
});

test('audit: schedule.create/update/cancel tercatat dan isi catatan tidak masuk log', async () => {
  const s = await mk({ note: SECRET_NOTE });
  await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { note: `${SECRET_NOTE}-2`, start_time: '09:30' });
  await api('adm', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  const rows = sql("SELECT action, target_type, target_id, detail FROM audit_log WHERE action LIKE 'schedule.%' ORDER BY id");
  const mine = rows.filter((r) => r.target_id === String(s.id));
  assert.deepEqual(mine.map((r) => r.action), ['schedule.create', 'schedule.update', 'schedule.cancel']);
  assert.ok(mine.every((r) => r.target_type === 'schedule'));
  const all = sql('SELECT detail, action, target_id FROM audit_log').map((r) => r.detail).join('\n');
  assert.ok(!all.includes(SECRET_NOTE), 'isi catatan bocor ke log audit');
  const upd = JSON.parse(mine[1].detail);
  assert.deepEqual([...upd.fields].sort(), ['note', 'start_time']);
  // tampilan audit supervisor
  const view = await api('sv', 'GET', '/api/sv/audit?action=schedule.update');
  assert.equal(view.status, 200, view.text);
  assert.ok(JSON.stringify(view.json).includes('Jam mulai'));
  assert.ok(JSON.stringify(view.json).includes('Catatan'));
  assert.ok(!JSON.stringify(view.json).includes(SECRET_NOTE));
});

test('kolom DB dan indeks ada; user_version tidak berubah', () => {
  const tables = sql("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['schedules', 'schedule_services', 'notifications']) assert.ok(tables.includes(t), t);
  assert.equal(sql('PRAGMA user_version')[0].user_version, 4);
});
