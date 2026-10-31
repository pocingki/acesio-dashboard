import { db, tx } from './db.js';
import { HttpError, normalizePhone, cleanName } from './util.js';
import { readTable } from './importer.js';

// Urutan kolom baku (impor, ekspor, dan tabel Customer): No | No RM | Reimburse | Nama | Jenis Kelamin | Tgl Lahir | No WA | Pekerjaan | Domisili | Bulan | Referensi
export const CUSTOMER_HEADERS = ['No', 'No RM', 'Reimburse', 'Nama', 'Jenis Kelamin', 'Tgl Lahir', 'No WA', 'Pekerjaan', 'Domisili', 'Bulan', 'Referensi'];
export const GENDER_LABEL = { L: 'Laki-laki', P: 'Perempuan', '': '' };

const nowIso = () => new Date().toISOString();
const squash = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// "2026-03-05" -> "05/03/2026" (tanpa zona waktu, hanya potong string)
export const displayDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};

const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, pebruari: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, agustus: 8, agu: 8, agt: 8, ags: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, oct: 10,
  november: 11, nov: 11, nopember: 11, desember: 12, des: 12, dec: 12,
};

function validYmd(y, m, d) {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Menerima 2026-03-05, 05/03/2026, 5-3-1990, 5.3.90, "5 Maret 1990", atau nomor seri tanggal Excel.
export function parseBirthDate(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    let y = +m[3];
    if (m[3].length === 2) y += y > new Date().getFullYear() % 100 ? 1900 : 2000;
    return validYmd(y, +m[2], +m[1]);
  }
  if ((m = /^(\d{1,2})\s+([a-zA-Z]+)\.?\s+(\d{4})$/.exec(s)) && MONTHS[m[2].toLowerCase()]) return validYmd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 1 && serial < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
  }
  return null;
}

export function parseGender(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (!s) return '';
  if (['l', 'lk', 'laki', 'lakilaki', 'laki-laki', 'pria', 'male', 'm'].includes(s)) return 'L';
  if (['p', 'pr', 'perempuan', 'wanita', 'female', 'f'].includes(s)) return 'P';
  return null;
}

