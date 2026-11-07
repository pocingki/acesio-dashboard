import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashForPage, pageFromHash } from '../public/js/page.js';

const staff = new Set(['report', 'customers', 'schedule', 'services', 'accounts', 'audit']);
const therapist = new Set(['home', 'schedule', 'history', 'input']);

test('tanpa hash: kembali ke halaman awal akun itu', () => {
  assert.deepEqual(pageFromHash('', staff, 'report'), { id: 'report', params: {} });
  assert.deepEqual(pageFromHash('#', therapist, 'home'), { id: 'home', params: {} });
});

test('hash halaman yang boleh dibuka dipertahankan, termasuk parameter singkat', () => {
  assert.deepEqual(pageFromHash('#customers', staff, 'report'), { id: 'customers', params: {} });
  assert.deepEqual(pageFromHash('#schedule?day=2026-11-07&status=menunggu', staff, 'report'), {
    id: 'schedule', params: { day: '2026-11-07', status: 'menunggu' },
  });
  assert.deepEqual(pageFromHash('#input?scheduleId=12', therapist, 'home'), {
    id: 'input', params: { scheduleId: '12' },
  });
});

test('halaman akun lain atau parameter asing tidak ikut', () => {
  assert.deepEqual(pageFromHash('#accounts', therapist, 'home'), { id: 'home', params: {} });
  assert.deepEqual(pageFromHash('#schedule?day=2026-11-07&token=rahasia', staff, 'report'), {
    id: 'schedule', params: { day: '2026-11-07' },
  });
});

test('hash yang ditulis sama dengan yang dibaca kembali', () => {
  const hash = hashForPage('schedule', { day: '2026-11-07', status: 'menunggu', note: 'abaikan' });
  assert.equal(hash, 'schedule?day=2026-11-07&status=menunggu');
  assert.deepEqual(pageFromHash(`#${hash}`, staff, 'report').params, { day: '2026-11-07', status: 'menunggu' });
});
