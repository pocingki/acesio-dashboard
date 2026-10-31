// Mengisi data contoh supaya dashboard bisa dicoba. JANGAN dijalankan di data produksi.
try { process.loadEnvFile(); } catch { /* opsional */ }
const { db, tx } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { ymd } = await import('../server/clock.js');

const names = ['Rina Wulandari', 'Dimas Prakoso', 'Siti Nurhaliza', 'Agus Setiawan', 'Maya Anggraini', 'Fajar Nugroho', 'Lestari Putri', 'Bayu Aditya', 'Tiara Maharani', 'Eko Prasetyo'];
const services = [
  ['Terapi Cedera Lutut', 25000], ['Sport Massage', 15000], ['Recovery Pasca Lari', 20000], ['Fisioterapi Punggung', 30000],
  ['Taping Atlet', 10000], ['Dry Needling', 35000], ['Latihan Penguatan', 18000], ['Konsultasi Postur', 12000],
];
const staff = [['sari', 'Sari Handayani', 'tetap', 1], ['budi', 'Budi Santoso', 'part_time', 0.8], ['dewi', 'Dewi Lestari', 'tetap', 1]]; // [username, nama, status kerja, pengali komisi]

tx(() => {
  const now = Date.now();
  services.forEach(([name], i) => db.prepare('UPDATE services SET name = ? WHERE position = ?').run(name, i + 1));
  const userIds = staff.map(([username, name, employment, factor]) => {
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    const id = row ? row.id : Number(db.prepare("INSERT INTO users (username, name, password_hash, role, employment, active, created_at) VALUES (?, ?, ?, 'user', ?, 1, ?)")
      .run(username, name, hashPassword('demo12345'), employment, new Date(now).toISOString()).lastInsertRowid);
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
console.log('Data contoh dibuat. Login user: sari / budi / dewi, password: demo12345');