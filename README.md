# Acesio Dashboard

Dashboard pencatatan layanan dan komisi untuk Acesio. Terapis (user) mencatat layanan yang sudah dikerjakan per customer, admin melihat laporan dan mengatur komisi.

Tanpa `npm install`: hanya memakai fitur bawaan Node.js (server, SQLite, enkripsi password).

## Menjalankan

Syarat: **Node.js 22.13 atau lebih baru** (cek dengan `node -v`).

```bash
cp .env.example .env      # opsional, untuk mengatur password admin dan kunci bot
npm start
```

Buka http://localhost:3000.

Saat pertama kali jalan, akun **supervisor** dibuat otomatis (username `admin` kecuali diubah di `.env`). Jika `ADMIN_PASSWORD` di `.env` kosong, password acak dicetak di terminal **sekali saja**, jadi catat.

Ingin mencoba dengan data contoh? `npm run seed:demo` (user `sari`, `budi`, `dewi`, password `demo12345`; budi part time). Jangan dijalankan di data sungguhan.

## Jenis akun

| | User | Admin | Supervisor |
|---|---|---|---|
| Input layanan + Rekam Medis, riwayat sendiri | ya | – | – |
| Lihat laporan, customer global, pemakaian layanan | – | ya | ya |
| Lihat komisi | – | **tidak** | ya |
| Approve data user + isi tepat waktu/terlambat | – | ya (sekali) | ya (bisa ubah/batalkan) |
| Hapus data input | miliknya, selama belum di-approve | – | semua |
| Edit komisi per user, nama/foto layanan, kelola akun | – | – | ya |

Akun lama dari versi sebelumnya otomatis menjadi **Supervisor**, dan komisi per layanan lama disalin ke tiap user sebagai titik awal.

## Cara pakai

**Supervisor**
1. **Akun User**: tambah akun (jenis akun: User / Admin / Supervisor; untuk User pilih status kerja Karyawan tetap atau Part time).
2. **Pengaturan Layanan** punya dua tab: *Kotak layanan* (nama dan foto 29 kotak) dan *Perbedaan komisi* (klik "Atur komisi" di sebuah user, nama user tampil paling atas, isi komisi tiap layanan). Tidak ada komisi umum: layanan yang belum diisi dihitung Rp0. Tersedia tombol "Salin dari user lain" untuk mempercepat.
3. **Laporan**: total komisi, customer, pelayanan, hari terlambat, laporan terlambat harian, data user, dan pemakaian layanan.

**Admin**: sama seperti supervisor untuk melihat laporan dan customer, tanpa angka komisi dan tanpa pengaturan.

**Approve data user (admin dan supervisor)**: klik baris user (atau baris di Laporan Kinerja), pilih tanggal, pilih *Tepat waktu* atau *Terlambat*, lalu **Approve**. Setelah itu data hari itu dikunci: user tidak bisa menghapus atau menambah data pada tanggal tersebut. Hanya supervisor yang bisa mengubah status atau membatalkan approve.

**Laporan per layanan**: klik kartu **Total pelayanan** untuk melihat "Layanan 1 · use 4", dst. Daftar yang sama ada di bagian *Pemakaian layanan*.

**Customer**: riwayat global (nama, no WA, semua layanan yang pernah diambil, riwayat terakhir). Klik tanggal riwayat terakhir untuk melihat semua waktu terapi beserta Rekam Medis.

**Excel**: tombol Excel di Laporan berisi tiga sheet: *Laporan*, *Layanan Terpopuler* (nama + jumlah + grafik batang), dan *Keterlambatan*. Rekam Medis tidak ikut diekspor. Admin tidak mendapat kolom komisi.

**User**
1. Login lalu pilih satu atau lebih kotak layanan. Panel input muncul **di atas**.
2. Ketik nama (atau nomor WA) customer, pilih dari saran. Jika belum ada, pilih "Customer baru" dan isi nomor WA.
3. Isi **Rekam Medis** (satu catatan untuk semua layanan yang dipilih), lalu klik **Input**.
4. Tab **Riwayat Customer**: lihat, cari, hapus data sendiri (selama belum terkunci), dan tarik data CSV/Excel. Komisi tidak pernah terlihat.

## Aturan data

- **Customer** dikenali dari **nama + nomor WA** (dinormalisasi ke `62812...`).
- **Total customer** dihitung per orang unik, **total pelayanan** per layanan yang diinput.
- **Komisi** diambil dari pengaturan user itu saat input. Mengubah komisi hanya berlaku untuk input berikutnya, kecuali supervisor mencentang "Terapkan juga ke data yang sudah tercatat".
- **Hari** mengikuti zona waktu `APP_TZ` (default Asia/Jakarta).

## Integrasi WA bot

Isi `BOT_API_KEY` di `.env`, lalu kirim header `X-API-Key` di setiap request. Semua respons JSON.

```bash
# Cari customer by nomor WA atau nama
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?phone=0812-3456-7890"
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?q=rina"

# Riwayat layanan satu customer
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/customers/1/history

# Daftar layanan (id dan nama, tanpa komisi)
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/services

# Catat layanan atas nama terapis (username)
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/api/bot/records \
  -d '{"username":"budi","customer_name":"Rina Wulandari","customer_phone":"081234567890","service_ids":[1,3]}'
```

Data yang dicatat bot tampil di laporan seperti input biasa (ditandai "via WA bot"). Body boleh menyertakan `"note"` untuk Rekam Medis. Komisi mengikuti pengaturan user (`username`) tersebut, dan input ditolak jika hari itu sudah di-approve. Jika `customer_id` dikirim, nama dan nomor tidak perlu.

## Keamanan

- Password disimpan dengan scrypt; sesi memakai cookie HttpOnly. Login dibatasi 8 percobaan gagal per 15 menit.
- Tiga peran dibedakan di server. API untuk user dan admin tidak pernah mengirim komisi.
- Ekspor CSV dibersihkan dari karakter formula Excel.
- Jika dipasang di server publik, jalankan di belakang HTTPS (Nginx/Caddy) dan set `COOKIE_SECURE=true`.

## Data dan backup

Semua data ada di folder `data/` (`acesio.db` dan `uploads/` untuk foto layanan). Backup = salin folder itu saat server mati (atau gunakan `sqlite3 acesio.db ".backup backup.db"`).

## Struktur

```
server/   index.js (HTTP), routes.js (API), db.js (skema + migrasi), auth.js, exporter.js (CSV/XLSX + grafik), util.js, clock.js
public/   index.html, css/app.css, js/ (login, user, admin, komponen)
scripts/  seed-demo.js
```