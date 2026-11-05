// Tes e2e klien user (Playwright). MANDIRI: tidak ikut `npm test`.
//
//   node test/e2e/user-flow.mjs
//
// Butuh Playwright + Chromium terpasang di mesin ini (bukan dependensi repo), misalnya:
//   npx playwright install chromium   (dan paket "playwright" tersedia lewat NODE_PATH / global)
// Skrip menjalankan server sendiri di port acak dengan DATA_DIR sementara, membuat akun, customer, dan jadwal
// lewat API, lalu mengendalikan browser. Tidak menyentuh data asli.
//
// Alur yang diuji (revisi v1.3.0): Beranda -> klik angka -> Jadwal Saya -> klik jadwal (memulai) -> isi SOAP -> Simpan.
// User tidak memilih customer maupun layanan; keduanya ditentukan admin pada jadwal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Bila ditemukan oleh `node --test` otomatis, lewati kecuali diminta (E2E=1).
const SKIP = process.env.NODE_TEST_CONTEXT && !process.env.E2E ? 'E2E dilewati di npm test; jalankan: node test/e2e/user-flow.mjs' : false;

const ADMIN = { username: 'admin', password: 'admin-e2e-pass' };
const USER_PASSWORD = 'e2e-password-1';
const RM = 'RM-E2E-1';
const RM2 = 'RM-E2E-2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNCERTAIN = 'Belum pasti tersimpan. Menekan Simpan lagi aman, data tidak akan ganda.';
const SOAP_ISI = {
  s: 'Nyeri lutut kanan sejak dua minggu.',
  o: 'Fleksi lutut 110 derajat, tidak bengkak.',
  a: 'Dugaan strain ligamen ringan.',
  p: 'Terapi manual, evaluasi dua minggu lagi.',
};
// Hari ini menurut zona bisnis server (APP_TZ bawaan Asia/Jakarta).
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });
const ymdOf = (d) => dayFmt.format(d);
const TODAY = () => ymdOf(new Date());
const TOMORROW = () => ymdOf(new Date(Date.now() + 86400000));

let main; // server utama (jam akses dimatikan supaya tes tidak bergantung pada jam mesin)
let browser;
let userSeq = 0;
let schedSeq = 0;
const base = () => main.base;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

