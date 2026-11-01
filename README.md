# Acesio Dashboard

Dashboard pencatatan layanan dan komisi untuk Acesio. Terapis (user) mencatat layanan yang sudah dikerjakan per customer; admin melihat laporan; supervisor mengatur komisi, akun, dan memantau log audit.

Tanpa `npm install`: hanya memakai fitur bawaan Node.js (server HTTP, SQLite `node:sqlite`, `crypto`). Frontend berupa ES module biasa, tanpa build.

## Menjalankan

Syarat: **Node.js 22.13 atau lebih baru** (`node -v`).

```bash
cp .env.example .env      # isi ADMIN_PASSWORD dan BOT_API_KEY
npm start
```

Buka http://localhost:3000. Untuk pengembangan: `npm run dev` (restart otomatis saat berkas berubah).

Saat pertama kali jalan, akun **supervisor** dibuat otomatis (username `admin` kecuali diubah lewat `ADMIN_USERNAME`). Jika `ADMIN_PASSWORD` kosong, password acak dicetak di terminal **sekali saja**, jadi catat. Variabel ini hanya dipakai saat belum ada supervisor sama sekali.

Data contoh: `npm run seed:demo` membuat user demo dengan **password acak yang dicetak di terminal sekali saja**, jadi catat. Hanya untuk database **kosong**; skrip menolak database yang sudah berisi data.

### Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | `0` = port acak; port sebenarnya dicetak di stdout |
| `HOST` | `0.0.0.0` | Di belakang reverse proxy, isi `127.0.0.1` |
| `DATA_DIR` | `./data` | Berisi `acesio.db` dan `uploads/` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, acak | Akun supervisor pertama |
| `BOT_API_KEY` | kosong | Kosong = endpoint `/api/bot/*` nonaktif (503) |
| `APP_TZ` | `Asia/Jakarta` | Zona waktu bisnis: menentukan "hari ini" untuk hapus, approve, dan laporan |
| `SESSION_HOURS` | `12` | Masa berlaku sesi login |
| `COOKIE_SECURE` | `false` | `true` di produksi (HTTPS) |
| `TRUST_PROXY` | `false` | `true` hanya bila di belakang reverse proxy tepercaya; lihat bagian Keamanan |
| `BACKUP_DIR` | `./backups` | Hanya dibaca `scripts/backup.js` |

## Jenis akun

| | User | Admin | Supervisor |
|---|---|---|---|
| Input layanan (customer dipilih lewat No RM), riwayat sendiri | ya | – | – |
| Upload / tambah / ubah / tarik data customer | – | ya | ya |
| Lihat laporan, customer global, pemakaian layanan | – | ya | ya |
| Lihat komisi | – | **tidak** | ya |
| Approve data user + isi tepat waktu/terlambat | – | ya (sekali) | ya (bisa ubah/batalkan) |
| Hapus data input | miliknya, **hanya hari ini** dan belum di-approve | – | semua (tercatat di log audit) |
| Edit komisi per user, nama/foto layanan, kelola akun, lihat log audit | – | – | ya |

## Cara pakai

**Supervisor**
1. **Akun User**: tambah akun (User / Admin / Supervisor; untuk User pilih Karyawan tetap atau Part time).
2. **Pengaturan Layanan**: tab *Kotak layanan* (nama dan foto 29 kotak) dan *Perbedaan komisi* (komisi per layanan per user; yang belum diisi dihitung Rp0; ada tombol "Salin dari user lain").
3. **Laporan**: total komisi, customer, pelayanan, hari terlambat, grafik donat, laporan terlambat harian, data user, pemakaian layanan.
4. **Log audit**: siapa menghapus data, mengubah komisi, meng-approve, membuat akun, dan seterusnya (lihat bagian Log audit).

**Admin**: sama seperti supervisor untuk laporan dan customer, tanpa angka komisi dan tanpa pengaturan.

**Approve data user (admin dan supervisor)**: klik baris user, pilih tanggal, pilih *Tepat waktu* atau *Terlambat*, lalu **Approve**. Approve baru hanya bisa pada hari yang sama. Setelah itu data hari itu dikunci. Hanya supervisor yang bisa mengubah atau membatalkan.

