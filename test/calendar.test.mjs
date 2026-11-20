// Fungsi murni kalender bulan dan dialog Terima pengajuan (tanpa DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { monthGrid, shiftMonth, monthTitle, monthOf, dayLabel, WEEKDAYS } = await import('../public/js/calendar.js');
const { acceptPayload, bookingText } = await import('../public/js/customers.js');

test('monthGrid: minggu mulai Senin, semua minggu penuh 7 hari', () => {
  const w = monthGrid('2026-11'); // 1 Nov 2026 = Minggu
  assert.equal(WEEKDAYS[0], 'Sen');
  assert.ok(w.every((r) => r.length === 7));
  assert.equal(w[0][6].ymd, '2026-11-01');
  assert.equal(w[0][0].inMonth, false);
  assert.equal(w.flat().filter((c) => c.inMonth).length, 30);
  assert.equal(w.at(-1).at(-1).ymd >= '2026-11-30', true);
  const feb = monthGrid('2028-02'); // kabisat
  assert.equal(feb.flat().filter((c) => c.inMonth).length, 29);
  assert.equal(monthGrid('2026-06')[0][0].ymd, '2026-06-01'); // 1 Juni 2026 = Senin
});

test('geser bulan lintas tahun dan judul', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthTitle('2026-11'), 'November 2026');
  assert.equal(monthOf('2026-11-20'), '2026-11');
});

test('label hari untuk pembaca layar', () => {
  assert.equal(dayLabel(undefined), 'tidak ada jadwal');
  assert.equal(dayLabel({ total: 3, baru: 2, berjalan: 1, selesai: 0, batal: 0 }), '3 jadwal (2 baru, 1 berjalan)');
});

test('acceptPayload: jadwal diisi semua atau tanpa jadwal', () => {
  const ok = { user_id: '4', day: '2026-12-01', start_time: '09:00', service_ids: [1] };
  assert.deepEqual(acceptPayload(ok, true).body, { user_id: 4, day: '2026-12-01', start_time: '09:00', service_ids: [1] });
  assert.deepEqual(acceptPayload({}, false).body, {});
  for (const bad of [{ ...ok, user_id: '' }, { ...ok, day: '' }, { ...ok, start_time: '' }, { ...ok, service_ids: [] }]) assert.ok(acceptPayload(bad, true).error);
});

test('bookingText', () => {
  assert.match(bookingText({}), /Belum ada data booking/);
  assert.match(bookingText({ day: '2099-06-15', time: '09:00', service_names: ['Facial'] }), /Booking.*09:00.*Facial/);
});
