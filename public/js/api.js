export const hooks = { onUnauthorized: null };

export async function api(path, { method = 'GET', body } = {}) {
  const hasBody = ['POST', 'PATCH', 'PUT'].includes(method);
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new Error('Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login') && hooks.onUnauthorized) hooks.onUnauthorized();
    const err = new Error(data?.error || 'Terjadi kesalahan');
    err.status = res.status;
    throw err;
  }
  return data;
}
