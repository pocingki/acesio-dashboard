// Backup VACUUM INTO lalu pulihkan ke database kosong. Tidak menyentuh data/ milik pengembang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, ROOT } from './helpers.mjs';

test('backup utuh bisa dipulihkan dan data customer tetap ada', async () => {
  const srv = await startServer();
  const sv = await srv.login();
  const created = await srv.call('/api/staff/customers', {
    method: 'POST', cookie: sv.cookie,
    body: { rm_no: 'RM-PULIH', name: 'Pasien Pulih', phone: '081234567899' },
  });
  assert.equal(created.status, 200, created.text);
  if (!fs.existsSync(path.join(srv.dataDir, 'acesio.db'))) {
    throw new Error(`db hilang di ${srv.dataDir}\n${srv.output()}`);
  }

  const dataDir = srv.dataDir;
  const backupDir = path.join(path.dirname(dataDir), 'backups');
  const run = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/backup.js'), '--keep', '2'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, APP_TZ: 'Asia/Jakarta' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stderr || run.stdout}\nisi data: ${fs.existsSync(dataDir) ? fs.readdirSync(dataDir).join(',') : 'tidak ada'}`);
  const file = fs.readdirSync(backupDir).find((n) => n.startsWith('acesio-') && n.endsWith('.db'));
  assert.ok(file, 'berkas backup tidak terbentuk');
  const kept = path.join(os.tmpdir(), `acesio-pulih-${process.pid}.db`);
  fs.copyFileSync(path.join(backupDir, file), kept);
  await srv.stop();

  const db = new DatabaseSync(kept, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    const row = db.prepare("SELECT name, phone FROM customers WHERE rm_no = 'RM-PULIH'").get();
    assert.equal(row.name, 'Pasien Pulih');
    assert.equal(row.phone, '6281234567899');
  } finally {
    db.close();
    fs.rmSync(kept, { force: true });
  }
});
