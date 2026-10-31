import zlib from 'node:zlib';
import { HttpError } from './util.js';

// Pembaca tabel dari file upload (CSV atau XLSX) tanpa library.
// Hasil: array baris, tiap baris array string. Baris kosong total dibuang oleh pemanggil.

export const MAX_IMPORT_ROWS = 20000;

// ---------- CSV ----------
export function parseCsv(text) {
  let src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const firstLine = src.split(/\r\n|\n|\r/, 1)[0] || '';
  // Excel versi Indonesia menyimpan CSV dengan titik koma.
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [',', ';', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length > MAX_IMPORT_ROWS + 1) throw new HttpError(400, `File terlalu panjang (maksimal ${MAX_IMPORT_ROWS} baris)`);
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- XLSX ----------
const MAX_ENTRY = 64 * 1024 * 1024;

function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new HttpError(400, 'File Excel tidak valid');
  const total = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(400, 'File Excel tidak valid');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }));
    } catch {
      throw new HttpError(400, 'File Excel rusak atau terlalu besar');
    }
  }
  return files;
}

const decodeXml = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
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

export function parseXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => (files.has(name) ? files.get(name).toString('utf8') : null);

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
    if (rid) {
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (new RegExp(`\\bId="${rid}"`).test(m[0])) {
          const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
          if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        }
      }
    }
  }
  const sheet = get(sheetPath);
  if (!sheet) throw new HttpError(400, 'Lembar kerja pertama di file Excel tidak ditemukan');

  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const rows = [];
  let rowNo = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNo = Number(/\br="(\d+)"/.exec(rm[1])?.[1]) || rowNo + 1;
    if (rowNo > MAX_IMPORT_ROWS + 1) throw new HttpError(400, `File terlalu panjang (maksimal ${MAX_IMPORT_ROWS} baris)`);
    const row = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cm[2] || '';
      let value = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'str') value = decodeXml(v);
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = '';
          else value = numberText(v);
        }
      }
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = value;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = row;
  }
  return rows;
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