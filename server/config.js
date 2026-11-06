// Aturan lingkungan. Dibaca setelah .env, tanpa membuka database.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function bindHost(env = process.env) {
  const raw = String(env.HOST ?? '').trim();
  return raw || '127.0.0.1';
}

// Kosong bila lingkungan ini boleh jalan. Produksi menolak konfigurasi yang membuka jaringan
// atau memperlakukan cookie dan IP klien seperti di pengembangan.
export function productionProblems(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  const host = bindHost(env);
  if (!LOOPBACK.has(host)) {
    problems.push(`HOST=${host} membuka alamat jaringan. Produksi hanya boleh mendengarkan 127.0.0.1; akses dari luar lewat reverse proxy HTTPS.`);
  }
  if (env.COOKIE_SECURE !== 'true') {
    problems.push('COOKIE_SECURE harus true di produksi supaya cookie sesi hanya terkirim lewat HTTPS.');
  }
  if (env.TRUST_PROXY !== 'true') {
    problems.push('TRUST_PROXY harus true di produksi. Batas percobaan login memakai IP klien dari reverse proxy, bukan IP proxy itu sendiri. Port aplikasi tetap hanya di 127.0.0.1.');
  }
  if (String(env.APP_FAKE_NOW_FILE || '').trim()) {
    problems.push('APP_FAKE_NOW_FILE memalsukan jam dan tidak boleh diisi di produksi.');
  }
  if (String(env.SESSION_TIMER || '').trim() === 'off') {
    problems.push('SESSION_TIMER=off adalah mode pengembangan dan tidak boleh dipakai di produksi.');
  }
  return problems;
}
