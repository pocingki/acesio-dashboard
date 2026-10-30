import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 0812-3456-789 / +62 812... / 812... -> 62812...
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  if (d.length < 9 || d.length > 15) return null;
  return d;
}

export function cleanName(input) {
  const n = String(input || '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 100 ? n : null;
}

export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
}

export const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

export function formatDateTime(iso) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: process.env.APP_TZ || 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

const MAX_IMAGE = 1.5 * 1024 * 1024;
export function saveDataUrlImage(dataUrl, prefix) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Format foto harus JPG, PNG, atau WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE) throw new HttpError(400, 'Ukuran foto maksimal 1,5 MB');
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (!(isJpg || isPng || isWebp)) throw new HttpError(400, 'File foto tidak valid');
  const ext = isJpg ? 'jpg' : isPng ? 'png' : 'webp';
  const file = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, file), buf);
  return `/uploads/${file}`;
}

export function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.basename(url);
  fs.rm(path.join(uploadDir, file), { force: true }, () => {});
}
