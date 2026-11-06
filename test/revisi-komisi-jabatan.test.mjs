// Revisi: (1) impor komisi per terapis, (2) jabatan + tanggal bergabung diatur supervisor, (3) terapis melihatnya di profil.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { parseRupiah } from '../server/commissions.js';

let srv; let sv;
const PW = 'Password-Terapis-1';
const post = (cookie, path, body, method = 'POST') => srv.call(path, { method, cookie, body });
const csvImport = (cookie, text, extra = {}) => post(cookie, '/api/sv/commissions/import', { format: 'csv', content: text, ...extra });
let sari; let budi; let svc;

before(async () => {
  srv = await startServer();
  sv = (await srv.login()).cookie;
  sari = (await post(sv, '/api/sv/accounts', { username: 'sari', name: 'Sari Dewi', password: PW, role: 'user', job_title: 'Terapis Senior', join_date: '2024-03-15' })).json.id;
  budi = (await post(sv, '/api/sv/accounts', { username: 'budi', name: 'Budi', password: PW, role: 'user' })).json.id;
  svc = (await srv.call('/api/services', { cookie: sv })).json.services;
});
after(async () => { await srv.stop(); });

const amountsOf = async (userId) => Object.fromEntries((await srv.call(`/api/sv/commissions/${userId}`, { cookie: sv })).json.items.map((i) => [i.position, i.amount]));

test('parseRupiah: format umum diterima, selain itu null', () => {
  assert.equal(parseRupiah('25000'), 25000);
  assert.equal(parseRupiah('Rp25.000'), 25000);
  assert.equal(parseRupiah('Rp 1.250.000'), 1250000);
  assert.equal(parseRupiah('25,000'), 25000);
  assert.equal(parseRupiah('25000.00'), 25000);
  assert.equal(parseRupiah('0'), 0);
  assert.equal(parseRupiah(''), null);
  assert.equal(parseRupiah('-5000'), null);
  assert.equal(parseRupiah('12.5'), null);
  assert.equal(parseRupiah('abc'), null);
  assert.equal(parseRupiah('1000000001'), null);
});

test('template komisi: baris per layanan, kolom per terapis aktif (@username)', async () => {
  const r = await srv.call('/api/sv/commission-template?format=csv', { cookie: sv });
  assert.equal(r.status, 200);
  const lines = r.text.replace(/^\ufeff/, '').trim().split(/\r\n/);
  assert.equal(lines[0], 'No,Layanan,Budi (@budi),Sari Dewi (@sari)');
  assert.equal(lines.length, svc.length + 1);
  assert.match(lines[1], /^1,Layanan 1,0,0$/);
});

test('impor CSV: cocok lewat @username dan nama, sel kosong tidak mengubah, sel salah dilewati + dilaporkan', async () => {
  const csv = [
    'No,Layanan,Sari Dewi (@sari),Budi',
    '1,Layanan 1,25000,Rp30.000',
    '2,layanan 2,"1.500",',        // nama beda huruf besar/kecil tetap cocok; Budi kosong
    '3,Layanan 3,abc,5000',        // sel Sari tidak valid
    '4,Layanan Tidak Ada,9999,9999', // layanan tidak ada: baris dilewati
  ].join('\n');
  const r = await csvImport(sv, csv);
  assert.equal(r.status, 200, r.text);
  const res = r.json.result;
  assert.equal(res.users, 2);
  assert.equal(res.changed, 4); // Sari L1, L2; Budi L1, L3
  assert.equal(res.skipped, 2); // sel "abc" + baris layanan tak dikenal
  assert.ok(res.issues.some((i) => /abc/.test(i.text)));
  assert.ok(res.issues.some((i) => /Layanan Tidak Ada/.test(i.text) && i.line === 5));
  const a = await amountsOf(sari); const b = await amountsOf(budi);
  assert.equal(a[1], 25000); assert.equal(a[2], 1500); assert.equal(a[3], 0); assert.equal(a[4], 0);
  assert.equal(b[1], 30000); assert.equal(b[2], 0); assert.equal(b[3], 5000);
});

