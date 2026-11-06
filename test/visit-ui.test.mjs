import { test } from 'node:test';
import assert from 'node:assert/strict';
const {
  validateSoapClient, soapPartError, soapDraftKey, cleanSoap, visitBlockReason, tidySoapText, SOAP_MAX,
} = await import('../public/js/visit.js');

const ok = (n) => 'x'.repeat(n);
const full = (n = 3) => ({ s: ok(n), o: ok(n), a: ok(n), p: ok(n) });

test('SOAP kosong: keempat bagian wajib, bagian pertama yang salah adalah S', () => {
  const v = validateSoapClient({});
  assert.equal(v.ok, false);
  assert.equal(v.first, 's');
  for (const k of ['s', 'o', 'a', 'p']) assert.match(v.errors[k], /wajib diisi/);
  assert.equal(validateSoapClient(null).ok, false);
  assert.equal(validateSoapClient(undefined).first, 's');
});

test('SOAP 2 karakter ditolak, 3 karakter diterima', () => {
  assert.match(validateSoapClient(full(2)).errors.s, /minimal 3 karakter/);
  assert.equal(validateSoapClient(full(3)).ok, true);
  assert.equal(validateSoapClient(full(3)).first, '');
  // spasi di ujung tidak dihitung (dirapikan lebih dulu)
  assert.equal(validateSoapClient({ ...full(3), s: '  ab  ' }).ok, false);
  assert.equal(validateSoapClient({ ...full(3), s: '   ' }).errors.s, 'Subjective wajib diisi.');
});

test('SOAP 2000 karakter diterima, 2001 karakter ditolak', () => {
  assert.equal(SOAP_MAX, 2000);
  assert.equal(validateSoapClient(full(2000)).ok, true);
  const v = validateSoapClient({ ...full(3), a: ok(2001) });
  assert.equal(v.ok, false);
  assert.equal(v.first, 'a');
  assert.match(v.errors.a, /maksimal 2000 karakter/);
  assert.equal(v.errors.s, '');
});

test('satu bagian salah menunjuk bagian itu; urutan S, O, A, P menentukan first', () => {
  assert.equal(validateSoapClient({ ...full(), p: '' }).first, 'p');
  assert.equal(validateSoapClient({ ...full(), o: 'ab', p: '' }).first, 'o');
});

test('nama bagian yang salah tidak dianggap sebagai isian', () => {
  const v = validateSoapClient({ subjective: 'keluhan nyeri', objective: 'ROM terbatas', assessment: 'baik', planning: 'terapi' });
  assert.equal(v.ok, false);
  assert.equal(v.first, 's');
  assert.match(soapPartError('x', 'abc'), /tidak dikenal/);
  assert.match(soapPartError('subjective', 'abc'), /tidak dikenal/);
  assert.equal(soapPartError('s', 'abc'), '');
});

test('cleanSoap hanya membawa empat bagian yang dirapikan', () => {
  const c = cleanSoap({ s: '  a\r\nb  ', o: 'oo', a: 'aa', p: 'pp', service_ids: [1], extra: 'x' });
  assert.deepEqual(Object.keys(c), ['s', 'o', 'a', 'p']);
  assert.equal(c.s, 'a\nb');
  assert.equal(tidySoapText(null), '');
});

test('soapDraftKey: hanya id jadwal yang sah', () => {
  assert.equal(soapDraftKey(7), '7');
  assert.equal(soapDraftKey('12'), '12');
  for (const bad of [undefined, null, '', 0, -1, 1.5, 'abc', NaN]) assert.equal(soapDraftKey(bad), '');
});

test('jadwal yang tidak bisa diisi: tidak ada, batal, lampau, mendatang; selesai tampil baca-saja', () => {
  const today = '2026-11-05';
  assert.match(visitBlockReason(null, today), /tidak ditemukan/);
  assert.match(visitBlockReason({ status: 'batal', day: today }, today), /dibatalkan/);
  assert.match(visitBlockReason({ status: 'baru', day: '2026-11-04' }, today), /terlewat/);
  assert.match(visitBlockReason({ status: 'berjalan', day: '2026-11-06' }, today), /bukan untuk hari ini/);
  assert.match(visitBlockReason({ status: 'baru', day: today }, today), /Mulai/);
  assert.match(visitBlockReason({ status: 'berjalan', phase: 'timer', day: today }, today), /hitung mundur sedang berjalan/);
  assert.match(visitBlockReason({ status: 'berjalan', phase: 'menunggu', day: today }, today), /Menunggu approve/);
  assert.equal(visitBlockReason({ status: 'berjalan', phase: 'soap', day: today }, today), null, 'Mulai lalu isi SOAP dulu');
  assert.equal(visitBlockReason({ status: 'berjalan', phase: null, day: today }, today), null, 'jadwal lama tanpa alur baru tetap bisa diisi');
  assert.equal(visitBlockReason({ status: 'selesai', day: '2026-11-01' }, today), null);
});
