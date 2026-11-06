// Revisi v1.4: profil akun + foto, logika customer awal vs baru, donat "New customer" per periode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, todayYmd } from './helpers.mjs';

let srv; let sv;
// PNG 1x1 valid
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => { srv = await startServer(); sv = (await srv.login()).cookie; });
after(async () => { await srv.stop(); });

test('profil: isi data diri + foto, tampil di /me, foto lama dihapus saat diganti', async () => {
  const get = await srv.call('/api/auth/profile', { cookie: sv });
  assert.equal(get.status, 200);
  assert.equal(get.json.profile.photo, null);
  const bad = await srv.call('/api/auth/profile', { method: 'PATCH', cookie: sv, body: { email: 'bukan-email' } });
  assert.equal(bad.status, 400);
  const r = await srv.call('/api/auth/profile', { method: 'PATCH', cookie: sv, body: { name: 'Sari Supervisor', phone: '0812-3456-789', email: 'sari@acesio.id', birth_date: '1990-05-17', address: 'Jl. Melati 1', photo: PNG } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.profile.photo, /^\/uploads\/usr\d+-/);
  assert.equal(r.json.profile.name, 'Sari Supervisor');
  const me = await srv.call('/api/auth/me', { cookie: sv });
  assert.equal(me.json.user.photo, r.json.profile.photo);
  assert.equal((await srv.call(r.json.profile.photo)).status, 401);
  assert.equal((await srv.call(r.json.profile.photo, { cookie: sv })).status, 200);
  const del = await srv.call('/api/auth/profile', { method: 'PATCH', cookie: sv, body: { photo: null } });
  assert.equal(del.json.profile.photo, null);
  assert.equal(del.json.profile.phone, '0812-3456-789', 'bidang lain tidak berubah');
  const notImg = await srv.call('/api/auth/profile', { method: 'PATCH', cookie: sv, body: { photo: 'data:image/png;base64,AAAA' } });
  assert.equal(notImg.status, 400);
});

test('tanpa login profil ditolak', async () => {
  assert.equal((await srv.call('/api/auth/profile')).status, 401);
});

test('Tambah customer selalu "baru" (origin dari klien diabaikan); ubah tidak mengubah asal data', async () => {
  const a = await srv.call('/api/staff/customers', { method: 'POST', cookie: sv, body: { rm_no: 'N-1', name: 'Baru Satu', origin: 'awal' } });
  assert.equal(a.status, 200, a.text);
  const list = await srv.call('/api/staff/customers?q=N-1', { cookie: sv });
  assert.equal(list.json.customers[0].origin, 'baru');
  const p = await srv.call(`/api/staff/customers/${a.json.id}`, { method: 'PATCH', cookie: sv, body: { rm_no: 'N-1', name: 'Baru Satu', origin: 'awal' } });
  assert.equal(p.status, 200);
  assert.equal((await srv.call('/api/staff/customers?q=N-1', { cookie: sv })).json.customers[0].origin, 'baru');
});

test('donat New customer: angka tengah = customer baru pada periode (hari ini), naik tiap customer baru', async () => {
  const today = todayYmd();
  const c0 = (await srv.call(`/api/staff/charts?from=${today}&to=${today}`, { cookie: sv })).json.charts.customers;
  assert.equal(c0.center, 1, 'N-1 dibuat hari ini');
  await srv.call('/api/staff/customers', { method: 'POST', cookie: sv, body: { rm_no: 'N-2', name: 'Baru Dua' } });
  const c1 = (await srv.call(`/api/staff/charts?from=${today}&to=${today}`, { cookie: sv })).json.charts.customers;
  assert.equal(c1.center, 2);
  const past = (await srv.call('/api/staff/charts?from=2020-01-01&to=2020-01-02', { cookie: sv })).json.charts.customers;
  assert.equal(past.center, 0);
});
