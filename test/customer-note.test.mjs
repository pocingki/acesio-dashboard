// Kolom Catatan pada data customer lewat API: tambah, ubah, cari, dan tidak bocor ke user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN } from './helpers.mjs';

const PW = 'Rahasia-Tes-123';
let srv; let adm; let usr;
const cookieOf = (r) => (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');

before(async () => {
  srv = await startServer({});
  adm = cookieOf(await srv.call('/api/auth/login', { method: 'POST', body: ADMIN }));
  await srv.call('/api/sv/accounts', { method: 'POST', cookie: adm, body: { username: 'terapis1', name: 'Terapis Satu', password: PW, role: 'user' } });
  usr = cookieOf(await srv.call('/api/auth/login', { method: 'POST', body: { username: 'terapis1', password: PW } }));
});
after(() => srv.stop());

test('Catatan: dibuat, ditampilkan di daftar, bisa dicari, diubah, dan tidak terhapus oleh klien tanpa field note', async () => {
  const c = await srv.call('/api/staff/customers', { method: 'POST', cookie: adm, body: { rm_no: 'RM-N1', name: 'Gita Pratama', note: 'Alergi minyak tertentu, tanya dulu' } });
  assert.equal(c.status, 200, c.text);
  const list = await srv.call('/api/staff/customers?q=alergi%20minyak', { cookie: adm });
  assert.equal(list.json.customers.length, 1, 'pencarian mencakup Catatan');
  assert.equal(list.json.customers[0].note, 'Alergi minyak tertentu, tanya dulu');
  const id = list.json.customers[0].id;
  const base = { rm_no: 'RM-N1', name: 'Gita Pratama' };
  const up = await srv.call(`/api/staff/customers/${id}`, { method: 'PATCH', cookie: adm, body: { ...base, note: 'Catatan baru' } });
  assert.equal(up.status, 200, up.text);
  const old = await srv.call(`/api/staff/customers/${id}`, { method: 'PATCH', cookie: adm, body: { ...base, phone: '081234567890' } });
  assert.equal(old.status, 200, old.text);
  const after = (await srv.call('/api/staff/customers?q=RM-N1', { cookie: adm })).json.customers[0];
  assert.equal(after.note, 'Catatan baru', 'klien lama tanpa note tidak menghapus');
  const clear = await srv.call(`/api/staff/customers/${id}`, { method: 'PATCH', cookie: adm, body: { ...base, note: '' } });
  assert.equal(clear.status, 200);
  assert.equal((await srv.call('/api/staff/customers?q=RM-N1', { cookie: adm })).json.customers[0].note, '');
});

test('Catatan tidak terlihat oleh user dan tidak bisa dibaca lewat jalur staf', async () => {
  await srv.call('/api/staff/customers', { method: 'POST', cookie: adm, body: { rm_no: 'RM-N2', name: 'Hadi Wijaya', note: 'RAHASIA-INTERNAL' } });
  const s = await srv.call('/api/customers/search?q=RM-N2', { cookie: usr });
  assert.ok(!s.text.includes('RAHASIA-INTERNAL'), 'pencarian user tidak memuat Catatan');
  assert.equal((await srv.call('/api/staff/customers?q=RM-N2', { cookie: usr })).status, 403);
  const exp = await srv.call('/api/staff/customers/export?format=csv', { cookie: adm });
  assert.match(exp.text, /Catatan/);
  assert.match(exp.text, /RAHASIA-INTERNAL/);
});
