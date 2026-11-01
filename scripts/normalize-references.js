// Merapikan kolom Referensi pada customer yang SUDAH ada ("fb" -> "Facebook") memakai keywords.json.
// Pemakaian: npm run normalize:references            (hanya menampilkan rencana, tidak mengubah apa pun)
//            npm run normalize:references -- --apply (menulis perubahan)
// Env: DATA_DIR, KEYWORDS_FILE (sama seperti server). Jalankan `npm run backup` dulu sebelum --apply.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveReference } from '../server/platforms.js';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const dbFile = path.join(dataDir, 'acesio.db');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(dbFile)) { console.error(`Database tidak ditemukan di ${dbFile}`); process.exit(1); }

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 10000');
const rows = db.prepare("SELECT id, rm_no, reference FROM customers WHERE reference <> ''").all();
const changes = rows.map((r) => ({ ...r, to: resolveReference(r.reference) })).filter((r) => r.to !== r.reference);

const tally = new Map();
for (const c of changes) tally.set(`${c.reference} -> ${c.to}`, (tally.get(`${c.reference} -> ${c.to}`) || 0) + 1);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
console.log(`${changes.length} dari ${rows.length} customer ber-referensi akan diubah.`);

if (!apply) { console.log('Belum ada yang ditulis. Tambahkan --apply untuk menjalankan.'); db.close(); process.exit(0); }

const upd = db.prepare('UPDATE customers SET reference = ?, updated_at = ? WHERE id = ?');
const now = new Date().toISOString();
db.exec('BEGIN');
try { for (const c of changes) upd.run(c.to, now, c.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`Selesai: ${changes.length} customer diperbarui.`);
db.close();
