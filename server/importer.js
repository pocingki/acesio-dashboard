import zlib from 'node:zlib';
import path from 'node:path';
import { HttpError } from './util.js';

// Pembaca tabel dari file upload (CSV atau XLSX) tanpa library.
// Hasil: array baris, tiap baris array string. Baris kosong total dibuang oleh pemanggil.
//
// Prinsip keamanan: file datang dari luar, jadi SEMUA angka di dalamnya (offset ZIP, ukuran, nomor
// kolom, nomor baris) diperlakukan tidak tepercaya. Tidak ada loop yang putarannya ditentukan angka
// dari file tanpa batas, dan semua pemindaian teks berjalan linear (tanpa regex lazy berulang).

export const MAX_IMPORT_ROWS = 20000;
export const MAX_IMPORT_COLS = 16384; // XFD, batas kolom Excel
export const MAX_IMPORT_CELLS = 600000; // total sel (termasuk sel kosong pengisi) per file

const MAX_ZIP_ENTRIES = 200;
const MAX_INFLATED_TOTAL = 64 * 1024 * 1024; // jumlah semua entri yang dibuka, bukan per entri
const MAX_CELL_CHARS = 32767; // batas teks satu sel di Excel
const MAX_SHARED_STRINGS = 1000000;
const MAX_ROW_ELEMENTS = 1048576; // batas baris Excel; lebih dari ini pasti file cacat
const MAX_ENTITIES = 2000000; // total entitas XML yang didekode per file
const MAX_RAW_TEXT = 400000; // teks mentah per sel yang didekode (32767 karakter x entitas terpanjang)

const corrupt = () => new HttpError(400, 'File Excel rusak');
const tooLong = () => new HttpError(400, `File terlalu panjang (maksimal ${MAX_IMPORT_ROWS} baris)`);
const tooBig = () => new HttpError(400, `File terlalu besar (maksimal ${MAX_IMPORT_CELLS.toLocaleString('id-ID')} sel)`);
const tooWide = () => new HttpError(400, `File terlalu lebar (maksimal ${MAX_IMPORT_COLS} kolom)`);

// Excel versi lama/ekspor tertentu menyimpan sel yang diawali = + - @ dengan apostrof pelindung.
// Ekspor CSV kita menambahkan SATU apostrof; saat impor dibuang satu agar data kembali utuh.
const PROTECTED = /^'+[=+\-@\t\r]/;

// ---------- CSV ----------
function detectDelimiter(src) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  const limit = Math.min(src.length, 1 << 20);
  for (let i = 0; i < limit; i++) {
    const c = src[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (c === '\n' || c === '\r') break;
      if (c in counts) counts[c]++;
    }
  }
  return [',', ';', '\t'].sort((a, b) => counts[b] - counts[a])[0];
}

export function parseCsv(text) {
  let src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.includes('\u0000')) throw new HttpError(400, 'File CSV tidak valid (berisi data biner). Pastikan file berformat CSV, atau unggah sebagai .xlsx.');

  const delim = detectDelimiter(src);
  const stop = new RegExp(`[${delim === '\t' ? '\\t' : delim}\\n\\r]`, 'g');
  const n = src.length;
  const rows = [];
  let row = [];
  let cells = 0;

  const pushCell = (v) => {
    if (row.length >= MAX_IMPORT_COLS) throw tooWide();
    if (++cells > MAX_IMPORT_CELLS) throw tooBig();
    row.push(PROTECTED.test(v) ? v.slice(1) : v);
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) throw tooLong();
  };

  let i = 0;
  while (i < n) {
    let cell = '';
    let j = i;
    if (src.charCodeAt(i) === 34) { // sel diawali tanda kutip
      j = i + 1;
      for (;;) {
        const q = src.indexOf('"', j);
        if (q < 0) { cell += src.slice(j); j = n; break; }
        cell += src.slice(j, q);
        if (src.charCodeAt(q + 1) === 34) { cell += '"'; j = q + 2; } else { j = q + 1; break; }
      }
    }
    stop.lastIndex = j;
    const m = stop.exec(src);
    const at = m ? m.index : n;
    if (at > j) cell += src.slice(j, at);
    pushCell(cell);
    if (!m) break;
    if (src[at] === delim) {
      i = at + 1;
      if (i >= n) pushCell(''); // pemisah di ujung file = sel terakhir kosong
      continue;
    }
    i = at + (src[at] === '\r' && src[at + 1] === '\n' ? 2 : 1);
    pushRow();
  }
  if (row.length) pushRow();
  return rows;
}

