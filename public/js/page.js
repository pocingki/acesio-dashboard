// Halaman yang sedang dibuka disimpan di hash URL supaya refresh kembali ke situ.
// Hanya id yang memang ada di menu akun itu yang dipakai; selain itu kembali ke halaman awal.

const PAGE_KEYS = new Set(['day', 'status', 'scheduleId']);

export function hashForPage(id, params = {}) {
  const search = new URLSearchParams();
  for (const key of PAGE_KEYS) {
    const value = params?.[key];
    if (value == null || value === '' || typeof value === 'object') continue;
    const text = String(value);
    if (text.length > 80) continue;
    search.set(key, text);
  }
  const qs = search.toString();
  return qs ? `${id}?${qs}` : String(id || '');
}

export function pageFromHash(hash, allowed, fallback) {
  const raw = String(hash || '').replace(/^#/, '').trim();
  const q = raw.indexOf('?');
  const id = q === -1 ? raw : raw.slice(0, q);
  if (!id || !allowed.has(id)) return { id: fallback, params: {} };
  const params = {};
  if (q !== -1) {
    for (const [key, value] of new URLSearchParams(raw.slice(q + 1))) {
      if (PAGE_KEYS.has(key) && value.length <= 80) params[key] = value;
    }
  }
  return { id, params };
}
