// Pengajuan dari WhatsApp tampil di Riwayat customer dan bisa diterima/ditolak oleh staf.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers.mjs';
const { leadSummary, acceptMessage } = await import('../public/js/customers.js');

let srv; let sv; let key;
const lead = (body) => srv.call('/api/bot/incoming-leads', { method: 'POST', headers: { 'x-api-key': key }, body });
const list = async () => (await srv.call('/api/staff/incoming-leads', { cookie: sv.cookie })).json.leads;

before(async () => {
  srv = await startServer();
  sv = await srv.login();
  key = (await srv.call('/api/sv/integration/bot-key', { method: 'POST', body: {}, cookie: sv.cookie })).json.new_bot_key;
});
after(async () => { await srv.stop(); });

test('teks ringkasan dan hasil terima', () => {
  assert.equal(leadSummary(0), 'Tidak ada pengajuan baru');
  assert.match(leadSummary(3), /3 pengajuan menunggu/);
  assert.match(acceptMessage({ linked: false, rm_no: 'RM-9' }), /baru dibuat.*RM-9/);
  assert.match(acceptMessage({ linked: true, rm_no: 'RM-1' }), /sudah terdaftar/);
});

test('layar customer memuat panel pengajuan', () => {
  const src = fs.readFileSync(new URL('../public/js/customers.js', import.meta.url), 'utf8');
  assert.match(src, /leadsPanel\(/);
  assert.match(src, /\/api\/staff\/incoming-leads/);
});

test('pengajuan dari bot muncul, bisa diterima (jadi customer) dan ditolak', async () => {
  assert.equal((await list()).length, 0);
  const a = await lead({ name: 'Budi Tes', phone: '081234500001', wa_lead_id: 'L1' });
  assert.equal(a.status, 200, a.text);
  assert.equal((await lead({ name: 'Budi Tes', phone: '081234500001', wa_lead_id: 'L1' })).json.replayed, true);
  const b = await lead({ name: 'Sari Tes', phone: '081234500002', wa_lead_id: 'L2' });
  const pend = await list();
  assert.equal(pend.length, 2, 'pengulangan tidak menggandakan');
  const acc = await srv.call(`/api/staff/incoming-leads/${a.json.id}/accept`, { method: 'POST', body: {}, cookie: sv.cookie });
  assert.equal(acc.status, 200, acc.text);
  assert.equal(acc.json.linked, false);
  assert.ok(acc.json.rm_no);
  const rej = await srv.call(`/api/staff/incoming-leads/${b.json.id}/reject`, { method: 'POST', body: {}, cookie: sv.cookie });
  assert.equal(rej.status, 200);
  assert.equal((await list()).length, 0);
  const again = await srv.call(`/api/staff/incoming-leads/${a.json.id}/accept`, { method: 'POST', body: {}, cookie: sv.cookie });
  assert.equal(again.status, 409);
  const custs = (await srv.call('/api/staff/customers?q=Budi', { cookie: sv.cookie })).json.customers;
  assert.equal(custs.some((c) => c.name === 'Budi Tes'), true, 'customer terbuat');
});