// ---------- XLSX ----------
function unzip(buf) {
  const len = buf.length;
  const u16 = (o) => { if (o < 0 || o + 2 > len) throw corrupt(); return buf.readUInt16LE(o); };
  const u32 = (o) => { if (o < 0 || o + 4 > len) throw corrupt(); return buf.readUInt32LE(o); };

  let end = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw corrupt();
  const total = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (total === 0xffff || total > MAX_ZIP_ENTRIES) throw corrupt();
  if (cdOffset === 0xffffffff || cdOffset + cdSize > end) throw corrupt();

  const entries = new Map();
  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (u32(p) !== 0x02014b50) throw corrupt();
    const nameLen = u16(p + 28);
    if (p + 46 + nameLen > len) throw corrupt();
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      flags: u16(p + 8), method: u16(p + 10), compSize: u32(p + 20), size: u32(p + 24), local: u32(p + 42),
    });
    p += 46 + nameLen + u16(p + 30) + u16(p + 32);
  }

  let used = 0;
  return {
    has: (name) => entries.has(name),
    // Mengembalikan Buffer isi entri (atau null bila tidak ada). Anggaran inflate dipakai bersama semua entri.
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if ((e.flags & 1) || (e.method !== 0 && e.method !== 8)) throw corrupt();
      if (e.compSize === 0xffffffff || e.size === 0xffffffff || e.local === 0xffffffff) throw corrupt();
      const remaining = MAX_INFLATED_TOTAL - used;
      if (e.size > remaining) throw corrupt();
      if (u32(e.local) !== 0x04034b50) throw corrupt();
      const dataStart = e.local + 30 + u16(e.local + 26) + u16(e.local + 28);
      if (dataStart + e.compSize > len) throw corrupt();
      const raw = buf.subarray(dataStart, dataStart + e.compSize);
      let out;
      if (e.method === 0) {
        if (raw.length > remaining) throw corrupt();
        out = raw;
      } else {
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) }); } catch { throw corrupt(); }
      }
      used += out.length;
      return out;
    },
  };
}

// ----- pemindai XML linear -----
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const isNameEnd = (c) => c === 62 || c === 47 || isWs(c); // > / spasi

// Posisi '<nama' berikutnya (diikuti akhir nama tag), atau -1.
function findTag(xml, name, from) {
  const needle = `<${name}`;
  let i = from;
  for (;;) {
    i = xml.indexOf(needle, i);
    if (i < 0) return -1;
    if (isNameEnd(xml.charCodeAt(i + needle.length))) return i;
    i++;
  }
}

// Nilai atribut dari teks tag (tanpa regex dinamis, aman untuk nilai apa pun).
function attr(tag, name) {
  let i = 0;
  for (;;) {
    i = tag.indexOf(name, i);
    if (i < 0) return undefined;
    if (i === 0 || isWs(tag.charCodeAt(i - 1))) {
      let j = i + name.length;
      while (isWs(tag.charCodeAt(j))) j++;
      if (tag[j] === '=') {
        j++;
        while (isWs(tag.charCodeAt(j))) j++;
        const q = tag[j];
        if (q === '"' || q === "'") {
          const e = tag.indexOf(q, j + 1);
          return e < 0 ? undefined : tag.slice(j + 1, e);
        }
      }
    }
    i++;
  }
}

// Isi elemen pertama <nama>...</nama> di dalam xml (tanpa memandang atribut).
function innerOf(xml, name) {
  const i = findTag(xml, name, 0);
  if (i < 0) return undefined;
  const gt = xml.indexOf('>', i);
  if (gt < 0) return undefined;
  if (xml.charCodeAt(gt - 1) === 47) return '';
  const e = xml.indexOf(`</${name}>`, gt + 1);
  return xml.slice(gt + 1, e < 0 ? xml.length : e);
}

