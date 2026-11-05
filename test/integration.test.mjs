// Tes menu Integrasi: Acesio -> WhatsApp, memakai WhatsApp tiruan (server HTTP kecil) dan server Acesio sungguhan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';

const KEY = 'amk_ab12cd34.' + 'x'.repeat(43);
const MEDICAL = 'RIWAYAT-MEDIS-RAHASIA';

// ---------- WhatsApp tiruan ----------
const fake = { seen: [], scopes: ['leads:write', 'events:write', 'messages:send'], slug: 'acesio', down: 0, rejectContacts: 0 };
const amnan = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'API key salah', code: 'UNAUTHORIZED' });
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/ping') {
      return send(200, { ok: true, contract: '1', brand: 'Klinik Uji', app: { id: 'ab12cd34', name: 'Acesio', scopes: fake.scopes }, wa: { status: 'connected' } });
    }
    fake.seen.push({ method: req.method, path: url.pathname, body, idem: req.headers['idempotency-key'] });
    if (fake.down > 0) { fake.down--; return send(503, { error: 'WhatsApp belum tersambung', code: 'WA_UNAVAILABLE' }); }
    if (url.pathname.startsWith('/api/v1/contacts/') && fake.rejectContacts > 0) { fake.rejectContacts--; return send(400, { error: 'data tidak valid', code: 'VALIDATION' }); }
    if (url.pathname === '/api/v1/events' && body.type.split('.')[0] !== fake.slug) {
      return send(403, { error: `Kunci ini hanya boleh mengirim kejadian berawalan "${fake.slug}."`, code: 'FORBIDDEN_SCOPE' });
    }
    return send(200, { ok: true });
  });
});
await new Promise((r) => amnan.listen(0, '127.0.0.1', r));
const AMNAN_URL = `http://127.0.0.1:${amnan.address().port}`;
const code = 'AMN1.' + Buffer.from(JSON.stringify({ u: AMNAN_URL, k: KEY, w: 'whsec_x', l: 'link' })).toString('base64url');

// ---------- Acesio ----------
let srv; let sv; let therapist; let therapistId;
const post = (p, body, who = sv, method = 'POST') => srv.call(p, { method, body, cookie: who.cookie });
const state = async () => (await srv.call('/api/sv/integration', { cookie: sv.cookie })).json;
const waitFor = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('waktu habis menunggu kondisi');
    await new Promise((r) => setTimeout(r, 100));
  }
};
let rm = 0;
async function newCustomer({ phone = '0812-3456-7001', name = 'Siti Aminah' } = {}) {
  const rmNo = `RM-${++rm}`;
  const r = await post('/api/staff/customers', { rm_no: rmNo, name, phone, medical_note: MEDICAL });
  assert.equal(r.status, 200, r.text);
  return rmNo;
}
// Fase 4: kunjungan = jadwal hari ini (dibuat supervisor) lalu diselesaikan terapis dengan SOAP.
const visit = async (rmNo, ids = [1, 2]) => {
  const sch = await createVisit(srv, sv.cookie, { userId: therapistId, customerRm: rmNo, serviceIds: ids });
  return post('/api/records', { schedule_id: sch.id, soap: VALID_SOAP }, therapist);
};

before(async () => {
  srv = await startServer({ env: { BOT_API_KEY: 'kunci-bot-uji-1234567890' } });
  sv = await srv.login();
  const r = await post('/api/sv/accounts', { username: 'terapis1', name: 'Terapis Satu', password: 'Password-Terapis-1', role: 'user' });
  assert.equal(r.status, 200, r.text);
  therapistId = r.json.id;
  therapist = await srv.login('terapis1', 'Password-Terapis-1');
  await post('/api/sv/services/1', { name: 'Fisioterapi' }, sv, 'PATCH');
  await post('/api/sv/services/2', { name: 'Terapi Latihan' }, sv, 'PATCH');
});
after(async () => { await srv.stop(); amnan.close(); });

test('hanya supervisor yang boleh membuka menu integrasi', async () => {
  assert.equal((await srv.call('/api/sv/integration')).status, 401);
  assert.equal((await srv.call('/api/sv/integration', { cookie: therapist.cookie })).status, 403);
  const s = await state();
  assert.equal(s.status, 'none');
  assert.equal(s.connected, false);
  assert.equal(s.amnan_can_read, true);
});

