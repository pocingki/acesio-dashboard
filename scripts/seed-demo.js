// Mengisi data contoh supaya dashboard bisa dicoba. HANYA untuk database kosong / baru.
// Menolak jalan di produksi, dan menolak jalan di database yang sudah berisi data
// kecuali dipaksa: `npm run seed:demo -- --force` lalu ketik tepat "SAYA YAKIN".
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

try { process.loadEnvFile(); } catch { /* opsional */ }

const refuse = (lines) => {
  console.error('\n  Seed demo DITOLAK:');
  for (const l of [].concat(lines)) console.error(`  - ${l}`);
  console.error('');
  process.exit(1);
};

// Dicek SEBELUM menyentuh database supaya tidak ada berkas/migrasi yang terbuat.
if (process.env.NODE_ENV === 'production') {
  refuse('NODE_ENV=production. Data contoh tidak boleh dibuat di produksi (tidak bisa dipaksa).');
}
const force = process.argv.includes('--force');

const { db, tx } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { ymd } = await import('../server/clock.js');
const { createSchedule, startSchedule, completeSchedule, cancelSchedule, approveSchedule } = await import('../server/schedules.js');

const count = (sql) => db.prepare(sql).get().n;
const problems = [];
if (count("SELECT COUNT(*) AS n FROM users WHERE role <> 'supervisor'") > 0 || count("SELECT COUNT(*) AS n FROM users WHERE role = 'supervisor'") > 1) {
  problems.push('tabel users sudah berisi akun selain supervisor awal');
}
if (count('SELECT COUNT(*) AS n FROM records') > 0) problems.push('tabel records tidak kosong');
if (count('SELECT COUNT(*) AS n FROM customers') > 0) problems.push('tabel customers sudah berisi data');
if (count("SELECT COUNT(*) AS n FROM services WHERE name <> 'Layanan ' || position") > 0) problems.push('nama layanan sudah diubah supervisor (seed akan menimpanya)');

