// Tes revisi: kolom Catatan Medis (customer, impor, ekspor) dan rincian log audit yang terbaca manusia.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, ADMIN } from './helpers.mjs';

let srv, sv, db;
const api = (who, url, opts = {}) => srv.call(url, { ...opts, cookie: who.cookie });

before(async () => {
  srv = await startServer();
  sv = await srv.login();
  db = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
});
after(async () => { try { db?.close(); } catch { /* sudah tertutup */ } await srv?.stop(); });

async function makeAccount(username, role = 'user') {
  const r = await api(sv, '/api/sv/accounts', { method: 'POST', body: { username, name: `Nama ${username}`, password: 'rahasia123', role, employment: 'tetap' } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.id, session: await srv.login(username, 'rahasia123') };
}

test('customer: catatan medis tersimpan, bisa dicari, multi-baris dipertahankan', async () => {
  const note = 'Keluhan nyeri lutut kanan\nAlergi: minyak kayu putih\n\n\n\nRiwayat operasi 2023';
  const r = await api(sv, '/api/staff/customers', { method: 'POST', body: { rm_no: 'MED-001', name: 'Pasien Medis', medical_note: note } });
  assert.equal(r.status, 200, r.text);
  const list = await api(sv, '/api/staff/customers?q=nyeri%20lutut');
  assert.equal(list.json.total, 1);
  assert.equal(list.json.customers[0].medical_note, 'Keluhan nyeri lutut kanan\nAlergi: minyak kayu putih\n\nRiwayat operasi 2023');

  const upd = await api(sv, `/api/staff/customers/${r.json.id}`, { method: 'PATCH', body: { rm_no: 'MED-001', name: 'Pasien Medis', medical_note: 'Sudah membaik' } });
  assert.equal(upd.status, 200);
  const after1 = await api(sv, '/api/staff/customers?q=MED-001');
  assert.equal(after1.json.customers[0].medical_note, 'Sudah membaik');
});

test('customer: admin juga bisa mengisi, panjang dibatasi 2000, user biasa ditolak', async () => {
  const admin = await makeAccount('adm1', 'admin');
  const usr = await makeAccount('usr1', 'user');
  const r = await api(admin.session, '/api/staff/customers', { method: 'POST', body: { rm_no: 'MED-002', name: 'Pasien Dua', medical_note: 'x'.repeat(5000) } });
  assert.equal(r.status, 200, r.text);
  const row = db.prepare('SELECT medical_note FROM customers WHERE rm_no = ?').get('MED-002');
  assert.equal(row.medical_note.length, 2000);
  assert.equal((await api(usr.session, '/api/staff/customers')).status, 403);
});

test('catatan medis tidak bocor ke endpoint sisi user', async () => {
  const usr = await makeAccount('usr2', 'user');
  await api(sv, '/api/staff/customers', { method: 'POST', body: { rm_no: 'MED-003', name: 'Rahasia Medis', medical_note: 'DIAGNOSA-RAHASIA-XYZ' } });
  for (const url of ['/api/customers/search?q=MED-003', '/api/customers?q=MED-003', '/api/records/mine?q=MED-003']) {
    const r = await api(usr.session, url);
    assert.ok(!r.text.includes('DIAGNOSA-RAHASIA-XYZ'), `bocor di ${url}`);
  }
});

test('ekspor CSV dan Excel memuat kolom Catatan Medis; template juga', async () => {
  const csv = await api(sv, '/api/staff/customers/export?format=csv&q=MED-001');
  const header = csv.text.replace(/^﻿/, '').split('\r\n')[0];
  assert.ok(header.endsWith('Referensi,Catatan Medis'), header);
  assert.ok(csv.text.includes('Sudah membaik'));

  const tpl = await api(sv, '/api/staff/customers/template?format=csv');
  assert.ok(tpl.text.includes('Catatan Medis'));

  const x = await fetch(`${srv.base}/api/staff/customers/export?format=xlsx`, { headers: { Cookie: sv.cookie } });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const { inflateRawSync } = await import('node:zlib');
  // cari entri sheet1.xml di zip secara manual (tanpa library)
  let off = 0; let xml = '';
  while ((off = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), off)) >= 0) {
    const method = buf.readUInt16LE(off + 8); const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26); const elen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString();
    const start = off + 30 + nlen + elen;
    if (name === 'xl/worksheets/sheet1.xml') xml = (method === 8 ? inflateRawSync(buf.subarray(start, start + csize)) : buf.subarray(start, start + csize)).toString();
    off = start;
  }
  assert.ok(xml.includes('Catatan Medis'), 'header Excel');
  assert.ok(xml.includes('Sudah membaik'), 'isi Excel');
  assert.ok(xml.includes('s="4"'), 'gaya wrap text dipakai');
});

