import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  SCHEDULE_STATUS_LABEL, fmtTimeRange, fmtLongDay, servicesSummary, SOAP_PARTS, fmtCountdown, PHASE_LABEL, STAFF_STATUS_FILTER,
} = await import('../public/js/schedule-ui.js');

test('label status jadwal', () => {
  assert.deepEqual(SCHEDULE_STATUS_LABEL, {
    baru: 'Baru', berjalan: 'Sedang dijalani', selesai: 'Selesai', batal: 'Dibatalkan',
  });
});

test('rentang jam', () => {
  assert.equal(fmtTimeRange('09:00', '10:00'), '09:00–10:00');
  assert.equal(fmtTimeRange('09:00', ''), '09:00');
  assert.equal(fmtTimeRange('09:00', null), '09:00');
  assert.equal(fmtTimeRange('09:00', undefined), '09:00');
});

test('hari panjang', () => {
  assert.equal(fmtLongDay('2026-11-05'), 'Kamis, 5 November 2026');
  assert.equal(fmtLongDay('2026-01-01'), 'Kamis, 1 Januari 2026');
  assert.equal(fmtLongDay(''), '');
  assert.equal(fmtLongDay('bukan-tanggal'), 'bukan-tanggal');
});

test('ringkasan layanan', () => {
  const names = (...n) => n.map((name, i) => ({ id: i + 1, name }));
  assert.equal(servicesSummary([]), '-');
  assert.equal(servicesSummary(undefined), '-');
  assert.equal(servicesSummary(names('Layanan 1')), 'Layanan 1');
  assert.equal(servicesSummary(names('Layanan 1', 'Layanan 3')), 'Layanan 1, Layanan 3');
  assert.equal(servicesSummary(names('Layanan 1', 'Layanan 3', 'A', 'B')), 'Layanan 1, Layanan 3 +2');
  assert.equal(servicesSummary(names('A', 'B', 'C'), 1), 'A +2');
});

test('bagian SOAP', () => {
  assert.deepEqual(SOAP_PARTS, [
    { key: 's', label: 'Subjective', hint: 'Keluhan dan cerita pasien' },
    { key: 'o', label: 'Objective', hint: 'Hasil pemeriksaan dan pengukuran' },
    { key: 'a', label: 'Assessment', hint: 'Penilaian dan diagnosis' },
    { key: 'p', label: 'Planning', hint: 'Rencana tindakan dan tindak lanjut' },
  ]);
});

test('modul jadwal aman diimpor di Node dan mengekspor scheduleView', async () => {
  const m = await import('../public/js/schedules.js');
  assert.equal(typeof m.scheduleView, 'function');
  const staff = await import('../public/js/staff.js');
  assert.equal(typeof staff.renderStaffApp, 'function');
});

test('fmtCountdown: MM:SS, jam bila perlu, nilai tak sah jadi 00:00', () => {
  assert.equal(fmtCountdown(0), '00:00');
  assert.equal(fmtCountdown(59), '00:59');
  assert.equal(fmtCountdown(125), '02:05');
  assert.equal(fmtCountdown(3600), '1:00:00');
  assert.equal(fmtCountdown(3725), '1:02:05');
  assert.equal(fmtCountdown(-5), '00:00');
  assert.equal(fmtCountdown('abc'), '00:00');
  assert.equal(fmtCountdown(undefined), '00:00');
  assert.equal(fmtCountdown(59.9), '00:59');
});

test('label fase dan opsi filter status staf', () => {
  assert.equal(PHASE_LABEL.menunggu, 'Menunggu approve');
  assert.equal(PHASE_LABEL.soap, 'Isi SOAP');
  assert.deepEqual(Object.keys(PHASE_LABEL), ['soap', 'timer', 'menunggu']);
  assert.equal(STAFF_STATUS_FILTER.menunggu, 'Menunggu approve');
  assert.deepEqual(Object.keys(STAFF_STATUS_FILTER), ['baru', 'berjalan', 'selesai', 'batal', 'menunggu']);
});