if (problems.length) {
  if (!force) {
    refuse([...problems, 'Seed hanya untuk database kosong. Jika benar-benar yakin: npm run seed:demo -- --force']);
  }
  console.log('\n  PERINGATAN: database ini sudah berisi data:');
  for (const p of problems) console.log(`  - ${p}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.once('close', () => resolve(''));
    rl.question('\n  Ketik tepat "SAYA YAKIN" untuk menambahkan data contoh: ').then(resolve, () => resolve(''));
  });
  rl.close();
  if (answer !== 'SAYA YAKIN') refuse('konfirmasi tidak sesuai, tidak ada yang diubah.');
}

const names = ['Rina Wulandari', 'Dimas Prakoso', 'Siti Nurhaliza', 'Agus Setiawan', 'Maya Anggraini', 'Fajar Nugroho', 'Lestari Putri', 'Bayu Aditya', 'Tiara Maharani', 'Eko Prasetyo'];
const services = [
  ['Terapi Cedera Lutut', 25000], ['Sport Massage', 15000], ['Recovery Pasca Lari', 20000], ['Fisioterapi Punggung', 30000],
  ['Taping Atlet', 10000], ['Dry Needling', 35000], ['Latihan Penguatan', 18000], ['Konsultasi Postur', 12000],
];
const staff = [['sari', 'Sari Handayani', 'tetap', 1], ['budi', 'Budi Santoso', 'part_time', 0.8], ['dewi', 'Dewi Lestari', 'tetap', 1]]; // [username, nama, status kerja, pengali komisi]

// Password acak per eksekusi, dicetak sekali di akhir. Hash dihitung di luar tx karena hashPassword async.
const demoPassword = crypto.randomBytes(9).toString('base64url');
const hashes = new Map();
for (const [username] of staff) {
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) hashes.set(username, await hashPassword(demoPassword));
}
// Jadwal butuh akun staf sebagai pembuatnya (created_by). Supervisor biasanya dibuat server saat pertama jalan;
// bila seed dijalankan lebih dulu, seed membuatnya dengan aturan yang sama (ADMIN_USERNAME / ADMIN_PASSWORD).
const needSupervisor = !db.prepare("SELECT 1 FROM users WHERE role = 'supervisor'").get();
const supervisorName = process.env.ADMIN_USERNAME || 'admin';
const supervisorPassword = process.env.ADMIN_PASSWORD || demoPassword;
const supervisorHash = needSupervisor ? await hashPassword(supervisorPassword) : null;
const created = [];

tx(() => {
  const now = Date.now();
  if (needSupervisor) {
    db.prepare("INSERT INTO users (username, name, password_hash, role, active, created_at) VALUES (?, 'Supervisor', ?, 'supervisor', 1, ?)")
      .run(supervisorName, supervisorHash, new Date(now).toISOString());
  }
  services.forEach(([name], i) => db.prepare('UPDATE services SET name = ? WHERE position = ?').run(name, i + 1));
  const userIds = staff.map(([username, name, employment, factor]) => {
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    let id;
    if (row) id = row.id; // akun yang sudah ada tidak disentuh (password-nya tidak diubah)
    else {
      id = Number(db.prepare("INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, 'user', ?, 1, ?)")
        .run(username, name, hashes.get(username), employment, new Date(now).toISOString()).lastInsertRowid);
      created.push(username);
    }
    services.forEach(([, base], i) => db.prepare('INSERT OR REPLACE INTO user_commissions (user_id, service_id, amount) SELECT ?, id, ? FROM services WHERE position = ?').run(id, Math.round(base * factor / 500) * 500, i + 1));
    return id;
  });
  const custIds = names.map((n, i) => {
    const phone = `62812${String(3000000 + i * 137)}`;
    const rm = `RM-${String(1001 + i)}`;
    const row = db.prepare('SELECT id FROM customers WHERE rm_no = ?').get(rm);
    return row ? row.id : Number(db.prepare(`INSERT INTO customers (rm_no, reimburse, name, gender, birth_date, phone, occupation, domicile, month, reference, origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rm, i % 3 === 0 ? 'Ya' : 'Tidak', n, i % 2 ? 'L' : 'P', `${1980 + i}-0${(i % 9) + 1}-15`, phone,
      ['Karyawan', 'Atlet', 'Guru', 'Wiraswasta'][i % 4], ['Depok', 'Jakarta Selatan', 'Bogor'][i % 3], 'Oktober 2026', ['Instagram', 'Teman', 'Dokter'][i % 3], i < 8 ? 'awal' : 'baru', new Date(now).toISOString()).lastInsertRowid);
  });
  let seed = 7;
  const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
  for (let i = 0; i < 40; i++) {
    const sid = rnd(services.length) + 1;
    const uid = userIds[rnd(userIds.length)];
    const commission = db.prepare('SELECT amount FROM user_commissions WHERE user_id = ? AND service_id = ?').get(uid, sid).amount;
    const when = new Date(now - rnd(20) * 86400000 - rnd(600) * 60000);
    const iso = when.toISOString();
    const cid = custIds[rnd(custIds.length)];
    db.prepare('INSERT INTO records (user_id, customer_id, service_id, commission, source, created_at, day, note, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, cid, sid, commission, 'web', iso, ymd(when), i % 3 === 0 ? 'Keluhan ringan, lanjut program latihan.' : '', `${iso}|${uid}|${cid}`);
  }
});

