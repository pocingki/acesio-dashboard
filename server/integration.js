// Integrasi Acesio -> Amnan (WhatsApp), kontrak v1 Amnan (lihat Amnan docs/INTEGRASI.md).
//
// Alurnya: saat terapis mencatat layanan, Acesio menaruh satu baris di antrean (integration_outbox) DALAM
// transaksi yang sama dengan pencatatan, lalu pekerja latar mengirimnya ke Amnan. Amnan mati atau lambat
// tidak pernah menggagalkan pencatatan layanan; kiriman diulang otomatis dan bisa dikirim ulang manual.
//
// Yang dikirim ke Amnan: nama, No RM, jumlah kunjungan, waktu dan nama layanan terakhir. Catatan Medis,
// komisi, dan data terapis TIDAK pernah dikirim.
import crypto from 'node:crypto';
import net from 'node:net';
import { db, tx } from './db.js';
import { HttpError } from './util.js';
import { seal, open } from './secretbox.js';

export const DEFAULT_THANKS = 'Halo {nama}, terima kasih sudah berkunjung ke Acesio. Jika ada keluhan setelah sesi, balas pesan ini ya.';
const REQUIRED_SCOPES = ['leads:write', 'events:write'];
const SCOPE_LABEL = {
  'leads:write': 'mengisi data pelanggan',
  'events:write': 'mencatat kunjungan',
  'messages:send': 'mengirim pesan WhatsApp',
};
const RETRY_DELAYS_SEC = [30, 120, 600, 3600, 21600];
const TIMEOUT_MS = 10_000;
const STALE_THANKS_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- pengaturan

const DEFAULTS = {
  enabled: '0', amnan_url: '', api_key: '', brand: '', app_slug: 'acesio', wa_status: '', scopes: '[]',
  tested_at: '', last_error: '', last_ok_at: '', send_visit: '1', send_thanks: '0', thanks_text: DEFAULT_THANKS,
};

function readAll() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM integration_settings').all()) if (r.key in out) out[r.key] = r.value;
  return out;
}

