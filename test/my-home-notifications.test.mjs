// Tes Fase 5: GET /api/my/home dan notifikasi (daftar, tandai dibaca) untuk user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, createVisit, VALID_SOAP, todayYmd } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const TODAY = todayYmd();
const TOMORROW = todayYmd(1);

let srv; let sdb;
let uBudi; let uSari; let uTia; let custRina; let custAndi; let custDewi;
const cookies = {};

const api = (who, method, url, body) => srv.call(url, {
  method, body: body === undefined && method !== 'GET' ? {} : body, cookie: who ? cookies[who] : undefined,
});
const one = (q, ...a) => sdb.prepare(q).get(...a);

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
const mk = (over = {}) => createVisit(srv, cookies.adm, { userId: uBudi, customerId: custRina, endTime: '', ...over });
const home = async (who) => { const r = await api(who, 'GET', '/api/my/home'); assert.equal(r.status, 200, r.text); return r.json; };
const notifs = async (who, qs = '') => { const r = await api(who, 'GET', `/api/my/notifications${qs}`); assert.equal(r.status, 200, r.text); return r.json; };

before(async () => {
  srv = await startServer();
  cookies.sv = (await srv.login()).cookie;
  await mkAccount('adm1', 'admin', 'Admin Satu');
  await mkAccount('spv1', 'supervisor', 'Supervisor Satu');
  uBudi = await mkAccount('budi', 'user', 'Budi');
  uSari = await mkAccount('sari', 'user', 'Sari');
  uTia = await mkAccount('tia', 'user', 'Tia');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cookies.spv = (await srv.login('spv1', PASS)).cookie;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  cookies.sari = (await srv.login('sari', PASS)).cookie;
  cookies.tia = (await srv.login('tia', PASS)).cookie;
  custRina = await mkCustomer('RM-001', 'Rina');
  custAndi = await mkCustomer('RM-002', 'Andi');
  custDewi = await mkCustomer('RM-003', 'Dewi');
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  sdb.exec('PRAGMA busy_timeout = 5000');
});

after(async () => {
  try { sdb?.close(); } catch { /* */ }
  await srv.stop();
});

// ---------------------------------------------------------------------------------------------
// Beranda
// ---------------------------------------------------------------------------------------------
test('home: user tanpa jadwal -> semua nol, next null', async () => {
  const h = await home('tia');
  assert.equal(h.today, TODAY);
  assert.equal(h.customers_today, 0);
  assert.deepEqual(h.by_status, { baru: 0, berjalan: 0, selesai: 0, batal: 0 });
  assert.equal(h.next, null);
  assert.equal(h.unread, 0);
});

test('home: customers_today unik, tanpa batal, tanpa hari lain, tanpa jadwal user lain', async () => {
  await mk({ customerId: custRina, startTime: '09:00' });
  await mk({ customerId: custRina, startTime: '11:00' }); // customer sama -> tetap satu
  await mk({ customerId: custAndi, startTime: '13:00' });
  const batal = await mk({ customerId: custDewi, startTime: '15:00' });
  const c = await api('spv', 'POST', `/api/staff/schedules/${batal.id}/cancel`);
  assert.equal(c.status, 200, c.text);
  await mk({ customerId: custDewi, day: TOMORROW });                  // hari lain
  await mk({ userId: uSari, customerId: custDewi, startTime: '10:00' }); // user lain

  const h = await home('budi');
  assert.equal(h.customers_today, 2);
  assert.deepEqual(h.by_status, { baru: 3, berjalan: 0, selesai: 0, batal: 1 });
  const hs = await home('sari');
  assert.equal(hs.customers_today, 1);
  assert.equal(hs.by_status.baru, 1);
});

test('home: by_status mengikuti mulai dan selesai; next mengikuti jam', async () => {
  // user baru supaya angkanya bersih
  const s1 = await createVisit(srv, cookies.adm, { userId: uSari, customerId: custAndi, startTime: '00:01', endTime: '00:30' });
  const s2 = await createVisit(srv, cookies.adm, { userId: uSari, customerId: custAndi, startTime: '23:59', endTime: '' });
  // Sari sudah punya satu jadwal 10:00 dari tes sebelumnya; baru = 3
  // Aturan next: jadwal terbuka dengan start_time >= jam sekarang yang paling awal; bila semua sudah lewat, yang paling awal.
  // Hasilnya bergantung jam dinding (00:01, 10:00, 23:59 jatuh di sisi mana pun), jadi harapan dihitung dari jam sekarang.
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const pick = (times) => times.find((t) => t >= hm) ?? times[0];
  let h = await home('sari');
  assert.deepEqual(h.by_status, { baru: 3, berjalan: 0, selesai: 0, batal: 0 });
  const nextAll = pick(['00:01', '10:00', '23:59']);
  assert.equal(h.next.start_time, nextAll);
  assert.equal(h.next.status, 'baru');
  if (nextAll === '23:59') assert.equal(h.next.id, s2.id);
  assert.ok(!('soap' in h.next), 'next tidak memuat SOAP');

  const st = await api('sari', 'POST', `/api/my/schedules/${s2.id}/start`);
  assert.equal(st.status, 200, st.text);
  h = await home('sari');
  assert.deepEqual(h.by_status, { baru: 2, berjalan: 1, selesai: 0, batal: 0 });
  assert.equal(h.next.start_time, nextAll); // jadwal berjalan ikut dihitung bersama yang baru
  if (nextAll === '23:59') { assert.equal(h.next.id, s2.id); assert.equal(h.next.status, 'berjalan'); }

  const done = await api('sari', 'POST', '/api/records', { schedule_id: s2.id, soap: VALID_SOAP });
  assert.equal(done.status, 200, done.text);
  h = await home('sari');
  assert.deepEqual(h.by_status, { baru: 2, berjalan: 0, selesai: 1, batal: 0 });
  assert.equal(h.customers_today, 2); // Andi + Dewi; jadwal selesai tetap dihitung
  // sisa: 00:01 dan 10:00. Salah satunya bisa saja belum lewat, tetapi next harus salah satu dari keduanya dan bukan yang selesai.
  assert.notEqual(h.next.id, s2.id);
  assert.equal(h.next.start_time, pick(['00:01', '10:00']));
  assert.ok(['baru', 'berjalan'].includes(h.next.status));
  assert.ok(s1.id);
});

