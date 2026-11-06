// Pembantu tes: menjalankan server sebagai proses anak dengan DATA_DIR sementara dan port acak.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = path.join(ROOT, 'server', 'index.js');
export const ADMIN = { username: 'admin', password: 'Tes-Password-Admin-123' };

// Hanya variabel ini yang diwariskan dari lingkungan pengembang; sisanya (PORT, BOT_API_KEY, COOKIE_SECURE,
// ADMIN_*, ...) tidak ikut supaya tes tidak terpengaruh mesin masing-masing.
const INHERIT = ['PATH', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'TZ'];

function buildEnv(tmp, dataDir, overrides) {
  const env = {};
  for (const k of INHERIT) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: tmp, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir,
    ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password,
    ACCESS_HOURS: 'off', // tes lama tidak boleh bergantung pada jam; tes jam akses menimpanya lewat `env`
    SESSION_TIMER: 'off', // tes lama tidak menunggu hitung mundur/approve; tes timer menimpanya lewat `env`
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) delete env[k]; // env: { ADMIN_PASSWORD: undefined } = hapus
    else env[k] = String(v);
  }
  return env;
}

// startServer({ env }) -> { base, port, dataDir, stop(), login(user, pass), call(path, opts), raw(text), output() }
export async function startServer({ env = {}, stdin = false } = {}) {
  const options = { stdin };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-test-'));
  const dataDir = path.join(tmp, 'data');
  // cwd = folder sementara, jadi process.loadEnvFile() tidak membaca .env milik pengembang.
  const child = spawn(process.execPath, ['--no-warnings', ENTRY], {
    cwd: tmp,
    env: buildEnv(tmp, dataDir, env),
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let exitInfo = null;
  exited.then((e) => { exitInfo = e; });

  const cleanup = () => removeDir(tmp);

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Server tidak siap dalam 20 detik.\n${out}`)); }, 20_000);
    const check = () => {
      const m = /http:\/\/localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', check);
    exited.then((e) => { clearTimeout(timer); reject(new Error(`Server berhenti saat start (kode ${e.code}).\n${out}`)); });
  }).catch(async (err) => { await cleanup(); throw err; });

  const base = `http://127.0.0.1:${port}`;

  async function call(urlPath, { method = 'GET', body, headers = {}, cookie } = {}) {
    const h = { ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    }
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { status: res.status, headers: res.headers, text, json };
  }

  async function login(username = ADMIN.username, password = ADMIN.password) {
    const r = await call('/api/auth/login', { method: 'POST', body: { username, password } });
    if (r.status !== 200) throw new Error(`Login gagal (${r.status}): ${r.text}`);
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
    const cookie = cookies.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    return { cookie, user: r.json.user, tz: r.json.tz };
  }

  // Kirim teks HTTP mentah lewat socket (untuk target request yang tidak bisa dibuat fetch).
  function raw(requestText, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      let data = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('raw(): waktu habis')); }, timeoutMs);
      sock.on('data', (d) => { data += d; });
      sock.on('error', reject);
      sock.on('close', () => {
        clearTimeout(timer);
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]) || null;
        resolve({ status, text: data, body: data.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
      });
      sock.write(requestText);
    });
  }

  async function stop() {
    if (!exitInfo) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 12_000);
      await exited;
      clearTimeout(kill);
    }
    await cleanup();
    return exitInfo;
  }

  return { base, port, dataDir, child, done: exited, call, login, raw, stop, output: () => out };
}

// Windows sering masih mengunci acesio.db sesaat setelah proses anak berhenti (EPERM/EBUSY).
export async function removeDir(dir) {
  if (!dir) return;
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'ENOTEMPTY') throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

export function waitExit(proc, ms = 8000) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ---------- jadwal (Fase 4) ----------
// Isi SOAP yang sah untuk tes. Dipakai juga untuk memeriksa bahwa SOAP tidak bocor ke tempat lain.
export const VALID_SOAP = { s: 'Nyeri bahu kanan', o: 'ROM terbatas', a: 'Frozen shoulder', p: 'Latihan 2x seminggu' };

// Tanggal hari ini pada zona waktu bisnis (APP_TZ; bawaan Asia/Jakarta, sama dengan server tes).
const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ || 'Asia/Jakarta' });
export const todayYmd = (offsetDays = 0) => tzFmt.format(new Date(Date.now() + offsetDays * 86400000));

// Membuat jadwal lewat API staff (cookie admin/supervisor) dan mengembalikan objek `schedule`.
// Wajib: userId dan salah satu dari customerId / customerRm. Bawaan: hari ini, layanan [1], jam 09:00.
export async function createVisit(srv, staffCookie, {
  userId, customerId, customerRm, serviceIds = [1], day = todayYmd(), startTime = '09:00', endTime = '10:00', note = '',
} = {}) {
  const body = { user_id: userId, service_ids: serviceIds, day, start_time: startTime, end_time: endTime, note };
  if (customerId !== undefined) body.customer_id = customerId;
  if (customerRm !== undefined) body.customer_rm = customerRm;
  const r = await srv.call('/api/staff/schedules', { method: 'POST', body, cookie: staffCookie });
  if (r.status !== 200) throw new Error(`createVisit gagal (${r.status}): ${r.text}`);
  return r.json.schedule;
}