function write(obj) {
  const up = db.prepare('INSERT INTO integration_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => { for (const [k, v] of Object.entries(obj)) up.run(k, String(v)); });
}

const scopesOf = (S) => { try { const a = JSON.parse(S.scopes); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

// ---------------------------------------------------------------- alamat dan kode sambungan

const b64uJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Menerima "kode sambungan" Amnan (AMN1....) atau kunci akses polos (amk_...).
export function parseCode(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return { url: '', key: '' };
  if (/^AMN1\./i.test(s)) {
    try {
      const d = b64uJson(s.slice(5));
      if (typeof d.k === 'string' && d.k) return { url: typeof d.u === 'string' ? d.u : '', key: d.k };
    } catch { /* jatuh ke galat di bawah */ }
    throw new HttpError(400, 'Kode sambungan tidak bisa dibaca. Salin ulang kodenya dari Amnan.');
  }
  if (/^amk_[A-Za-z0-9]{4,16}\.[A-Za-z0-9_-]{16,}$/.test(s)) return { url: '', key: s };
  throw new HttpError(400, 'Kode tidak dikenali. Tempel "kode sambungan" atau "kunci akses" dari Amnan.');
}

function privateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host === '[::1]' || host === '::1';
}

export function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new HttpError(400, 'Alamat Amnan tidak valid. Contoh: https://wa.klinikanda.id'); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) {
    throw new HttpError(400, 'Alamat Amnan harus berbentuk https://... tanpa tambahan apa pun di belakangnya.');
  }
  if (u.hostname.startsWith('169.254.')) throw new HttpError(400, 'Alamat ini tidak diizinkan.');
  if (u.protocol === 'http:' && !privateHost(u.hostname)) {
    throw new HttpError(400, 'Gunakan alamat https:// agar kunci akses tidak terkirim tanpa enkripsi. (http:// hanya boleh untuk server yang sama, mis. http://127.0.0.1:8080)');
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- panggilan ke Amnan

async function call({ url, key }, method, path, body, idem) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  let res;
  try {
    res = await fetch(url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { network: true, status: 0, json: null };
  }
  let json = null;
  try { json = JSON.parse((await res.text()).slice(0, 50_000)); } catch { /* bukan JSON */ }
  return { network: false, status: res.status, json };
}

// Mengubah balasan Amnan menjadi keputusan: ok | retry (coba lagi nanti) | perm (gagal tetap) | skip.
// link = masalah di sambungan itu sendiri, jadi sisa antrean juga ditunda.
function classify(r) {
  const msg = r.json?.error ? String(r.json.error).slice(0, 200) : '';
  if (r.network) return { retry: true, link: true, msg: 'Amnan tidak bisa dijangkau' };
  if (r.status >= 200 && r.status < 300) return { ok: true };
  if (r.status >= 300 && r.status < 400) return { retry: true, link: true, msg: 'Alamat Amnan dialihkan ke tempat lain' };
  if (r.status === 401) return { retry: true, link: true, msg: 'Kunci akses ditolak Amnan (salah atau sudah dicabut)', auth: true };
  if (r.status === 403 && r.json?.code === 'BLOCKED') return { skip: true, msg: 'Nomor ini diblokir di Amnan' };
  if (r.status === 429) return { retry: true, link: true, msg: 'Batas kirim harian Amnan tercapai' };
  if (r.status === 503) return { retry: true, link: true, msg: 'WhatsApp di Amnan belum tersambung' };
  if (r.status >= 500) return { retry: true, link: true, msg: 'Amnan sedang bermasalah' };
  return { perm: true, msg: msg || `Ditolak Amnan (kode ${r.status})` };
}

function friendlyTestError(r) {
  if (r.network) return 'Amnan tidak bisa dijangkau di alamat itu. Pastikan alamatnya benar dan Amnan sedang menyala.';
  if (r.status === 401) return 'Kunci akses ditolak Amnan. Salin ulang kode terbaru dari Amnan.';
  if (r.status === 429) return 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.';
  if (r.status >= 300 && r.status < 400) return 'Alamat dialihkan ke tempat lain. Pakai alamat akhirnya (biasanya yang diawali https://).';
  if (r.status >= 500) return 'Amnan menjawab dengan galat. Coba lagi sebentar lagi.';
  return 'Alamat ini sepertinya bukan Amnan, atau versi Amnan-nya terlalu lama.';
}

// Uji sambungan (GET /api/v1/ping). Melempar HttpError berbahasa awam bila gagal.
async function ping(cfg) {
  const r = await call(cfg, 'GET', '/api/v1/ping');
  if (!(r.status === 200 && r.json?.ok === true && r.json?.app)) throw new HttpError(400, friendlyTestError(r));
  return {
    brand: String(r.json.brand || r.json.client || '').slice(0, 100),
    wa: String(r.json.wa?.status || ''),
    scopes: Array.isArray(r.json.app.scopes) ? r.json.app.scopes.map(String) : [],
  };
}

function missingOf(scopes, needed = REQUIRED_SCOPES) {
  return needed.filter((s) => !scopes.includes(s));
}

const missingText = (m) => m.map((s) => SCOPE_LABEL[s] || s).join(', ');

// ---------------------------------------------------------------- sambung / putus / pengaturan

export async function connect({ code, url, key }) {
  const parsed = parseCode(code);
  const finalKey = parsed.key || String(key || '').trim();
  if (!finalKey) throw new HttpError(400, 'Tempel kode sambungan dari Amnan.');
  if (!parsed.key && !/^amk_[A-Za-z0-9]{4,16}\.[A-Za-z0-9_-]{16,}$/.test(finalKey)) throw new HttpError(400, 'Kunci akses tidak dikenali. Salin ulang dari Amnan.');
  const finalUrl = cleanUrl(String(url || '').trim() || parsed.url);
  const info = await ping({ url: finalUrl, key: finalKey });
  const missing = missingOf(info.scopes);
  if (missing.length) throw new HttpError(400, `Kunci ini belum boleh ${missingText(missing)}. Minta admin Amnan memberi izin itu, atau buat kunci baru.`);
  const S = readAll();
  write({
    amnan_url: finalUrl, api_key: seal(finalKey), brand: info.brand, wa_status: info.wa, scopes: JSON.stringify(info.scopes),
    tested_at: new Date().toISOString(), last_error: '',
    // Ucapan terima kasih mati sendiri bila kunci baru tidak boleh mengirim pesan.
    send_thanks: info.scopes.includes('messages:send') ? S.send_thanks : '0',
  });
  return { brand: info.brand, wa: info.wa };
}

export async function retest() {
  const S = readAll();
  const key = open(S.api_key);
  if (!key) throw new HttpError(409, 'Belum tersambung ke Amnan.');
  try {
    const info = await ping({ url: S.amnan_url, key });
    write({ brand: info.brand, wa_status: info.wa, scopes: JSON.stringify(info.scopes), tested_at: new Date().toISOString(), last_error: '', last_ok_at: new Date().toISOString() });
    return { ok: true, message: 'Sambungan baik.' };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    write({ tested_at: new Date().toISOString(), last_error: e.message });
    return { ok: false, message: e.message };
  }
}

export function disconnect() {
  tx(() => {
    write({ enabled: '0', api_key: '', brand: '', wa_status: '', scopes: '[]', tested_at: '', last_error: '', last_ok_at: '' });
    db.prepare("UPDATE integration_outbox SET status = 'skipped', last_error = 'Integrasi diputus sebelum terkirim' WHERE status = 'pending'").run();
  });
}

export function update(patch) {
  const S = readAll();
  const next = {};
  const bool = (v, name) => {
    if (typeof v !== 'boolean') throw new HttpError(400, `Nilai ${name} tidak valid`);
    return v ? '1' : '0';
  };
  const connected = !!S.api_key;
  if (patch.send_visit !== undefined) next.send_visit = bool(patch.send_visit, 'send_visit');
  if (patch.send_thanks !== undefined) next.send_thanks = bool(patch.send_thanks, 'send_thanks');
  if (patch.thanks_text !== undefined) {
    const t = String(patch.thanks_text).trim();
    if (!t || t.length > 500) throw new HttpError(400, 'Isi ucapan harus 1–500 karakter');
    next.thanks_text = t;
  }
  if (patch.enabled !== undefined) {
    next.enabled = bool(patch.enabled, 'enabled');
    if (next.enabled === '1' && !connected) throw new HttpError(409, 'Sambungkan ke Amnan dulu sebelum menyalakan.');
  }
  const merged = { ...S, ...next };
  if (merged.send_thanks === '1') {
    if (merged.send_visit !== '1') throw new HttpError(400, 'Ucapan terima kasih butuh "Catat kunjungan" menyala.');
    if (!scopesOf(merged).includes('messages:send')) throw new HttpError(400, 'Kunci akses ini belum boleh mengirim pesan WhatsApp. Minta admin Amnan menambah izinnya.');
  }
  write(next);
  return Object.keys(next);
}

// ---------------------------------------------------------------- antrean

const phoneOk = (p) => /^\d{8,15}$/.test(String(p || ''));

// Dipanggil DI DALAM transaksi pencatatan layanan (server/records.js). Tidak pernah melempar error.
export function enqueueVisit({ customer, serviceIds, day }) {
  try {
    const S = readAll();
    if (S.enabled !== '1' || S.send_visit !== '1' || !S.api_key) return;
    const names = db.prepare(`SELECT name FROM services WHERE id IN (${serviceIds.map(() => '?').join(',')}) ORDER BY position`).all(...serviceIds).map((r) => r.name);
    const visits = db.prepare('SELECT COUNT(DISTINCT batch) AS n FROM records WHERE customer_id = ?').get(customer.id).n;
    const phone = String(customer.phone || '');
    const when = new Date().toISOString();
    let thanks = 0;
    if (S.send_thanks === '1' && phoneOk(phone) && scopesOf(S).includes('messages:send')) {
      const already = db.prepare("SELECT 1 FROM integration_outbox WHERE customer_id = ? AND day = ? AND thanks = 1 AND status IN ('pending','sent')").get(customer.id, day);
      thanks = already ? 0 : 1;
    }
    const payload = { name: customer.name, rm: customer.rm_no || '', services: names, visits, at: when, text: thanks ? S.thanks_text : '' };
    const skipped = !phoneOk(phone);
    db.prepare(`INSERT INTO integration_outbox (uid, created_at, customer_id, day, phone, payload, thanks, status, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), when, customer.id, day, phone, JSON.stringify(payload), thanks, skipped ? 'skipped' : 'pending', skipped ? 'Customer belum punya nomor WA yang valid' : '');
    if (!skipped) kick();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] integrasi: gagal mengantre`, err);
  }
}

const steps = (row) => (row.thanks ? ['contact', 'event', 'message'] : ['contact', 'event']);
const trim500 = (s) => String(s).slice(0, 500);

async function runStep(name, row, p, cfg, S) {
  const slug = S.app_slug || 'acesio';
  const idem = (suffix = '') => `${row.uid}-${name}${suffix}`;
  if (name === 'contact') {
    return call(cfg, 'PUT', `/api/v1/contacts/${row.phone}`, {
      name: p.name,
      data: { rmNo: String(p.rm || ''), visits: Number(p.visits) || 0, lastVisitAt: p.at, lastServices: trim500((p.services || []).join(', ')) },
    }, idem());
  }
  if (name === 'event') {
    const send = (s) => call(cfg, 'POST', '/api/v1/events', {
      type: `${s}.visit_recorded`, phone: row.phone, name: p.name,
      summary: trim500(`Kunjungan dicatat di Acesio: ${(p.services || []).join(', ') || '-'}${p.rm ? ` (RM ${p.rm})` : ''}`),
      data: { rmNo: String(p.rm || ''), services: (p.services || []).length },
    }, idem(`-${s}`));
    let r = await send(slug);
    // Amnan hanya menerima kejadian berawalan nama aplikasi milik kunci. Bila beda dari bawaan, ikuti dan ingat.
    const m = r.status === 403 && r.json?.code === 'FORBIDDEN_SCOPE' && /berawalan "([a-z][a-z0-9-]*)\./.exec(String(r.json?.error || ''));
    if (m && m[1] !== slug) {
      write({ app_slug: m[1] });
      r = await send(m[1]);
    }
    return r;
  }
  const first = String(p.name || '').trim();
  return call(cfg, 'POST', '/api/v1/messages', { phone: row.phone, name: first, text: String(p.text || '').replace(/\{nama\}/gi, first).slice(0, 4000) }, idem());
}

async function deliver(row, cfg, S) {
  let p;
  try { p = JSON.parse(row.payload); } catch { p = {}; }
  const list = steps(row);
  for (let i = row.done_steps; i < list.length; i++) {
    if (list[i] === 'message' && Date.now() - Date.parse(row.created_at) > STALE_THANKS_MS) break; // ucapan basi tidak dikirim
    const d = classify(await runStep(list[i], row, p, cfg, S));
    if (d.ok) { db.prepare('UPDATE integration_outbox SET done_steps = ? WHERE id = ?').run(i + 1, row.id); continue; }
    if (d.skip) {
      db.prepare("UPDATE integration_outbox SET status = 'skipped', last_error = ? WHERE id = ?").run(d.msg, row.id);
      return { link: false };
    }
    if (d.auth) write({ last_error: d.msg });
    const attempts = row.attempts + 1;
    if (d.perm || attempts > RETRY_DELAYS_SEC.length) {
      db.prepare("UPDATE integration_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, d.msg, row.id);
    } else {
      const next = Date.now() + RETRY_DELAYS_SEC[attempts - 1] * 1000;
      db.prepare('UPDATE integration_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, next, d.msg, row.id);
    }
    return { link: !!d.link };
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE integration_outbox SET status = 'sent', sent_at = ?, last_error = '' WHERE id = ?").run(now, row.id);
  write({ last_ok_at: now, last_error: '' });
  return { link: false };
}

let timer = null;
let busy = false;
let kickTimer = null;

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const S = readAll();
    const key = open(S.api_key);
    if (S.enabled !== '1' || !key) return;
    const cfg = { url: S.amnan_url, key };
    for (let i = 0; i < 25; i++) {
      const row = db.prepare("SELECT * FROM integration_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT 1").get(Date.now());
      if (!row) break;
      const r = await deliver(row, cfg, readAll());
      if (r.link) break; // sambungan bermasalah: jangan menghantam Amnan dengan sisa antrean
    }
    db.prepare("DELETE FROM integration_outbox WHERE status IN ('sent','skipped') AND created_at < ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString());
  } catch (err) {
    if (!/not open|closed/i.test(String(err?.message))) console.error(`[${new Date().toISOString()}] integrasi: pekerja error`, err);
  } finally {
    busy = false;
  }
}

function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; tick(); }, 400);
  kickTimer.unref();
}

export function startWorker() {
  if (timer) return;
  timer = setInterval(tick, 5000);
  timer.unref();
  kick();
}

export function stopWorker() {
  clearInterval(timer);
  clearTimeout(kickTimer);
  timer = null;
  kickTimer = null;
}

export function retryFailed() {
  const r = db.prepare("UPDATE integration_outbox SET status = 'pending', attempts = 0, next_at = 0, last_error = '' WHERE status = 'failed'").run();
  if (r.changes) kick();
  return Number(r.changes);
}

// ---------------------------------------------------------------- tampilan untuk dashboard

const hintOf = (key) => {
  const id = String(key || '').split('.')[0];
  return id ? `${id}.••••••••` : '';
};

export function state() {
  const S = readAll();
  const key = open(S.api_key);
  const scopes = scopesOf(S);
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const stats = {
    pending: n("SELECT COUNT(*) AS n FROM integration_outbox WHERE status = 'pending'"),
    failed: n("SELECT COUNT(*) AS n FROM integration_outbox WHERE status = 'failed'"),
    sent_24h: n("SELECT COUNT(*) AS n FROM integration_outbox WHERE status = 'sent' AND sent_at >= ?", day),
    last_ok_at: S.last_ok_at || '',
  };
  const recent = db.prepare('SELECT id, created_at, status, attempts, last_error, payload, thanks FROM integration_outbox ORDER BY id DESC LIMIT 8').all().map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload); } catch { /* abaikan */ }
    return { id: r.id, at: r.created_at, status: r.status, error: r.last_error, customer: p.name || '', services: (p.services || []).join(', '), thanks: !!r.thanks };
  });
  const connected = !!(S.api_key && key);
  const enabled = connected && S.enabled === '1';
  let status = 'none';
  if (connected) status = !enabled ? 'paused' : (S.last_error || stats.failed > 0 ? 'problem' : 'on');
  return {
    status, connected, enabled,
    url: connected ? S.amnan_url : '', key_hint: connected ? hintOf(key) : '', brand: S.brand,
    wa_status: S.wa_status, scopes, can_message: scopes.includes('messages:send'),
    missing_scopes: missingOf(scopes).map((s) => SCOPE_LABEL[s] || s),
    tested_at: S.tested_at, last_error: S.last_error,
    send_visit: S.send_visit === '1', send_thanks: S.send_thanks === '1', thanks_text: S.thanks_text,
    stats, recent,
    // Arah sebaliknya (Amnan membaca data customer Acesio) memakai BOT_API_KEY di .env.
    amnan_can_read: !!process.env.BOT_API_KEY,
  };
}
