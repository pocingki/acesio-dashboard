// Pengajuan WhatsApp dengan booking: notif ke admin, Terima membuat jadwal + petugas, slot, status untuk WA-AMN, kalender.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const DAY = '2099-06-15';
let srv; let sv; let key; let worker; let svc;
const bot = (url, opt = {}) => srv.call(url, { ...opt, headers: { 'x-api-key': key } });
const staff = (url, body, method = 'POST') => srv.call(url, { method, body: body || {}, cookie: sv.cookie });
const get = (url) => srv.call(url, { cookie: sv.cookie });
const lead = (id, name, phone, data) => bot('/api/bot/incoming-leads', { method: 'POST', body: { name, phone, wa_lead_id: id, data } });
const pending = async () => (await get('/api/staff/incoming-leads')).json.leads;

before(async () => {
  srv = await startServer({ env: { SLOT_CHECK: undefined } }); sv = await srv.login();
  key = (await staff('/api/sv/integration/bot-key')).json.new_bot_key;
  const w = await staff('/api/sv/accounts', { username: 'terapis1', name: 'Terapis Satu', password: 'Password-Terapis-1', role: 'user' });
  assert.equal(w.status, 200, w.text);
  worker = (await get('/api/staff/schedule-workers')).json.workers[0];
  svc = (await bot('/api/bot/services')).json.services[0];
  assert.ok(worker && svc);
});
after(async () => { await srv.stop(); });

test('pengajuan baru: notif ke admin sekali, booking terbaca di daftar', async () => {
  const data = { booking_day: DAY, booking_time: '09:00', booking_services: [svc.name, 'Layanan Tak Ada'], gender: 'P' };
  const a = await lead('B1', 'Rina Booking', '081300000001', data);
  assert.equal(a.status, 200, a.text);
  assert.equal((await lead('B1', 'Rina Booking', '081300000001', data)).json.replayed, true);
  const n = (await get('/api/my/notifications')).json;
  const mine = n.notifications.filter((x) => x.type === 'pengajuan_baru');
  assert.equal(mine.length, 1, 'ulang tidak menggandakan notifikasi');
  assert.match(mine[0].body, /Rina Booking.*2099-06-15 09:00/);
  const p = (await pending()).find((l) => l.name === 'Rina Booking');
  assert.equal(p.booking.day, DAY); assert.equal(p.booking.time, '09:00');
  assert.deepEqual(p.booking.service_ids, [svc.id], 'layanan yang tidak dikenal dibuang');
  assert.equal('raw_data' in p, false);
});

test('slot: tersedia sebelum, penuh sesudah jadwal dibuat; tanggal salah 400', async () => {
  const before0 = (await bot(`/api/bot/slots?date=${DAY}`)).json;
  const s9 = before0.slots.find((s) => s.time === '09:00');
  assert.equal(before0.supported, true); assert.equal(s9.available, true); assert.equal(s9.free, 1);
  assert.equal((await bot('/api/bot/slots?date=bukan')).status, 400);
  assert.equal((await srv.call(`/api/bot/slots?date=${DAY}`)).status, 401);
  assert.equal((await bot('/api/bot/slots?date=2000-01-01')).json.slots.every((s) => !s.available), true, 'hari lampau tidak tersedia');
});

test('Terima dengan petugas: customer + jadwal terbentuk, petugas dapat notif, slot terisi, status untuk WA-AMN', async () => {
  const p = (await pending()).find((l) => l.name === 'Rina Booking');
  const acc = await staff(`/api/staff/incoming-leads/${p.id}/accept`, { user_id: worker.id, day: DAY, start_time: '09:00', service_ids: [svc.id] });
  assert.equal(acc.status, 200, acc.text);
  assert.equal(acc.json.schedule.day, DAY); assert.equal(acc.json.schedule.worker, 'Terapis Satu');
  const sch = (await get(`/api/staff/schedules?from=${DAY}&to=${DAY}`)).json;
  assert.equal(sch.schedules.length, 1); assert.equal(sch.schedules[0].customer.name, 'Rina Booking');
  const w = await srv.login('terapis1', 'Password-Terapis-1');
  const wn = (await srv.call('/api/my/notifications', { cookie: w.cookie })).json.notifications;
  assert.equal(wn.some((x) => x.type === 'tugas_baru'), true, 'petugas menerima notifikasi tugas');
  const after0 = (await bot(`/api/bot/slots?date=${DAY}`)).json.slots.find((s) => s.time === '09:00');
  assert.equal(after0.free, 0); assert.equal(after0.available, false);
  const st = (await bot('/api/bot/incoming-leads/status?ids=B1,TIDAKADA')).json.leads;
  assert.equal(st[0].status, 'accepted'); assert.deepEqual(st[0].schedule, { day: DAY, start_time: '09:00', worker: 'Terapis Satu' });
  assert.equal(st[1].status, 'unknown');
  assert.equal(JSON.stringify(st).includes('rm_no'), false);
});

