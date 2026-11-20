// Workflow terapis: Mulai -> (pelayanan selesai) isi SOAP paling lambat 23.00 WIB -> menunggu approve -> Selesai.
// Approve admin/supervisor: hari yang sama, atau besoknya sampai 10.00 WIB. Staf bisa mengisi/mengubah SOAP dan layanan.
// Waktu dimajukan lewat APP_FAKE_NOW_FILE (khusus NODE_ENV=test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';

const PASS = 'Rahasia-Tes-123';
const DAY = '2026-03-10';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+07:00`).toISOString();

let srv; let sdb; let clockDir; let clockFile;
let uBudi; let uSari; let cust;
const cookies = {};
const setNow = (hhmm) => fs.writeFileSync(clockFile, at(hhmm));
const setDayAt = (day, hhmm) => fs.writeFileSync(clockFile, new Date(`${day}T${hhmm}:00+07:00`).toISOString());
const api = (who, method, url, body) => srv.call(url, { method, body: body === undefined && method !== 'GET' ? {} : body, cookie: cookies[who] });
const one = (q, ...a) => sdb.prepare(q).get(...a);
const sql = (q, ...a) => sdb.prepare(q).all(...a);
const mk = (over = {}) => createVisit(srv, cookies.adm, { userId: uBudi, customerId: cust, day: DAY, startTime: '09:00', endTime: '10:00', ...over });
const start = (who, id) => api(who, 'POST', `/api/my/schedules/${id}/start`);
const approve = (who, id) => api(who, 'POST', `/api/staff/schedules/${id}/approve`);
const soap = (who, id) => api(who, 'POST', '/api/records', { schedule_id: id, soap: VALID_SOAP });
const records = () => one('SELECT COUNT(*) AS n FROM records WHERE user_id = ?', uBudi).n;
const mine = async (who, id) => (await api(who, 'GET', `/api/my/schedules/${id}`)).json.schedule;

before(async () => {
  clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-timer-'));
  clockFile = path.join(clockDir, 'now.txt');
  setNow('09:00');
  srv = await startServer({ env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SESSION_TIMER: undefined, SLOT_CHECK: 'off' } });
  cookies.sv = (await srv.login()).cookie;
  const mkAcc = async (username, role, name) => {
    const r = await api('sv', 'POST', '/api/sv/accounts', { username, name, password: PASS, role });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  await mkAcc('adm1', 'admin', 'Admin Satu');
  uBudi = await mkAcc('budi', 'user', 'Budi');
  uSari = await mkAcc('sari', 'user', 'Sari');
  cookies.adm = (await srv.login('adm1', PASS)).cookie;
  cookies.budi = (await srv.login('budi', PASS)).cookie;
  cookies.sari = (await srv.login('sari', PASS)).cookie;
  const c = await api('adm', 'POST', '/api/staff/customers', { rm_no: 'RM-T1', name: 'Rina' });
  assert.equal(c.status, 200, c.text);
  cust = c.json.id;
  sdb = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
});
after(async () => { sdb?.close(); await srv.stop(); fs.rmSync(clockDir, { recursive: true, force: true }); });

test('Mulai: status berjalan, fase soap, tanpa hitung mundur', async () => {
  setNow('09:00');
  const s = await mk();
  assert.equal(s.phase, null);
  const r = await start('budi', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'berjalan');
  assert.equal(r.json.schedule.phase, 'soap');
  assert.equal(r.json.schedule.soap_deadline, '23:00');
  assert.equal(r.json.schedule.approve_until, '10:00');
  assert.equal(r.json.schedule.can_approve, false);
  assert.equal('remaining_sec' in r.json.schedule, false, 'hitung mundur dihapus');
  setNow('22:59');
  assert.equal((await mine('budi', s.id)).phase, 'soap', 'sebelum 23.00 masih boleh mengisi SOAP');
});

test('SOAP disimpan kapan saja sebelum 23.00: tanpa waktu mundur, langsung menunggu approve, belum ada record', async () => {
  setNow('10:00');
  const s = await mk({ startTime: '10:00', endTime: '11:00' });
  await start('budi', s.id);
  setNow('10:05');
  const before = records();
  const r = await soap('budi', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.count, 0);
  const d = r.json.schedule;
  assert.equal(d.status, 'berjalan');
  assert.equal(d.phase, 'menunggu');
  assert.equal(d.can_approve, true);
  assert.equal(d.soap_at, at('10:05'));
  assert.equal(records(), before);
  const log = sql("SELECT detail FROM audit_log WHERE action = 'schedule.soap' AND target_id = ?", String(s.id));
  assert.equal(log.length, 1);
  assert.ok(!log[0].detail.includes(VALID_SOAP.s), 'isi SOAP tidak masuk audit');
  assert.equal((await soap('budi', s.id)).json.code, 'SOAP_ALREADY_SAVED');
});

test('approve sebelum SOAP ditolak; SOAP tidak valid ditolak', async () => {
  setNow('12:00');
  const s = await mk({ startTime: '12:00', endTime: '12:30' });
  await start('budi', s.id);
  const a = await approve('adm', s.id);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'SOAP_PENDING');
  const bad = await api('budi', 'POST', '/api/records', { schedule_id: s.id, soap: { ...VALID_SOAP, o: '' } });
  assert.equal(bad.status, 400);
  assert.equal((await mine('budi', s.id)).phase, 'soap');
});

test('lewat 23.00 tanpa SOAP: user tidak bisa mengisi, fase lewat, approve ditolak', async () => {
  setNow('13:00');
  const s = await mk({ startTime: '13:00', endTime: '14:00' });
  await start('budi', s.id);
  setNow('23:00');
  assert.equal((await mine('budi', s.id)).phase, 'lewat');
  const r = await soap('budi', s.id);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SOAP_DEADLINE');
  const a = await approve('adm', s.id);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'SOAP_PENDING');
  setDayAt('2026-03-11', '08:00');
  const r2 = await soap('budi', s.id);
  assert.equal(r2.status, 409, 'besoknya user juga tidak bisa');
  assert.equal(r2.json.code, 'SOAP_DEADLINE');
  assert.equal(sql("SELECT 1 FROM schedules WHERE id = ? AND batch <> '' AND batch IS NOT NULL", s.id).length, 0, 'tanpa SOAP tidak ada komisi');
});

test('user yang terlambat: staf mengisi SOAP -> menunggu approve -> approve besok pagi sebelum 10.00 -> komisi pada tanggal jadwal', async () => {
  setNow('08:00');
  const s = await mk({ startTime: '08:00', endTime: '08:30' });
  await start('budi', s.id);
  setDayAt('2026-03-10', '23:30');
  assert.equal((await mine('budi', s.id)).phase, 'lewat');
  assert.equal((await api('budi', 'PATCH', `/api/staff/schedules/${s.id}/soap`, { soap: VALID_SOAP })).status, 403, 'user tidak boleh');
  const f = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/soap`, { soap: VALID_SOAP });
  assert.equal(f.status, 200, f.text);
  assert.equal(f.json.schedule.phase, 'menunggu');
  assert.equal(f.json.schedule.soap.s, VALID_SOAP.s);
  const bad = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/soap`, { soap: { ...VALID_SOAP, p: '' } });
  assert.equal(bad.status, 400);
  const before = records();
  setDayAt('2026-03-11', '09:59');
  const ok = await approve('sv', s.id);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.schedule.status, 'selesai');
  assert.equal(records(), before + 1);
  assert.equal(one('SELECT day FROM records WHERE batch = ?', one('SELECT batch FROM schedules WHERE id = ?', s.id).batch).day, DAY, 'komisi tercatat pada tanggal jadwal');
  const log = sql("SELECT detail FROM audit_log WHERE action = 'schedule.soap_staff' AND target_id = ?", String(s.id));
  assert.equal(log.length, 1);
  assert.ok(log[0].detail.includes('late_fill'));
});

test('batas approve: hari yang sama kapan saja; besok sampai 09.59; 10.00 ke atas dan lusa ditolak', async () => {
  const run = async (tag, h, expectStatus, nowDay = DAY) => {
    setNow('15:00');
    const s = await mk({ startTime: '15:00', endTime: '15:30' });
    await start('budi', s.id);
    await soap('budi', s.id);
    setDayAt(nowDay, h);
    const r = await approve('adm', s.id);
    assert.equal(r.status, expectStatus, `${tag}: ${r.text}`);
    return r;
  };
  await run('malam hari sama', '23:30', 200);
  await run('besok 09.59', '09:59', 200, '2026-03-11');
  const late = await run('besok 10.00', '10:00', 409, '2026-03-11');
  assert.equal(late.json.code, 'APPROVE_CLOSED');
  assert.match(late.json.error || late.text, /10\.00/);
  const lusa = await run('lusa', '08:00', 409, '2026-03-12');
  assert.equal(lusa.json.code, 'APPROVE_CLOSED');
});

test('daftar staf: fase menunggu muncul, notifikasi approve, user tidak dapat notifikasi approve', async () => {
  setNow('15:40');
  const s = await mk({ startTime: '15:40', endTime: '16:00' });
  await start('budi', s.id);
  await soap('budi', s.id);
  const pend = await api('adm', 'GET', `/api/staff/schedules?from=${DAY}&to=${DAY}&status=menunggu`);
  assert.equal(pend.status, 200);
  assert.ok(pend.json.schedules.some((x) => x.id === s.id));
  assert.ok(pend.json.schedules.every((x) => x.phase === 'menunggu' && x.status === 'berjalan'));
  const home = await api('budi', 'GET', '/api/my/home');
  assert.ok(home.json.phases.menunggu >= 1);
  const bell = await api('adm', 'GET', '/api/my/notifications');
  const item = bell.json.notifications.find((x) => x.type === 'perlu_approve' && x.schedule_id === s.id);
  assert.ok(item, 'admin diberi tahu untuk approve');
  const therapist = await api('budi', 'GET', '/api/my/notifications');
  assert.ok(therapist.json.notifications.every((x) => x.type !== 'perlu_approve'));
});

test('approve: hanya staf, sekali saja; approve = Selesai + layanan/komisi + notifikasi', async () => {
  setNow('16:00');
  const s = await mk({ startTime: '16:00', endTime: '16:30' });
  await start('budi', s.id);
  await soap('budi', s.id);
  const before = records();
  assert.equal((await approve('budi', s.id)).status, 403);
  assert.equal((await approve('sari', s.id)).status, 403);
  assert.equal(records(), before);
  const ok = await approve('adm', s.id);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.schedule.status, 'selesai');
  assert.equal(ok.json.schedule.approved_by_name, 'Admin Satu');
  assert.equal(records(), before + 1);
  assert.equal((await approve('sv', s.id)).status, 409);
  assert.equal(records(), before + 1);
  assert.equal(sql("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'tugas_selesai' AND schedule_id = ?", uBudi, s.id).length, 1);
});

test('staf mengubah SOAP pada jadwal menunggu dan jadwal selesai', async () => {
  setNow('17:00');
  const s = await mk({ startTime: '17:00', endTime: '17:15' });
  await start('budi', s.id);
  await soap('budi', s.id);
  const edit = { ...VALID_SOAP, s: 'Keluhan diperbarui oleh admin setelah pelayanan.' };
  const e1 = await api('sv', 'PATCH', `/api/staff/schedules/${s.id}/soap`, { soap: edit });
  assert.equal(e1.status, 200, e1.text);
  assert.equal(e1.json.schedule.soap.s, edit.s);
  assert.equal(e1.json.schedule.phase, 'menunggu');
  assert.equal((await approve('sv', s.id)).status, 200);
  const e2 = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/soap`, { soap: { ...edit, a: 'Asesmen diperbaiki setelah selesai.' } });
  assert.equal(e2.status, 200, e2.text);
  assert.equal(e2.json.schedule.status, 'selesai');
  const baru = await mk({ startTime: '18:00', endTime: '18:30' });
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${baru.id}/soap`, { soap: VALID_SOAP })).status, 409, 'jadwal Baru tidak punya SOAP');
});

test('staf menambah dan mengurangi layanan pada jadwal selesai: record dan komisi ikut, batch sama, tanpa WA ulang', async () => {
  const svcs = (await api('adm', 'GET', '/api/services')).json.services;
  assert.ok(svcs.length >= 2, 'perlu minimal 2 layanan master');
  setNow('19:00');
  const s = await mk({ startTime: '19:00', endTime: '19:30' });
  const firstSvc = [1];
  await start('budi', s.id);
  await soap('budi', s.id);
  assert.equal((await approve('adm', s.id)).status, 200);
  const batch = one('SELECT batch FROM schedules WHERE id = ?', s.id).batch;
  const n0 = one('SELECT COUNT(*) AS n FROM records WHERE batch = ?', batch).n;
  const extra = svcs.map((x) => x.id).find((id) => !firstSvc.includes(id));
  const add = await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [...firstSvc, extra] });
  assert.equal(add.status, 200, add.text);
  assert.equal(one('SELECT COUNT(*) AS n FROM records WHERE batch = ?', batch).n, n0 + 1);
  assert.equal(one('SELECT COUNT(*) AS n FROM records WHERE batch = ? AND day <> ?', batch, DAY).n, 0, 'tanggal = tanggal jadwal');
  assert.equal((await mine('budi', s.id)).services.length, firstSvc.length + 1);
  const same = await api('sv', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [...firstSvc, extra] });
  assert.equal(same.status, 200);
  assert.equal(one('SELECT COUNT(*) AS n FROM records WHERE batch = ?', batch).n, n0 + 1, 'tanpa perubahan = tanpa record baru');
  const rm = await api('sv', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [extra] });
  assert.equal(rm.status, 200, rm.text);
  assert.equal(one('SELECT COUNT(*) AS n FROM records WHERE batch = ?', batch).n, 1);
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [] })).status, 400);
  assert.equal((await api('budi', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [extra] })).status, 403);
  assert.equal(sql("SELECT 1 FROM audit_log WHERE action = 'schedule.services_staff' AND target_id = ?", String(s.id)).length, 2);
});

test('tambah layanan saat jadwal masih berjalan: hanya daftar, record belum ada sampai approve', async () => {
  const svcs = (await api('adm', 'GET', '/api/services')).json.services;
  setNow('20:00');
  const s = await mk({ startTime: '20:00', endTime: '20:30' });
  const first = [1];
  await start('budi', s.id);
  const extra = svcs.map((x) => x.id).find((id) => !first.includes(id));
  const before = records();
  assert.equal((await api('adm', 'PATCH', `/api/staff/schedules/${s.id}/services`, { service_ids: [...first, extra] })).status, 200);
  assert.equal(records(), before);
  await soap('budi', s.id);
  assert.equal((await approve('adm', s.id)).status, 200);
  assert.equal(records(), before + first.length + 1);
});

test('supervisor tetap bisa membatalkan jadwal yang menunggu approve; approve sesudahnya ditolak', async () => {
  setNow('21:00');
  const s = await mk({ startTime: '21:00', endTime: '21:10' });
  await start('budi', s.id);
  await soap('budi', s.id);
  const before = records();
  const r = await api('sv', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  assert.equal(r.status, 200, r.text);
  assert.equal((await approve('adm', s.id)).status, 409);
  assert.equal(records(), before);
});

test('jadwal flow 0 (lama) tetap selesai langsung saat SOAP disimpan', async () => {
  setNow('19:50');
  const s = await mk({ startTime: '19:50', endTime: '19:55' });
  await start('budi', s.id);
  sdb.prepare('UPDATE schedules SET flow = 0 WHERE id = ?').run(s.id);
  assert.equal((await mine('budi', s.id)).phase, null);
  const before = records();
  const r = await soap('budi', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'selesai');
  assert.equal(records(), before + s.services.length);
});

test('approve ketepatan waktu harian mengikuti jendela yang sama', async () => {
  setNow('09:00');
  await mk({ userId: uSari, startTime: '07:00', endTime: '07:30' });
  setDayAt('2026-03-11', '09:00');
  const ok = await api('adm', 'POST', '/api/staff/reviews', { user_id: uSari, day: DAY, late: false });
  assert.equal(ok.status, 200, ok.text);
  setDayAt('2026-03-11', '10:00');
  const closed = await api('sv', 'POST', '/api/staff/reviews', { user_id: uBudi, day: DAY, late: false });
  assert.equal(closed.status, 409, closed.text);
  setDayAt('2026-03-12', '08:00');
  assert.equal((await api('sv', 'POST', '/api/staff/reviews', { user_id: uBudi, day: DAY, late: false })).status, 409);
});
