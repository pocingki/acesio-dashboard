import { db } from './db.js';
import { HttpError } from './util.js';
import { readTable } from './importer.js';

// Impor "perbedaan komisi" per terapis dari CSV/Excel, mengikuti pola impor data customer.
//
// Tata letak file: satu baris per LAYANAN, satu kolom per TERAPIS (sama seperti tampilan Atur komisi).
//   No | Layanan | Sari (@sari) | Budi (@budi) | ...
//   1  | Pijat   | 25000        | 30000        |
// - Kolom terapis dikenali dari "@username" di judul kolom, atau dari username / nama persis.
// - Layanan dikenali dari nama (huruf besar/kecil sama); bila nama kosong, dari kolom No.
// - Sel kosong = tidak mengubah komisi yang sudah ada (sama seperti impor customer). Isi 0 untuk mengosongkan.

export const COMMISSION_MAX = 1_000_000_000;
const HEADER_SCAN_ROWS = 10;
const MAX_ISSUES = 100;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function workerAccounts() {
  return db.prepare("SELECT id, username, name, employment, active FROM users WHERE role = 'user' ORDER BY name COLLATE NOCASE").all();
}
export function activeServices() {
  return db.prepare('SELECT id, position, name FROM services WHERE active = 1 ORDER BY position').all();
}

export const commissionHeader = (u) => `${u.name} (@${u.username})`;

// Template berisi komisi yang berlaku sekarang, jadi bisa diedit lalu diunggah kembali.
export function commissionTemplate() {
  const users = workerAccounts().filter((u) => u.active);
  const services = activeServices();
  const current = new Map(db.prepare('SELECT user_id, service_id, amount FROM user_commissions').all()
    .map((r) => [`${r.user_id}:${r.service_id}`, r.amount]));
  return {
    headers: ['No', 'Layanan', ...users.map(commissionHeader)],
    rows: services.map((s) => [s.position, s.name, ...users.map((u) => current.get(`${u.id}:${s.id}`) ?? 0)]),
    intCols: [0, ...users.map((_, i) => i + 2)],
    widths: [6, 36, ...users.map(() => 24)],
  };
}

// "Rp25.000", "25.000", "25,000", "25000", "25000.00" -> 25000. Selain itu null (tidak valid).
export function parseRupiah(raw) {
  let s = String(raw ?? '').trim().replace(/^rp\.?\s*/i, '').replace(/\s+/g, '');
  if (s === '') return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+[.,]0+$/.test(s)) s = s.replace(/[.,]0+$/, '');
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n <= COMMISSION_MAX ? n : null;
}

