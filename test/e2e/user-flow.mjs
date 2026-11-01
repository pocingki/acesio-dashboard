// Tes e2e klien user (Playwright). MANDIRI: tidak ikut `npm test`.
//
//   node test/e2e/user-flow.mjs
//
// Butuh Playwright + Chromium terpasang di mesin ini (bukan dependensi repo), misalnya:
//   npx playwright install chromium   (dan paket "playwright" tersedia lewat NODE_PATH / global)
// Skrip menjalankan server sendiri di port acak dengan DATA_DIR sementara, membuat akun dan customer
// lewat API, lalu mengendalikan browser. Tidak menyentuh data asli.
//
// Catatan: pengujian idempotensi (hanya 1 record) baru lulus setelah server mendukung header Idempotency-Key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNCERTAIN = 'Belum pasti tersimpan. Menekan Input lagi aman, data tidak akan ganda.';

let server;
let dataDir;
let base;
let browser;
let adminCookie;
let userSeq = 0;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

async function adminApi(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  assert.ok(res.ok, `${method} ${url} gagal: ${res.status} ${data.error || ''}`);
  return data;
}

before(async () => {
  if (SKIP) return;
  let chromium;
  try {
    const pw = createRequire(import.meta.url)('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error('Playwright belum terpasang. Pasang dengan: npm i -g playwright && npx playwright install chromium (lalu NODE_PATH ke folder global).');
  }
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'acesio-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, BOT_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.resume();
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/api/auth/me`); break; } catch { if (i > 100) throw new Error('Server tidak mau jalan'); await sleep(100); }
  }
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  assert.equal(res.status, 200, 'login admin gagal');
  adminCookie = res.headers.getSetCookie()[0].split(';')[0];
  await adminApi('POST', '/api/staff/customers', { rm_no: RM, name: 'Customer E2E', phone: '081234567890' });
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// Akun baru per tes supaya hitungan record terisolasi.
async function newUser() {
  const username = `e2e_user_${++userSeq}`;
  await adminApi('POST', '/api/sv/accounts', { username, name: `User E2E ${userSeq}`, password: USER_PASSWORD });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { username, context, page };
}

async function login(page, username) {
  await page.goto(base);
  await page.fill('#u', username);
  await page.fill('#p', USER_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.tabs');
}

const tab = (page, name) => page.getByRole('button', { name, exact: true });
const submitBtn = (page) => page.locator('.panel .btn--primary').first();

async function pickCustomerAndService(page) {
  await page.waitForSelector('.svc-grid .svc');
  await page.fill('#cust-rm', RM);
  await page.click('.cust__opt');
  await page.locator('.svc-grid .svc').first().click();
  await page.waitForFunction(() => /^Input/.test(document.querySelector('.panel .btn--primary')?.textContent || '') && !document.querySelector('.panel .btn--primary').disabled);
}

async function myRecords(context) {
  const res = await context.request.get(`${base}/api/records/mine`);
  assert.equal(res.status(), 200);
  return (await res.json()).records;
}

// ---------------------------------------------------------------- #6 tab bercampur
test('pindah tab saat /api/services masih memuat tidak mencampur halaman', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await page.route('**/api/services', async (route) => { await sleep(1500); await route.continue(); });
    await login(page, username);
    await tab(page, 'Riwayat Customer').click();
    await page.waitForSelector('h1:has-text("Riwayat customer")');
    await page.waitForTimeout(2200); // lewati penundaan 1,5 dtk: respons /api/services yang terlambat tidak boleh menyentuh halaman
    assert.equal(await page.locator('.svc-grid').count(), 0, 'grid layanan tidak boleh muncul di tab Riwayat');
    assert.equal(await page.locator('.panel').count(), 0, 'panel input tidak boleh muncul di tab Riwayat');
    assert.deepEqual(await page.locator('main h1').allTextContents(), ['Riwayat customer']);

    await tab(page, 'Layanan').click();
    await page.waitForSelector('.svc-grid .svc'); // tab Layanan tetap bisa dimuat sesudahnya
    assert.deepEqual(await page.locator('main h1').allTextContents(), ['Pilih layanan']);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #2 pilihan tersimpan antar tab
test('pilihan customer dan layanan bertahan saat pindah tab, hilang saat keluar', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    await pickCustomerAndService(page);
    await tab(page, 'Riwayat Customer').click();
    await page.waitForSelector('h1:has-text("Riwayat customer")');
    await tab(page, 'Layanan').click();
    await page.waitForSelector('.svc-grid .svc');
    assert.ok(await page.locator('.chip-ok').isVisible(), 'customer terpilih harus pulih');
    assert.match(await page.locator('.chip-ok').innerText(), /Customer E2E/);
    assert.equal(await page.locator('.svc[aria-pressed=true]').count(), 1);
    assert.equal(await submitBtn(page).isDisabled(), false);

    await page.getByRole('button', { name: 'Keluar' }).click();
    await page.waitForSelector('.login');
    assert.equal((await page.locator('.login .error').innerText()).trim(), '', 'keluar yang disengaja tidak menampilkan "Sesi berakhir"');
    await page.fill('#u', username);
    await page.fill('#p', USER_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('.svc-grid .svc');
    assert.equal(await page.locator('.chip-ok').isVisible(), false, 'customer harus kosong setelah logout');
    assert.equal(await page.locator('.svc[aria-pressed=true]').count(), 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------- #4 idempotensi
test('Input ditekan dua kali setelah respons hilang: hanya 1 record dan key sama', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
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
    await pickCustomerAndService(page);
    await submitBtn(page).click();
    await page.getByText(UNCERTAIN).first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.panel .btn--primary').disabled);

    await submitBtn(page).click();
    assert.equal(await submitBtn(page).isDisabled(), true, 'tombol Input nonaktif selama permintaan berjalan');
    await submitBtn(page).click({ force: true, timeout: 500 }).catch(() => {}); // tekan lagi: tidak boleh mengirim permintaan ketiga
    await page.getByText(/layanan tercatat untuk/).waitFor();

    assert.equal(sent, 2, 'hanya dua permintaan (percobaan ulang), bukan tiga');
    assert.ok(keys[0], 'header Idempotency-Key harus terkirim');
    assert.equal(keys[0], keys[1], 'key dipertahankan untuk percobaan ulang pada kombinasi yang sama');
    assert.equal((await myRecords(context)).length, 1, 'harus tepat 1 record');
  } finally { await context.close(); }
});

test('Input saat jaringan putus lalu tersambung: hanya 1 record dan key dibuang setelah sukses', { skip: SKIP }, async () => {
  const { username, context, page } = await newUser();
  try {
    await login(page, username);
    const keys = [];
    await page.route('**/api/records', (route) => {
      if (route.request().method() === 'POST') keys.push(route.request().headers()['idempotency-key']);
      return route.fallback();
    });
    await pickCustomerAndService(page);

    await context.setOffline(true);
    await submitBtn(page).click();
    await page.getByText(UNCERTAIN).first().waitFor();
    await context.setOffline(false);
    await page.waitForFunction(() => !document.querySelector('.panel .btn--primary').disabled);
    await submitBtn(page).click();
    await page.getByText(/layanan tercatat untuk/).waitFor();
    assert.equal((await myRecords(context)).length, 1);

    // Kombinasi baru sesudah sukses memakai key baru.
    await pickCustomerAndService(page);
    await submitBtn(page).click();
    for (let i = 0; i < 100 && keys.length < 3; i++) await sleep(50);
    assert.equal(keys.length, 3, 'tiga permintaan POST: gagal offline, ulang, lalu kombinasi baru');
    assert.ok(keys[0], 'header Idempotency-Key harus terkirim');
    assert.equal(keys[0], keys[1], 'percobaan ulang memakai key yang sama');
    assert.notEqual(keys[2], keys[0], 'kombinasi baru setelah sukses memakai key baru');
  } finally { await context.close(); }
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
    await page.waitForSelector('.svc-grid .svc');
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