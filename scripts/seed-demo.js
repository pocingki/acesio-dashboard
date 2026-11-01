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
const created = [];

tx(() => {
  const now = Date.now();
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

console.log('\n  Data contoh dibuat.');
if (created.length) {
  console.log(`  Akun baru   : ${created.join(', ')}`);
  console.log(`  Password    : ${demoPassword}   (acak, hanya tampil sekali ini; catat sekarang)\n`);
} else {
  console.log('  Tidak ada akun baru (sari/budi/dewi sudah ada, password mereka tidak diubah).\n');
}