test('sambungan ditolak dengan pesan awam: kode asal, alamat http publik, kunci salah, izin kurang', async () => {
  let r = await post('/api/sv/integration/connect', { code: 'halo dunia' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tidak dikenali/);

  r = await post('/api/sv/integration/connect', { code: KEY, url: 'http://contoh.com' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /https/);

  r = await post('/api/sv/integration/connect', { code: KEY, url: 'http://127.0.0.1:1' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tidak bisa dijangkau/);

  r = await post('/api/sv/integration/connect', { code: 'amk_ab12cd34.' + 'y'.repeat(43), url: AMNAN_URL });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /ditolak/);

  fake.scopes = ['leads:write'];
  r = await post('/api/sv/integration/connect', { code });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /mencatat kunjungan/);
  fake.scopes = ['leads:write', 'events:write', 'messages:send'];
  assert.equal((await state()).connected, false, 'gagal menyambung tidak boleh menyimpan apa pun');
});

test('menyalakan sebelum tersambung ditolak', async () => {
  const r = await post('/api/sv/integration', { enabled: true }, sv, 'PUT');
  assert.equal(r.status, 409);
});

test('sambung lewat satu kode: alamat terisi dari kode, kunci tidak pernah kembali ke browser dan terenkripsi di database', async () => {
  const r = await post('/api/sv/integration/connect', { code });
  assert.equal(r.status, 200, r.text);
  const s = r.json;
  assert.equal(s.connected, true);
  assert.equal(s.status, 'paused');
  assert.equal(s.brand, 'Klinik Uji');
  assert.equal(s.wa_status, 'connected');
  assert.equal(s.url, AMNAN_URL);
  assert.equal(s.key_hint, 'amk_ab12cd34.••••••••');
  assert.ok(!r.text.includes('x'.repeat(20)), 'kunci bocor ke respons');

  const db = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  const dump = JSON.stringify(db.prepare('SELECT * FROM integration_settings').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  db.close();
  assert.ok(!dump.includes('x'.repeat(20)), 'kunci tersimpan polos di database atau audit');
  assert.ok(db && dump.includes('integration.connect'));
});

test('kunjungan terkirim ke WhatsApp: data pelanggan + catatan kejadian, tanpa SOAP', async () => {
  fake.seen.length = 0;
  assert.equal((await post('/api/sv/integration', { enabled: true }, sv, 'PUT')).json.status, 'on');
  const rmNo = await newCustomer();
  const r = await visit(rmNo);
  assert.equal(r.status, 200, r.text);

  await waitFor(() => fake.seen.length >= 2);
  const [put, ev] = fake.seen;
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/api/v1/contacts/6281234567001');
  assert.equal(put.body.name, 'Siti Aminah');
  assert.equal(put.body.data.rmNo, rmNo);
  assert.equal(put.body.data.visits, 1);
  assert.equal(put.body.data.lastServices, 'Fisioterapi, Terapi Latihan');
  assert.equal(ev.path, '/api/v1/events');
  assert.equal(ev.body.type, 'acesio.visit_recorded');
  assert.match(ev.body.summary, /Fisioterapi, Terapi Latihan/);
  assert.ok(put.idem && ev.idem && put.idem !== ev.idem);
  assert.ok(!JSON.stringify(fake.seen).includes(MEDICAL), 'SOAP bocor ke WhatsApp');
  // SOAP kunjungan tidak pernah dikirim ke WhatsApp (D10): tidak di permintaan keluar maupun di antrean (outbox).
  const outbox = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  const queued = JSON.stringify(outbox.prepare('SELECT * FROM integration_outbox').all());
  outbox.close();
  for (const text of Object.values(VALID_SOAP)) {
    assert.ok(!JSON.stringify(fake.seen).includes(text), `SOAP bocor ke WhatsApp: ${text}`);
    assert.ok(!queued.includes(text), `SOAP bocor ke outbox: ${text}`);
  }
  assert.equal(fake.seen.length, 2, 'ucapan terima kasih mati secara bawaan');

  const s = await waitFor(async () => { const x = await state(); return x.stats.sent_24h === 1 && x; });
  assert.equal(s.stats.pending, 0);
  assert.equal(s.recent[0].status, 'sent');
});

test('awalan kejadian mengikuti nama aplikasi pada kunci WhatsApp (menyesuaikan diri sekali)', async () => {
  fake.seen.length = 0;
  fake.slug = 'klinik';
  await visit(await newCustomer({ phone: '0812-3456-7002', name: 'Budi' }));
  await waitFor(() => fake.seen.filter((x) => x.path === '/api/v1/events').length >= 2);
  const evs = fake.seen.filter((x) => x.path === '/api/v1/events');
  assert.deepEqual(evs.map((e) => e.body.type), ['acesio.visit_recorded', 'klinik.visit_recorded']);
  fake.seen.length = 0;
  await visit(await newCustomer({ phone: '0812-3456-7003', name: 'Dewi' }));
  await waitFor(() => fake.seen.length >= 2);
  assert.deepEqual(fake.seen.filter((x) => x.path === '/api/v1/events').map((e) => e.body.type), ['klinik.visit_recorded']);
});

test('ucapan terima kasih: opsional, {nama} terisi, hanya sekali per pelanggan per hari', async () => {
  fake.seen.length = 0;
  let r = await post('/api/sv/integration', { send_thanks: true, thanks_text: 'Halo {nama}, terima kasih ya.' }, sv, 'PUT');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.send_thanks, true);
  const rmNo = await newCustomer({ phone: '0812-3456-7004', name: 'Rina' });
  await visit(rmNo, [1]);
  await visit(rmNo, [2]);
  await waitFor(() => fake.seen.filter((x) => x.path === '/api/v1/events').length >= 2);
  await new Promise((r2) => setTimeout(r2, 500));
  const msgs = fake.seen.filter((x) => x.path === '/api/v1/messages');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body.text, 'Halo Rina, terima kasih ya.');
  assert.equal(msgs[0].body.phone, '6281234567004');
  await post('/api/sv/integration', { send_thanks: false }, sv, 'PUT');
});

