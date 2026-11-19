// Formulir data customer untuk bot: kolom kosong saja, tanpa No RM/SOAP; data dari form ikut saat staf menerima.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv; let sv; let key;
const bot = (url, opt = {}) => srv.call(url, { ...opt, headers: { 'x-api-key': key } });
const staff = (url, body) => srv.call(url, { method: 'POST', body: body || {}, cookie: sv.cookie });

before(async () => {
  srv = await startServer(); sv = await srv.login();
  key = (await staff('/api/sv/integration/bot-key')).json.new_bot_key;
});
after(async () => { await srv.stop(); });

test('nomor baru: semua kolom form kosong, tanpa No RM/SOAP', async () => {
  const r = await bot('/api/bot/customer-form?phone=081200000001');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.exists, false);
  assert.deepEqual(r.json.missing, ['name', 'gender', 'birth_date', 'occupation', 'domicile']);
  assert.equal(JSON.stringify(r.json).includes('rm_no'), false);
  assert.equal(JSON.stringify(r.json).includes('medical'), false);
  assert.equal((await bot('/api/bot/customer-form')).status, 400);
  assert.equal((await srv.call('/api/bot/customer-form?phone=081200000001')).status, 401);
});

test('terima pengajuan baru memakai data form; nilai tak valid dibuang', async () => {
  const r = await bot('/api/bot/incoming-leads', { method: 'POST', body: { name: 'Ani Form', phone: '081200000002', wa_lead_id: 'F1', data: { gender: 'P', birth_date: '12/03/1990', occupation: 'Guru', domicile: 'Bekasi', month: 'November 2026' } } });
  assert.equal(r.status, 200, r.text);
  const bad = await bot('/api/bot/incoming-leads', { method: 'POST', body: { name: 'Rudi Form', phone: '081200000003', wa_lead_id: 'F2', data: { gender: 'entah', birth_date: 'bukan tanggal', occupation: 'Sopir' } } });
  assert.equal((await staff(`/api/staff/incoming-leads/${r.json.id}/accept`)).status, 200);
  assert.equal((await staff(`/api/staff/incoming-leads/${bad.json.id}/accept`)).status, 200, 'data form rusak tidak menggagalkan terima');
  const a = (await srv.call('/api/staff/customers?q=Ani', { cookie: sv.cookie })).json.customers[0];
  assert.equal(a.gender, 'P'); assert.equal(a.birth_date, '1990-03-12'); assert.equal(a.occupation, 'Guru'); assert.equal(a.domicile, 'Bekasi'); assert.equal(a.month, 'November 2026');
  const u = (await srv.call('/api/staff/customers?q=Rudi', { cookie: sv.cookie })).json.customers[0];
  assert.equal(u.gender, ''); assert.equal(u.occupation, 'Sopir');
});

test('customer lama: form hanya menawarkan kolom kosong; terima tidak menimpa data yang ada', async () => {
  const c = await staff('/api/staff/customers', { rm_no: 'RM-LAMA-1', name: 'Dewi Lama', phone: '081200000004', gender: 'P', occupation: 'Dokter' });
  assert.equal(c.status, 200, c.text);
  const f = (await bot('/api/bot/customer-form?phone=081200000004')).json;
  assert.equal(f.exists, true);
  assert.deepEqual(f.missing, ['birth_date', 'domicile']);
  assert.equal(f.values.occupation, 'Dokter');
  const l = await bot('/api/bot/incoming-leads', { method: 'POST', body: { name: 'Nama WA Beda', phone: '081200000004', wa_lead_id: 'F3', data: { occupation: 'Guru', birth_date: '1/2/1985', domicile: 'Depok' } } });
  const acc = await staff(`/api/staff/incoming-leads/${l.json.id}/accept`);
  assert.equal(acc.json.linked, true);
  const d = (await srv.call('/api/staff/customers?q=Dewi', { cookie: sv.cookie })).json.customers[0];
  assert.equal(d.name, 'Dewi Lama'); assert.equal(d.occupation, 'Dokter', 'tidak ditimpa');
  assert.equal(d.birth_date, '1985-02-01'); assert.equal(d.domicile, 'Depok');
});
