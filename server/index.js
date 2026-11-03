import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

// Modul dimuat dinamis supaya .env sudah terbaca sebelum db.js dan auth.js dievaluasi.
const { db, dataDir, uploadDir } = await import('./db.js');
const { sessionUser, hashPassword, isSecure } = await import('./auth.js');
const { routes, loadRoutes, LIMITS } = await import('./routes/index.js');
await loadRoutes();
const { botKeyValid } = await import('./routes/bot.js');
const { startWorker, stopWorker } = await import('./integration.js');
const { HttpError } = await import('./util.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const HOST = process.env.HOST || '0.0.0.0';

// PORT=0 berarti port acak (dipakai tes). Kosong = 3000.
const rawPort = process.env.PORT;
const PORT = rawPort === undefined || String(rawPort).trim() === '' ? 3000 : Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`PORT tidak valid: "${rawPort}". Isi angka 0-65535.`);
  process.exit(1);
}

const TIMEOUTS = {
  request: 5 * 60 * 1000, // seluruh request termasuk body (impor customer 30 MB butuh waktu)
  headers: 30 * 1000,
  keepAlive: 65 * 1000, // di atas batas idle umum reverse proxy (60 dtk)
};

const HSTS = 'max-age=15552000'; // 180 hari; tanpa includeSubDomains/preload karena subdomain lain tidak kita kuasai

