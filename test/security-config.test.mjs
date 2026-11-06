// Konfigurasi produksi, cookie, foto, peran, dan URL integrasi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, createVisit, VALID_SOAP } from './helpers.mjs';
import { productionProblems } from '../server/config.js';
import { cleanUrl, addressClass } from '../server/integration.js';

const PASS = 'Rahasia-Tes-123';
const ROOT = path.resolve(import.meta.dirname, '..');
const entry = path.join(ROOT, 'server', 'index.js');

test('produksi menolak bind terbuka, cookie tidak aman, dan jam palsu', () => {
  assert.deepEqual(productionProblems({ NODE_ENV: 'development', HOST: '0.0.0.0' }), []);
  const bad = productionProblems({ NODE_ENV: 'production', HOST: '0.0.0.0', APP_FAKE_NOW_FILE: 'now.txt', SESSION_TIMER: 'off' });
  assert.match(bad.join('\n'), /HOST/);
  assert.match(bad.join('\n'), /COOKIE_SECURE/);
  assert.match(bad.join('\n'), /TRUST_PROXY/);
  assert.match(bad.join('\n'), /APP_FAKE_NOW_FILE/);
  assert.match(bad.join('\n'), /SESSION_TIMER/);
  assert.deepEqual(productionProblems({
    NODE_ENV: 'production', HOST: '127.0.0.1', COOKIE_SECURE: 'true', TRUST_PROXY: 'true',
  }), []);
});

