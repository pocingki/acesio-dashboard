// Workflow terapis: Mulai -> WAJIB isi SOAP -> hitung mundur -> (waktu habis) menunggu approve admin/supervisor -> Selesai.
// Waktu dimajukan lewat APP_FAKE_NOW_FILE (khusus NODE_ENV=test); SESSION_TIMER tidak dimatikan seperti di tes lain.
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
  srv = await startServer({ env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, SESSION_TIMER: undefined, SESSION_MINUTES: '30' } });
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

test('Mulai: status berjalan, fase soap, hitung mundur BELUM jalan', async () => {
  setNow('09:00');
  const s = await mk();
  assert.equal(s.phase, null, 'jadwal Baru belum punya fase');
  const r = await start('budi', s.id);
  assert.equal(r.status, 200, r.text);
  const d = r.json.schedule;
  assert.equal(d.status, 'berjalan');
  assert.equal(d.phase, 'soap');
  assert.equal(d.due_at, '');
  assert.equal(d.remaining_sec, 0);
  setNow('09:40');
  assert.equal((await mine('budi', s.id)).remaining_sec, 0, 'waktu berlalu sebelum SOAP tidak mengurangi apa pun');
  const home = await api('budi', 'GET', '/api/my/home');
  assert.ok(home.json.phases.soap >= 1);
});

test('SOAP disimpan: hitung mundur mulai dari saat itu (jam selesai - jam mulai); belum ada record; masih berjalan', async () => {
  setNow('10:00');
  const s = await mk({ startTime: '10:00', endTime: '11:00' });
  await start('budi', s.id);
  setNow('10:05');
  const before = records();
  const r = await soap('budi', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.count, 0, 'layanan belum dicatat sebelum approve');
  const d = r.json.schedule;
  assert.equal(d.status, 'berjalan');
  assert.equal(d.phase, 'timer');
  assert.equal(d.due_at, at('11:05'));
  assert.equal(d.remaining_sec, 3600);
  assert.equal(d.soap.s, VALID_SOAP.s);
  assert.equal(records(), before);
  setNow('10:35');
  assert.equal((await mine('budi', s.id)).remaining_sec, 1800, 'sisa dihitung server dari jam sekarang');
  const log = sql("SELECT detail FROM audit_log WHERE action = 'schedule.soap' AND target_id = ?", String(s.id));
  assert.equal(log.length, 1);
  assert.ok(!log[0].detail.includes(VALID_SOAP.s), 'isi SOAP tidak masuk audit');
});

test('tanpa jam selesai: durasi dari SESSION_MINUTES', async () => {
  setNow('11:00');
  const s = await mk({ startTime: '11:00', endTime: '' });
  await start('budi', s.id);
  const r = await soap('budi', s.id);
  assert.equal(r.json.schedule.remaining_sec, 1800);
  assert.equal(r.json.schedule.due_at, at('11:30'));
});

test('SOAP wajib dulu: approve sebelum SOAP ditolak; SOAP tidak valid ditolak dan hitung mundur tidak mulai', async () => {
  setNow('12:00');
  const s = await mk({ startTime: '12:00', endTime: '12:30' });
  await start('budi', s.id);
  const a = await approve('adm', s.id);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'SOAP_PENDING');
  const bad = await api('budi', 'POST', '/api/records', { schedule_id: s.id, soap: { ...VALID_SOAP, o: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'SOAP_REQUIRED');
  assert.equal((await mine('budi', s.id)).phase, 'soap');
});

test('selama hitung mundur: SOAP kedua dan approve ditolak, tidak ada record', async () => {
  setNow('13:00');
  const s = await mk({ startTime: '13:00', endTime: '14:00' });
  await start('budi', s.id);
  await soap('budi', s.id);
  setNow('13:30');
  const before = records();
  const c = await soap('budi', s.id);
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'SOAP_ALREADY_SAVED');
  const a = await approve('adm', s.id);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'TIMER_RUNNING');
  const early = await api('adm', 'GET', '/api/my/notifications');
  assert.ok(early.json.notifications.every((x) => x.schedule_id !== s.id), 'belum ada notifikasi approve selama hitung mundur');
  assert.equal(records(), before);
  assert.equal(one('SELECT status FROM schedules WHERE id = ?', s.id).status, 'berjalan');
});