**Data customer (admin dan supervisor)** adalah sumber data awal. Menu **Customer** menampilkan *No | No RM | Reimburse | Nama | Jenis Kelamin | Tgl Lahir | No WA | Pekerjaan | Domisili | Bulan | Referensi | Catatan Medis* (50 baris per halaman, bisa dicari). *Catatan Medis* diisi admin/supervisor lewat form Tambah/Ubah customer atau kolom ke-12 pada file upload, ikut ditarik ke CSV/Excel, dan tidak pernah tampil di sisi user.
- **Upload data**: CSV atau Excel (.xlsx) dengan baris judul yang sama (template tersedia di jendela upload). *No RM* dan *Nama* wajib. No RM yang sudah ada diperbarui (sel kosong tidak menghapus data lama), yang belum ada ditambahkan. Baris bermasalah dilaporkan setelah upload.
- **Tambah customer**: dipakai saat user melapor No RM tidak ditemukan.
- **Ubah**, **Tarik data** (CSV/Excel), dan **Riwayat** per customer.
- Ekspor CSV menetralkan sel yang bisa dibaca Excel sebagai formula (anti formula injection). Hasil ekspor yang diimpor kembali tidak boleh mengubah data: nama seperti `-Andi` harus tetap `-Andi` (diuji di regresi #8).

**User**
1. Login. Panel input di atas, kotak layanan di bawahnya.
2. Alur: **isi No RM** → **klik No RM di daftar saran** (minimal 2 karakter) → **pilih layanan** → **Input**.
3. User tidak membuat customer. Jika No RM tidak ada, lapor ke admin lalu cari lagi.
4. Tab **Riwayat Customer**: lihat, cari, hapus data **hari ini** milik sendiri, dan tarik CSV/Excel. Komisi tidak pernah terlihat.

## Aturan data

- **Customer** dikenali dari **No RM** (unik, huruf besar/kecil sama). Nomor WA dinormalisasi ke `62812...`.
- **Total customer** dihitung per orang unik, **total pelayanan** per layanan yang diinput.
- **Komisi** diambil dari pengaturan user saat input. Mengubah komisi hanya berlaku untuk input berikutnya, kecuali supervisor mencentang "Terapkan juga ke data yang sudah tercatat".
- **Hari** mengikuti `APP_TZ`. Data hari lampau terkunci untuk user (HTTP 409).
- **Pencarian riwayat** (`q`) mencocokkan nama customer, No RM, dan nama layanan. Kolom No WA hanya dicocokkan bila `q` seluruhnya angka/spasi/strip/plus dengan minimal 3 digit.
- `/api/records/mine` mengembalikan `{records, totals, truncated}`. `totals` dihitung terpisah dan tidak terpotong; `records` dibatasi 1000 baris (`truncated: true` bila terpotong).
- Rentang tanggal terbalik (`from` > `to`) dan `id`/`user_id` non-angka ditolak dengan 400.

## API: ringkasan perilaku

- Semua error berbentuk `{"error": "pesan", "code": "KODE_OPSIONAL"}` dengan status 4xx. 500 berarti bug; mohon dilaporkan.
- Body JSON harus objek (selain itu 400). Body terlalu besar: 413 (batas 3 MB; impor customer 30 MB).
- Pencarian customer: minimal 2 karakter, maksimal 60 permintaan per menit per user (429), hasil maksimal 8.
- Login dibatasi per kombinasi **IP + username**; kegagalan satu akun tidak mengunci akun lain.

### Idempotency-Key (anti data ganda)

`POST /api/records` menerima header `Idempotency-Key` (8–100 karakter `A-Za-z0-9_-`). Permintaan ulang dengan key yang sama **tidak membuat data baru**: server mengembalikan respons semula dengan header `Idempotent-Replay: true`. Key disimpan 24 jam per user. Tanpa header, setiap permintaan membuat data baru, jadi klien yang bisa mengulang kiriman (aplikasi, bot) sebaiknya selalu mengirim key.

## Integrasi WA bot

Isi `BOT_API_KEY`, lalu kirim header `X-API-Key` di setiap request. Semua respons JSON.

```bash
# Cari customer: No RM (utama), nomor WA, atau nama
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?rm=RM-001"
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?phone=0812-3456-7890"
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/bot/customers?q=rina"

# Riwayat layanan satu customer, dan daftar layanan (tanpa komisi)
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/customers/1/history
curl -H "X-API-Key: $KEY" http://localhost:3000/api/bot/services

# Catat layanan atas nama terapis. request_id mencegah data ganda saat bot mengulang kiriman
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  http://localhost:3000/api/bot/records \
  -d '{"username":"budi","customer_rm":"RM-001","service_ids":[1,3],"request_id":"wa-msg-8f31c2a9"}'
```

Idempotensi bot memakai `request_id` di body, atau header `Idempotency-Key` yang sama dengan endpoint web. Data bot ditandai "via WA bot" di laporan. Bot **tidak membuat customer baru**: No RM tidak ada = 404. Input ditolak (409) bila hari itu sudah di-approve.

## Keamanan (ringkas)

Rincian ada di [SECURITY.md](SECURITY.md).

- Password: scrypt (asinkron, tidak memblokir server). Sesi: cookie `HttpOnly`, `SameSite=Lax`. Ganti password mencabut sesi lain milik akun itu.
- Tiga peran dipisah di server; API user dan admin tidak pernah mengirim komisi.
- **Di belakang reverse proxy** set `TRUST_PROXY=true` agar IP klien dan HTTPS terbaca dari `X-Forwarded-For` / `X-Forwarded-Proto`. Tanpa itu, header tersebut **diabaikan** (tidak bisa dipalsukan). Pasang `TRUST_PROXY=true` hanya bila port aplikasi tidak bisa diakses langsung dari luar.
- Produksi wajib HTTPS dan `COOKIE_SECURE=true`. Panduan lengkap: [docs/DEPLOY.md](docs/DEPLOY.md).

## Log audit

Tabel `audit_log` mencatat aksi sensitif: `record.delete`, `review.approve`, `review.change`, `review.cancel`, `commission.update`, `account.create`, `account.update`, `service.update`, `customer.import`, `customer.create`, `customer.update`, `auth.password_change`. Setiap baris menyimpan waktu, pelaku, target, detail (JSON), dan IP.

Supervisor membacanya lewat `GET /api/sv/audit?page=&q=&action=` (admin dan user tidak punya akses).

## Backup

```bash
npm run backup                 # salin ke backups/acesio-YYYYMMDD-HHMM.db, simpan 14 terbaru
npm run backup -- --keep 30    # simpan 30 terbaru
```

Memakai `VACUUM INTO`, jadi **aman saat server hidup** (bukan menyalin berkas mentah yang bisa setengah tertulis), lalu memeriksa `integrity_check` sebelum menghapus backup lama. Folder `backups/` ada di `.gitignore`.

Backup database **tidak** mencakup `data/uploads/` (foto layanan). Salin folder itu terpisah. Jadwal cron dan prosedur pemulihan ada di [docs/DEPLOY.md](docs/DEPLOY.md).

## Tes

```bash
npm run check    # node --check untuk semua .js dan .mjs
npm test         # node --test: seluruh test/**/*.test.mjs
```

Tes menjalankan server asli di port acak dengan folder data sementara; tidak menyentuh `data/`. `test/regression-audit.test.mjs` berisi satu tes per temuan audit. Temuan sisi klien diuji manual: lihat [test/e2e/README.md](test/e2e/README.md). CI: `.github/workflows/test.yml` (Node 22.x).

## Struktur

```
server/
  index.js            HTTP, header keamanan, berkas statis
  util.js             HttpError, normalisasi, helper umum
  auth.js, ratelimit.js   sesi, password (scrypt async), pembatas percobaan
  db.js, records.js, audit.js, idempotency.js   skema + migrasi, input data, log audit, anti data ganda
  importer.js, exporter.js, customers.js        CSV/XLSX, data customer
  routes/             index.js (registry), helpers.js, auth.js, records.js, history.js,
                      staff-report.js, staff-customers.js, sv.js, bot.js
public/               index.html, css/app.css, js/ (login, user, staff, customers, charts, ui, api)
scripts/              seed-demo.js, backup.js
docs/DEPLOY.md        Caddy/Nginx, systemd, cron backup, rotasi key, pemulihan
test/                 regression-audit.test.mjs, e2e/README.md, tes per area
```
