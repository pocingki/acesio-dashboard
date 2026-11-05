import { test } from 'node:test';
import assert from 'node:assert/strict';
const { relativeTime, notificationText, badgeText, bellLabel } = await import('../public/js/notify.js');
const { setTz } = await import('../public/js/ui.js');
setTz('Asia/Jakarta');

test('waktu relatif: baru saja, menit, jam, kemarin, hari', () => {
  const now = Date.parse('2026-11-05T10:00:00+07:00');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(20_000), now), 'baru saja');
  assert.equal(relativeTime(ago(-5_000), now), 'baru saja', 'jam server sedikit maju tetap baru saja');
  assert.equal(relativeTime(ago(5 * 60_000), now), '5 menit lalu');
  assert.equal(relativeTime(ago(3 * 3600_000), now), '3 jam lalu');
  assert.equal(relativeTime('2026-11-04T20:00:00+07:00', now), '14 jam lalu');
  assert.equal(relativeTime('2026-11-04T09:00:00+07:00', now), 'kemarin');
  assert.equal(relativeTime('2026-11-04T00:10:00+07:00', now), 'kemarin');
  assert.equal(relativeTime('2026-11-02T09:00:00+07:00', now), '3 hari lalu');
  assert.match(relativeTime('2026-10-01T09:00:00+07:00', now), /2026/);
  assert.equal(relativeTime('', now), '');
  assert.equal(relativeTime('bukan tanggal', now), '');
});

test('waktu relatif: batas hari memakai zona aplikasi', () => {
  const now = Date.parse('2026-11-05T00:30:00+07:00'); // masih 04 November di UTC
  assert.equal(relativeTime('2026-11-04T23:00:00+07:00', now), '1 jam lalu');
  assert.equal(relativeTime('2026-11-03T23:00:00+07:00', now), '2 hari lalu');
  // 26 jam lalu: di UTC selisih kalendernya 2 hari, di WIB hanya 1 hari.
  assert.equal(relativeTime('2026-11-04T06:00:00+07:00', Date.parse('2026-11-05T08:00:00+07:00')), 'kemarin');
});

test('teks notifikasi untuk tiap tipe', () => {
  const n = (type) => notificationText({ type, title: 'dari server', body: 'Rina · 2026-11-05 09:00' });
  assert.equal(n('tugas_baru').title, 'Tugas baru');
  assert.equal(n('tugas_diubah').title, 'Jadwal diubah');
  assert.equal(n('tugas_berjalan').title, 'Tugas sedang dijalani');
  assert.equal(n('tugas_selesai').title, 'Tugas selesai');
  assert.equal(n('tugas_dibatalkan').title, 'Tugas dibatalkan');
  assert.equal(n('tugas_baru').body, 'Rina · 2026-11-05 09:00');
  const tones = ['tugas_baru', 'tugas_diubah', 'tugas_berjalan', 'tugas_selesai', 'tugas_dibatalkan'].map((t) => n(t).tone);
  assert.equal(new Set(tones).size, 5, 'tiap tipe punya nada berbeda');
  assert.equal(n('tipe_asing').title, 'dari server', 'tipe tak dikenal memakai judul server');
  assert.equal(notificationText({ type: 'x' }).title, 'Notifikasi');
  assert.equal(notificationText(null).body, '');
});

test('lencana dan label lonceng', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(badgeText(250), '9+');
  assert.equal(badgeText(-3), '');
  assert.equal(badgeText(undefined), '');
  assert.equal(bellLabel(3), 'Notifikasi, 3 belum dibaca');
  assert.equal(bellLabel(0), 'Notifikasi, 0 belum dibaca');
});
