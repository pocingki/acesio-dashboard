import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

const { db, uploadDir } = await import('./db.js');
const { sessionUser, hashPassword } = await import('./auth.js');
const { routes, botKeyValid } = await import('./routes.js');
const { HttpError } = await import('./util.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Akun admin pertama dibuat otomatis kalau belum ada.
if (!db.prepare("SELECT 1 FROM users WHERE role = 'supervisor'").get()) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (username, name, password_hash, role, active, created_at) VALUES (?, ?, ?, 'supervisor', 1, ?)")
    .run(username, 'Supervisor', hashPassword(password), new Date().toISOString());
  console.log('\n  Akun supervisor dibuat');
  console.log(`  username : ${username}`);
  console.log(generated ? `  password : ${password}   (catat sekarang, tidak ditampilkan lagi)\n` : '  password : sesuai ADMIN_PASSWORD di .env\n');
}
if (!process.env.BOT_API_KEY) console.log('  Info: BOT_API_KEY belum diisi, jadi endpoint /api/bot/* nonaktif.\n');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Format JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, base, rel, extraHeaders = {}) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Tidak ditemukan');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...extraHeaders });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
  if (!route) {
    if (routes.some((r) => r.rx.test(url.pathname))) throw new HttpError(405, 'Metode tidak diizinkan');
    throw new HttpError(404, 'Endpoint tidak ditemukan');
  }
  const m = route.rx.exec(url.pathname);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

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
    body = await readBody(req);
  }
  const query = Object.fromEntries(url.searchParams);
  const result = route.handler({ req, res, user, body, query, params });
  if (result === null) return; // handler sudah menulis respons (ekspor)
  sendJson(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metode tidak diizinkan');
    if (url.pathname.startsWith('/uploads/')) {
      return serveFile(res, uploadDir, decodeURIComponent(url.pathname.slice(9)), { 'Cache-Control': 'public, max-age=86400' });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return serveFile(res, publicDir, rel, { 'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300' });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Terjadi kesalahan di server' });
  }
});

server.listen(PORT, HOST, () => console.log(`  Acesio Dashboard berjalan di http://localhost:${PORT}\n`));
