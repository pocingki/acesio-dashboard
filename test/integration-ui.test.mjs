import { test } from 'node:test';
import assert from 'node:assert/strict';
const { urlFromCode, ago, statusInfo, waText } = await import('../public/js/integration.js');

test('alamat Amnan dibaca dari kode sambungan; kode lain atau rusak menghasilkan kosong', () => {
  const code = 'AMN1.' + Buffer.from(JSON.stringify({ u: 'https://wa.klinik.id', k: 'amk_x' })).toString('base64url');
  assert.equal(urlFromCode(code), 'https://wa.klinik.id');
  assert.equal(urlFromCode(`  ${code.slice(0, 20)}\n${code.slice(20)}  `), 'https://wa.klinik.id', 'spasi dan baris baru karena salin-tempel diabaikan');
  assert.equal(urlFromCode('amk_ab12cd34.abcdefghijklmnop'), '');
  assert.equal(urlFromCode('AMN1.%%%'), '');
  assert.equal(urlFromCode(''), '');
});

test('waktu relatif', () => {
  const now = Date.parse('2026-11-04T10:00:00Z');
  assert.equal(ago('2026-11-04T09:59:40Z', now), 'baru saja');
  assert.equal(ago('2026-11-04T09:55:00Z', now), '5 menit lalu');
  assert.equal(ago('2026-11-04T07:00:00Z', now), '3 jam lalu');
  assert.equal(ago('', now), '');
  assert.equal(ago('bukan tanggal', now), '');
});

test('banner status memakai bahasa awam untuk tiap keadaan', () => {
  const base = { stats: { pending: 0, failed: 0, last_ok_at: '' }, last_error: '' };
  assert.equal(statusInfo({ ...base, status: 'none' }).title, 'Belum tersambung');
  assert.equal(statusInfo({ ...base, status: 'paused' }).tone, 'wait');
  assert.match(statusInfo({ ...base, status: 'on' }).text, /Menunggu kunjungan pertama/);
  const now = Date.parse('2026-11-04T10:00:00Z');
  assert.match(statusInfo({ ...base, status: 'on', stats: { pending: 2, failed: 0, last_ok_at: '2026-11-04T09:00:00Z' } }, now).text, /1 jam lalu\. 2 kiriman sedang menunggu/);
  const bad = statusInfo({ ...base, status: 'problem', last_error: 'Amnan tidak bisa dijangkau', stats: { pending: 0, failed: 3, last_ok_at: '' } });
  assert.equal(bad.tone, 'bad');
  assert.match(bad.text, /Amnan tidak bisa dijangkau\. 3 kiriman gagal\./);
});

test('status WhatsApp Amnan', () => {
  assert.equal(waText('connected')[0], 'ok');
  assert.equal(waText('qr')[0], 'wait');
  assert.equal(waText('disconnected')[0], 'bad');
  assert.equal(waText('aneh')[0], 'wait');
});
