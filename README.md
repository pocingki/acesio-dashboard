# Acesio Dashboard

Dashboard pencatatan layanan dan komisi untuk Acesio. **Admin atau supervisor membuat jadwal** (siapa, customer mana, layanan apa, kapan); **terapis (user) menjalankan jadwalnya** lalu mengisi **SOAP** kunjungan, dan layanan tercatat otomatis. Admin juga melihat laporan; supervisor mengatur komisi, akun, dan memantau log audit.

Tanpa `npm install`: hanya memakai fitur bawaan Node.js (server HTTP, SQLite `node:sqlite`, `crypto`). Frontend berupa ES module biasa, tanpa build.

## Menjalankan

Syarat: **Node.js 22.13 atau lebih baru** (`node -v`).

```bash
cp .env.example .env      # isi ADMIN_PASSWORD dan BOT_API_KEY
npm start
```

Buka http://localhost:3000. Untuk pengembangan: `npm run dev` (restart otomatis saat berkas berubah).

Saat pertama kali jalan, akun **supervisor** dibuat otomatis (username `admin` kecuali diubah lewat `ADMIN_USERNAME`). Jika `ADMIN_PASSWORD` kosong, password acak dicetak di terminal **sekali saja**, jadi catat. Variabel ini hanya dipakai saat belum ada supervisor sama sekali.

Data contoh: `npm run seed:demo` membuat user demo (sari, budi, dewi) dengan **password acak yang dicetak di terminal sekali saja**, jadi catat. Selain customer dan riwayat layanan, seed membuat **jadwal demo**: sembilan jadwal hari ini (campuran Baru, Sedang dijalani, Selesai, dan satu Dibatalkan; dua di antaranya selesai lengkap dengan SOAP contoh), satu jadwal besok, beserta notifikasi awalnya. Bila belum ada supervisor, seed membuatnya (username dari `ADMIN_USERNAME`, password dari `ADMIN_PASSWORD`; kosong = memakai password acak yang sama dengan akun demo). Hanya untuk database **kosong**; skrip menolak database yang sudah berisi data. Jadwal demo dibuat untuk tanggal **saat seed dijalankan**; jalankan seed pada hari Anda mencobanya.

### Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | `0` = port acak; port sebenarnya dicetak di stdout |
| `HOST` | `0.0.0.0` | Di belakang reverse proxy, isi `127.0.0.1` |
| `DATA_DIR` | `./data` | Berisi `acesio.db` dan `uploads/` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, acak | Akun supervisor pertama |
| `BOT_API_KEY` | kosong | Kosong = endpoint `/api/bot/*` nonaktif (503) |
| `APP_TZ` | `Asia/Jakarta` | Zona waktu bisnis: menentukan "hari ini" untuk jadwal, hapus, approve, laporan, dan jam akses user |
| `SESSION_HOURS` | `12` | Masa berlaku sesi login |
| `ACCESS_HOURS` | `06:00-23:00` | Jam akses akun **user** (format `HH:MM-HH:MM`, zona `APP_TZ`; mulai harus lebih kecil dari akhir). `off` = tanpa batas. Nilai tidak valid memakai default dan mencetak peringatan |
| `APP_FAKE_NOW_FILE` | kosong | **Khusus tes.** Hanya dibaca bila `NODE_ENV=test`; berisi waktu palsu (ISO) untuk menguji jam akses. **Jangan dipakai di produksi** |
| `SESSION_MINUTES` | `60` | Durasi hitung mundur (menit) bila jadwal **tanpa jam selesai**. Bila jam selesai diisi, durasi = jam selesai − jam mulai |
| `SESSION_TIMER` | menyala | `off` mematikan alur hitung mundur dan approve (perilaku lama: Mulai, isi SOAP, langsung Selesai). Untuk tes; jangan dipakai di produksi |
| `COOKIE_SECURE` | `false` | `true` di produksi (HTTPS) |
| `TRUST_PROXY` | `false` | `true` hanya bila di belakang reverse proxy tepercaya; lihat bagian Keamanan |
| `BACKUP_DIR` | `./backups` | Hanya dibaca `scripts/backup.js` |
| `KEYWORDS_FILE` | `./config/keywords.json` | Berkas kata kunci bersama bot WA; dashboard hanya membaca `platforms`, `referralCodes`, `defaultPlatform` |

## Jenis akun