test('impor ulang: sel kosong tidak menghapus, 0 mengosongkan, tidak ada perubahan = unchanged', async () => {
  const r = await csvImport(sv, 'No,Layanan,Sari Dewi (@sari)\n1,Layanan 1,\n2,Layanan 2,1500\n3,Layanan 3,0\n');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.changed, 0);
  assert.equal(r.json.result.unchanged, 2); // L2 sama; L3 sudah 0
  assert.equal((await amountsOf(sari))[1], 25000, 'sel kosong tidak menghapus');
  const z = await csvImport(sv, 'No,Layanan,Budi\n3,Layanan 3,0\n');
  assert.equal(z.json.result.changed, 1);
  assert.equal((await amountsOf(budi))[3], 0);
});

test('impor memakai nomor bila nama layanan kosong; judul kolom tak dikenal dilaporkan', async () => {
  const r = await csvImport(sv, 'No,Layanan,Sari Dewi (@sari),Orang Asing\n5,,7000,1\n');
  assert.equal(r.status, 200, r.text);
  assert.equal((await amountsOf(sari))[5], 7000);
  assert.ok(r.json.result.issues.some((i) => /Orang Asing/.test(i.text)));
});

test('impor ditolak 400 bila tanpa kolom Layanan, tanpa kolom terapis, atau file kosong', async () => {
  assert.equal((await csvImport(sv, 'a,b\n1,2\n')).status, 400);
  assert.equal((await csvImport(sv, 'No,Layanan\n1,Layanan 1\n')).status, 400);
  assert.equal((await post(sv, '/api/sv/commissions/import', { format: 'csv', content: '' })).status, 400);
  assert.equal((await post(sv, '/api/sv/commissions/import', { format: 'pdf', content: 'x' })).status, 400);
});