async function api(srv, method, url, body, cookie = srv.adminCookie) {
  const res = await fetch(srv.base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  assert.ok(res.ok, `${method} ${url} gagal: ${res.status} ${data.error || ''}`);
  return data;
}
const adminApi = (method, url, body) => api(main, method, url, body);

// Menyalakan satu server dengan DATA_DIR sendiri. `env` menimpa lingkungan; ACCESS_HOURS bawaan di sini = off.
async function startServer(env = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acesio-e2e-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, BOT_API_KEY: '', ACCESS_HOURS: 'off', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc.stdout.resume();
  for (let i = 0; ; i++) {
    try { await fetch(`${url}/api/auth/me`); break; } catch { if (i > 100) throw new Error('Server tidak mau jalan'); await sleep(100); }
  }
  const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  assert.equal(res.status, 200, 'login admin gagal');
  const srv = { base: url, dataDir, proc, adminCookie: res.headers.getSetCookie()[0].split(';')[0] };
  await api(srv, 'POST', '/api/staff/customers', { rm_no: RM, name: 'Customer E2E', phone: '081234567890' });
  await api(srv, 'POST', '/api/staff/customers', { rm_no: RM2, name: 'Customer Dua', phone: '081234567891' });
  return srv;
}
const stopServer = (srv) => { if (srv?.proc) srv.proc.kill(); if (srv?.dataDir) rmSync(srv.dataDir, { recursive: true, force: true }); };

before(async () => {
  if (SKIP) return;
  let chromium;
  try {
    const pw = createRequire(import.meta.url)('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error('Playwright belum terpasang. Pasang dengan: npm i -g playwright && npx playwright install chromium (lalu NODE_PATH ke folder global).');
  }
  main = await startServer();
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  stopServer(main);
});

// Akun baru per tes supaya hitungan record terisolasi.
async function newUser(srv = main) {
  const username = `e2e_user_${++userSeq}`;
  await api(srv, 'POST', '/api/sv/accounts', { username, name: `User E2E ${userSeq}`, password: USER_PASSWORD });
  const { workers } = await api(srv, 'GET', '/api/staff/schedule-workers');
  const id = workers.find((w) => w.username === username).id;
  const context = await browser.newContext();
  const page = await context.newPage();
  return { username, id, context, page, srv };
}

// Admin membuat jadwal untuk user (customer dan layanan ditentukan admin).
async function makeSchedule(u, { day = TODAY(), start, rm = RM, services = [1], note = '' } = {}) {
  const start_time = start || `${String(8 + (++schedSeq % 12)).padStart(2, '0')}:00`;
  const { schedule } = await api(u.srv, 'POST', '/api/staff/schedules', { user_id: u.id, customer_rm: rm, service_ids: services, day, start_time, note });
  return schedule;
}

async function login(page, username, srv = main) {
  await page.goto(srv.base);
  await page.fill('#u', username);
  await page.fill('#p', USER_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.tabs');
}

const tab = (page, name) => page.getByRole('button', { name, exact: true });
const saveBtn = (page) => page.getByRole('button', { name: /^(Simpan|Menyimpan)/ });
const rows = (page) => page.locator('.us-item');

async function fillSoap(page, soap = SOAP_ISI) {
  for (const [k, v] of Object.entries(soap)) await page.fill(`#soap-${k}`, v);
}

async function myRecords(context, srv = main) {
  const res = await context.request.get(`${srv.base}/api/records/mine`);
  assert.equal(res.status(), 200);
  return (await res.json()).records;
}

async function scheduleOf(id) {
  return (await adminApi('GET', `/api/staff/schedules/${id}`)).schedule;
}

// Membuka halaman input dari Jadwal Saya (klik baris = memulai jadwal).
async function openFirstRow(page) {
  await tab(page, 'Jadwal Saya').click();
  await page.waitForSelector('.us-item');
  await rows(page).first().click();
  await page.waitForSelector('#soap-s');
}

// ---------------------------------------------------------------- #6 tab bercampur
test('pindah tab saat Jadwal Saya masih memuat tidak mencampur halaman', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    await makeSchedule(u);
    await page.route('**/api/my/schedules*', async (route) => { await sleep(1500); await route.continue(); });
    await login(page, u.username);
    await page.waitForSelector('.home-hero');
    await tab(page, 'Jadwal Saya').click();
    await tab(page, 'Riwayat Customer').click();
    await page.waitForSelector('h1:has-text("Riwayat customer")');
    await page.waitForTimeout(2200); // lewati penundaan 1,5 dtk: respons yang terlambat tidak boleh menyentuh halaman
    assert.equal(await page.locator('.us').count(), 0, 'daftar jadwal tidak boleh muncul di tab Riwayat');
    assert.equal(await page.locator('.visit').count(), 0);
    assert.deepEqual(await page.locator('main h1').allTextContents(), ['Riwayat customer']);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- alur utama: Beranda -> Jadwal -> SOAP
test('alur utama: Beranda, klik angka, Jadwal Saya, klik jadwal, isi SOAP, simpan (tanpa memilih layanan)', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    const a = await makeSchedule(u, { start: '09:00', rm: RM, services: [1, 2], note: 'Datang lebih awal.' });
    await makeSchedule(u, { start: '10:00', rm: RM2, services: [3] });
    await makeSchedule(u, { start: '11:00', rm: RM, services: [4] }); // customer sama: dihitung sekali
    await makeSchedule(u, { day: TOMORROW(), start: '09:00', rm: RM2 });
    await login(page, u.username);

    // Beranda adalah tab awal; angka = customer unik hari ini (D7), jadwal besok tidak dihitung.
    await page.waitForSelector('.home-hero');
    assert.match(await page.locator('.home-hero').getAttribute('aria-label'), /^2 customer hari ini/);
    assert.equal(await page.locator('.home-hero__num').innerText(), '2');

    // Klik angka -> Jadwal Saya (hari ini saja).
    await page.locator('.home-hero').click();
    await page.waitForSelector('.us-item');
    assert.equal(await rows(page).count(), 3, 'default hanya jadwal hari ini');
    assert.equal(await page.locator('.svc-grid').count(), 0, 'tidak ada pemilih layanan');

    // Klik jadwal pertama (09:00) = memulai jadwal dan membuka halaman input untuk jadwal itu.
    assert.equal((await scheduleOf(a.id)).status, 'baru');
    await rows(page).first().click();
    await page.waitForSelector('#soap-s');
    assert.equal((await scheduleOf(a.id)).status, 'berjalan', 'klik baris memulai jadwal (D8)');

    // Customer dan layanan sudah ditentukan admin; user hanya mengisi SOAP.
    assert.equal(await page.locator('#cust-rm').count(), 0, 'tidak ada kolom pencarian customer');
    assert.equal(await page.locator('.svc-grid').count(), 0, 'tidak ada pemilih layanan');
    assert.match(await page.locator('.visit-card__name').innerText(), /Customer E2E/);
    assert.equal(await page.locator('.visit-services__list li').count(), 2);
    assert.match(await page.locator('.visit-card__note').innerText(), /Datang lebih awal/);
    assert.equal(await saveBtn(page).isDisabled(), true, 'Simpan nonaktif sebelum SOAP lengkap');

    // Bagian yang terlalu pendek ditolak di klien; setelah keempat bagian terisi tombol aktif.
    await page.fill('#soap-s', 'ab');
    await page.locator('#soap-s').blur();
    assert.equal(await saveBtn(page).isDisabled(), true);
    await fillSoap(page);
    assert.equal(await saveBtn(page).isDisabled(), false);
    await saveBtn(page).click();

    // Setelah tersimpan kembali ke Jadwal Saya; jadwal itu Selesai.
    await page.waitForSelector('.us-item');
    await page.getByText(/SOAP tersimpan/).first().waitFor();
    const done = await scheduleOf(a.id);
    assert.equal(done.status, 'selesai');
    assert.equal(done.has_soap, true);
    assert.deepEqual(done.soap, SOAP_ISI);
    assert.equal((await myRecords(context)).length, 2, 'satu record per layanan jadwal');

    // Beranda ikut berubah.
    await tab(page, 'Beranda').click();
    await page.waitForSelector('.home-hero');
    assert.match(await page.locator('.home-stats').innerText(), /Selesai\s*1|1\s*Selesai/);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- filter tanggal
test('Jadwal Saya: bawaan hari ini, tombol Semua menampilkan semua tanggal, jadwal besok tidak bisa dijalankan', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    await makeSchedule(u, { start: '09:00' });
    const besok = await makeSchedule(u, { day: TOMORROW(), start: '10:00', rm: RM2 });
    await login(page, u.username);
    await tab(page, 'Jadwal Saya').click();
    await page.waitForSelector('.us-item');
    assert.equal(await rows(page).count(), 1, 'bawaan: hari ini saja');

    await page.getByRole('button', { name: 'Semua', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.us-item').length === 2);
    assert.match(await page.locator('.us-group__tag').first().innerText(), /Hari ini/);

    // Klik jadwal besok: hanya pesan, tidak memulai dan tidak membuka halaman input.
    await rows(page).nth(1).click();
    await page.getByText(/bukan untuk hari ini/).first().waitFor();
    assert.equal(await page.locator('#soap-s').count(), 0);
    assert.equal((await scheduleOf(besok.id)).status, 'baru');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- input tanpa jadwal
test('tab Input Customer tanpa jadwal meminta memilih jadwal dulu', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    await login(page, u.username);
    await tab(page, 'Input Customer').click();
    await page.getByText('Pilih jadwal dulu').waitFor();
    assert.equal(await page.locator('textarea').count(), 0);
    await page.getByRole('button', { name: 'Buka Jadwal Saya' }).click();
    await page.waitForSelector('h1:has-text("Jadwal Saya")');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- draf SOAP
test('draf SOAP bertahan saat pindah tab dan hilang saat keluar', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    await makeSchedule(u);
    await login(page, u.username);
    await openFirstRow(page);
    await page.fill('#soap-s', 'Draf subjective');
    await tab(page, 'Riwayat Customer').click();
    await page.waitForSelector('h1:has-text("Riwayat customer")');
    await openFirstRow(page); // jadwal berjalan: klik lagi membuka halaman yang sama
    assert.equal(await page.inputValue('#soap-s'), 'Draf subjective', 'draf pulih');

    await page.getByRole('button', { name: 'Keluar' }).click();
    await page.waitForSelector('.login');
    assert.equal((await page.locator('.login .error').innerText()).trim(), '', 'keluar yang disengaja tidak menampilkan "Sesi berakhir"');
    await login(page, u.username);
    await openFirstRow(page);
    assert.equal(await page.inputValue('#soap-s'), '', 'draf dibuang setelah keluar');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #4 idempotensi
test('Simpan ditekan dua kali setelah respons hilang: record tidak ganda dan key sama', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    const s = await makeSchedule(u, { services: [1] });
    await login(page, u.username);
    const keys = [];
    let sent = 0;
    await page.route('**/api/records', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      sent += 1;
      if (sent === 1) { await route.fetch(); await route.abort('connectionreset'); return; } // server menyimpan, klien tidak menerima jawaban
      await sleep(600); // permintaan kedua lambat: tombol harus tetap nonaktif selama berjalan
      return route.continue();
    });
    await openFirstRow(page);
    await fillSoap(page);
    await saveBtn(page).click();
    await page.getByText(UNCERTAIN).first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.visit__actions .btn--primary').disabled);

    await saveBtn(page).click();
    assert.equal(await saveBtn(page).isDisabled(), true, 'tombol Simpan nonaktif selama permintaan berjalan');
    await saveBtn(page).click({ force: true, timeout: 500 }).catch(() => {}); // tekan lagi: tidak boleh mengirim permintaan ketiga
    await page.getByText(/SOAP tersimpan/).first().waitFor();

    assert.equal(sent, 2, 'hanya dua permintaan (percobaan ulang), bukan tiga');
    assert.ok(keys[0], 'header Idempotency-Key harus terkirim');
    assert.equal(keys[0], keys[1], 'key dipertahankan untuk percobaan ulang pada jadwal yang sama');
    assert.equal((await myRecords(context)).length, 1, 'harus tepat 1 record');
    assert.equal((await scheduleOf(s.id)).status, 'selesai');
  } finally { await context.close(); }
});

test('Simpan saat jaringan putus lalu tersambung: 1 record, key dibuang setelah sukses, jadwal lain memakai key baru', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    await makeSchedule(u, { start: '09:00', services: [1] });
    await makeSchedule(u, { start: '10:00', rm: RM2, services: [2] });
    await login(page, u.username);
    const keys = [];
    await page.route('**/api/records', (route) => {
      if (route.request().method() === 'POST') keys.push(route.request().headers()['idempotency-key']);
      return route.fallback();
    });
    await openFirstRow(page);
    await fillSoap(page);

    await context.setOffline(true);
    await saveBtn(page).click();
    await page.getByText(UNCERTAIN).first().waitFor();
    await context.setOffline(false);
    await page.waitForFunction(() => !document.querySelector('.visit__actions .btn--primary').disabled);
    await saveBtn(page).click();
    await page.getByText(/SOAP tersimpan/).first().waitFor();
    assert.equal((await myRecords(context)).length, 1);

    // Jadwal berikutnya (belum selesai) memakai key baru.
    await page.waitForSelector('.us-item');
    await page.locator('.us-item--baru').first().click();
    await page.waitForSelector('#soap-s');
    await fillSoap(page);
    await saveBtn(page).click();
    for (let i = 0; i < 100 && keys.length < 3; i++) await sleep(50);
    assert.equal(keys.length, 3, 'tiga permintaan POST: gagal offline, ulang, lalu jadwal berikutnya');
    assert.ok(keys[0], 'header Idempotency-Key harus terkirim');
    assert.equal(keys[0], keys[1], 'percobaan ulang memakai key yang sama');
    assert.notEqual(keys[2], keys[0], 'jadwal berikutnya memakai key baru');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- notifikasi (lonceng)
test('lonceng: tugas baru, sedang dijalani, selesai; membuka notifikasi menuju Jadwal Saya', { skip: SKIP }, async () => {
  const u = await newUser();
  const { context, page } = u;
  try {
    const s = await makeSchedule(u, { start: '09:00', services: [1] });
    await login(page, u.username);
    const bell = page.locator('.notify__btn');
    await bell.waitFor();
    await page.waitForFunction(() => /1/.test(document.querySelector('.notify__btn').getAttribute('aria-label') || ''));
    assert.equal(await page.locator('.notify__badge').isVisible(), true, 'lencana belum dibaca tampil');

    await bell.click();
    await page.locator('.notify__panel').waitFor({ state: 'visible' });
    assert.match(await page.locator('.notify__list').innerText(), /Tugas baru/);
    await page.getByRole('button', { name: 'Tandai semua dibaca' }).click();
    await page.waitForFunction(() => document.querySelector('.notify__badge')?.hidden !== false);
    await page.keyboard.press('Escape');

    // Mulai + selesai dari UI -> dua notifikasi baru.
    await openFirstRow(page);
    await fillSoap(page);
    await saveBtn(page).click();
    await page.getByText(/SOAP tersimpan/).first().waitFor();
    await bell.click();
    await page.locator('.notify__panel').waitFor({ state: 'visible' });
    // Daftar dimuat ulang saat panel dibuka: tunggu sampai dua notifikasi baru muncul.
    await page.waitForFunction(() => /Tugas selesai/.test(document.querySelector('.notify__list')?.innerText || ''));
    const text = await page.locator('.notify__list').innerText();
    assert.match(text, /Tugas sedang dijalani/);
    assert.match(text, /Tugas selesai/);

    // Klik notifikasi: menuju Jadwal Saya pada tanggal jadwal itu.
    await tab(page, 'Beranda').click();
    await page.waitForSelector('.home-hero');
    await bell.click();
    await page.locator('.notify__item').first().click();
    await page.waitForSelector('h1:has-text("Jadwal Saya")');
    assert.equal((await scheduleOf(s.id)).status, 'selesai');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- jam akses
test('jam akses: login ditolak di luar jam, sesi berjalan dicabut saat jam lewat, admin tidak dibatasi', { skip: SKIP }, async () => {
  // Jam server dikendalikan lewat berkas (hanya dibaca bila NODE_ENV=test; tidak boleh dipakai di produksi).
  const clockFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'acesio-clock-')), 'now.txt');
  const at = (hhmmWib) => { // jam WIB (UTC+7) pada hari ini -> waktu ISO UTC
    const [h, m] = hhmmWib.split(':').map(Number);
    return new Date(Date.parse(`${TODAY()}T00:00:00Z`) + ((h - 7) * 60 + m) * 60000).toISOString();
  };
  writeFileSync(clockFile, at('23:30')); // di luar 06.00-23.00
  const srv = await startServer({ NODE_ENV: 'test', APP_FAKE_NOW_FILE: clockFile, ACCESS_HOURS: '06:00-23:00' });
  const u = await newUser(srv);
  const { context, page } = u;
  try {
    await page.goto(srv.base);
    await page.fill('#u', u.username);
    await page.fill('#p', USER_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => /pukul 06\.00/.test(document.querySelector('.login .error')?.textContent || ''));
    assert.equal(await page.locator('.tabs').count(), 0, 'tidak masuk di luar jam akses');

    // Admin/supervisor tidak dibatasi pada jam yang sama.
    const adminRes = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    assert.equal(adminRes.status, 200);

    // Dalam jam: bisa masuk. Lewat pukul 23.00: sesi dicabut pada permintaan berikutnya dan layar login memuat pesannya.
    writeFileSync(clockFile, at('10:00'));
    await login(page, u.username, srv);
    await page.waitForSelector('.home-hero');
    writeFileSync(clockFile, at('23:05'));
    await tab(page, 'Jadwal Saya').click();
    await page.waitForSelector('.login');
    assert.match(await page.locator('.login .error').innerText(), /pukul 06\.00.23\.00/);
  } finally {
    await context.close();
    stopServer(srv);
    rmSync(path.dirname(clockFile), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- #11 #8 modal
test('modal: Escape hanya menutup yang teratas, listener tidak bocor, fokus terjebak dan kembali', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    await page.evaluate(async () => {
      const ui = await import('/js/ui.js');
      window.__ui = ui;
      window.__closed = [];
      window.__net = 0;
      const add = document.addEventListener.bind(document);
      const rem = document.removeEventListener.bind(document);
      document.addEventListener = (t, ...a) => { if (t === 'keydown') window.__net += 1; return add(t, ...a); };
      document.removeEventListener = (t, ...a) => { if (t === 'keydown') window.__net -= 1; return rem(t, ...a); };
      const trigger = document.createElement('button');
      trigger.id = 'trigger';
      trigger.textContent = 'pemicu';
      document.body.append(trigger);
      trigger.focus();
      const body = (id) => { const d = document.createElement('div'); d.innerHTML = `<button id="${id}-1" type="button">satu</button><button id="${id}-2" type="button">dua</button>`; return d; };
      ui.openModal({ title: 'A', content: body('a'), onClose: () => window.__closed.push('A') });
      ui.openModal({ title: 'B', content: body('b'), onClose: () => window.__closed.push('B') });
      ui.openModal({ title: 'C', content: body('c'), onClose: () => window.__closed.push('C') });
    });
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.__closed), ['C'], 'Escape hanya menutup modal teratas');
    assert.equal(await page.locator('.overlay').count(), 2);

    // Perangkap fokus di modal teratas (B)
    await page.focus('#b-2');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Tutup', 'Tab dari elemen terakhir kembali ke awal modal');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'b-2', 'Shift+Tab dari awal pindah ke elemen terakhir');

    // Tutup semua; satu modal lain dicabut dari luar; tidak boleh ada listener keydown tersisa.
    await page.evaluate(() => {
      const ui = window.__ui;
      ui.closeAllModals();
      ui.openModal({ title: 'D', content: 'x', onClose: () => window.__closed.push('D') });
      document.querySelector('.overlay').remove(); // dicabut tanpa close()
      ui.closeAllModals();
    });
    assert.equal(await page.locator('.overlay').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__closed), ['C', 'B', 'A', 'D'], 'closeAllModals menutup dari atas ke bawah, masing-masing sekali');
    assert.equal(await page.evaluate(() => window.__net), 0, 'listener keydown harus seimbang (tidak bocor)');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'trigger', 'fokus kembali ke pemicu');

    // Toast: wilayah live + role alert untuk error
    await page.evaluate(() => window.__ui.toast('Gagal contoh', 'err'));
    assert.equal(await page.locator('#toasts').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('.toast--err').getAttribute('role'), 'alert');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #6 #10 api.js
test('api: pesan jelas untuk 413, 429 (Retry-After), 5xx, timeout, dan offline', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    await page.route('**/api/__t/413', (r) => r.fulfill({ status: 413, contentType: 'application/json', body: '{"error":"x"}' }));
    await page.route('**/api/__t/429', (r) => r.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '30' }, body: '{"error":"x"}' }));
    await page.route('**/api/__t/503', (r) => r.fulfill({ status: 503, contentType: 'text/html', body: '<h1>503</h1>' }));
    await page.route('**/api/__t/400', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Format salah"}' }));
    await page.route('**/api/__t/slow', async (r) => { await sleep(500); await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    const msgs = await page.evaluate(async () => {
      const { api } = await import('/js/api.js');
      const grab = async (p, o) => { try { await api(p, o); return null; } catch (e) { return { status: e.status, message: e.message, timeout: !!e.timeout, network: !!e.network, retryAfter: e.retryAfter }; } };
      const out = {};
      out.e413 = await grab('/api/__t/413');
      out.e429 = await grab('/api/__t/429');
      out.e503 = await grab('/api/__t/503');
      out.e400 = await grab('/api/__t/400');
      const orig = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = () => orig(50);
      out.slow = await grab('/api/__t/slow');
      AbortSignal.timeout = orig;
      return out;
    });
    assert.match(msgs.e413.message, /File terlalu besar/);
    assert.match(msgs.e429.message, /30 detik/);
    assert.equal(msgs.e429.retryAfter, 30);
    assert.match(msgs.e503.message, /Server sedang bermasalah.*503/);
    assert.equal(msgs.e400.message, 'Format salah');
    assert.equal(msgs.slow.timeout, true);
    assert.match(msgs.slow.message, /terlalu lama/);

    await context.setOffline(true);
    const off = await page.evaluate(async () => {
      const { api } = await import('/js/api.js');
      try { await api('/api/services'); } catch (e) { return { message: e.message, network: !!e.network }; }
    });
    await context.setOffline(false);
    assert.equal(off.network, true);
    assert.match(off.message, /offline/i);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #9 unduh
test('downloadFile: sukses menyimpan berkas, 401 menampilkan toast dan login tanpa berkas', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    await tab(page, 'Riwayat Customer').click();
    await page.waitForSelector('h1:has-text("Riwayat customer")');
    assert.equal(await page.locator('a[download]').count(), 0, 'tidak boleh ada <a download>');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
    assert.match(dl.suggestedFilename(), /^riwayat-customer-.*\.csv$/);

    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.route('**/api/records/mine/export*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Silakan login terlebih dahulu"}' }));
    await page.getByRole('button', { name: 'Excel' }).click();
    await page.waitForSelector('.login');
    await page.getByText('Sesi berakhir').first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(downloaded, false, 'JSON error tidak boleh tersimpan sebagai berkas');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #5 sesi habis
test('sesi habis: modal ditutup, request dibatalkan, login tampil SEKALI', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    await page.waitForSelector('.home-hero');
    await page.locator('.userbtn').click();
    await page.waitForSelector('.overlay');
    await page.route('**/api/__t/slow2', async (r) => { await sleep(3000); await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    await page.route('**/api/__t/401', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Silakan login terlebih dahulu"}' }));
    const result = await page.evaluate(async () => {
      const { api } = await import('/js/api.js');
      let loginRenders = 0;
      new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.classList?.contains('login')) loginRenders += 1; }).observe(document.getElementById('app'), { childList: true });
      const t0 = performance.now();
      const slow = api('/api/__t/slow2').then(() => 'selesai', (e) => (e.aborted ? 'dibatalkan' : `error: ${e.message}`));
      await Promise.allSettled([api('/api/__t/401'), api('/api/__t/401'), api('/api/__t/401')]);
      const slowResult = await slow;
      await new Promise((r) => setTimeout(r, 200));
      return { slowResult, ms: performance.now() - t0, loginRenders };
    });
    assert.equal(result.slowResult, 'dibatalkan');
    assert.ok(result.ms < 2500, 'request lambat harus dibatalkan, bukan ditunggu');
    assert.equal(result.loginRenders, 1, 'login tampil sekali');
    assert.equal(await page.locator('.overlay').count(), 0, 'semua modal ditutup');
    assert.match(await page.locator('.login .error').innerText(), /Sesi berakhir/);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #7 zona waktu
test('zona waktu: tidak ada nilai hardcode dan format mengikuti setTz', { skip: SKIP }, async () => {
  for (const f of ['api.js', 'app.js', 'login.js', 'shell.js', 'ui.js', 'user.js']) {
    const src = readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
    assert.ok(!src.includes('Asia/Jakarta'), `${f} masih memuat Asia/Jakarta`);
    assert.ok(!src.includes('+07:00'), `${f} masih memuat +07:00`);
  }
  assert.ok(!/download\s*:/.test(readFileSync(path.join(ROOT, 'public/js/user.js'), 'utf8')), 'user.js masih memakai <a download>');

  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    const r = await page.evaluate(async () => {
      const ui = await import('/js/ui.js');
      const out = {};
      ui.setTz('Pacific/Kiritimati'); // UTC+14
      out.timeA = ui.fmtTime('2026-10-31T10:00:00Z');
      out.todayA = ui.todayInTz();
      out.dayA = ui.fmtDay('2026-10-31');
      ui.setTz('Pacific/Pago_Pago'); // UTC-11
      out.timeB = ui.fmtTime('2026-10-31T10:00:00Z');
      out.todayB = ui.todayInTz();
      out.dayB = ui.fmtDay('2026-10-31');
      out.alias = ui.jakartaToday() === ui.todayInTz();
      ui.setTz('Zona/Ngawur'); // nilai tidak valid diabaikan
      out.kept = ui.getTz();
      return out;
    });
    assert.match(r.timeA, /^00[.:]00$/);
    assert.match(r.timeB, /^23[.:]00$/);
    assert.match(r.todayA, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(r.todayA, r.todayB);
    assert.equal(r.dayA, r.dayB, 'fmtDay (tanggal kalender) tidak bergeser oleh zona');
    assert.match(r.dayA, /31/);
    assert.equal(r.alias, true);
    assert.equal(r.kept, 'Pacific/Pago_Pago');
  } finally { await context.close(); }
});