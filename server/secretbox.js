// Menyimpan rahasia (mis. kunci akses WhatsApp) terenkripsi di database.
// Kunci enkripsi dibuat otomatis sekali di DATA_DIR/integration.key (izin 600), terpisah dari acesio.db,
// jadi salinan database saja (backup, kiriman ke orang lain) tidak membuka rahasianya.
// AES-256-GCM; format tersimpan: v1.<iv>.<tag>.<data> (base64url).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './db.js';

const FILE = path.join(dataDir, 'integration.key');
let cached = null;

function loadKey() {
  if (cached) return cached;
  try {
    const raw = Buffer.from(fs.readFileSync(FILE, 'utf8').trim(), 'base64url');
    if (raw.length === 32) return (cached = raw);
  } catch { /* belum ada */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(FILE, key.toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  return (cached = key);
}

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data].map((x) => (Buffer.isBuffer(x) ? x.toString('base64url') : x)).join('.');
}

// Mengembalikan '' bila kosong, rusak, atau kunci enkripsi berbeda (bukan error: pemakai cukup menyambung ulang).
export function open(sealed) {
  try {
    const [v, iv, tag, data] = String(sealed || '').split('.');
    if (v !== 'v1' || !data) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