test('roundtrip: template Excel yang diunggah kembali tidak mengubah apa pun', async () => {
  const before = JSON.stringify([await amountsOf(sari), await amountsOf(budi)]);
  const base = srv.base ?? `http://127.0.0.1:${srv.port}`;
  const res = await fetch(`${base}/api/sv/commission-template?format=xlsx`, { headers: { cookie: sv } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  const r = await post(sv, '/api/sv/commissions/import', { format: 'xlsx', content: buf.toString('base64') });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.changed, 0);
  assert.ok(r.json.result.unchanged > 0);
  assert.equal(JSON.stringify([await amountsOf(sari), await amountsOf(budi)]), before);
});

test('impor tercatat di log audit (ringkasan + per terapis); hanya supervisor yang boleh', async () => {
  const a = (await srv.call('/api/sv/audit?action=commission.import', { cookie: sv })).json;
  assert.ok(a.total >= 1);
  assert.match(a.rows[0].summary, /Impor komisi/);
  assert.ok((await srv.call('/api/sv/audit?action=commission.update', { cookie: sv })).json.total >= 2);

  await post(sv, '/api/sv/accounts', { username: 'adm1', name: 'Admin Satu', password: PW, role: 'admin' });
  const admin = (await srv.login('adm1', PW)).cookie;
  assert.equal((await csvImport(admin, 'No,Layanan,Budi\n1,Layanan 1,1\n')).status, 403);
  assert.equal((await srv.call('/api/sv/commission-template?format=csv', { cookie: admin })).status, 403);
  const user = (await srv.login('budi', PW)).cookie;
  assert.equal((await csvImport(user, 'No,Layanan,Budi\n1,Layanan 1,1\n')).status, 403);
  assert.equal((await amountsOf(budi))[1], 30000, 'tidak berubah oleh akun non-supervisor');
});

test('jabatan & tanggal bergabung: supervisor mengisi saat buat/ubah akun, tampil di daftar akun', async () => {
  const list = (await srv.call('/api/sv/accounts', { cookie: sv })).json.accounts;
  const s = list.find((x) => x.username === 'sari');
  assert.equal(s.job_title, 'Terapis Senior'); assert.equal(s.join_date, '2024-03-15');
  const b = list.find((x) => x.username === 'budi');
  assert.equal(b.job_title, ''); assert.equal(b.join_date, '');

  const up = await post(sv, `/api/sv/accounts/${budi}`, { job_title: '  Terapis   Junior ', join_date: '2025-01-02' }, 'PATCH');
  assert.equal(up.status, 200, up.text);
  const b2 = (await srv.call('/api/sv/accounts', { cookie: sv })).json.accounts.find((x) => x.username === 'budi');
  assert.equal(b2.job_title, 'Terapis Junior'); assert.equal(b2.join_date, '2025-01-02');
  // PATCH tanpa kedua kolom tidak menghapusnya
  await post(sv, `/api/sv/accounts/${budi}`, { name: 'Budi Santoso' }, 'PATCH');
  const b3 = (await srv.call('/api/sv/accounts', { cookie: sv })).json.accounts.find((x) => x.username === 'budi');
  assert.equal(b3.job_title, 'Terapis Junior'); assert.equal(b3.join_date, '2025-01-02');
});

test('jabatan & tanggal bergabung: validasi', async () => {
  for (const bad of ['2025-02-30', '2025-13-01', 'kemarin', '15/03/2024', '1900-01-01']) {
    assert.equal((await post(sv, `/api/sv/accounts/${budi}`, { join_date: bad }, 'PATCH')).status, 400, bad);
  }
  assert.equal((await post(sv, `/api/sv/accounts/${budi}`, { job_title: 'x'.repeat(61) }, 'PATCH')).status, 400);
  const clear = await post(sv, `/api/sv/accounts/${budi}`, { join_date: '', job_title: '' }, 'PATCH');
  assert.equal(clear.status, 200);
  const b = (await srv.call('/api/sv/accounts', { cookie: sv })).json.accounts.find((x) => x.username === 'budi');
  assert.equal(b.job_title, ''); assert.equal(b.join_date, '');
  await post(sv, `/api/sv/accounts/${budi}`, { job_title: 'Terapis Junior', join_date: '2025-01-02' }, 'PATCH');
});

test('terapis melihat jabatan & tanggal bergabung di profilnya, tetapi tidak bisa mengubahnya', async () => {
  const me = (await srv.login('sari', PW)).cookie;
  const p = (await srv.call('/api/auth/profile', { cookie: me })).json.profile;
  assert.equal(p.job_title, 'Terapis Senior'); assert.equal(p.join_date, '2024-03-15');
  const r = await post(me, '/api/auth/profile', { phone: '0812-000-111', job_title: 'Direktur', join_date: '2000-01-01' }, 'PATCH');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.profile.phone, '0812-000-111');
  assert.equal(r.json.profile.job_title, 'Terapis Senior', 'jabatan tidak bisa diubah dari profil');
  assert.equal(r.json.profile.join_date, '2024-03-15');
  // lewat jalur supervisor pun ditolak untuk terapis
  assert.equal((await post(me, `/api/sv/accounts/${sari}`, { job_title: 'Direktur' }, 'PATCH')).status, 403);
  const again = (await srv.call('/api/auth/profile', { cookie: me })).json.profile;
  assert.equal(again.job_title, 'Terapis Senior');
});

test('perubahan jabatan/tanggal bergabung masuk log audit', async () => {
  const a = (await srv.call('/api/sv/audit?action=account.update', { cookie: sv })).json;
  assert.ok(a.rows.some((r) => /jabatan/.test(r.summary)));
  const created = (await srv.call('/api/sv/audit?action=account.create', { cookie: sv })).json;
  assert.ok(created.rows.some((r) => (r.items || []).some((i) => i.label === 'Jabatan' && i.value === 'Terapis Senior')));
});
