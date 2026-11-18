// Kunci server WhatsApp dibuat/dicabut dari dashboard (tanpa .env). Hanya hash yang disimpan; kunci utuh tampil sekali.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.mjs';

const ENV_KEY = 'kunci-env-cadangan-1234567890';
let srv; let sv;
const bot = (key) => srv.call('/api/bot/services', { headers: key ? { 'x-api-key': key } : {} });
const post = (url) => srv.call(url, { method: 'POST', body: {}, cookie: sv.cookie });

before(async () => { srv = await startServer({ env: { BOT_API_KEY: ENV_KEY } }); sv = await srv.login(); });
after(async () => { await srv.stop(); });

test('awal: kunci .env berlaku dan dashboard menampilkannya sebagai sumber env', async () => {
  assert.equal((await bot(ENV_KEY)).status, 200);
  const s = (await srv.call('/api/sv/integration', { cookie: sv.cookie })).json;
  assert.equal(s.bot_key.source, 'env');
  assert.equal(s.bot_key.active, true);
});

test('buat kunci: tampil sekali, jadi kunci utama; .env tidak lagi berlaku', async () => {
  const r = await post('/api/sv/integration/bot-key');
  assert.equal(r.status, 200, r.text);
  const key = r.json.new_bot_key;
  assert.match(key, /^acb_[A-Za-z0-9_-]{30,}$/);
  assert.equal(r.json.bot_key.source, 'dashboard');
  assert.equal(r.json.bot_key.hint.startsWith(key.slice(0, 8)), true);
  assert.equal(JSON.stringify(r.json.bot_key).includes(key), false, 'kunci utuh tidak ada di keadaan');
  assert.equal((await bot(key)).status, 200);
  assert.equal((await bot(ENV_KEY)).status, 401, 'kunci dashboard mengalahkan .env');
  assert.equal((await bot('acb_salah')).status, 401);
  const again = (await srv.call('/api/sv/integration', { cookie: sv.cookie })).json;
  assert.equal(again.new_bot_key, undefined, 'tidak tampil lagi setelah itu');
  assert.equal(JSON.stringify(again).includes(key), false);
});

test('database hanya menyimpan hash, bukan kunci', async () => {
  const key = (await post('/api/sv/integration/bot-key')).json.new_bot_key;
  const db = new DatabaseSync(path.join(srv.dataDir, 'acesio.db'));
  const rows = db.prepare("SELECT key, value FROM integration_settings WHERE key LIKE 'bot_key%'").all();
  db.close();
  assert.equal(rows.some((x) => String(x.value).includes(key)), false);
  assert.equal(rows.find((x) => x.key === 'bot_key_hash').value.length, 64);
});

test('buat ulang: kunci lama langsung mati', async () => {
  const a = (await post('/api/sv/integration/bot-key')).json.new_bot_key;
  const b = (await post('/api/sv/integration/bot-key')).json.new_bot_key;
  assert.notEqual(a, b);
  assert.equal((await bot(a)).status, 401);
  assert.equal((await bot(b)).status, 200);
});

test('cabut: kembali ke kunci .env; hanya supervisor yang boleh', async () => {
  assert.equal((await srv.call('/api/sv/integration/bot-key', { method: 'POST', body: {} })).status, 401);
  const r = await post('/api/sv/integration/bot-key/revoke');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.bot_key.source, 'env');
  assert.equal((await bot(ENV_KEY)).status, 200);
});
