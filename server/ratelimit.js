// Pembatas laju in-memory dengan jendela tetap (fixed window).
//
// createLimiter({ max, windowMs, maxKeys }) -> { hit, peek, reset, sweep, size }
//   hit(key)   : hitung satu kejadian. allowed=false bila kejadian ke-(max+1) dst. dalam jendela.
//   reset(key) : hapus hitungan key.
//   peek(key)  : tambahan di luar kontrak; melihat tanpa menghitung. allowed=false bila hitungan >= max
//                (artinya hit berikutnya sudah pasti ditolak).
//   sweep()    : buang semua entri kedaluwarsa (dipanggil otomatis berkala).
//   size()     : jumlah key yang sedang disimpan.
//
// Batas memori:
//  - key dipotong 200 karakter, jadi username raksasa tidak menggelembungkan memori;
//  - jumlah key dibatasi maxKeys, yang tertua (urutan pembuatan) dibuang lebih dulu;
//  - entri kedaluwarsa dibuang berkala lewat setInterval yang di-unref (tidak menahan proses).

const KEY_MAX = 200;

export function createLimiter({ max, windowMs, maxKeys = 10000 } = {}) {
  if (!(max >= 1) || !(windowMs > 0) || !(maxKeys >= 1)) {
    throw new TypeError('createLimiter: max, windowMs, dan maxKeys harus angka positif');
  }
  const entries = new Map(); // key -> { count, resetAt }; urutan Map = urutan pembuatan
  const norm = (key) => String(key).slice(0, KEY_MAX);

  function sweep(now = Date.now()) {
    for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
  }

  const timer = setInterval(() => sweep(), Math.max(10, Math.min(windowMs, 60_000)));
  if (typeof timer.unref === 'function') timer.unref();

  function live(key, now) {
    const e = entries.get(key);
    if (e && e.resetAt <= now) {
      entries.delete(key);
      return undefined;
    }
    return e;
  }

  const retryAfter = (e, now) => Math.max(1, Math.ceil((e.resetAt - now) / 1000));

  return {
    hit(rawKey) {
      const key = norm(rawKey);
      const now = Date.now();
      let e = live(key, now);
      if (!e) {
        while (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
        e = { count: 0, resetAt: now + windowMs };
        entries.set(key, e);
      }
      e.count++;
      const allowed = e.count <= max;
      return { allowed, retryAfterSec: allowed ? 0 : retryAfter(e, now) };
    },
    peek(rawKey) {
      const now = Date.now();
      const e = live(norm(rawKey), now);
      const allowed = !e || e.count < max;
      return { allowed, retryAfterSec: allowed ? 0 : retryAfter(e, now) };
    },
    reset(rawKey) {
      entries.delete(norm(rawKey));
    },
    sweep,
    size: () => entries.size,
  };
}