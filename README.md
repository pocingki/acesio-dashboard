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
| Input layanan (customer dipilih lewat No RM), riwayat sendiri | ya | – | – |
| Upload / tambah / ubah / tarik data customer | – | ya | ya |
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
3. **Laporan**: total komisi, customer, pelayanan, hari terlambat, **grafik donat** (Kunjungan per terapis, Layanan, New customer, Jenis kelamin) di atas Laporan Kinerja, laporan terlambat harian, data user, dan pemakaian layanan. Kunjungan dan Layanan mengikuti filter tanggal; New customer dan Jenis kelamin memakai seluruh data customer.

**Admin**: sama seperti supervisor untuk melihat laporan dan customer, tanpa angka komisi dan tanpa pengaturan.

**Approve data user (admin dan supervisor)**: klik baris user (atau baris di Laporan Kinerja), pilih tanggal, pilih *Tepat waktu* atau *Terlambat*, lalu **Approve**. Setelah itu data hari itu dikunci: user tidak bisa menghapus atau menambah data pada tanggal tersebut. Hanya supervisor yang bisa mengubah status atau membatalkan approve.

**Laporan per layanan**: klik kartu **Total pelayanan** untuk melihat "Layanan 1 · use 4", dst. Daftar yang sama ada di bagian *Pemakaian layanan*.

**Data customer (admin dan supervisor)** adalah sumber data awal. Menu **Customer** menampilkan tabel *No | No RM | Reimburse | Nama | Jenis Kelamin | Tgl Lahir | No WA | Pekerjaan | Domisili | Bulan | Referensi* beserta seluruh isinya (50 baris per halaman, bisa dicari).
- **Upload data**: file CSV atau Excel (.xlsx) dengan baris judul yang sama (template kosong tersedia di jendela upload). Kolom *No RM* dan *Nama* wajib; kolom *No* diabaikan. No RM yang sudah ada diperbarui (sel kosong tidak menghapus data lama), yang belum ada ditambahkan. Baris bermasalah dilaporkan setelah upload.
- **Tambah customer**: dipakai saat user melapor bahwa No RM tidak ditemukan. Pilih *Asal data*: **Customer baru** (dilaporkan user) atau **Data awal** (tambahan).
- **Ubah**: edit semua kolom (termasuk mengisi No RM untuk customer lama yang belum punya).
- **Tarik data**: CSV/Excel dengan kolom persis seperti tabel di atas.
- Kolom **Riwayat** membuka semua waktu terapi beserta Rekam Medis.

**Excel**: tombol Excel di Laporan berisi tiga sheet: *Laporan*, *Layanan Terpopuler* (nama + jumlah + grafik batang), dan *Keterlambatan*. Rekam Medis tidak ikut diekspor. Admin tidak mendapat kolom komisi.

**User**
1. Login. Panel input ada **di atas**, daftar kotak layanan di bawahnya.
2. Alur: **isi No RM** → **klik No RM yang sesuai** di daftar saran → **pilih layanan** → **Input**. User tidak mengisi Rekam Medis; semua data customer dikelola admin dan supervisor. Kotak layanan baru bisa dipilih setelah customer dipilih.
3. User tidak bisa membuat customer. Jika No RM tidak ditemukan, user **wajib melapor ke admin** untuk memasukkan data customer baru, lalu mencari lagi.
4. Tab **Riwayat Customer**: lihat, cari, hapus data sendiri (selama belum terkunci), dan tarik data CSV/Excel. Komisi tidak pernah terlihat.

## Aturan data

- **Customer** dikenali dari **No RM** (unik, tidak peduli huruf besar/kecil). Nomor WA dinormalisasi ke `62812...`. Customer lama dari versi sebelumnya tetap ada (ditandai *Customer baru*, No RM belum ada) dan No RM-nya diisi admin lewat tombol Ubah.
- **Total customer** dihitung per orang unik, **total pelayanan** per layanan yang diinput.
- **Komisi** diambil dari pengaturan user itu saat input. Mengubah komisi hanya berlaku untuk input berikutnya, kecuali supervisor mencentang "Terapkan juga ke data yang sudah tercatat".
- **Hari** mengikuti zona waktu `APP_TZ` (default Asia/Jakarta).

## Integrasi WA bot

Isi `BOT_API_KEY` di `.env`, lalu kirim header `X-API-Key` di setiap request. Semua respons JSON.

```bash
# Cari customer by No RM (utama), nomor WA, atau nama
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?rm=RM-001"
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?phone=0812-3456-7890"
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?q=rina"

# Riwayat layanan satu customer
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/customers/1/history

# Daftar layanan (id dan nama, tanpa komisi)
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/services

# Catat layanan atas nama terapis (username)
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/api/bot/records \
  -d '{"username":"budi","customer_rm":"RM-001","service_ids":[1,3]}'
```

Data yang dicatat bot tampil di laporan seperti input biasa (ditandai "via WA bot"). Bot tidak mengisi Rekam Medis. Komisi mengikuti pengaturan user (`username`) tersebut, dan input ditolak jika hari itu sudah di-approve. Customer ditentukan lewat `customer_rm` (No RM) atau `customer_id`. Seperti user web, bot **tidak membuat customer baru**: jika No RM tidak ada, responsnya 404 dan customer harus ditambahkan admin lebih dulu.

## Keamanan

- Password disimpan dengan scrypt; sesi memakai cookie HttpOnly. Login dibatasi 8 percobaan gagal per 15 menit.
- Tiga peran dibedakan di server. API untuk user dan admin tidak pernah mengirim komisi.
- Ekspor CSV dibersihkan dari karakter formula Excel.
- Jika dipasang di server publik, jalankan di belakang HTTPS (Nginx/Caddy) dan set `COOKIE_SECURE=true`.

## Data dan backup

Semua data ada di folder `data/` (`acesio.db` dan `uploads/` untuk foto layanan). Backup = salin folder itu saat server mati (atau gunakan `sqlite3 acesio.db ".backup backup.db"`).

## Struktur

```
server/   index.js (HTTP), routes.js (API), db.js (skema + migrasi), customers.js (data customer + impor), importer.js (baca CSV/XLSX), auth.js, exporter.js (CSV/XLSX + grafik), util.js, clock.js
public/   index.html, css/app.css, js/ (login, user, staff, customers, charts, komponen)
scripts/  seed-demo.js
```