const codePointText = (cp) => (Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '');
const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// Dekoder entitas XML dengan anggaran jumlah entitas per file. Satu putaran, linear: "&amp;lt;" menjadi
// "&lt;" (bukan "<"), kode karakter tidak sah menjadi kosong, dan "&" tanpa pasangan dibiarkan apa adanya.
function makeDecoder() {
  let budget = MAX_ENTITIES;
  return (input) => {
    let s = String(input);
    let i = s.indexOf('&');
    if (i < 0) return s;
    if (s.length > MAX_RAW_TEXT) s = s.slice(0, MAX_RAW_TEXT);
    let out = '';
    let p = 0;
    let semi = -2; // -2 = belum dicari, -1 = tidak ada lagi
    i = s.indexOf('&');
    while (i >= 0) {
      if (semi !== -1 && semi < i) semi = s.indexOf(';', i + 1);
      if (semi === -1) break;
      const name = semi - i <= 10 ? s.slice(i + 1, semi) : '';
      let rep = null;
      if (name in NAMED && Object.hasOwn(NAMED, name)) rep = NAMED[name];
      else if (/^#[xX][0-9a-fA-F]{1,8}$/.test(name)) rep = codePointText(parseInt(name.slice(2), 16));
      else if (/^#\d{1,8}$/.test(name)) rep = codePointText(Number(name.slice(1)));
      if (rep === null) { i = s.indexOf('&', i + 1); continue; }
      if (--budget < 0) throw tooBig();
      out += s.slice(p, i) + rep;
      p = semi + 1;
      i = s.indexOf('&', p);
    }
    return out + s.slice(p);
  };
}

const capText = (s) => (s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s);

// Teks dari <si> atau <is>: semua <t>, kecuali <rPh> (furigana/phonetic).
function textOf(xml, decode) {
  if (xml.includes('<rPh')) {
    let out = '';
    let p = 0;
    for (;;) {
      const i = findTag(xml, 'rPh', p);
      if (i < 0) { out += xml.slice(p); break; }
      out += xml.slice(p, i);
      const e = xml.indexOf('</rPh>', i);
      if (e < 0) break;
      p = e + 6;
    }
    xml = out;
  }
  let text = '';
  let p = 0;
  while (text.length <= MAX_CELL_CHARS * 2) {
    const i = findTag(xml, 't', p);
    if (i < 0) break;
    const gt = xml.indexOf('>', i);
    if (gt < 0) break;
    if (xml.charCodeAt(gt - 1) === 47) { p = gt + 1; continue; }
    const e = xml.indexOf('</t>', gt + 1);
    text += xml.slice(gt + 1, Math.min(e < 0 ? xml.length : e, gt + 1 + MAX_RAW_TEXT));
    if (e < 0) break;
    p = e + 4;
  }
  return capText(decode(text));
}

// Indeks kolom (0 = A). Mengembalikan -1 bila ref tanpa huruf; melempar 400 bila melebihi XFD.
function colIndex(ref) {
  let n = 0;
  let k = 0;
  for (; k < ref.length; k++) {
    const c = ref.charCodeAt(k) & ~32;
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
    if (n > MAX_IMPORT_COLS) throw new HttpError(400, 'File Excel rusak (kolom melebihi XFD)');
  }
  return k === 0 ? -1 : n - 1;
}

// Angka besar di Excel kadang tersimpan sebagai 6.28E+12; kembalikan ke deretan digit.
function numberText(v) {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && Math.abs(n) < 1e21) return BigInt(Math.round(n)).toString();
  }
  return s;
}