// ---------- akun supervisor pertama ----------
function writeFirstRunCredentials(username, password) {
  const file = path.join(dataDir, 'first-run-credentials.txt');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(
    file,
    `Akun supervisor pertama Acesio Dashboard\nusername : ${username}\npassword : ${password}\n\nCatat password ini, ganti lewat menu akun, lalu hapus berkas ini.\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return file;
}

async function ensureSupervisor() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'supervisor'").get()) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const given = process.env.ADMIN_PASSWORD;
  const generated = !given;
  const password = given || crypto.randomBytes(12).toString('base64url');

  // Berkas ditulis SEBELUM akun dibuat: kalau gagal menulis, akun tidak terbentuk dan password tidak hilang.
  const credFile = generated ? writeFirstRunCredentials(username, password) : null;
  try {
    const hash = await hashPassword(password);
    db.prepare("INSERT INTO users (username, name, password_hash, role, active, created_at) VALUES (?, ?, ?, 'supervisor', 1, ?)")
      .run(username, 'Supervisor', hash, new Date().toISOString());
  } catch (err) {
    if (credFile) fs.rmSync(credFile, { force: true });
    if (/UNIQUE/i.test(String(err?.message))) {
      console.error(`\n  Gagal membuat supervisor: username "${username}" sudah dipakai akun non-supervisor. Isi ADMIN_USERNAME dengan nama lain.\n`);
      process.exit(1);
    }
    throw err;
  }

  console.log('\n  Akun supervisor dibuat');
  console.log(`  username : ${username}`);
  if (generated) {
    console.log(`  password : dibuat acak, disimpan di ${credFile}`);
    console.log('             (buka berkas itu, catat passwordnya, lalu hapus berkasnya)\n');
  } else {
    console.log('  password : sesuai ADMIN_PASSWORD di .env');
    if (password.length < 12) console.log('  PERINGATAN: ADMIN_PASSWORD kurang dari 12 karakter. Gunakan password yang lebih panjang.');
    console.log('');
  }
}

await ensureSupervisor();
if (!process.env.BOT_API_KEY) console.log('  Info: BOT_API_KEY belum diisi, jadi endpoint /api/bot/* nonaktif.\n');

// ---------- helper HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// decodeURIComponent yang melempar 400 (bukan URIError/500) kalau encoding URL rusak.
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    throw new HttpError(400, 'URL tidak valid');
  }
}

// Target request harus berbentuk path absolut ("/..."). "//host/x" dan "/\host" ditolak karena
// parser URL menafsirkannya sebagai host lain; sisanya yang tidak bisa diurai juga 400, bukan 500.
function parseUrl(raw) {
  if (typeof raw !== 'string' || raw[0] !== '/' || raw[1] === '/' || raw.includes('\\')) throw new HttpError(400, 'URL tidak valid');
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    throw new HttpError(400, 'URL tidak valid');
  }
}

function sendJson(res, status, data, headers = {}) {
  const payload = JSON.stringify(data ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload); // untuk HEAD, Node otomatis membuang body
}

// Membaca body JSON. Body harus berupa objek (bukan null/angka/array/string).
// Bila melebihi batas: tolak dengan 413 + Connection: close (lihat sendTooLarge). Sisa body dibuang,
// bukan req.destroy(), supaya respons 413 sempat sampai ke klien.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => new HttpError(413, 'Data terlalu besar', 'PAYLOAD_TOO_LARGE', { Connection: 'close' });
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      req.resume();
      return reject(tooBig());
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    req.on('data', (c) => {
      if (settled) return; // setelah 413: buang saja
      size += c.length;
      if (size > limit) { chunks.length = 0; settle(reject, tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return settle(resolve, {});
      let parsed;
      try { parsed = JSON.parse(text); } catch { return settle(reject, new HttpError(400, 'Format JSON tidak valid')); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return settle(reject, new HttpError(400, 'Isi permintaan harus berupa objek JSON'));
      }
      settle(resolve, parsed);
    });
    req.on('error', () => settle(reject, new HttpError(400, 'Permintaan terputus')));
    req.on('close', () => settle(reject, new HttpError(400, 'Permintaan terputus')));
  });
}

function notFound(res) {
  return sendJson(res, 404, { error: 'Tidak ditemukan' });
}

const etagMatches = (header, etag) => {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === bare(etag));
};

// cache: 'no-cache' (selalu validasi lewat ETag) atau nilai Cache-Control lain.
function serveFile(req, res, base, rel, cache) {
  // Tolak null byte, lalu pastikan path akhir tetap di dalam folder dasar (anti path traversal).
  if (rel.includes('\0')) return notFound(res);
  const baseDir = path.resolve(base);
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(baseDir + path.sep)) return notFound(res);
  let st;
  try { st = fs.statSync(file); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache,
    ETag: etag,
  });
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(file), res, (err) => { if (err) res.destroy(); });
}

async function handleApi(req, res, url) {
  res.setHeader('Cache-Control', 'no-store'); // termasuk respons ekspor yang ditulis langsung oleh handler
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const route = routes.find((r) => r.method === method && r.rx.test(url.pathname));
  if (!route) {
    const allowed = [...new Set(routes.filter((r) => r.rx.test(url.pathname)).map((r) => r.method))];
    if (allowed.length) {
      throw new HttpError(405, 'Metode tidak diizinkan', undefined, { Allow: [...allowed, ...(allowed.includes('GET') ? ['HEAD'] : [])].join(', ') });
    }
    throw new HttpError(404, 'Endpoint tidak ditemukan');
  }
  const m = route.rx.exec(url.pathname);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, safeDecode(m[i + 1])]));

  let user = null;
  if (route.access === 'bot') {
    if (!botKeyValid(req)) throw new HttpError(401, 'API key salah');
  } else if (route.access !== 'public') {
    user = sessionUser(req);
    if (!user) throw new HttpError(401, 'Silakan login terlebih dahulu');
    if (route.access === 'staff' && user.role === 'user') throw new HttpError(403, 'Khusus admin dan supervisor');
    if (route.access === 'sv' && user.role !== 'supervisor') throw new HttpError(403, 'Khusus supervisor');
  }

  let body = {};
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    // Wajib JSON: form lintas situs tidak bisa mengirim tipe ini tanpa preflight (perlindungan CSRF).
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type harus application/json');
    body = await readBody(req, route.limit ?? LIMITS.default);
  }
  const query = Object.fromEntries(url.searchParams);
  const result = await route.handler({ req, res, user, body, query, params });
  if (res.headersSent || res.writableEnded) return; // handler sudah menulis respons (ekspor)
  sendJson(res, 200, result === undefined ? { ok: true } : result);
}

// 413: respons dikirim LEBIH DULU (lengkap, sesuai Content-Length), tetapi koneksi baru ditutup setelah klien
// selesai mengirim sisa body (dibuang), atau setelah batas waktu/ukuran. Menutup koneksi saat klien masih
// menulis membuat klien melihat EPIPE/ECONNRESET alih-alih pesan 413.
const DRAIN = { ms: 10_000, bytes: 64 * 1024 * 1024 };
function sendTooLarge(req, res, err) {
  const payload = JSON.stringify({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.write(payload);
  let drained = 0;
  let timer = null;
  const finish = () => {
    clearTimeout(timer);
    if (!res.writableEnded) res.end(); // Connection: close -> Node menutup socket setelah ini
  };
  if (req.complete || req.readableEnded) return finish();
  timer = setTimeout(finish, DRAIN.ms);
  req.on('data', (c) => { drained += c.length; if (drained > DRAIN.bytes) finish(); });
  req.once('end', finish);
  req.once('close', finish);
  req.resume();
}

function fail(req, res, err) {
  if (res.headersSent) { res.destroy(); return; } // respons sudah setengah terkirim; tidak bisa diubah
  if (err instanceof HttpError) {
    if (err.status === 413) return sendTooLarge(req, res, err);
    return sendJson(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) }, err.headers);
  }
  // Detail hanya ke log server, tidak pernah ke klien.
  console.error(`[${new Date().toISOString()}] 500 ${req.method} ${JSON.stringify(String(req.url).slice(0, 200))}`, err);
  return sendJson(res, 500, { error: 'Terjadi kesalahan di server' });
}

let shuttingDown = false;

const server = http.createServer(async (req, res) => {
  try {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', HSTS);
    if (shuttingDown) res.setHeader('Connection', 'close');

    const url = parseUrl(req.url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metode tidak diizinkan', undefined, { Allow: 'GET, HEAD' });
    if (url.pathname.startsWith('/uploads/')) {
      return serveFile(req, res, uploadDir, safeDecode(url.pathname.slice(9)), 'public, max-age=86400');
    }
    const rel = url.pathname === '/' ? 'index.html' : safeDecode(url.pathname.slice(1));
    return serveFile(req, res, publicDir, rel, 'no-cache');
  } catch (err) {
    return fail(req, res, err);
  }
});

server.requestTimeout = TIMEOUTS.request;
server.headersTimeout = TIMEOUTS.headers;
server.keepAliveTimeout = TIMEOUTS.keepAlive;

// ---------- penutupan rapi ----------
function closeDb() {
  try { db.close(); } catch { /* sudah tertutup */ }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} diterima, menutup server...`);
  const force = setTimeout(() => {
    console.error('  Batas waktu penutupan habis, keluar paksa.');
    closeDb();
    process.exit(1);
  }, 10_000);
  force.unref();
  stopWorker();
  server.close(() => {
    closeDb();
    console.log('  Server ditutup.');
    process.exit(0);
  });
  // closeIdleConnections() hanya melihat keadaan saat dipanggil; koneksi yang baru selesai membalas
  // (mis. file statis) dilewati. Karena itu disapu berulang sampai server benar-benar tertutup.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 200).unref();
  setTimeout(() => server.closeAllConnections(), 5_000).unref();
}

// ---------- mulai ----------
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
  });
} catch (err) {
  console.error(err.code === 'EADDRINUSE' ? `\n  Port ${PORT} sudah dipakai proses lain.\n` : err);
  closeDb();
  process.exit(1);
}

// Pendengar ini dipasang setelah server hidup: kegagalan saat start tetap menghentikan proses dengan jelas.
process.on('uncaughtException', (err) => console.error(`[${new Date().toISOString()}] uncaughtException`, err));
process.on('unhandledRejection', (reason) => console.error(`[${new Date().toISOString()}] unhandledRejection`, reason));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startWorker();
console.log(`  Acesio Dashboard berjalan di http://localhost:${server.address().port}\n`);