test('WhatsApp mati: pencatatan tetap berhasil, kiriman menunggu lalu terkirim; gagal tetap bisa dikirim ulang', async () => {
  fake.seen.length = 0;
  fake.down = 1000;
  const rmNo = await newCustomer({ phone: '0812-3456-7005', name: 'Agus' });
  const r = await visit(rmNo);
  assert.equal(r.status, 200, 'pencatatan layanan tidak boleh gagal karena WhatsApp mati');
  const s = await waitFor(async () => { const x = await state(); return x.stats.pending === 1 && x.recent[0].error && x; });
  assert.match(s.recent[0].error, /belum tersambung/);
  fake.down = 0;

  fake.rejectContacts = 1;
  const rm2 = await newCustomer({ phone: '0812-3456-7006', name: 'Tono' });
  await visit(rm2);
  const failed = await waitFor(async () => { const x = await state(); return x.stats.failed === 1 && x; });
  assert.equal(failed.status, 'problem');
  assert.match(failed.recent.find((x) => x.status === 'failed').error, /tidak valid/);

  const again = await post('/api/sv/integration/retry', {});
  assert.equal(again.status, 200);
  const ok = await waitFor(async () => { const x = await state(); return x.stats.failed === 0 && x.recent.find((i) => i.customer === 'Tono' && i.status === 'sent') && x; });
  assert.equal(ok.status, 'on');
});

test('customer tanpa nomor WA dilewati dengan penjelasan', async () => {
  fake.seen.length = 0;
  const rmNo = await newCustomer({ phone: '', name: 'Tanpa Nomor' });
  await visit(rmNo);
  const s = await waitFor(async () => { const x = await state(); return x.recent.find((i) => i.customer === 'Tanpa Nomor') && x; });
  const row = s.recent.find((i) => i.customer === 'Tanpa Nomor');
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /nomor WA/);
  assert.equal(fake.seen.length, 0);
});

test('dimatikan = tidak ada yang dikirim; putus = kunci terhapus', async () => {
  await post('/api/sv/integration', { enabled: false }, sv, 'PUT');
  fake.seen.length = 0;
  await visit(await newCustomer({ phone: '0812-3456-7007', name: 'Mati' }));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fake.seen.length, 0);

  const r = await post('/api/sv/integration/disconnect', {});
  assert.equal(r.json.status, 'none');
  assert.equal(r.json.connected, false);
  assert.equal(r.json.key_hint, '');
});

test('tes sambungan ulang melaporkan masalah dengan bahasa awam', async () => {
  await post('/api/sv/integration/connect', { code });
  fake.scopes = ['leads:write', 'events:write'];
  const ok = await post('/api/sv/integration/test', {});
  assert.equal(ok.json.test.ok, true);
  assert.equal(ok.json.can_message, false);
  const bad = await post('/api/sv/integration', { send_thanks: true }, sv, 'PUT');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /mengirim pesan/);
});
