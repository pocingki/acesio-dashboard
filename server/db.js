import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ymd } from './clock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
export const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'acesio.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','admin','supervisor')),
  employment TEXT NOT NULL DEFAULT 'tetap' CHECK (employment IN ('tetap','part_time')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  photo TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (name, phone)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  commission INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  batch TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_commissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, service_id)
);
CREATE TABLE IF NOT EXISTS day_reviews (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  late INTEGER NOT NULL CHECK (late IN (0,1)),
  reviewed_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_records_user_day ON records(user_id, day);
CREATE INDEX IF NOT EXISTS idx_records_day ON records(day);
CREATE INDEX IF NOT EXISTS idx_records_customer ON records(customer_id);
CREATE INDEX IF NOT EXISTS idx_records_service ON records(service_id);
`;

const hasUsers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
const version = db.prepare('PRAGMA user_version').get().user_version;

if (hasUsers && version < 2) {
  // Migrasi dari versi 1: admin lama (akses penuh) -> supervisor; komisi per layanan -> komisi tiap user.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const usersDdl = SCHEMA.match(/CREATE TABLE IF NOT EXISTS users \([\s\S]*?\n\);/)[0]
      .replace('CREATE TABLE IF NOT EXISTS users (', 'CREATE TABLE users_new (');
    db.exec(usersDdl);
    db.exec(`INSERT INTO users_new (id, username, name, password_hash, role, employment, active, created_at)
             SELECT id, username, name, password_hash, CASE role WHEN 'admin' THEN 'supervisor' ELSE role END, 'tetap', active, created_at FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    for (const col of ["day TEXT NOT NULL DEFAULT ''", "note TEXT NOT NULL DEFAULT ''", "batch TEXT NOT NULL DEFAULT ''"]) {
      try { db.exec(`ALTER TABLE records ADD COLUMN ${col}`); } catch { /* sudah ada */ }
    }
    db.exec(SCHEMA);
    const upd = db.prepare('UPDATE records SET day = ?, batch = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, user_id, customer_id, created_at FROM records').all()) {
      upd.run(ymd(new Date(r.created_at)), `${r.created_at}|${r.user_id}|${r.customer_id}`, r.id);
    }
    const hasOld = db.prepare("SELECT 1 FROM pragma_table_info('services') WHERE name = 'commission'").get();
    if (hasOld) {
      db.exec(`INSERT OR IGNORE INTO user_commissions (user_id, service_id, amount)
               SELECT u.id, s.id, s.commission FROM users u CROSS JOIN services s WHERE u.role = 'user' AND s.commission > 0`);
    }
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
} else {
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 2');
}
db.exec(INDEXES);

// 29 kotak layanan tetap; supervisor mengubah nama dan fotonya.
export const SERVICE_COUNT = 29;
if (db.prepare('SELECT COUNT(*) AS n FROM services').get().n < SERVICE_COUNT) {
  const ins = db.prepare('INSERT OR IGNORE INTO services (position, name) VALUES (?, ?)');
  for (let i = 1; i <= SERVICE_COUNT; i++) ins.run(i, `Layanan ${i}`);
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
