import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.js membuka database saat diimpor, jadi arahkan ke folder sementara sebelum impor dinamis.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acesio-impexp-'));
const { parseCsv, parseXlsx, readTable, MAX_IMPORT_ROWS } = await import('../server/importer.js');
const { toCsv, toXlsx } = await import('../server/exporter.js');
const { HttpError } = await import('../server/util.js');
const { importCustomers, parseBirthDate, CUSTOMER_HEADERS, customerExportRow } = await import('../server/customers.js');
const { db } = await import('../server/db.js');

const is400 = (e) => e instanceof HttpError && e.status === 400;
const timed = (fn) => { const t = process.hrtime.bigint(); let err; let res; try { res = fn(); } catch (e) { err = e; } return { ms: Number(process.hrtime.bigint() - t) / 1e6, err, res }; };

// ---------- pembuat ZIP kecil untuk fixture ----------
function buildZip(entries, { method = 8 } = {}) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name); const data = Buffer.from(content);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(method, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nameBuf.length, 26);
    parts.push(l, nameBuf, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
// Workbook berisi dua sheet; `order` menentukan sheet mana yang tercantum pertama.
function workbookParts(order = [1, 2]) {
  return [
    ['xl/workbook.xml', `${XML}<workbook ${NS}><sheets>${order.map((n, i) => `<sheet name="S${n}" sheetId="${n}" r:id="rId${n}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships ${REL_NS}>${[1, 2].map((n) => `<Relationship Id="rId${n}" Type="${RT}" Target="worksheets/sheet${n}.xml"/>`).join('')}</Relationships>`],
  ];
}
const sheetWith = (rows) => `${XML}<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;
const strCell = (ref, t) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const evilXlsx = (rows, extra = []) => buildZip([...workbookParts([1]), ['xl/worksheets/sheet1.xml', sheetWith(rows)], ...extra]);

// ---------- XLSX berbahaya ----------
test('sel dengan ref ZZZZZZ1 -> 400 cepat (bukan 500 setelah menghitung)', () => {
  const buf = evilXlsx('<row r="1"><c r="ZZZZZZ1"><v>1</v></c></row>');
  const { ms, err } = timed(() => parseXlsx(buf));
  assert.ok(is400(err), `harus HttpError 400, dapat: ${err && err.constructor.name} ${err && err.message}`);
  assert.ok(ms < 200, `terlalu lambat: ${ms} ms`);
});

test('kolom XFD masih boleh, satu setelahnya (XFE) ditolak', () => {
  assert.deepEqual(parseXlsx(evilXlsx(`<row r="1">${strCell('XFD1', 'x')}</row>`))[0].length, 16384);
  assert.ok(is400(timed(() => parseXlsx(evilXlsx(`<row r="1">${strCell('XFE1', 'x')}</row>`))).err));
});

test('lompatan baris kosong tidak mengisi array jutaan elemen', () => {
  const ok = timed(() => parseXlsx(evilXlsx(`<row r="1">${strCell('A1', 'a')}</row><row r="1048576"/>`)));
  assert.ok(!ok.err && ok.res.length === 1 && ok.ms < 200);
  const bad = timed(() => parseXlsx(evilXlsx(`<row r="1048576">${strCell('A1048576', 'a')}</row>`)));
  assert.ok(is400(bad.err) && bad.ms < 200);
});

test('banyak sel di kolom jauh tidak meledakkan memori (anggaran sel)', () => {
  let rows = '';
  for (let r = 1; r <= 3000; r++) rows += `<row r="${r}">${strCell(`XFD${r}`, 'x')}</row>`;
  const { ms, err } = timed(() => parseXlsx(evilXlsx(rows)));
  assert.ok(is400(err) && ms < 500, `${err && err.message} ${ms}`);
});

test('tag <row> tanpa penutup berulang -> 400 cepat (tidak kuadratik)', () => {
  const buf = evilXlsx('<row r="1">'.repeat(20000));
  const { ms, err } = timed(() => parseXlsx(buf));
  assert.ok(is400(err) && ms < 200, `${err && err.message} ${ms}`);
});

test('offset ZIP rusak -> 400, bukan RangeError', () => {
  const good = toXlsx([{ name: 'Data', headers: ['No', 'Nama'], rows: [[1, 'Andi']] }]);
  const endAt = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  // Posisi entri central directory milik berkas tertentu (entri yang benar-benar dibaca parser).
  const cdEntry = (name) => {
    let p = good.readUInt32LE(endAt + 16);
    for (let k = 0; k < good.readUInt16LE(endAt + 10); k++) {
      const nl = good.readUInt16LE(p + 28);
      if (good.toString('utf8', p + 46, p + 46 + nl) === name) return p;
      p += 46 + nl + good.readUInt16LE(p + 30) + good.readUInt16LE(p + 32);
    }
    throw new Error(`entri ${name} tidak ada`);
  };
  const cdAt = cdEntry('xl/worksheets/sheet1.xml');
  const mutate = (fn) => { const b = Buffer.from(good); fn(b); return b; };
  const cases = {
    'offset central directory raksasa': mutate((b) => b.writeUInt32LE(0xfffffff0, endAt + 16)),
    'offset local header raksasa': mutate((b) => b.writeUInt32LE(0xfffffff0, cdAt + 42)),
    'ukuran terkompresi raksasa': mutate((b) => b.writeUInt32LE(0x7ffffff0, cdAt + 20)),
    'panjang nama raksasa': mutate((b) => b.writeUInt16LE(60000, cdAt + 28)),
    'jumlah entri tidak cocok': mutate((b) => b.writeUInt16LE(150, endAt + 10)),
    'terpotong di tengah': good.subarray(0, Math.floor(good.length / 2)),
    'hanya header PK': Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]),
  };
  for (const [label, buf] of Object.entries(cases)) {
    const { err } = timed(() => parseXlsx(buf));
    assert.ok(is400(err), `${label}: harus 400, dapat ${err && err.constructor.name}: ${err && err.message}`);
  }
});

test('lebih dari 200 entri ZIP -> 400', () => {
  const entries = [...workbookParts([1]), ['xl/worksheets/sheet1.xml', sheetWith('')]];
  for (let i = 0; i < 210; i++) entries.push([`junk/${i}.txt`, 'x']);
  assert.ok(is400(timed(() => parseXlsx(buildZip(entries))).err));
});

test('bom ZIP: satu entri raksasa, dan jumlah beberapa entri -> 400', () => {
  const MB = 1024 * 1024;
  const one = buildZip([...workbookParts([1]), ['xl/worksheets/sheet1.xml', Buffer.alloc(70 * MB, 0x20)]]);
  assert.ok(one.length < MB, 'fixture harus kecil setelah kompresi');
  assert.ok(is400(timed(() => parseXlsx(one)).err), 'satu entri 70 MB');
  // Masing-masing 40 MB (di bawah 64 MB) tetapi jumlahnya 80 MB.
  const sum = buildZip([...workbookParts([1]), ['xl/worksheets/sheet1.xml', Buffer.alloc(40 * MB, 0x20)], ['xl/sharedStrings.xml', Buffer.alloc(40 * MB, 0x20)]]);
  const { err, ms } = timed(() => parseXlsx(sum));
  assert.ok(is400(err), `jumlah entri harus 400, dapat ${err && err.message}`);
  assert.ok(ms < 500, `bom terlalu lambat ditolak: ${ms} ms`);
});

test('entitas karakter tidak sah dan r:id aneh tidak menjadi 500', () => {
  const rows = `<row r="1">${strCell('A1', 'a&#x110000;b&#99999999;c&#xD800;d&amp;lt;')}</row>`;
  assert.deepEqual(parseXlsx(evilXlsx(rows)), [['abcd&lt;']]);
  const wb = buildZip([
    ['xl/workbook.xml', `${XML}<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="(("/></sheets></workbook>`],
    workbookParts()[1],
    ['xl/worksheets/sheet1.xml', sheetWith(`<row r="1">${strCell('A1', 'ok')}</row>`)],
  ]);
  const { err, res } = timed(() => parseXlsx(wb));
  assert.ok(err ? is400(err) : Array.isArray(res), 'tidak boleh melempar selain 400');
});

// ---------- perilaku XLSX ----------
test('hanya sheet pertama menurut urutan workbook yang dibaca', () => {
  const s1 = sheetWith(`<row r="1">${strCell('A1', 'dari-sheet1')}</row>`);
  const s2 = sheetWith(`<row r="1">${strCell('A1', 'dari-sheet2')}</row>`);
  const files = (order) => buildZip([...workbookParts(order), ['xl/worksheets/sheet1.xml', s1], ['xl/worksheets/sheet2.xml', s2]]);
  assert.deepEqual(parseXlsx(files([1, 2])), [['dari-sheet1']]);
  assert.deepEqual(parseXlsx(files([2, 1])), [['dari-sheet2']]); // sheet2.xml tercantum pertama
});

test('ekspor XLSX dengan dua sheet: sheet kedua tidak ikut terbaca', () => {
  const buf = toXlsx([
    { name: 'Pertama', headers: ['No RM', 'Nama'], rows: [['RM1', 'Andi']] },
    { name: 'Kedua', headers: ['No RM', 'Nama'], rows: [['RM2', 'Budi']] },
  ]);
  assert.deepEqual(parseXlsx(buf), [['No RM', 'Nama'], ['RM1', 'Andi']]);
});

test('teks furigana <rPh> di sharedStrings diabaikan', () => {
  const sst = `${XML}<sst ${NS}><si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh><phoneticPr fontId="1"/></si><si><r><t>Bu </t></r><r><t>Ani</t></r></si><si/></sst>`;
  const rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>';
  assert.deepEqual(parseXlsx(evilXlsx(rows, [['xl/sharedStrings.xml', sst]])), [['漢字', 'Bu Ani', '']]);
});

test('ekspor lalu impor XLSX tidak mengubah data (termasuk awalan - + = @)', () => {
  const headers = ['No', 'Nama', 'Catatan'];
  const rows = [[1, '-Andi Lestari', 'a'], [2, '+Budi', 'b'], [3, '=Cici', 'c'], [4, '@Dodi', 'd'], [5, "'-Eka", 'e'], [6, 'Fani, "S"\nbaris2', 'f']];
  const back = parseXlsx(toXlsx([{ name: 'Data', headers, rows, intCols: [0] }]));
  assert.deepEqual(back, [headers, ...rows.map((r) => r.map(String))]);
});

test('baris besar (20000 x 11) terbaca dalam waktu wajar', () => {
  const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [i + 1, `RM-${i}`, 'Ya', `Nama ${i}`, 'Laki-laki', '05/03/1990', '6281234567890', 'Guru', 'Depok', 'Januari', 'IG']);
  const buf = toXlsx([{ name: 'Data', headers: CUSTOMER_HEADERS, rows, intCols: [0] }]);
  const { err, res, ms } = timed(() => parseXlsx(buf));
  assert.ok(!err, err && err.message);
  assert.equal(res.length, MAX_IMPORT_ROWS + 1);
  assert.ok(ms < 1500, `terlalu lambat: ${ms} ms`);
});

// ---------- CSV ----------
test('delimiter koma, titik koma, dan tab terdeteksi', () => {
  const expected = [['No RM', 'Nama'], ['RM1', 'Andi, S.'], ['RM2', 'Budi']];
  assert.deepEqual(parseCsv('No RM,Nama\r\nRM1,"Andi, S."\r\nRM2,Budi\r\n'), expected);
  assert.deepEqual(parseCsv('No RM;Nama\r\nRM1;"Andi, S."\r\nRM2;Budi\r\n'), expected);
  assert.deepEqual(parseCsv('No RM\tNama\nRM1\tAndi, S.\nRM2\tBudi'), expected);
});

test('BOM UTF-8 dibuang dari sel judul pertama', () => {
  assert.deepEqual(parseCsv('\ufeffNo RM,Nama\n1,Ani\n')[0], ['No RM', 'Nama']);
});

test('ekspor lalu impor CSV tidak mengubah data, termasuk awalan - + = @ dan apostrof', () => {
  const headers = ['No', 'Nama', 'Catatan'];
  const rows = [
    [1, '-Andi Lestari', 'x'], [2, '+Budi', 'x'], [3, '=Cici', 'x'], [4, '@Dodi', 'x'],
    [5, "'-Eka", 'x'], [6, "''=Gita", 'x'], [7, "'Hani", 'x'], [8, '\tTab', 'x'],
    [9, 'Fani, "S"\nbaris2', ',;'], [10, '', ''],
  ];
  const csv = toCsv(headers, rows);
  assert.ok(csv.includes("'-Andi Lestari"), 'ekspor tetap memberi apostrof pelindung');
  assert.deepEqual(parseCsv(csv), [headers, ...rows.map((r) => r.map(String))]);
});

test('CSV biner (byte null) -> 400', () => {
  assert.ok(is400(timed(() => parseCsv('No RM,Nama\n1,A\u0000B\n')).err));
  assert.ok(is400(timed(() => readTable('csv', 'PK\u0003\u0004\u0000\u0000')).err));
});

test('CSV lebih dari MAX_IMPORT_ROWS baris -> 400', () => {
  const header = 'No RM,Nama\n';
  const atLimit = header + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `RM${i},A${i}`).join('\n') + '\n';
  assert.equal(parseCsv(atLimit).length, MAX_IMPORT_ROWS + 1);
  const { err } = timed(() => parseCsv(atLimit + 'RMX,Extra\n'));
  assert.ok(is400(err) && /baris/.test(err.message), err && err.message);
});

test('CSV terlalu lebar atau terlalu banyak sel -> 400 cepat', () => {
  const wide = timed(() => parseCsv(','.repeat(20000)));
  assert.ok(is400(wide.err) && wide.ms < 200);
  const many = timed(() => parseCsv(('a,'.repeat(5000) + '\n').repeat(200)));
  assert.ok(is400(many.err) && many.ms < 500, `${many.err && many.err.message} ${many.ms}`);
});

test('CSV 20 MB diproses di bawah 500 ms atau ditolak cepat', () => {
  const line = 'RM-0001,Ahmad Fauzi,Ya,Laki-laki,05/03/1990,6281234567890\n'; // ~58 byte
  const big = 'No RM,Nama\n' + line.repeat(Math.floor((20 * 1024 * 1024) / line.length));
  const { err, ms } = timed(() => parseCsv(big));
  assert.ok(!err || is400(err));
  assert.ok(ms < 500, `terlalu lambat: ${ms} ms`);
});

// ---------- tanggal & judul ----------
test('tanggal serial Excel 4 dan 5 digit', () => {
  assert.equal(parseBirthDate('45000'), '2023-03-15');
  assert.equal(parseBirthDate('45000.75'), '2023-03-15');
  assert.equal(parseBirthDate('9999'), '1927-05-17');
  assert.equal(parseBirthDate('2500'), '1906-11-04');
  assert.equal(parseBirthDate('1990'), null, 'tahun saja bukan tanggal');
  assert.equal(parseBirthDate('31/12/1990'), '1990-12-31');
});

// ---------- impor ke database ----------
const names = () => db.prepare('SELECT rm_no, name FROM customers ORDER BY rm_no').all().map((r) => `${r.rm_no}|${r.name}`);

test('impor mencari baris judul dalam 10 baris pertama dan menghitung nomor baris asli', () => {
  const csv = 'LAPORAN CUSTOMER\n\nDibuat: Oktober 2026\nNo,No RM,Nama,Tgl Lahir\n1,H-1,Ani Wulandari,05/03/1990\n\n2,H-2,Budi,bukan-tanggal\n';
  const r = importCustomers('csv', csv);
  assert.equal(r.added, 2);
  assert.deepEqual(r.issues.map((i) => i.line), [7], 'peringatan memakai nomor baris asli di file');
  // Judul di baris ke-11 tidak dicari.
  const late = `${Array.from({ length: 10 }, (_, i) => `catatan ${i}`).join('\n')}\nNo RM,Nama\nH-9,Zed\n`;
  assert.throws(() => importCustomers('csv', late), is400);
});

test('ekspor lalu impor ulang customer tidak mengubah data (CSV dan XLSX)', () => {
  const people = ['-Andi Lestari', '+Budi Santoso', '=Cici Amelia', '@Dodi Pratama', "'-Eka Putri"];
  const rows = people.map((n, i) => [i + 1, `RT-${i + 1}`, 'Ya', n, 'Laki-laki', '05/03/1990', '081234567890', 'Guru', 'Depok', 'Januari', 'IG']);
  const first = importCustomers('csv', toCsv(CUSTOMER_HEADERS, rows));
  assert.equal(first.added, 5);
  const before = names().filter((s) => s.startsWith('RT-'));
  assert.deepEqual(before, people.map((n, i) => `RT-${i + 1}|${n}`));

  const stored = db.prepare("SELECT * FROM customers WHERE rm_no LIKE 'RT-%' ORDER BY rm_no").all();
  const exported = stored.map((c, i) => customerExportRow(c, i + 1));
  const again = importCustomers('csv', toCsv(CUSTOMER_HEADERS, exported));
  assert.deepEqual([again.added, again.updated], [0, 5]);
  const viaXlsx = importCustomers('xlsx', toXlsx([{ name: 'Data', headers: CUSTOMER_HEADERS, rows: exported, intCols: [0] }]).toString('base64'));
  assert.deepEqual([viaXlsx.added, viaXlsx.updated], [0, 5]);
  assert.deepEqual(names().filter((s) => s.startsWith('RT-')), before);
});

test('importCustomers dengan file jahat -> 400 dari awal sampai akhir', () => {
  const evil = evilXlsx('<row r="1"><c r="ZZZZZZ1"><v>1</v></c></row>').toString('base64');
  const { err, ms } = timed(() => importCustomers('xlsx', evil));
  assert.ok(is400(err) && ms < 200);
  assert.ok(is400(timed(() => importCustomers('xlsx', Buffer.from('PK\u0003\u0004 bukan zip sungguhan, hanya awalan saja').toString('base64'))).err));
});