// ---------- jadwal demo ----------
// Dibuat lewat fungsi layanan yang sama dengan API (bukan SQL mentah) supaya konsisten dengan kontrak:
// layanan ada di schedule_services, jadwal selesai menyimpan batch record dan SOAP, notifikasi awal dan audit ikut terbuat.
// Jadwal hari ini untuk tiap user demo (jam berbeda, 1 sampai 3 layanan, campuran status), satu jadwal besok, satu jadwal batal.
const SOAP_CONTOH = {
  s: 'Nyeri lutut kanan saat naik tangga sejak dua minggu, membaik bila istirahat.',
  o: 'Fleksi lutut 110 derajat, nyeri tekan sisi medial, tidak ada bengkak atau kemerahan.',
  a: 'Dugaan strain ligamen medial derajat ringan.',
  p: 'Terapi manual dan latihan penguatan paha dua kali seminggu, evaluasi ulang dalam dua minggu.',
};
const scheduleSummary = { hariIni: 0, besok: 0, batal: 0, selesai: 0, berjalan: 0, menunggu: 0, baru: 0 };
tx(() => {
  const staffActor = db.prepare("SELECT id, name, role FROM users WHERE role = 'supervisor' ORDER BY id LIMIT 1").get();
  const serviceIds = db.prepare('SELECT id FROM services ORDER BY position').all().map((r) => r.id);
  const customerIds = names.map((_, i) => db.prepare('SELECT id FROM customers WHERE rm_no = ?').get(`RM-${1001 + i}`).id);
  const workers = staff.map(([username, name]) => ({ ...db.prepare('SELECT id, name FROM users WHERE username = ?').get(username), role: 'user' }));
  const today = ymd();
  const tomorrow = ymd(new Date(Date.now() + 86400000));

  // [pekerja, jam mulai, jam selesai, indeks customer, layanan (posisi 1..), status akhir]
  const plan = [
    [0, '08:00', '09:00', 0, [1, 2], 'selesai'],
    [0, '10:30', '11:30', 1, [3], 'berjalan'], // sudah Mulai, menunggu SOAP
    [0, '14:00', '15:30', 2, [4, 5, 6], 'baru'],
    [1, '08:30', '09:30', 3, [2], 'selesai'],
    [1, '11:00', '12:00', 4, [1, 7], 'baru'],
    [1, '15:00', '16:00', 5, [6, 8], 'baru'],
    [2, '09:30', '10:30', 6, [5], 'menunggu'], // SOAP terisi, hitung mundur habis, menunggu approve admin/supervisor
    [2, '13:00', '14:00', 7, [3, 4], 'baru'],
    [2, '16:00', '17:00', 8, [1], 'batal'],
  ];
  const make = (w, day, start, end, cust, pos, note = '') => createSchedule({
    user_id: workers[w].id, customer_id: customerIds[cust], service_ids: pos.map((p) => serviceIds[p - 1]),
    day, start_time: start, end_time: end, note,
  }, staffActor, '');

  for (const [w, start, end, cust, pos, status] of plan) {
    const sch = make(w, today, start, end, cust, pos, status === 'baru' && cust === 2 ? 'Customer lama, mulai dari evaluasi keluhan terakhir.' : '');
    scheduleSummary.hariIni += 1;
    if (['berjalan', 'menunggu', 'selesai'].includes(status)) startSchedule({ user: workers[w], id: sch.id });
    // Alur: Mulai -> SOAP (hitung mundur mulai) -> waktu habis -> approve = Selesai.
    if (status === 'menunggu' || status === 'selesai') completeSchedule({ user: workers[w], scheduleId: sch.id, soap: SOAP_CONTOH });
    // Demo: majukan batas waktu ke masa lalu seolah hitung mundur sudah habis (jadwal asli menunggu waktunya berjalan).
    if (status === 'menunggu' || status === 'selesai') db.prepare('UPDATE schedules SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), sch.id);
    if (status === 'selesai') approveSchedule(sch.id, staffActor, '');
    if (status === 'batal') cancelSchedule(sch.id, staffActor, '');
    scheduleSummary[status] += 1;
  }
  make(0, tomorrow, '09:00', '10:00', 9, [1, 4]);
  scheduleSummary.besok += 1;
});

console.log('\n  Data contoh dibuat.');
if (created.length) {
  console.log(`  Akun baru   : ${created.join(', ')}`);
  console.log(`  Password    : ${demoPassword}   (acak, hanya tampil sekali ini; catat sekarang)\n`);
} else {
  console.log('  Tidak ada akun baru (sari/budi/dewi sudah ada, password mereka tidak diubah).\n');
}
if (needSupervisor) {
  console.log(`  Supervisor  : ${supervisorName} (dibuat seed karena belum ada)`);
  console.log(process.env.ADMIN_PASSWORD ? '  Password    : sesuai ADMIN_PASSWORD\n' : `  Password    : sama dengan password akun demo di atas\n`);
}
console.log(`  Jadwal      : ${scheduleSummary.hariIni} untuk hari ini (${scheduleSummary.baru} baru, ${scheduleSummary.berjalan} berjalan (menunggu SOAP), ${scheduleSummary.menunggu} menunggu approve, ${scheduleSummary.selesai} selesai, ${scheduleSummary.batal} batal), ${scheduleSummary.besok} untuk besok.`);
console.log('  Jadwal selesai membuat record layanan; jadwal baru siap dijalankan dari akun user demo (Mulai -> isi SOAP -> hitung mundur -> approve).\n');