test('bentrok petugas dan jam lewat: ditolak, pengajuan tetap pending, customer tidak dibuat', async () => {
  await lead('B2', 'Tono Bentrok', '081300000002', { booking_day: DAY, booking_time: '09:00', booking_services: [svc.name] });
  const p = (await pending()).find((l) => l.name === 'Tono Bentrok');
  const clash = await staff(`/api/staff/incoming-leads/${p.id}/accept`, { user_id: worker.id, day: DAY, start_time: '09:00', service_ids: [svc.id] });
  assert.equal(clash.status, 409, clash.text); assert.match(clash.json.error, /sudah punya jadwal/);
  const past = await staff(`/api/staff/incoming-leads/${p.id}/accept`, { user_id: worker.id, day: '2000-01-01', start_time: '09:00', service_ids: [svc.id] });
  assert.equal(past.status, 400, past.text);
  const incomplete = await staff(`/api/staff/incoming-leads/${p.id}/accept`, { user_id: worker.id, day: DAY });
  assert.equal(incomplete.status, 400);
  assert.equal((await pending()).some((l) => l.name === 'Tono Bentrok'), true, 'masih pending');
  assert.equal((await get('/api/staff/customers?q=Tono')).json.customers.length, 0, 'customer tidak terbentuk');
  const ok = await staff(`/api/staff/incoming-leads/${p.id}/accept`, { user_id: worker.id, day: DAY, start_time: '10:00', service_ids: [svc.id] });
  assert.equal(ok.status, 200, ok.text);
});

test('Terima tanpa kolom jadwal tetap membuat customer saja; Tolak terlihat di status', async () => {
  await lead('B3', 'Sari Tanpa Jadwal', '081300000003', {});
  await lead('B4', 'Dedi Tolak', '081300000004', {});
  const ps = await pending();
  const a = await staff(`/api/staff/incoming-leads/${ps.find((l) => l.name === 'Sari Tanpa Jadwal').id}/accept`);
  assert.equal(a.status, 200); assert.equal(a.json.schedule, null);
  const r = await staff(`/api/staff/incoming-leads/${ps.find((l) => l.name === 'Dedi Tolak').id}/reject`, { reason: 'Jadwal penuh' });
  assert.equal(r.status, 200);
  const st = (await bot('/api/bot/incoming-leads/status?ids=B4')).json.leads[0];
  assert.equal(st.status, 'rejected'); assert.equal(st.rejection_reason, 'Jadwal penuh'); assert.equal(st.schedule, null);
  assert.equal((await bot('/api/bot/incoming-leads/status')).status, 400);
});

test('kalender bulan: jumlah jadwal per hari', async () => {
  const c = (await get('/api/staff/schedule-calendar?month=2099-06')).json;
  assert.equal(c.month, '2099-06'); assert.equal(c.days[DAY].total, 2); assert.equal(c.days[DAY].baru, 2);
  assert.equal((await get('/api/staff/schedule-calendar?month=2099-13')).status, 400);
  assert.equal((await srv.call('/api/staff/schedule-calendar?month=2099-06')).status, 401);
});

test('jam layanan diatur dari dashboard (supervisor) dan memengaruhi slot', async () => {
  const { bookingConfig, saveBookingConfig } = await import('../server/booking.js');
  assert.throws(() => saveBookingConfig({ from: '17:00', to: '09:00', step: 60 }));
  assert.throws(() => saveBookingConfig({ from: '09:00', to: '17:00', step: 5 }));
  const c = saveBookingConfig({ from: '08:00', to: '12:00', step: 30 });
  assert.deepEqual(c, { from: '08:00', to: '12:00', step: 30 });
  assert.deepEqual(bookingConfig({}), c, 'pengaturan dashboard mengalahkan env');
  saveBookingConfig({ from: '09:00', to: '17:00', step: 60 });
});
