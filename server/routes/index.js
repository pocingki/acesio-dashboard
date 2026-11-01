// Registry rute. Berkas rute memanggil add(...) saat dimuat; server/index.js memanggil loadRoutes() sekali.
// Tidak ada impor melingkar: berkas ini tidak mengimpor berkas rute secara statis.

// Batas ukuran body JSON (byte). Rute bisa menimpa lewat add(..., { limit }).
export const LIMITS = Object.freeze({
  default: 1 * 1024 * 1024,
  login: 16 * 1024,
  import: 30 * 1024 * 1024,
  image: 3 * 1024 * 1024, // foto layanan dikirim sebagai data URL base64 (maks 1,5 MB biner ≈ 2 MB base64)
});

// akses: public | user (semua yang login) | staff (admin & supervisor) | sv (supervisor) | bot
export const routes = [];

export function add(method, pattern, access, handler, opts = {}) {
  if (routes.some((r) => r.method === method && r.pattern === pattern)) {
    throw new Error(`Rute ganda: ${method} ${pattern}`);
  }
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, rx, keys, access, handler, limit: opts.limit });
}

const ROUTE_FILES = ['auth', 'records', 'history', 'staff-report', 'staff-customers', 'sv', 'bot'];

export async function loadRoutes() {
  for (const f of ROUTE_FILES) await import(`./${f}.js`);
  return routes;
}
