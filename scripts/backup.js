// Backup database dengan VACUUM INTO: aman dijalankan saat server hidup (bukan salin berkas mentah).
// Pemakaian: npm run backup [-- --keep 14]
// Env: DATA_DIR (sama seperti server), BACKUP_DIR (default: <repo>/backups), APP_TZ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(root, 'backups');
const dbFile = path.join(dataDir, 'acesio.db');
const PATTERN = /^acesio-\d{8}-\d{4}(-\d{2})?\.db$/;

function fail(msg) {
  console.error(`Backup gagal: ${msg}`);
  process.exit(1);
}

function parseKeep(argv) {
  const i = argv.findIndex((a) => a === '--keep' || a.startsWith('--keep='));
  if (i < 0) return 14;
  const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail('--keep harus bilangan bulat 1 atau lebih (contoh: --keep 14)');
  return n;
}

// YYYYMMDD-HHMM di zona waktu bisnis (APP_TZ), supaya urutan nama = urutan waktu.
function stamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.APP_TZ || 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { minute: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`, second: parts.second };
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

const keep = parseKeep(process.argv.slice(2));
if (!fs.existsSync(dbFile)) fail(`database tidak ditemukan di ${dbFile}`);
fs.mkdirSync(backupDir, { recursive: true });

const { minute, second } = stamp();
let target = path.join(backupDir, `acesio-${minute}.db`);
if (fs.existsSync(target)) target = path.join(backupDir, `acesio-${minute}-${second}.db`); // dua backup dalam menit yang sama
if (fs.existsSync(target)) fail(`berkas ${path.basename(target)} sudah ada`);

const db = new DatabaseSync(dbFile);
try {
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare('VACUUM INTO ?').run(target);
} catch (err) {
  fs.rmSync(target, { force: true });
  fail(err.message);
} finally {
  db.close();
}

// Pastikan hasilnya benar-benar basis data yang utuh sebelum backup lama dihapus.
const copy = new DatabaseSync(target, { readOnly: true });
try {
  const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  if (check !== 'ok') throw new Error(`integrity_check: ${check}`);
} catch (err) {
  copy.close();
  fs.rmSync(target, { force: true });
  fail(`salinan tidak lolos pemeriksaan (${err.message})`);
}
copy.close();

console.log(`Backup dibuat: ${target} (${fmtSize(fs.statSync(target).size)})`);

// Urut tanpa ekstensi: "…-2100" harus lebih lama dari "…-2100-20" (karakter "-" mengurut sebelum ".").
const key = (f) => f.replace(/\.db$/, '');
const all = fs.readdirSync(backupDir).filter((f) => PATTERN.test(f)).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const old = all.slice(0, Math.max(0, all.length - keep));
for (const f of old) fs.rmSync(path.join(backupDir, f), { force: true });
if (old.length) console.log(`Backup lama dihapus: ${old.length} berkas (menyimpan ${keep} terbaru)`);