test('proses produksi berhenti sebelum membuka layanan bila konfigurasi tidak aman', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-prod-'));
  const r = spawnSync(process.execPath, [entry], {
    cwd, encoding: 'utf8', timeout: 20_000,
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
      NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '0', DATA_DIR: path.join(cwd, 'data'),
      COOKIE_SECURE: 'false', TRUST_PROXY: 'false', ADMIN_PASSWORD: PASS,
    },
  });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}`, /COOKIE_SECURE/);
  assert.match(`${r.stderr}`, /HOST/);
  assert.equal(fs.existsSync(path.join(cwd, 'data', 'acesio.db')), false);
});

test('alamat integrasi menolak metadata, IP desimal, dan nama yang mengarah ke jaringan dalam', async () => {
  assert.equal(addressClass('169.254.169.254'), 'blocked');
  assert.equal(addressClass('::ffff:169.254.169.254'), 'blocked');
  assert.equal(addressClass('127.0.0.1'), 'loopback');
  assert.equal(addressClass('10.1.2.3'), 'private');
  assert.equal(await cleanUrl('http://127.0.0.1:8080/wa'), 'http://127.0.0.1:8080/wa');
  await assert.rejects(() => cleanUrl('https://169.254.169.254/latest'), (e) => e.status === 400);
  await assert.rejects(() => cleanUrl('http://2130706433'), (e) => e.status === 400);
  await assert.rejects(() => cleanUrl('https://gateway.internal.test', async () => ['private']), (e) => /internal/i.test(e.message));
  await assert.rejects(() => cleanUrl('http://wa.contoh.id'), (e) => /https/.test(e.message));
  assert.equal(await cleanUrl('https://wa.contoh.id/api', async () => ['public']), 'https://wa.contoh.id/api');
});

test('cookie, logout, peran, foto, dan SOAP mengikuti batas server', async () => {
  const srv = await startServer({ env: { BOT_API_KEY: 'kunci-uji-keamanan-01' } });
  try {
    const sv = (await srv.login()).cookie;
    const login = await srv.call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Tes-Password-Admin-123' } });
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
    assert.doesNotMatch(login.headers.get('set-cookie'), /Secure/);

    const weak = await srv.call('/api/sv/accounts', {
      method: 'POST', cookie: sv, body: { username: 'lemah', name: 'Akun Lemah', password: 'hurufsaja', role: 'user' },
    });
    assert.equal(weak.status, 400, weak.text);
    const adm = await srv.call('/api/sv/accounts', {
      method: 'POST', cookie: sv, body: { username: 'adm1', name: 'Admin Satu', password: PASS, role: 'admin' },
    });
    const budi = await srv.call('/api/sv/accounts', {
      method: 'POST', cookie: sv, body: { username: 'budi', name: 'Budi', password: PASS, role: 'user' },
    });
    const sari = await srv.call('/api/sv/accounts', {
      method: 'POST', cookie: sv, body: { username: 'sari', name: 'Sari', password: PASS, role: 'user' },
    });
    assert.equal(budi.status, 200, budi.text);
    const admin = (await srv.login('adm1', PASS)).cookie;
    const user = (await srv.login('budi', PASS)).cookie;

    const out = await srv.call('/api/auth/logout', { method: 'POST', cookie: user, body: {} });
    assert.equal(out.status, 200, out.text);
    assert.equal((await srv.call('/api/auth/me', { cookie: user })).status, 401);
    const again = (await srv.login('budi', PASS)).cookie;

    assert.equal((await srv.call('/api/sv/accounts', { method: 'POST', cookie: again, body: {} })).status, 403);
    assert.equal((await srv.call('/api/staff/customers', { cookie: again })).status, 403);
    assert.equal((await srv.call('/api/sv/audit', { cookie: admin })).status, 403);
    assert.equal((await srv.call('/api/staff/customers', { cookie: admin })).status, 200);
    assert.equal((await srv.call('/api/sv/audit', { cookie: sv })).status, 200);

    const note = 'catatan-klinis-tidak-bocor';
    const customer = await srv.call('/api/staff/customers', {
      method: 'POST', cookie: sv, body: { rm_no: 'RM-SEC', name: 'Rina', phone: '081234567890', medical_note: note },
    });
    assert.equal(customer.status, 200, customer.text);
    const search = await srv.call('/api/customers/search?q=RM-SEC', { cookie: again });
    assert.equal(search.status, 200, search.text);
    assert.equal(JSON.stringify(search.json).includes(note), false);
    const visit = await createVisit(srv, sv, { userId: budi.json.id, customerId: customer.json.id, serviceIds: [1] });
    const saved = await srv.call('/api/records', { method: 'POST', cookie: again, body: { schedule_id: visit.id, soap: VALID_SOAP } });
    assert.equal(saved.status, 200, saved.text);
    const other = (await srv.login('sari', PASS)).cookie;
    assert.equal((await srv.call(`/api/my/schedules/${visit.id}`, { cookie: other })).status, 404);
    assert.equal((await srv.call(`/api/staff/schedules/${visit.id}`, { cookie: again })).status, 403);
    const staffSoap = await srv.call(`/api/staff/schedules/${visit.id}`, { cookie: admin });
    assert.equal(staffSoap.status, 200, staffSoap.text);
    assert.equal(staffSoap.json.schedule.soap.s, VALID_SOAP.s);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dir = path.join(srv.dataDir, 'uploads');
    fs.writeFileSync(path.join(dir, `usr${budi.json.id}-10-abcdef.png`), png);
    fs.writeFileSync(path.join(dir, `usr${sari.json.id}-10-abcdef.png`), png);
    fs.writeFileSync(path.join(dir, 'svc1-10-abcdef.png'), png);
    fs.writeFileSync(path.join(dir, 'lama.png'), png);
    assert.equal((await srv.call(`/uploads/usr${budi.json.id}-10-abcdef.png`)).status, 401);
    assert.equal((await srv.call(`/uploads/usr${budi.json.id}-10-abcdef.png`, { cookie: again })).status, 200);
    assert.equal((await srv.call(`/uploads/usr${sari.json.id}-10-abcdef.png`, { cookie: again })).status, 403);
    assert.equal((await srv.call('/uploads/svc1-10-abcdef.png', { cookie: again })).status, 200);
    assert.equal((await srv.call('/uploads/lama.png', { cookie: again })).status, 403);
    assert.equal((await srv.call('/uploads/lama.png', { cookie: admin })).status, 200);
    assert.equal((await srv.call(`/uploads/usr${sari.json.id}-10-abcdef.png`, { cookie: sv })).status, 200);

    const bot = await srv.call('/api/bot/records', { method: 'POST', body: { username: 'budi' } });
    assert.equal(bot.status, 401);
    assert.equal(JSON.stringify(bot.json).includes('kunci-uji-keamanan-01'), false);
    assert.equal((await srv.call('/api/webhook', { method: 'POST', body: {} })).status, 404);
  } finally {
    await srv.stop();
  }
});
