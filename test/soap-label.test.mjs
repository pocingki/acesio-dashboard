// Tes Fase 1: istilah "Catatan Medis" menjadi "SOAP" (hanya teks yang terlihat; kolom DB dan kunci JSON medical_note tetap).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer } from './helpers.mjs';

let srv, sv, db;
const api = (url, opts = {}) => srv.call(url, { ...opts, cookie: sv.cookie });
const soapOf = (rm) => db.prepare('SELECT medical_note FROM customers WHERE rm_no = ?').get(rm)?.medical_note;

before(async () => {
  srv = await startServer();
  sv = await srv.login();
  db = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
});
after(async () => { try { db?.close(); } catch { /* sudah tertutup */ } await srv?.stop(); });

test('template dan ekspor memakai header SOAP, bukan Catatan Medis', async () => {
  const tpl = await api('/api/staff/customers/template?format=csv');
  assert.ok(tpl.text.includes('SOAP'));
  assert.ok(!tpl.text.includes('Catatan Medis'));

  await api('/api/staff/customers', { method: 'POST', body: { rm_no: 'SOAP-001', name: 'Customer Soap', medical_note: 'catatan awal' } });
  const csv = await api('/api/staff/customers/export?format=csv&q=SOAP-001');
  const header = csv.text.replace(/^﻿/, '').split('\r\n')[0];
  assert.ok(header.endsWith('Referensi,SOAP'), header);
  assert.ok(!csv.text.includes('Catatan Medis'));
});

test('impor dengan header lama "Catatan Medis" tetap menyimpan isinya', async () => {
  const csv = 'No,No RM,Nama,Catatan Medis\n1,SOAP-OLD,Header Lama,"isi dari header lama"\n';
  const r = await api('/api/staff/customers/import', { method: 'POST', body: { format: 'csv', content: csv } });
  assert.equal(r.status, 200, r.text);
  assert.equal(soapOf('SOAP-OLD'), 'isi dari header lama');
});

test('impor dengan header baru "SOAP" menyimpan isinya', async () => {
  const csv = 'No,No RM,Nama,SOAP\n1,SOAP-NEW,Header Baru,"isi dari header baru"\n';
  const r = await api('/api/staff/customers/import', { method: 'POST', body: { format: 'csv', content: csv } });
  assert.equal(r.status, 200, r.text);
  assert.equal(soapOf('SOAP-NEW'), 'isi dari header baru');
});

test('label audit untuk perubahan kolom itu menampilkan SOAP, tanpa isinya', async () => {
  const c = await api('/api/staff/customers', { method: 'POST', body: { rm_no: 'SOAP-AUD', name: 'Audit Soap' } });
  await api(`/api/staff/customers/${c.json.id}`, { method: 'PATCH', body: { rm_no: 'SOAP-AUD', name: 'Audit Soap', medical_note: 'RAHASIA-SOAP-ABC', reference: 'Teman' } });
  const { json } = await api('/api/sv/audit?action=customer.update');
  const text = JSON.stringify(json);
  assert.match(text, /SOAP/);
  assert.ok(!text.includes('Catatan Medis'));
  assert.ok(!text.includes('RAHASIA-SOAP-ABC'), 'isi SOAP tidak boleh masuk log');
});