test('home: semua jadwal terbuka sudah lewat -> ambil yang paling awal; tanpa jadwal terbuka -> null', async () => {
  const a = await createVisit(srv, cookies.adm, { userId: uTia, customerId: custRina, startTime: '00:00', endTime: '' });
  const h = await home('tia');
  assert.equal(h.next.id, a.id); // satu-satunya terbuka (00:00 hampir pasti sudah lewat) -> tetap dikembalikan
  const done = await api('tia', 'POST', '/api/records', { schedule_id: a.id, soap: VALID_SOAP });
  assert.equal(done.status, 200, done.text);
  assert.equal((await home('tia')).next, null);
});

test('home: admin dan supervisor 403', async () => {
  assert.equal((await api('adm', 'GET', '/api/my/home')).status, 403);
  assert.equal((await api('spv', 'GET', '/api/my/home')).status, 403);
});

test('home: tanpa login 401', async () => {
  assert.equal((await api(null, 'GET', '/api/my/home')).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Notifikasi
// ---------------------------------------------------------------------------------------------
test('notifikasi: jadwal baru -> tugas_baru belum dibaca; mulai dan selesai menambah notifikasi; terbaru dulu', async () => {
  const sched = await createVisit(srv, cookies.adm, { userId: uBudi, customerId: custAndi, startTime: '08:30', day: TODAY });
  let n = await notifs('budi');
  assert.equal(n.notifications[0].type, 'tugas_baru');
  assert.equal(n.notifications[0].schedule_id, sched.id);
  assert.equal(n.notifications[0].day, TODAY);
  assert.equal(n.notifications[0].read, false);
  assert.equal(n.notifications[0].title, 'Tugas baru');
  assert.equal(n.notifications[0].body, `Andi · ${TODAY} 08:30`);
  assert.deepEqual(Object.keys(n.notifications[0]).sort(), ['body', 'created_at', 'day', 'id', 'read', 'schedule_id', 'title', 'type']);
  assert.equal(n.unread, n.notifications.length);

  assert.equal((await api('budi', 'POST', `/api/my/schedules/${sched.id}/start`)).status, 200);
  assert.equal((await api('budi', 'POST', '/api/records', { schedule_id: sched.id, soap: VALID_SOAP })).status, 200);
  n = await notifs('budi');
  assert.deepEqual(n.notifications.slice(0, 3).map((x) => x.type), ['tugas_selesai', 'tugas_berjalan', 'tugas_baru']);
  assert.ok(n.notifications.every((x, i, a) => i === 0 || a[i - 1].id > x.id), 'urut id menurun');
  assert.equal((await home('budi')).unread, n.unread);
});

test('notifikasi: limit bekerja; nilai buruk 400', async () => {
  const all = await notifs('budi');
  assert.ok(all.notifications.length >= 3);
  const two = await notifs('budi', '?limit=2');
  assert.equal(two.notifications.length, 2);
  assert.equal(two.notifications[0].id, all.notifications[0].id);
  assert.equal(two.unread, all.unread, 'unread tidak dibatasi limit');
  assert.equal((await notifs('budi', '?limit=100')).notifications.length, all.notifications.length);
  for (const bad of ['0', 'abc', '101', '-1', '1.5']) {
    const r = await api('budi', 'GET', `/api/my/notifications?limit=${bad}`);
    assert.equal(r.status, 400, `limit=${bad}`);
  }
});

test('notifikasi: read dengan ids hanya menandai itu; id user lain diabaikan', async () => {
  const before = await notifs('budi');
  const [first, second] = before.notifications;
  const foreign = (await notifs('sari')).notifications[0];
  const r = await api('budi', 'POST', '/api/my/notifications/read', { ids: [first.id, foreign.id, 999999] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.unread, before.unread - 1);
  const after1 = await notifs('budi');
  assert.equal(after1.notifications.find((x) => x.id === first.id).read, true);
  assert.equal(after1.notifications.find((x) => x.id === second.id).read, false);
  // milik Sari tidak berubah
  assert.equal(one('SELECT read_at FROM notifications WHERE id = ?', foreign.id).read_at, '');
  // mengulang tidak mengubah waktu baca
  const t1 = one('SELECT read_at FROM notifications WHERE id = ?', first.id).read_at;
  await api('budi', 'POST', '/api/my/notifications/read', { ids: [first.id] });
  assert.equal(one('SELECT read_at FROM notifications WHERE id = ?', first.id).read_at, t1);
});

test('notifikasi: read all menandai semua milik sendiri saja', async () => {
  const sariBefore = await notifs('sari');
  assert.ok(sariBefore.unread > 0);
  const r = await api('budi', 'POST', '/api/my/notifications/read', { all: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, unread: 0 });
  assert.equal((await notifs('budi')).unread, 0);
  assert.equal((await notifs('sari')).unread, sariBefore.unread);
  assert.equal((await home('budi')).unread, 0);
});

test('notifikasi: body kosong atau salah bentuk -> 400', async () => {
  const bad = [
    {}, { ids: [] }, { ids: 'abc' }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ['1'] }, { ids: [true] }, { ids: [null] },
    { all: 'ya' }, { all: 1 }, { all: false }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
  ];
  for (const b of bad) {
    const r = await api('budi', 'POST', '/api/my/notifications/read', b);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 60));
  }
  // body bukan objek
  assert.equal((await srv.call('/api/my/notifications/read', { method: 'POST', body: '[1,2]', cookie: cookies.budi })).status, 400);
  assert.equal((await srv.call('/api/my/notifications/read', { method: 'POST', body: '', cookie: cookies.budi })).status, 400);
});

test('notifikasi: ids tepat 100 diterima', async () => {
  const r = await api('budi', 'POST', '/api/my/notifications/read', { ids: Array.from({ length: 100 }, (_, i) => i + 1) });
  assert.equal(r.status, 200, r.text);
});

test('notifikasi: user A tidak melihat milik user B', async () => {
  const b = await notifs('budi');
  const s = await notifs('sari');
  const bIds = new Set(b.notifications.map((x) => x.id));
  assert.ok(s.notifications.length > 0);
  assert.ok(s.notifications.every((x) => !bIds.has(x.id)));
  // satu jadwal Budi tidak bocor ke Sari lewat schedule_id
  const bSched = new Set(b.notifications.map((x) => x.schedule_id));
  assert.ok(s.notifications.every((x) => !bSched.has(x.schedule_id)));
});

test('notifikasi: admin/supervisor 403 pada kedua endpoint; tanpa login 401', async () => {
  for (const who of ['adm', 'spv']) {
    assert.equal((await api(who, 'GET', '/api/my/notifications')).status, 403, who);
    assert.equal((await api(who, 'POST', '/api/my/notifications/read', { all: true })).status, 403, who);
  }
  assert.equal((await api(null, 'GET', '/api/my/notifications')).status, 401);
  assert.equal((await api(null, 'POST', '/api/my/notifications/read', { all: true })).status, 401);
});

test('notifikasi: jadwal dibatalkan/diubah muncul dengan day dari jadwal', async () => {
  const s = await createVisit(srv, cookies.adm, { userId: uTia, customerId: custDewi, day: TOMORROW, startTime: '09:00' });
  const p = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}`, { start_time: '10:00' });
  assert.equal(p.status, 200, p.text);
  const c = await api('spv', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  assert.equal(c.status, 200, c.text);
  const n = await notifs('tia');
  const mine = n.notifications.filter((x) => x.schedule_id === s.id).map((x) => x.type);
  assert.deepEqual(mine, ['tugas_dibatalkan', 'tugas_diubah', 'tugas_baru']);
  assert.ok(n.notifications.filter((x) => x.schedule_id === s.id).every((x) => x.day === TOMORROW));
});

// ---------------------------------------------------------------------------------------------
// Bersih-bersih: pruneOldNotifications dipanggil langsung pada DB sementara (di proses tes ini).
// ---------------------------------------------------------------------------------------------
test('pruneOldNotifications: hapus yang lebih dari 90 hari, sisakan yang baru', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-prune-'));
  const { db } = await import('../server/db.js');
  const { pruneOldNotifications } = await import('../server/notifications.js');
  const uid = Number(db.prepare("INSERT INTO users (username, name, password_hash, role, created_at) VALUES ('prune', 'Prune', 'x', 'user', ?)")
    .run(new Date().toISOString()).lastInsertRowid);
  const ins = db.prepare("INSERT INTO notifications (user_id, type, title, created_at) VALUES (?, 'tugas_baru', ?, ?)");
  ins.run(uid, 'lama', new Date(Date.now() - 100 * 86400000).toISOString());
  ins.run(uid, 'baru', new Date(Date.now() - 10 * 86400000).toISOString());
  assert.equal(pruneOldNotifications(90), 1);
  assert.deepEqual(db.prepare('SELECT title FROM notifications').all().map((r) => r.title), ['baru']);
  assert.equal(pruneOldNotifications(0), 0);
});