// Hanya membaca dan mencocokkan; tidak menulis apa pun. Pemanggil yang menyimpan (dalam satu transaksi).
// Hasil: { perUser: Map(userId -> { user, amounts: Map(serviceId -> nilai) }), issues, rows, cells }
export function parseCommissionImport(format, content) {
  const table = readTable(format, content)
    .map((row, i) => ({ row, line: i + 1 }))
    .filter(({ row }) => row.some((c) => String(c ?? '').trim() !== ''));
  if (!table.length) throw new HttpError(400, 'File kosong');

  let headerAt = -1;
  let svcCol = -1;
  let noCol = -1;
  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, table.length); i++) {
    const cells = table[i].row.map(norm);
    const k = cells.findIndex((c) => ['layanan', 'namalayanan', 'service', 'pelayanan'].includes(c));
    if (k >= 0) { headerAt = i; svcCol = k; noCol = cells.findIndex((c) => ['no', 'nomor', 'nomorurut'].includes(c)); break; }
  }
  if (headerAt < 0) {
    throw new HttpError(400, 'Baris judul harus punya kolom “Layanan” (dicari di 10 baris pertama). Unduh template untuk melihat format yang benar.');
  }

  const issues = [];
  const note = (line, text, skipped = true) => issues.push({ line, skipped, text });
  const header = table[headerAt];
  const workers = workerAccounts();
  const byUsername = new Map(workers.map((u) => [u.username.toLowerCase(), u]));

  // Kolom terapis: semua kolom berjudul selain No dan Layanan.
  const cols = [];
  const claimed = new Set();
  header.row.forEach((cell, idx) => {
    const title = String(cell ?? '').trim();
    if (!title || idx === svcCol || idx === noCol) return;
    const at = /@([A-Za-z0-9._-]{3,32})\s*\)?\s*$/.exec(title);
    let user = at ? byUsername.get(at[1].toLowerCase()) : undefined;
    if (!user) user = byUsername.get(title.toLowerCase());
    if (!user) {
      const same = workers.filter((u) => squash(u.name) === squash(title));
      if (same.length > 1) { note(header.line, `Kolom “${title}” cocok dengan lebih dari satu terapis. Tulis username-nya, misalnya “${same[0].name} (@${same[0].username})”. Kolom dilewati`); return; }
      user = same[0];
    }
    if (!user) { note(header.line, `Kolom “${title}” tidak cocok dengan terapis mana pun (akun admin/supervisor tidak punya komisi). Kolom dilewati`); return; }
    if (claimed.has(user.id)) { note(header.line, `Kolom “${title}” memakai terapis yang sama dengan kolom lain. Kolom dilewati`); return; }
    claimed.add(user.id);
    cols.push({ idx, user });
  });
  if (!cols.length) throw new HttpError(400, 'Tidak ada kolom terapis yang dikenali. Judul kolom harus memuat nama atau “@username” terapis. Unduh template untuk melihat format yang benar.');

  const services = activeServices();
  const byName = new Map();
  for (const s of services) {
    const k = squash(s.name);
    byName.set(k, [...(byName.get(k) || []), s]);
  }
  const byPos = new Map(services.map((s) => [s.position, s]));
  const seenService = new Set();
  const perUser = new Map(cols.map((c) => [c.user.id, { user: c.user, amounts: new Map() }]));
  let rows = 0;
  let cells = 0;

  for (const { row, line } of table.slice(headerAt + 1)) {
    const name = String(row[svcCol] ?? '').trim();
    const noRaw = noCol >= 0 ? String(row[noCol] ?? '').trim() : '';
    if (!name && !noRaw) { note(line, 'Nama layanan kosong. Baris dilewati'); continue; }

    let svc = null;
    if (name) {
      const hit = byName.get(squash(name)) || [];
      if (hit.length === 1) [svc] = hit;
      else if (hit.length > 1) {
        svc = /^\d{1,6}$/.test(noRaw) ? hit.find((s) => s.position === Number(noRaw)) : null;
        if (!svc) { note(line, `Ada lebih dari satu layanan bernama “${name}”. Isi kolom No sesuai nomor layanan. Baris dilewati`); continue; }
      } else { note(line, `Layanan “${name}” tidak ditemukan di kotak layanan. Baris dilewati`); continue; }
    } else {
      svc = /^\d{1,6}$/.test(noRaw) ? byPos.get(Number(noRaw)) : null;
      if (!svc) { note(line, `Layanan nomor “${noRaw}” tidak ditemukan. Baris dilewati`); continue; }
    }
    if (seenService.has(svc.id)) note(line, `Layanan “${svc.name}” muncul lebih dari sekali di file; baris ini menimpa baris sebelumnya`, false);
    seenService.add(svc.id);
    rows++;

    for (const { idx, user } of cols) {
      const raw = String(row[idx] ?? '').trim();
      if (raw === '') continue; // kosong = tidak mengubah
      const n = parseRupiah(raw);
      if (n === null) { note(line, `Komisi ${user.name} untuk “${svc.name}”: “${raw}” bukan angka bulat 0 sampai Rp1.000.000.000. Sel dilewati`); continue; }
      perUser.get(user.id).amounts.set(svc.id, n);
      cells++;
    }
  }
  if (!rows) throw new HttpError(400, 'Tidak ada baris layanan yang bisa diproses. Periksa nama layanan dan isi file.');
  return { perUser, issues, rows, cells };
}

export function trimIssues(issues) {
  if (issues.length <= MAX_ISSUES) return issues;
  const extra = issues.length - MAX_ISSUES;
  return [...issues.slice(0, MAX_ISSUES), { line: 0, skipped: false, text: `…dan ${extra} catatan lain` }];
}