Admin dan supervisor (staf) **membuat dan mengelola jadwal**; user **menjalankan** jadwal miliknya. Akun **User** hanya bisa login dan dipakai pukul 06.00–22.59 (zona `APP_TZ`, bisa diubah lewat `ACCESS_HOURS`; lihat bagian *Jam akses*). Admin dan supervisor tidak dibatasi.

| | User | Admin | Supervisor |
|---|---|---|---|
| Lihat jadwal sendiri, menjalankannya, mengisi SOAP kunjungan, riwayat sendiri | ya | – | – |
| Membuat / mengubah / membatalkan jadwal user (termasuk layanannya) | – | ya (batal hanya jadwal Baru) | ya (batal juga jadwal Sedang dijalani) |
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

**Data customer (admin dan supervisor)** adalah sumber data awal. Menu **Customer** menampilkan *No | No RM | Reimburse | Nama | Jenis Kelamin | Tgl Lahir | No WA | Pekerjaan | Domisili | Bulan | Referensi | Catatan Medis* (50 baris per halaman, bisa dicari). Kolom terakhir bernama *SOAP*: catatan awal customer yang diisi admin/supervisor lewat form Tambah/Ubah customer atau kolom ke-12 pada file upload, ikut ditarik ke CSV/Excel, dan tidak pernah tampil di sisi user. Kolom ini **terpisah** dari SOAP kunjungan yang diisi terapis (lihat *Jadwal dan SOAP*). File upload lama yang masih memakai judul kolom "Catatan Medis" tetap diterima.
- **Upload data**: CSV atau Excel (.xlsx) dengan baris judul yang sama (template tersedia di jendela upload). *No RM* dan *Nama* wajib. No RM yang sudah ada diperbarui (sel kosong tidak menghapus data lama), yang belum ada ditambahkan. Baris bermasalah dilaporkan setelah upload.
- **Referensi otomatis jadi nama platform**: isi `fb` → *Facebook*, `ig` / `IG01` → *Instagram*, `tt` / `tiktok` → *TikTok*, `google ads` → *Google Ads*, dst. Berlaku di form Tambah/Ubah (terisi lengkap saat kolom ditinggalkan, ada daftar saran) dan di upload CSV/Excel. Aturan dan nama platform dibaca dari `config/keywords.json`, berkas yang sama dengan bot WA, jadi nama di dashboard dan bot selalu seragam. Hanya jika **seluruh isian** adalah satu platform (boleh diawali "dari"/"via"); isian lain seperti *Teman* atau *IG kak Rina* disimpan apa adanya. Kolom kosong tetap kosong. Merapikan data lama: `npm run normalize:references` (tampilkan rencana) lalu `-- --apply`.
- **Tambah customer**: untuk customer yang datang **setelah** data awal diunggah (user tidak membuat customer). Data yang masuk lewat **Upload** otomatis bernilai *Data awal*; yang dibuat lewat **Tambah customer** otomatis *Customer baru*, tanpa pilihan manual. Donat **New customer** di Laporan menampilkan jumlah customer baru pada periode terpilih (default hari ini) di tengahnya dan menyegarkan diri tiap 30 detik.
- **Profil akun**: klik nama di pojok kanan atas (semua peran) untuk mengisi data diri (nama, No HP, email, tanggal lahir, alamat), mengunggah foto, dan mengganti password.
- **Ubah**, **Tarik data** (CSV/Excel), dan **Riwayat** per customer.
- Ekspor CSV menetralkan sel yang bisa dibaca Excel sebagai formula (anti formula injection). Hasil ekspor yang diimpor kembali tidak boleh mengubah data: nama seperti `-Andi` harus tetap `-Andi` (diuji di regresi #8).

**Jadwal (admin dan supervisor)**: tab **Jadwal**.
1. **Tambah jadwal**: pilih user (hanya akun aktif), cari customer lewat No RM atau nama, **centang layanan yang akan dikerjakan** (minimal 1, maksimal 29, dari kotak layanan), isi tanggal, jam mulai, jam selesai (boleh kosong), dan catatan untuk terapis (maksimal 500 karakter). Tanggal tidak boleh lampau.
2. Daftar bisa disaring menurut rentang tanggal, user, status, dan kata kunci (nama customer, No RM, nama user). Daftar tidak menampilkan SOAP; SOAP hanya ada di detail jadwal yang sudah selesai.
3. **Ubah** (termasuk mengganti layanan atau user) hanya selama status **Baru**. **Batalkan**: admin hanya dari status Baru; supervisor juga dari Sedang dijalani. Jadwal Selesai atau Dibatalkan tidak bisa diubah lagi (409 `SCHEDULE_STATE`).
4. **Approve pekerjaan terapis**: jadwal yang hitung mundurnya habis tampil dengan status **Menunggu approve** (ada penanda jumlahnya di atas tabel dan filter status *Menunggu approve*). Admin atau supervisor menekan **Approve** di baris atau di detail jadwal. Admin/supervisor dapat membaca SOAP di detail jadwal sebelum approve. Approve hanya bisa pada tanggal jadwal, setelah SOAP tersimpan dan waktu habis (sebelum itu 409 `SOAP_PENDING` / `TIMER_RUNNING`), dan membuat jadwal Selesai. Supervisor tetap bisa membatalkan jadwal yang menunggu approve.
5. User menerima notifikasi untuk tiap tugas baru, perubahan, dan pembatalan. Bila admin mengganti user, user lama menerima pembatalan dan user baru menerima tugas baru.

**User**
1. Login (pukul 06.00–22.59). Tab awal **Beranda** menampilkan angka **customer hari ini** (customer unik pada jadwal hari ini yang tidak dibatalkan), ringkasan status, dan jadwal berikutnya. Ketuk angka itu untuk membuka **Jadwal Saya**.
2. **Jadwal Saya** menampilkan jadwal **hari ini** secara bawaan. Ada pintasan *Hari ini*, *Besok*, *7 hari ke depan*, *Semua*, dan pilihan tanggal sendiri. Tiap baris memuat jam, customer, No RM, dan layanan yang ditentukan admin.
3. Tekan **Mulai** pada jadwal hari ini (di Beranda atau Jadwal Saya): jadwal menjadi **Sedang dijalani** dan halaman **Input customer** langsung terbuka. Customer dan layanan sudah terisi; **user tidak memilih layanan** dan tidak mencari customer. **SOAP wajib diisi dulu**; hitung mundur belum berjalan.
4. Isi keempat bagian **SOAP** (Subjective, Objective, Assessment, Planning; wajib, tiap bagian 3–2000 karakter) lalu **Simpan**. Saat itulah **hitung mundur mulai** dan tampil di kartu jadwal (Beranda dan Jadwal Saya). Lamanya = jam selesai − jam mulai jadwal (atau `SESSION_MINUTES` bila jam selesai kosong). Sisa waktu dihitung server, jadi tetap benar saat halaman dimuat ulang atau jam perangkat salah. Draf SOAP bertahan selama pindah tab, hilang saat keluar.
5. Saat waktu habis, jadwal berubah menjadi **Menunggu approve**: user menunggu **admin atau supervisor** menyatakan pekerjaan selesai. Layar user menyegarkan diri tiap 15 detik. Begitu di-approve, jadwal menjadi **Selesai**, sistem mencatat satu layanan untuk setiap layanan pada jadwal itu (komisi dari pengaturan komisi user), dan user mendapat notifikasi *Tugas selesai*.
6. Setelah SOAP disimpan, user tidak bisa mengubahnya atau menyimpan lagi (409 `SOAP_ALREADY_SAVED`). Tanpa Mulai, SOAP ditolak (409 `SCHEDULE_STATE`).
7. Jadwal tanggal lain hanya bisa dilihat. Jadwal hari lampau yang belum selesai tampil sebagai **Terlewat**; hubungi admin.
8. **Ikon lonceng** di kanan atas menampilkan notifikasi (tugas baru, diubah, sedang dijalani, selesai, dibatalkan) dan jumlah yang belum dibaca. Mengetuk notifikasi membuka Jadwal Saya pada tanggal jadwal itu.
9. Tab **Riwayat Customer**: lihat, cari, hapus data **hari ini** milik sendiri, dan tarik CSV/Excel. Komisi tidak pernah terlihat. Menghapus riwayat tidak mengubah status jadwal (tetap Selesai).

## Jam akses

Hanya akun **User** yang dibatasi: boleh pukul **06:00:00 sampai 22:59:59** menurut `APP_TZ`; mulai 23:00:00 ditolak. Login di luar jam dijawab 403 `OUTSIDE_HOURS`; sesi yang sedang aktif dicabut pada permintaan berikutnya dan layar login menampilkan pesannya. Admin, supervisor, dan jalur bot tidak dibatasi. Atur dengan `ACCESS_HOURS` (format `HH:MM-HH:MM`; `off` mematikan pembatasan). Pastikan `APP_TZ` benar, karena batas jam mengikuti zona itu, bukan zona browser atau server.

## Jadwal dan SOAP

Status jadwal: **Baru** → **Sedang dijalani** → **Selesai**, atau **Dibatalkan**. Di dalam *Sedang dijalani* ada tiga **fase** (field `phase` pada API; tidak disimpan, dihitung dari `flow`, `due_at`, dan waktu sekarang): `soap` (sudah Mulai, menunggu SOAP, hitung mundur belum jalan) → `timer` (SOAP tersimpan, hitung mundur berjalan) → `menunggu` (waktu habis, menunggu approve). Approve admin/supervisor membuat jadwal **Selesai**. Jadwal yang sedang dijalani dengan `phase: null` (dimulai sebelum alur ini ada, atau `SESSION_TIMER=off`) memakai alur lama: SOAP disimpan = langsung Selesai.

Simpan SOAP (`POST /api/records`) pada alur baru: jadwal Baru (belum Mulai) → 409 `SCHEDULE_STATE`; fase `timer` atau `menunggu` (SOAP sudah tersimpan) → 409 `SOAP_ALREADY_SAVED`. Approve: fase `soap` → 409 `SOAP_PENDING`; fase `timer` → 409 `TIMER_RUNNING`.

Saat user menyimpan SOAP, dalam satu transaksi server memeriksa jadwal dan SOAP, menyimpan SOAP, dan memasang batas hitung mundur (`due_at`). Saat admin/supervisor approve, dalam satu transaksi server membuat satu record per layanan jadwal (komisi dihitung seperti biasa dari pengaturan komisi user), mengubah status menjadi Selesai, dan membuat notifikasi. Pada alur lama kedua langkah itu terjadi sekaligus saat SOAP disimpan. Customer dan layanan **selalu** diambil dari jadwal; `customer_id` atau `service_ids` dari klien diabaikan.

SOAP kunjungan adalah data sensitif: hanya user pemilik jadwal dan admin/supervisor yang bisa membacanya; tidak pernah dikirim ke WhatsApp atau bot dan tidak masuk log audit (hanya nama bagiannya).

## Notifikasi

Hanya untuk user pemilik jadwal. Lima tipe: `tugas_baru`, `tugas_diubah`, `tugas_berjalan`, `tugas_selesai` (juga dikirim saat approve), `tugas_dibatalkan`. Isinya: judul pendek dan `{nama customer} · {tanggal} {jam mulai}`. Notifikasi untuk admin/supervisor belum ada. Notifikasi dibuat di transaksi yang sama dengan perubahan jadwalnya; yang lebih dari 90 hari dihapus setiap server dinyalakan.

## Aturan data

- **Customer** dikenali dari **No RM** (unik, huruf besar/kecil sama). Nomor WA dinormalisasi ke `62812...`.
- **Total customer** dihitung per orang unik, **total pelayanan** per layanan yang diinput.
- **Jadwal dijalankan hanya pada tanggalnya** (D2): user hanya bisa memulai dan menyelesaikan jadwal yang `day`-nya hari ini menurut `APP_TZ`; selain itu 409 `SCHEDULE_NOT_TODAY`. Jadwal lampau yang belum selesai hanya bisa dilihat.
- **Input user wajib lewat jadwal** (D3): `POST /api/records` tanpa `schedule_id` ditolak 400 `SCHEDULE_REQUIRED`. Jalur bot (`/api/bot/records`) tidak berubah.
- **SOAP kunjungan** (D4): empat bagian wajib (S, O, A, P), tiap bagian minimal 3 dan maksimal 2000 karakter setelah dirapikan; kurang dari itu 400 `SOAP_REQUIRED`.
- **"Customer hari ini"** (D7) = jumlah customer unik pada jadwal hari ini yang statusnya bukan Dibatalkan.
- **Layanan ditentukan admin** (D12): 1 sampai 29 layanan unik per jadwal, hanya bisa diubah selama status Baru. User tidak memilih layanan.
- Satu user boleh punya beberapa jadwal berjalan sekaligus dan jadwal yang jamnya bertumpuk (D11); tidak ada validasi bentrok.
- Penamaan **SOAP** hanya pada teks yang terlihat (D1). Kolom database `customers.medical_note` dan kunci JSON `medical_note` sengaja **tidak** diganti, supaya tidak perlu migrasi dan patch WhatsApp/bot tidak rusak.
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

### API jadwal, SOAP, dan notifikasi

Kode error baru: `SCHEDULE_REQUIRED`, `SOAP_REQUIRED`, `SCHEDULE_NOT_TODAY`, `SCHEDULE_STATE` (409), `OUTSIDE_HOURS` (403), `TIMER_RUNNING` (409, waktu layanan belum habis), `APPROVAL_PENDING` (409, menunggu approve).

**Staf (admin dan supervisor)**

| Jalur | Fungsi |
|---|---|
| `GET /api/staff/schedules?from&to&user_id&status&q&page` | Daftar jadwal (`{schedules, total, page, pageSize, pending_approval}`), tanpa SOAP. `status` boleh `menunggu` (SOAP tersimpan, waktu habis, belum di-approve) |
| `GET /api/staff/schedules/:id` | Detail, termasuk SOAP bila sudah selesai |
| `POST /api/staff/schedules` | Buat jadwal: `{user_id, customer_id` atau `customer_rm, service_ids, day, start_time, end_time?, note?}` |
| `PATCH /api/staff/schedules/:id` | Ubah (hanya status Baru; `service_ids` mengganti seluruh daftar) |
| `POST /api/staff/schedules/:id/approve` | Menyatakan pekerjaan terapis selesai (admin dan supervisor): hanya jadwal Sedang dijalani yang SOAP-nya sudah tersimpan dan hitung mundurnya habis, pada tanggalnya. Hasilnya jadwal Selesai dan layanan tercatat |
| `POST /api/staff/schedules/:id/cancel` | Batalkan (admin dari Baru; supervisor dari Baru atau Sedang dijalani) |
| `GET /api/staff/schedule-workers` | User aktif untuk pilihan di form jadwal |

**User**

| Jalur | Fungsi |
|---|---|
| `GET /api/my/home` | `{today, customers_today, by_status, phases, next, schedules, unread}` (`phases` = jumlah jadwal berjalan hari ini per fase: `soap`, `timer`, `menunggu`) |
| `GET /api/my/schedules?from&to` atau `?all=1` | Jadwal sendiri; tanpa parameter = hari ini; maksimal 500 baris (`truncated`) |
| `GET /api/my/schedules/:id` | Detail (dengan SOAP bila ada); milik orang lain = 404 |
| `POST /api/my/schedules/:id/start` | Baru → Sedang dijalani (`phase: soap`; hitung mundur baru berjalan setelah SOAP disimpan); memulai ulang tidak mengubah apa pun |
| `POST /api/records` | `{schedule_id, soap:{s,o,a,p}}` menyimpan SOAP dan memulai hitung mundur (`count: 0`); layanan dicatat saat approve. Jadwal alur lama langsung Selesai dan mencatat semua layanannya |
| `GET /api/my/notifications?limit` | Notifikasi terbaru dulu (bawaan 30, maksimal 100) dan jumlah belum dibaca |
| `POST /api/my/notifications/read` | `{ids:[…]}` atau `{all:true}` |

### Idempotency-Key (anti data ganda)

`POST /api/records` menerima header `Idempotency-Key` (8–100 karakter `A-Za-z0-9_-`). Permintaan ulang dengan key yang sama **tidak membuat data baru**: server mengembalikan respons semula dengan header `Idempotent-Replay: true`. Key disimpan 24 jam per user. Tanpa header, pengiriman ulang untuk jadwal yang sudah Selesai ditolak 409 `SCHEDULE_STATE`; klien yang bisa mengulang kiriman (aplikasi web, bot) sebaiknya tetap selalu mengirim key supaya jawabannya sama dengan yang pertama.

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

Idempotensi bot memakai `request_id` di body, atau header `Idempotency-Key` yang sama dengan endpoint web. Data bot ditandai "via WA bot" di laporan. Bot **tidak membuat customer baru**: No RM tidak ada = 404. Jalur bot tidak memakai jadwal atau SOAP dan tidak terpengaruh jam akses user. Input ditolak (409) bila hari itu sudah di-approve.

## Integrasi WhatsApp (WhatsApp)

Khusus supervisor: tombol **Integrasi** di pojok kanan atas membuka panel samping dengan 3 langkah.

1. **Sambungkan**: tempel *kode sambungan* dari admin WhatsApp (alamat server WhatsApp terisi otomatis) lalu tekan Sambungkan.
2. **Pilih yang dikirim**: *Catat kunjungan* (nama, No RM, kunjungan ke-berapa, layanan) dan, bila mau, *ucapan terima kasih* via WhatsApp (maksimal sekali sehari per pelanggan).
3. **Nyalakan**: hanya kunjungan yang dicatat setelah dinyalakan yang dikirim.

Catatan teknis:
- Kiriman masuk antrean (`integration_outbox`) di transaksi yang sama dengan pencatatan layanan, lalu dikirim latar belakang. WhatsApp mati tidak menggagalkan pencatatan; kiriman diulang otomatis (30 dtk, 2 mnt, 10 mnt, 1 jam, 6 jam) dan yang gagal bisa dikirim ulang dari panel.
- SOAP (catatan awal customer maupun SOAP kunjungan), komisi, dan data terapis tidak pernah dikirim.
- Kunci akses disimpan terenkripsi (AES-256-GCM); kunci enkripsinya ada di `DATA_DIR/integration.key`, **ikut dibackup terpisah dari `acesio.db`**. Bila hilang, cukup sambungkan ulang.
- `http://` hanya diizinkan untuk server yang sama (127.0.0.1 / jaringan privat); selain itu wajib `https://`.
- Kejadian dikirim sebagai `<app>.visit_recorded`; awalan `<app>` menyesuaikan otomatis dengan nama aplikasi pada kunci WhatsApp.
- Arah sebaliknya (WhatsApp membaca data customer Acesio) memakai `BOT_API_KEY`, lihat bagian *Integrasi WA bot*.

## Keamanan (ringkas)

Rincian ada di [SECURITY.md](SECURITY.md).

- Password: scrypt (asinkron, tidak memblokir server). Sesi: cookie `HttpOnly`, `SameSite=Lax`. Ganti password mencabut sesi lain milik akun itu.
- Tiga peran dipisah di server; API user dan admin tidak pernah mengirim komisi.
- **Di belakang reverse proxy** set `TRUST_PROXY=true` agar IP klien dan HTTPS terbaca dari `X-Forwarded-For` / `X-Forwarded-Proto`. Tanpa itu, header tersebut **diabaikan** (tidak bisa dipalsukan). Pasang `TRUST_PROXY=true` hanya bila port aplikasi tidak bisa diakses langsung dari luar.
- Produksi wajib HTTPS dan `COOKIE_SECURE=true`. Panduan lengkap: [docs/DEPLOY.md](docs/DEPLOY.md).

## Log audit

Tabel `audit_log` mencatat aksi sensitif: `record.delete`, `review.approve`, `review.change`, `review.cancel`, `commission.update`, `account.create`, `account.update`, `service.update`, `customer.import`, `customer.create`, `customer.update`, `auth.password_change`, `schedule.create`, `schedule.update` (hanya nama kolom yang berubah), `schedule.cancel`, `schedule.start`, `schedule.soap` (SOAP disimpan, hitung mundur mulai), `schedule.approve`, `schedule.complete` (alur lama). Isi SOAP dan catatan jadwal tidak pernah dicatat. Setiap baris menyimpan waktu, pelaku, target, detail (JSON), dan IP.

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

Tes menjalankan server asli di port acak dengan folder data sementara; tidak menyentuh `data/`. `test/regression-audit.test.mjs` berisi satu tes per temuan audit. Sisi klien diuji dengan skenario manual dan skrip Playwright mandiri (bukan bagian `npm test`): lihat [test/e2e/README.md](test/e2e/README.md). CI: `.github/workflows/test.yml` (Node 22.x).

## Struktur

```
server/
  index.js            HTTP, header keamanan, berkas statis
  util.js             HttpError, normalisasi, helper umum
  auth.js, ratelimit.js   sesi, password (scrypt async), pembatas percobaan
  db.js, records.js, audit.js, idempotency.js   skema + migrasi, input data, log audit, anti data ganda
  importer.js, exporter.js, customers.js        CSV/XLSX, data customer
  schedules.js, notifications.js, clock.js      jadwal + SOAP, notifikasi, waktu bisnis dan jam akses
  routes/             index.js (registry), helpers.js, auth.js, records.js, history.js,
                      staff-report.js, staff-customers.js, staff-schedules.js,
                      my-schedules.js, my-home.js, my-notifications.js, sv.js, bot.js
public/               index.html, css/ (app.css + satu berkas per fitur), js/ (login, user, home, myschedule,
                      visit, notify, staff, schedules, schedule-ui, customers, charts, ui, api)
scripts/              seed-demo.js, backup.js
docs/DEPLOY.md        Caddy/Nginx, systemd, cron backup, rotasi key, pemulihan
test/                 regression-audit.test.mjs, e2e/README.md, tes per area
```
