// Tidak ada batas jam login: admin, supervisor, dan user bisa masuk dan memakai aplikasi kapan saja.
// Waktu dimajukan lewat APP_FAKE_NOW_FILE (khusus NODE_ENV=test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ADMIN } from './helpers.mjs';

const PW = 'Tes-Password-User-123';
const wib = (hhmm, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+07:00`).toISOString();

test('semua akun bisa login dan memakai aplikasi pada jam berapa pun, meski ACCESS_HOURS lama masih ada di .env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-clock-'));
  const file = path.join(dir, 'now.txt');
  const setTime = (hhmm) => fs.writeFileSync(file, wib(hhmm));
  setTime('12:00');
  const s = await startServer({ env: { NODE_ENV: 'test', APP_FAKE_NOW_FILE: file, ACCESS_HOURS: '06:00-23:00' } });
  try {
    const adm = await s.call('/api/auth/login', { method: 'POST', body: ADMIN });
    assert.equal(adm.status, 200);
    const cookie = (adm.headers.getSetCookie?.() || [adm.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    for (const role of ['user', 'supervisor']) {
      const r = await s.call('/api/sv/accounts', { method: 'POST', cookie, body: { username: `t_${role}`, name: `Nama ${role}`, password: PW, role } });
      assert.equal(r.status, 200, r.text);
    }
    for (const hhmm of ['00:30', '03:00', '05:59', '12:00', '22:59', '23:00', '23:59']) {
      setTime(hhmm);
      for (const username of [ADMIN.username, 't_supervisor', 't_user']) {
        const password = username === ADMIN.username ? ADMIN.password : PW;
        const l = await s.call('/api/auth/login', { method: 'POST', body: { username, password } });
        assert.equal(l.status, 200, `${username} pukul ${hhmm}: ${l.text}`);
        assert.equal('access' in l.json, false, 'respons login tidak lagi memuat batas jam');
        const ck = (l.headers.getSetCookie?.() || [l.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
        const me = await s.call('/api/auth/me', { cookie: ck });
        assert.equal(me.status, 200, `${username} pukul ${hhmm} /me: ${me.text}`);
      }
    }
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