function firstSheetPath(zip) {
  const fallback = 'xl/worksheets/sheet1.xml';
  const wbBuf = zip.read('xl/workbook.xml');
  const relBuf = zip.read('xl/_rels/workbook.xml.rels');
  if (!wbBuf || !relBuf) return fallback;
  const wb = wbBuf.toString('utf8');
  const rels = relBuf.toString('utf8');
  const i = findTag(wb, 'sheet', 0); // sheet pertama menurut urutan workbook
  if (i < 0) return fallback;
  const gt = wb.indexOf('>', i);
  const tag = wb.slice(i, gt < 0 ? wb.length : gt);
  const rid = attr(tag, 'r:id') ?? /\s\w+:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
  if (!rid) return fallback;
  let p = 0;
  for (;;) {
    const j = findTag(rels, 'Relationship', p);
    if (j < 0) break;
    const g = rels.indexOf('>', j);
    if (g < 0) break;
    const t = rels.slice(j, g);
    p = g + 1;
    if (attr(t, 'Id') === rid) {
      const target = attr(t, 'Target');
      if (target) return target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${makeDecoder()(target)}`);
    }
  }
  return fallback;
}

// Tabel string bersama; teks baru didekode saat dipakai (dan di-cache), bukan sekaligus.
function sharedStrings(xml, decode) {
  const starts = [];
  const cache = new Map();
  if (xml) {
    let p = 0;
    for (;;) {
      const i = findTag(xml, 'si', p);
      if (i < 0) break;
      if (starts.length >= MAX_SHARED_STRINGS) throw new HttpError(400, 'File Excel terlalu besar (terlalu banyak teks)');
      starts.push(i);
      p = i + 3;
    }
  }
  return (k) => {
    if (cache.has(k)) return cache.get(k);
    let text = '';
    const i = starts[k];
    if (i !== undefined) {
      const gt = xml.indexOf('>', i);
      // Wilayah dibatasi sampai <si> berikutnya agar pemindaian tetap linear pada file cacat.
      if (gt >= 0 && xml.charCodeAt(gt - 1) !== 47) text = textOf(xml.slice(gt + 1, starts[k + 1] ?? xml.length), decode);
    }
    cache.set(k, text);
    return text;
  };
}

function parseXlsxInner(buf) {
  const zip = unzip(buf);
  const sheetBuf = zip.read(firstSheetPath(zip));
  if (!sheetBuf) throw new HttpError(400, 'Lembar kerja pertama di file Excel tidak ditemukan');
  const sstBuf = zip.read('xl/sharedStrings.xml');
  const decode = makeDecoder();
  const shared = sharedStrings(sstBuf ? sstBuf.toString('utf8') : null, decode);
  const sheet = sheetBuf.toString('utf8');

  const rows = [];
  let budget = MAX_IMPORT_CELLS;
  let rowNo = 0;
  let pos = 0;
  let rowElements = 0;
  for (;;) {
    const i = findTag(sheet, 'row', pos);
    if (i < 0) break;
    if (++rowElements > MAX_ROW_ELEMENTS) throw corrupt();
    const gt = sheet.indexOf('>', i);
    if (gt < 0) throw corrupt();
    const rowTag = sheet.slice(i + 4, gt);
    let body = '';
    if (sheet.charCodeAt(gt - 1) === 47) pos = gt + 1;
    else {
      const close = sheet.indexOf('</row>', gt + 1);
      if (close < 0) throw corrupt();
      body = sheet.slice(gt + 1, close);
      pos = close + 6;
    }
    const rAttr = attr(rowTag, 'r');
    rowNo = rAttr !== undefined && /^\d{1,9}$/.test(rAttr) && Number(rAttr) > 0 ? Number(rAttr) : rowNo + 1;

    const row = [];
    let cp = 0;
    for (;;) {
      const ci = findTag(body, 'c', cp);
      if (ci < 0) break;
      const cgt = body.indexOf('>', ci);
      if (cgt < 0) throw corrupt();
      const cTag = body.slice(ci + 2, cgt);
      let inner = '';
      if (body.charCodeAt(cgt - 1) === 47) cp = cgt + 1;
      else {
        const cend = body.indexOf('</c>', cgt + 1);
        if (cend < 0) throw corrupt();
        inner = body.slice(cgt + 1, cend);
        cp = cend + 4;
      }
      if (--budget < 0) throw tooBig();

      const type = attr(cTag, 't');
      let value = '';
      if (inner) {
        if (type === 'inlineStr') value = textOf(inner, decode);
        else {
          let v = innerOf(inner, 'v');
          if (v !== undefined) {
            if (v.length > MAX_RAW_TEXT) v = v.slice(0, MAX_RAW_TEXT);
            if (type === 's') value = shared(Number(v));
            else if (type === 'str' || type === 'd') value = capText(decode(v));
            else if (type === 'b') value = v.trim() === '1' ? 'TRUE' : 'FALSE';
            else if (type === 'e') value = '';
            else value = numberText(v);
          }
        }
      }

      const ref = attr(cTag, 'r');
      const idx = ref ? colIndex(ref) : -1;
      const at = idx >= 0 ? idx : row.length;
      const pad = at - row.length;
      if (pad > 0) {
        budget -= pad;
        if (budget < 0) throw tooBig();
        for (let k = 0; k < pad; k++) row.push('');
      }
      row[at] = value;
    }

    if (rowNo > MAX_IMPORT_ROWS + 1) {
      // Baris kosong di luar batas (sisa format) diabaikan; baris berisi data = file terlalu panjang.
      if (row.some((c) => c !== '')) throw tooLong();
      continue;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = row;
  }
  return rows;
}

export function parseXlsx(buf) {
  try {
    return parseXlsxInner(buf);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw corrupt(); // jaring pengaman: file cacat tidak boleh menjadi 500
  }
}

// Titik masuk: format 'csv' (content = teks) atau 'xlsx' (content = base64).
export function readTable(format, content) {
  if (typeof content !== 'string' || !content) throw new HttpError(400, 'File kosong');
  if (format === 'xlsx') {
    const buf = Buffer.from(content, 'base64');
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50) throw new HttpError(400, 'File bukan Excel (.xlsx) yang valid. File .xls lama: simpan ulang sebagai .xlsx atau CSV.');
    return parseXlsx(buf);
  }
  if (format === 'csv') return parseCsv(content);
  throw new HttpError(400, 'Format file harus CSV atau Excel (.xlsx)');
}