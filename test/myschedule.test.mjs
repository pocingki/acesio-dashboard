// Tes fungsi murni "Jadwal Saya" (tanpa DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysYmd, rangeProblem, scheduleRange, activeQuick, isSingleDay, scheduleQuery,
  groupByDay, rowAction, needsPolling, summaryParts, emptyTitle, isYmd, RANGE_ERROR,
} from '../public/js/myschedule.js';

const TODAY = '2026-11-05';

test('addDaysYmd melewati batas bulan dan tahun', () => {
  assert.equal(addDaysYmd('2026-11-30', 1), '2026-12-01');
  assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28');
});

test('isYmd menolak format dan tanggal tidak valid', () => {
  assert.equal(isYmd('2026-11-05'), true);
  assert.equal(isYmd('2026-13-45'), false);
  assert.equal(isYmd('5/11/2026'), false);
  assert.equal(isYmd(undefined), false);
});

test('scheduleRange: hari ini, besok, 7 hari ke depan, semua', () => {
  assert.deepEqual(scheduleRange('today', TODAY), { from: TODAY, to: TODAY, all: false });
  assert.deepEqual(scheduleRange('tomorrow', TODAY), { from: '2026-11-06', to: '2026-11-06', all: false });
  assert.deepEqual(scheduleRange('week', TODAY), { from: TODAY, to: '2026-11-11', all: false });
  assert.deepEqual(scheduleRange('all', TODAY), { from: '', to: '', all: true });
});

test('activeQuick mengenali tombol cepat dan rentang bebas', () => {
  for (const k of ['today', 'tomorrow', 'week', 'all']) assert.equal(activeQuick(scheduleRange(k, TODAY), TODAY), k);
  assert.equal(activeQuick({ from: '2026-11-01', to: '2026-11-03', all: false }, TODAY), '');
});

test('isSingleDay', () => {
  assert.equal(isSingleDay(scheduleRange('today', TODAY)), true);
  assert.equal(isSingleDay(scheduleRange('week', TODAY)), false);
  assert.equal(isSingleDay(scheduleRange('all', TODAY)), false);
});

test('scheduleQuery: all=1 untuk Semua, from/to untuk rentang', () => {
  assert.equal(scheduleQuery(scheduleRange('all', TODAY)), 'all=1');
  assert.equal(scheduleQuery(scheduleRange('week', TODAY)), 'from=2026-11-05&to=2026-11-11');
});

test('rangeProblem menolak rentang terbalik', () => {
  assert.equal(rangeProblem('2026-11-06', '2026-11-05'), RANGE_ERROR);
  assert.equal(rangeProblem('2026-11-05', '2026-11-05'), '');
  assert.equal(rangeProblem('', '2026-11-05'), '');
});

test('groupByDay mengelompokkan per tanggal dan menjaga urutan dalam kelompok', () => {
  const list = [
    { id: 1, day: '2026-11-06', start_time: '08:00' },
    { id: 2, day: '2026-11-05', start_time: '09:00' },
    { id: 3, day: '2026-11-05', start_time: '10:00' },
  ];
  const g = groupByDay(list);
  assert.deepEqual(g.map((x) => x.day), ['2026-11-05', '2026-11-06']);
  assert.deepEqual(g[0].items.map((x) => x.id), [2, 3]);
  assert.deepEqual(groupByDay(null), []);
});

test('rowAction mengikuti aturan klik', () => {
  assert.equal(rowAction({ status: 'baru', day: TODAY }, TODAY), 'start');
  assert.equal(rowAction({ status: 'berjalan', day: TODAY }, TODAY), 'start', 'jadwal lama tanpa fase tetap bisa diisi');
  assert.equal(rowAction({ status: 'berjalan', phase: 'timer', day: TODAY }, TODAY), 'wait');
  assert.equal(rowAction({ status: 'berjalan', phase: 'menunggu', day: TODAY }, TODAY), 'wait');
  assert.equal(rowAction({ status: 'berjalan', phase: 'soap', day: TODAY }, TODAY), 'start', 'sudah Mulai: wajib isi SOAP dulu');
  assert.equal(rowAction({ status: 'selesai', day: '2026-11-01' }, TODAY), 'detail');
  assert.equal(rowAction({ status: 'batal', day: TODAY }, TODAY), 'none');
  assert.equal(rowAction({ status: 'baru', day: '2026-11-01', overdue: true }, TODAY), 'overdue');
  assert.equal(rowAction({ status: 'berjalan', day: '2026-11-01' }, TODAY), 'overdue');
  assert.equal(rowAction({ status: 'baru', day: '2026-11-09' }, TODAY), 'future');
});

test('summaryParts: sisa = baru + berjalan', () => {
  assert.deepEqual(summaryParts({ total: 6, baru: 2, berjalan: 1, selesai: 2, batal: 1 }), { total: 6, selesai: 2, sisa: 3 });
  assert.deepEqual(summaryParts(undefined), { total: 0, selesai: 0, sisa: 0 });
});

test('emptyTitle', () => {
  assert.equal(emptyTitle(scheduleRange('all', TODAY)), 'Belum ada jadwal');
  assert.equal(emptyTitle(scheduleRange('today', TODAY)), 'Tidak ada jadwal pada tanggal ini');
});

test('needsPolling: hanya bila ada tugas yang statusnya berubah sendiri', () => {
  assert.equal(needsPolling([]), false);
  assert.equal(needsPolling(undefined), false);
  assert.equal(needsPolling([{ status: 'baru' }, { status: 'selesai' }, { status: 'berjalan', phase: 'soap' }, { status: 'berjalan', phase: null }]), false);
  assert.equal(needsPolling([{ status: 'baru' }, { status: 'berjalan', phase: 'timer' }]), true);
  assert.equal(needsPolling([{ status: 'berjalan', phase: 'menunggu' }]), true);
});