// Satu pintu pembersihan untuk impor file dan form manual.
// Mengembalikan { value, warnings } atau melempar HttpError bila No RM / nama tidak ada.
export function cleanCustomer(raw) {
  const warnings = [];
  const rm = squash(raw.rm_no, 40);
  const name = cleanName(raw.name);
  if (!rm) throw new HttpError(400, 'No RM wajib diisi');
  if (!name) throw new HttpError(400, 'Nama minimal 2 huruf');

  const gender = parseGender(raw.gender);
  if (gender === null) warnings.push(`Jenis Kelamin “${squash(raw.gender, 20)}” tidak dikenali (pakai L/P atau Laki-laki/Perempuan)`);
  const birth = parseBirthDate(raw.birth_date);
  if (birth === null) warnings.push(`Tgl Lahir “${squash(raw.birth_date, 20)}” tidak dikenali (pakai format 31/12/1990)`);
  const phoneRaw = String(raw.phone ?? '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  if (phoneRaw && !phone) warnings.push(`No WA “${squash(phoneRaw, 20)}” tidak valid`);

  return {
    value: {
      rm_no: rm,
      reimburse: squash(raw.reimburse, 60),
      name,
      gender: gender || '',
      birth_date: birth || '',
      phone: phone || '',
      occupation: squash(raw.occupation, 100),
      domicile: squash(raw.domicile, 150),
      month: squash(raw.month, 40),
      reference: squash(raw.reference, 150),
    },
    warnings,
  };
}

const FIELDS = ['rm_no', 'reimburse', 'name', 'gender', 'birth_date', 'phone', 'occupation', 'domicile', 'month', 'reference'];

export function insertCustomer(v, origin) {
  const info = db.prepare(`INSERT INTO customers (${FIELDS.join(', ')}, origin, created_at, updated_at)
    VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`).run(...FIELDS.map((f) => v[f]), origin, nowIso(), nowIso());
  return Number(info.lastInsertRowid);
}

export function updateCustomer(id, v) {
  db.prepare(`UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...FIELDS.map((f) => v[f]), nowIso(), id);
}

export const findByRm = (rm) => db.prepare('SELECT id FROM customers WHERE rm_no = ?').get(rm);

// ---------- impor ----------
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES = {
  no: ['no', 'nomor', 'nomorurut'],
  rm_no: ['norm', 'nomorrm', 'rm', 'nomorrekammedis', 'norekammedis'],
  reimburse: ['reimburse', 'reimbursement', 'reimburs'],
  name: ['nama', 'namacustomer', 'namapasien', 'namalengkap'],
  gender: ['jeniskelamin', 'jk', 'gender', 'kelamin'],
  birth_date: ['tgllahir', 'tanggallahir', 'ttl'],
  phone: ['nowa', 'nomorwa', 'wa', 'whatsapp', 'nowhatsapp', 'nohp', 'telepon', 'notelp'],
  occupation: ['pekerjaan', 'profesi'],
  domicile: ['domisili', 'alamat', 'kota'],
  month: ['bulan'],
  reference: ['referensi', 'reference', 'sumber'],
};

export function importCustomers(format, content) {
  const table = readTable(format, content).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!table.length) throw new HttpError(400, 'File kosong');

  const headerRow = table[0].map(norm);
  const col = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = headerRow.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[field] = i;
  }
  if (col.rm_no === undefined || col.name === undefined) {
    throw new HttpError(400, 'Baris judul harus punya kolom “No RM” dan “Nama”. Unduh template untuk melihat format yang benar.');
  }

  const result = { added: 0, updated: 0, skipped: 0, issues: [] };
  const seen = new Set();
  const get = (row, f) => (col[f] === undefined ? '' : String(row[col[f]] ?? '').trim());

  tx(() => {
    table.slice(1).forEach((row, i) => {
      const line = i + 2; // nomor baris di file (judul = baris 1)
      const raw = Object.fromEntries(['rm_no', 'reimburse', 'name', 'gender', 'birth_date', 'phone', 'occupation', 'domicile', 'month', 'reference'].map((f) => [f, get(row, f)]));
      let cleaned;
      try { cleaned = cleanCustomer(raw); } catch (e) {
        result.skipped++;
        result.issues.push({ line, skipped: true, text: e.message });
        return;
      }
      const { value, warnings } = cleaned;
      for (const w of warnings) result.issues.push({ line, skipped: false, text: w });
      if (seen.has(value.rm_no.toLowerCase())) result.issues.push({ line, skipped: false, text: `No RM ${value.rm_no} muncul lebih dari sekali di file; baris ini menimpa baris sebelumnya` });
      seen.add(value.rm_no.toLowerCase());

      const existing = findByRm(value.rm_no);
      if (existing) {
        // Impor ulang hanya mengisi/menimpa sel yang berisi; sel kosong tidak menghapus data yang sudah ada.
        const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
        const merged = {};
        for (const f of FIELDS) merged[f] = value[f] !== '' ? value[f] : cur[f];
        updateCustomer(existing.id, merged);
        result.updated++;
      } else {
        insertCustomer(value, 'awal');
        result.added++;
      }
    });
  });
  if (result.issues.length > 100) {
    const extra = result.issues.length - 100;
    result.issues = result.issues.slice(0, 100);
    result.issues.push({ line: 0, skipped: false, text: `…dan ${extra} catatan lain` });
  }
  return result;
}

// Baris ekspor mengikuti urutan CUSTOMER_HEADERS; `no` = nomor urut tampil.
export const customerExportRow = (c, no) => [
  no, c.rm_no || '', c.reimburse, c.name, GENDER_LABEL[c.gender] || '', displayDate(c.birth_date), c.phone, c.occupation, c.domicile, c.month, c.reference,
];