test('impor: kolom Catatan Medis dibaca, sel kosong tidak menghapus catatan lama', async () => {
  const csv = 'No,No RM,Nama,Catatan Medis\n1,IMP-001,Impor Satu,"Hipertensi\nKontrol rutin"\n2,MED-001,Pasien Medis,\n';
  const r = await api(sv, '/api/staff/customers/import', { method: 'POST', body: { format: 'csv', content: csv } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare('SELECT medical_note FROM customers WHERE rm_no = ?').get('IMP-001').medical_note, 'Hipertensi\nKontrol rutin');
  assert.equal(db.prepare('SELECT medical_note FROM customers WHERE rm_no = ?').get('MED-001').medical_note, 'Sudah membaik');
});

test('audit: rincian komisi memakai nama terapis & layanan, tanpa JSON mentah', async () => {
  const t = await makeAccount('boy', 'user');
  const amounts = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [i + 1, 300000]));
  const put = await api(sv, `/api/sv/commissions/${t.id}`, { method: 'PUT', body: { amounts, apply_to_history: false } });
  assert.equal(put.status, 200, put.text);
  const { json } = await api(sv, '/api/sv/audit?action=commission.update');
  const row = json.rows[0];
  assert.equal(row.target_label, 'Nama boy');
  assert.match(row.summary, /^Komisi Nama boy: 29 layanan diubah; riwayat lama tidak diubah$/);
  const joined = JSON.stringify(row.items);
  assert.ok(joined.includes('Rp0 → Rp300.000'));
  assert.ok(joined.includes('29 layanan: Layanan 1, Layanan 2'));
  const texts = row.items.map((i) => `${i.label} ${i.value}`).join('\n');
  assert.ok(!/[{}]|"from"|"to"/.test(`${row.summary}\n${texts}`), 'tidak ada JSON mentah');
  assert.ok(row.items.some((i) => i.label === 'Berlaku ke riwayat lama' && /Tidak/.test(i.value)));
});

test('audit: akun, approve, hapus, customer, dan password diterjemahkan', async () => {
  const t = await makeAccount('rina', 'user');
  await api(sv, `/api/sv/accounts/${t.id}`, { method: 'PATCH', body: { name: 'Rina Baru', active: false } });
  const c = await api(sv, '/api/staff/customers', { method: 'POST', body: { rm_no: 'AUD-9', name: 'Budi Audit' } });
  await api(sv, `/api/staff/customers/${c.json.id}`, { method: 'PATCH', body: { rm_no: 'AUD-9', name: 'Budi Audit', medical_note: 'catatan baru', reference: 'Teman' } });

  const { json } = await api(sv, '/api/sv/audit?page=1');
  const by = (a, pred = () => true) => json.rows.find((r) => r.action === a && pred(r));

  const acc = by('account.update');
  assert.equal(acc.target_label, 'Rina Baru');
  assert.ok(acc.items.some((i) => i.label === 'Status akun' && i.value === 'Aktif → Nonaktif'));
  assert.ok(acc.items.some((i) => i.label === 'Nama' && i.value === 'Nama rina → Rina Baru'));

  const cu = by('customer.update', (r) => r.target_id === String(c.json.id));
  assert.equal(cu.target_label, 'AUD-9 · Budi Audit');
  assert.match(cu.summary, /Referensi, Catatan Medis/);
  assert.ok(!JSON.stringify(cu.items).includes('catatan baru'), 'isi catatan medis tidak masuk log');

  const create = by('account.create');
  assert.match(create.summary, /^Membuat akun /);
  for (const r of json.rows) {
    assert.equal(typeof r.summary, 'string');
    assert.ok(Array.isArray(r.items) && r.items.length > 0, r.action);
    assert.ok(!/^\{|"from"/.test(r.summary), `ringkasan mentah: ${r.summary}`);
  }
});

test('audit: pencarian lewat nama sasaran (bukan hanya ID)', async () => {
  const hit = await api(sv, '/api/sv/audit?q=' + encodeURIComponent('Budi Audit'));
  assert.ok(hit.json.total >= 1);
  assert.ok(hit.json.rows.every((r) => r.target_type === 'customer' || /Budi/.test(JSON.stringify(r))));
});

test('audit: review & hapus data dan aksi tak dikenal tetap terbaca', async () => {
  const usr = await makeAccount('dewi', 'user');
  const now = new Date().toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  const cid = Number(db.prepare("INSERT INTO customers (rm_no, name, created_at) VALUES ('REC-1','Pelanggan Rec',?)").run(now).lastInsertRowid);
  db.prepare("INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?,?,?)")
    .run(now, 1, 'Supervisor', 'record.delete', 'record', '77', JSON.stringify({ user_id: usr.id, customer_id: cid, service_id: 2, commission: 1500000, day }), '127.0.0.1');
  db.prepare("INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?,?,?)")
    .run(now, 1, 'Supervisor', 'review.cancel', 'day_review', `${usr.id}:${day}`, JSON.stringify({ user_id: usr.id, day, late: true, reviewed_by: 1, reviewed_at: now }), '127.0.0.1');
  db.prepare("INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?,?,?)")
    .run(now, 1, 'Supervisor', 'masa.depan', 'thing', '5', JSON.stringify({ user_id: usr.id, aktif: true, nested: { a: 1 } }), '127.0.0.1');
  const { json } = await api(sv, '/api/sv/audit?page=1');
  const del = json.rows.find((r) => r.action === 'record.delete');
  assert.match(del.summary, /^Menghapus layanan Layanan 2 untuk REC-1 · Pelanggan Rec \(\d+ \w+ \d{4}\)$/);
  assert.ok(del.items.some((i) => i.label === 'Komisi' && i.value === 'Rp1.500.000'));
  assert.ok(del.items.some((i) => i.label === 'Terapis' && i.value === 'Nama dewi'));
  const cancel = json.rows.find((r) => r.action === 'review.cancel');
  assert.equal(cancel.target_label.startsWith('Nama dewi · '), true);
  assert.ok(cancel.items.some((i) => i.label === 'Semula di-approve oleh' && i.value === 'Supervisor'));
  assert.ok(cancel.items.some((i) => i.at));
  const unk = json.rows.find((r) => r.action === 'masa.depan');
  assert.ok(unk.items.some((i) => i.label === 'Pengguna' && i.value === 'Nama dewi'));
  assert.ok(!unk.summary.includes('{'));
});
