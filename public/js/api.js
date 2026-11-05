// Klien HTTP: api(), downloadFile(), pembatalan massal, dan pesan error berbahasa Indonesia.
import { toast } from './ui.js';

export const hooks = { onUnauthorized: null };

const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXPIRED_MSG = 'Sesi berakhir. Silakan masuk lagi.';

// Semua permintaan yang sedang berjalan, supaya bisa dibatalkan sekaligus (sesi habis / keluar).
const inflight = new Set();

export function abortAllRequests() {
  for (const c of [...inflight]) c.abort();
  inflight.clear();
}

// Gabungan beberapa AbortSignal (abaikan yang kosong).
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) { c.abort(); break; }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
}

function abortedError() {
  const err = new Error('Permintaan dibatalkan');
  err.name = 'AbortError';
  err.aborted = true;
  return err;
}

function waitText(sec) {
  if (sec < 60) return `${sec} detik`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} menit`;
  return `${Math.ceil(sec / 3600)} jam`;
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

function httpError(res, data) {
  const status = res.status;
  let message;
  let retryAfter = 0;
  if (status === 413) {
    message = 'File terlalu besar. Perkecil ukuran file lalu coba lagi.';
  } else if (status === 429) {
    retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    message = retryAfter
      ? `Terlalu banyak permintaan. Coba lagi dalam ${waitText(retryAfter)}.`
      : (data?.error || 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.');
  } else if (status >= 500) {
    message = `Server sedang bermasalah (kode ${status}). Coba lagi sebentar lagi.`;
  } else {
    message = data?.error || 'Terjadi kesalahan';
  }
  const err = new Error(message);
  err.status = status;
  if (data?.code) err.code = data.code;
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

// Satu pintu untuk fetch: timeout, pembatalan, dan klasifikasi error jaringan.
async function request(path, { method = 'GET', headers, body, signal, timeoutMs = TIMEOUT_MS, as = 'json' } = {}) {
  const own = new AbortController();
  inflight.add(own);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = anySignal([own.signal, timeout, signal]);
  try {
    const res = await fetch(path, { method, credentials: 'same-origin', headers, body, signal: combined });
    const isJson = (res.headers.get('content-type') || '').includes('json');
    let data = null;
    let badJson = false;
    if (as === 'blob' && res.ok) {
      data = await res.blob();
    } else if (isJson) {
      try { data = await res.json(); } catch (e) { if (e instanceof SyntaxError) badJson = true; else throw e; }
    }
    if (badJson && res.ok) {
      const bad = new Error('Respons server tidak valid. Coba lagi.');
      bad.own = true;
      throw bad;
    }
    return { res, data };
  } catch (e) {
    if (e?.own) throw e;
    if (signal?.aborted || own.signal.aborted) throw abortedError();
    if (timeout.aborted) {
      const err = new Error('Server terlalu lama menjawab. Coba lagi.');
      err.timeout = true;
      err.uncertain = true;
      throw err;
    }
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const err = new Error(offline
      ? 'Kamu sedang offline. Periksa koneksi internet lalu coba lagi.'
      : 'Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.');
    err.network = true;
    err.offline = offline;
    err.uncertain = true;
    throw err;
  } finally {
    inflight.delete(own);
  }
}

function fail(path, res, data) {
  const err = httpError(res, data);
  if (res.status === 401 && !path.startsWith('/api/auth/login') && hooks.onUnauthorized) hooks.onUnauthorized();
  // Di luar jam akses: diperlakukan seperti sesi berakhir, tetapi membawa pesan dari server.
  // Saat login (403 dari /api/auth/login) pesan cukup tampil di formulir, tanpa memicu hook.
  if (res.status === 403 && data?.code === 'OUTSIDE_HOURS' && !path.startsWith('/api/auth/login') && hooks.onUnauthorized) {
    hooks.onUnauthorized(err.message);
  }
  return err;
}

export async function api(path, { method = 'GET', body, headers, signal } = {}) {
  const hasBody = ['POST', 'PATCH', 'PUT'].includes(method);
  const { res, data } = await request(path, {
    method,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    signal,
  });
  if (!res.ok) throw fail(path, res, data);
  return data;
}

function nameFromHeader(res) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// Unduh berkas lewat fetch (bukan <a download>) supaya error 401/JSON tidak tersimpan sebagai berkas.
// Selalu resolve: true bila berkas tersimpan, false bila gagal (error tampil sebagai toast).
export async function downloadFile(url, filename) {
  try {
    const { res, data } = await request(url, { as: 'blob', timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok) throw fail(url, res, data);
    const wantsJson = /\.json$/i.test(filename || '');
    if (!wantsJson && /json|html/i.test(data.type || '')) {
      let msg = '';
      try { msg = JSON.parse(await data.text())?.error || ''; } catch { /* bukan JSON */ }
      throw new Error(msg || 'Server tidak mengirim berkas. Coba lagi.');
    }
    saveBlob(data, filename || nameFromHeader(res) || 'unduhan');
    return true;
  } catch (e) {
    if (e?.aborted) return false;
    toast(e.status === 401 ? EXPIRED_MSG : (e.message || 'Berkas gagal diunduh'), 'err');
    return false;
  }
}