test('waktu habis -> menunggu approve; muncul di filter staf; staf bisa membaca SOAP', async () => {
  setNow('15:00');
  const s = await mk({ startTime: '15:00', endTime: '15:30' });
  await start('budi', s.id);
  await soap('budi', s.id);
  setNow('15:30');
  const d = await mine('budi', s.id);
  assert.equal(d.phase, 'menunggu');
  assert.equal(d.remaining_sec, 0);
  assert.equal((await soap('budi', s.id)).json.code, 'SOAP_ALREADY_SAVED');
  const pend = await api('adm', 'GET', `/api/staff/schedules?from=${DAY}&to=${DAY}&status=menunggu`);
  assert.equal(pend.status, 200);
  assert.ok(pend.json.schedules.some((x) => x.id === s.id));
  assert.ok(pend.json.schedules.every((x) => x.phase === 'menunggu' && x.status === 'berjalan'));
  assert.equal(pend.json.pending_approval, pend.json.total);
  const running = await api('adm', 'GET', `/api/staff/schedules?from=${DAY}&to=${DAY}&status=berjalan`);
  assert.ok(running.json.schedules.some((x) => x.id === s.id), 'menunggu approve tetap berstatus berjalan');
  const detail = await api('adm', 'GET', `/api/staff/schedules/${s.id}`);
  assert.equal(detail.json.schedule.soap.s, VALID_SOAP.s, 'staf melihat SOAP sebelum approve');
  assert.equal((await api('adm', 'GET', '/api/staff/schedules?status=ngawur')).status, 400);
  const home = await api('budi', 'GET', '/api/my/home');
  assert.ok(home.json.phases.menunggu >= 1);
  const bell = await api('adm', 'GET', '/api/my/notifications');
  assert.equal(bell.status, 200, bell.text);
  const item = bell.json.notifications.find((x) => x.type === 'perlu_approve' && x.schedule_id === s.id);
  assert.ok(item, 'admin diberi tahu untuk approve');
  assert.equal(item.read, false);
  assert.match(item.body, /Budi/);
  assert.match(item.body, /Rina/);
  const again = await api('adm', 'GET', '/api/my/notifications');
  assert.equal(again.json.notifications.filter((x) => x.type === 'perlu_approve' && x.schedule_id === s.id).length, 1);
  const svBell = await api('sv', 'GET', '/api/my/notifications');
  assert.ok(svBell.json.notifications.some((x) => x.type === 'perlu_approve' && x.schedule_id === s.id));
  const therapist = await api('budi', 'GET', '/api/my/notifications');
  assert.ok(therapist.json.notifications.every((x) => x.type !== 'perlu_approve'));
});

test('approve: hanya staf, sekali saja; approve = Selesai + layanan/komisi tercatat + notifikasi', async () => {
  setNow('16:00');
  const s = await mk({ startTime: '16:00', endTime: '16:30' });
  await start('budi', s.id);
  await soap('budi', s.id);
  setNow('16:30');
  const before = records();
  assert.equal((await approve('budi', s.id)).status, 403, 'user tidak boleh approve');
  assert.equal((await approve('sari', s.id)).status, 403);
  assert.equal(records(), before);
  const ok = await approve('adm', s.id);
  assert.equal(ok.status, 200, ok.text);
  const d = ok.json.schedule;
  assert.equal(d.status, 'selesai');
  assert.equal(d.phase, null);
  assert.equal(d.approved_by_name, 'Admin Satu');
  assert.ok(d.approved_at && d.completed_at);
  assert.equal(d.soap.s, VALID_SOAP.s, 'SOAP tetap tersimpan');
  assert.equal(records(), before + 1, 'satu record per layanan jadwal');
  assert.equal((await approve('sv', s.id)).status, 409, 'approve kedua ditolak');
  assert.equal(records(), before + 1);
  const note = sql("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'tugas_selesai' AND schedule_id = ?", uBudi, s.id);
  assert.equal(note.length, 1);
  assert.equal(sql("SELECT 1 FROM audit_log WHERE action = 'schedule.approve' AND target_id = ?", String(s.id)).length, 1);
});

test('supervisor juga bisa approve', async () => {
  setNow('17:00');
  const s = await mk({ startTime: '17:00', endTime: '17:15' });
  await start('budi', s.id);
  await soap('budi', s.id);
  setNow('17:15');
  const r = await approve('sv', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'selesai');
  assert.ok(r.json.schedule.approved_by_name.length > 0);
});

test('tidak bisa melewati Mulai: SOAP dari Baru ditolak; approve jadwal Baru ditolak', async () => {
  setNow('18:00');
  const s = await mk({ startTime: '18:00', endTime: '18:30' });
  const c = await soap('budi', s.id);
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'SCHEDULE_STATE');
  const a = await approve('adm', s.id);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'SCHEDULE_STATE');
  assert.equal((await approve('adm', 999999)).status, 404);
});

test('jadwal berjalan lama (flow 0, dimulai sebelum alur ini) tetap selesai langsung saat SOAP disimpan', async () => {
  setNow('19:00');
  const s = await mk({ startTime: '19:00', endTime: '19:30' });
  await start('budi', s.id);
  sdb.prepare('UPDATE schedules SET flow = 0 WHERE id = ?').run(s.id);
  assert.equal((await mine('budi', s.id)).phase, null);
  const before = records();
  const r = await soap('budi', s.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'selesai');
  assert.equal(records(), before + 1);
  assert.equal((await approve('adm', s.id)).status, 409, 'jadwal selesai tidak perlu approve');
});

test('supervisor tetap bisa membatalkan jadwal yang menunggu approve; approve sesudahnya ditolak', async () => {
  setNow('20:00');
  const s = await mk({ startTime: '20:00', endTime: '20:10' });
  await start('budi', s.id);
  await soap('budi', s.id);
  setNow('20:10');
  assert.equal((await mine('budi', s.id)).phase, 'menunggu');
  const before = records();
  const r = await api('sv', 'POST', `/api/staff/schedules/${s.id}/cancel`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schedule.status, 'batal');
  assert.equal((await approve('adm', s.id)).status, 409);
  assert.equal(records(), before);
});
