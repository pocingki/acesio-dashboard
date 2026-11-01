// Tes revisi: kolom Referensi dilengkapi jadi nama platform baku (berkas keywords.json bersama bot WA).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ROOT } from './helpers.mjs';
import { resolveReference, platformNames } from '../server/platforms.js';

let srv, sv;
const api = (url, opts = {}) => srv.call(url, { ...opts, cookie: sv.cookie });

before(async () => { srv = await startServer(); sv = await srv.login(); });
after(async () => { await srv?.stop(); });

test('resolveReference: singkatan, kode referral, dan nama baku', () => {
  const cases = {
    fb: 'Facebook', FB: 'Facebook', ' Fb ': 'Facebook', ig: 'Instagram', IG01: 'Instagram', 'dari IG': 'Instagram',
    instagramnya: 'Instagram', 'tik tok': 'TikTok', tt01: 'TikTok', FB01: 'Facebook', situs: 'Website', 'situs web': 'Website',
    'google ads': 'Google Ads', 'Iklan Google': 'Google Ads', google: 'Google (organik)', gmaps: 'Google (organik)',
    'Google (organik)': 'Google (organik)', 'iklan meta': 'Iklan Meta', lainnya: 'Lainnya',
  };
  for (const [typed, want] of Object.entries(cases)) assert.equal(resolveReference(typed), want, typed);
});

test('resolveReference: tidak tumpang tindih dan tidak merusak teks bebas', () => {
  // "google ads" harus Google Ads, bukan Google (organik); "insta" tidak boleh menelan "instan".
  assert.equal(resolveReference('google ads'), 'Google Ads');
  assert.equal(resolveReference('instan'), 'instan');
  for (const free of ['Teman', 'Dr. Budi', 'IG kak Rina', 'walk in', '']) assert.equal(resolveReference(free), free);
  // Idempoten: hasilnya dimasukkan lagi tetap sama.
  for (const n of platformNames()) assert.equal(resolveReference(n), n, n);
});

test('keywords.json: tidak ada kata kunci platform yang dipakai dua platform', () => {
  const k = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'keywords.json'), 'utf8'));
  const key = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const owner = new Map();
  const claim = (word, platform) => {
    const have = owner.get(key(word));
    assert.ok(!have || have === platform, `“${word}” dipakai ${have} dan ${platform}`);
    owner.set(key(word), platform);
  };
  for (const [code, p] of Object.entries(k.referralCodes)) claim(code, p);
  for (const [p, list] of Object.entries(k.platforms)) { claim(p, p); list.forEach((a) => claim(a, p)); }
});

test('customer baru: isi "fb" langsung tersimpan sebagai Facebook, teks lain apa adanya', async () => {
  const r = await api('/api/staff/customers', { method: 'POST', body: { rm_no: 'PLT-1', name: 'Pasien Satu', reference: 'fb' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.reference, 'Facebook');
  const r2 = await api('/api/staff/customers', { method: 'POST', body: { rm_no: 'PLT-2', name: 'Pasien Dua', reference: 'Teman' } });
  assert.equal(r2.json.reference, 'Teman');
  const list = await api('/api/staff/customers?q=PLT-');
  const byRm = Object.fromEntries(list.json.customers.map((c) => [c.rm_no, c.reference]));
  assert.deepEqual(byRm, { 'PLT-1': 'Facebook', 'PLT-2': 'Teman' });
  // Dicari dengan nama lengkap.
  assert.equal((await api('/api/staff/customers?q=Facebook')).json.total, 1);
});

test('ubah customer dan upload file memakai aturan yang sama', async () => {
  const c = await api('/api/staff/customers', { method: 'POST', body: { rm_no: 'PLT-3', name: 'Pasien Tiga' } });
  const upd = await api(`/api/staff/customers/${c.json.id}`, { method: 'PATCH', body: { rm_no: 'PLT-3', name: 'Pasien Tiga', reference: 'IG01' } });
  assert.equal(upd.json.reference, 'Instagram');

  const file = 'No RM,Nama,Referensi\nPLT-4,Pasien Empat,tiktok\nPLT-5,Pasien Lima,google ads\nPLT-6,Pasien Enam,Rekan kerja\n';
  const imp = await api('/api/staff/customers/import', { method: 'POST', body: { format: 'csv', content: file } });
  assert.equal(imp.status, 200, imp.text);
  const list = await api('/api/staff/customers?q=PLT-');
  const byRm = Object.fromEntries(list.json.customers.map((x) => [x.rm_no, x.reference]));
  assert.equal(byRm['PLT-3'], 'Instagram');
  assert.equal(byRm['PLT-4'], 'TikTok');
  assert.equal(byRm['PLT-5'], 'Google Ads');
  assert.equal(byRm['PLT-6'], 'Rekan kerja');
});

test('endpoint saran: daftar platform dan pratinjau, hanya untuk staff', async () => {
  const names = await api('/api/staff/platforms');
  assert.ok(names.json.platforms.includes('Facebook') && names.json.platforms.includes('Google Ads'));
  const p = await api('/api/staff/platforms/resolve?q=fb');
  assert.deepEqual(p.json, { value: 'Facebook', matched: true });
  const q = await api('/api/staff/platforms/resolve?q=Teman');
  assert.deepEqual(q.json, { value: 'Teman', matched: false });
  const anon = await srv.call('/api/staff/platforms');
  assert.ok([401, 403].includes(anon.status), String(anon.status));
});
