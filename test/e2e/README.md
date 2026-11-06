# Uji manual sisi klien (e2e)

Perilaku klien (DOM, fetch dari browser, zona waktu browser) tidak bisa diuji dengan `node --test` tanpa dependensi. Temuan klien **#6, #9, #10, #11** dan alur baru v1.3.0 (Beranda, Jadwal Saya, SOAP, lonceng, jam akses) diuji dengan skenario di bawah. Jalankan sebelum rilis dan setiap kali `public/js/ui.js`, `api.js`, `shell.js`, atau tampilan apa pun di `public/js/` berubah.

> **Pemetaan.** Nomor mengikuti rencana perbaikan: #6 tab bercampur, #9 unduhan, #10 pesan 413, #11 modal. Skenario zona waktu adalah tambahan (kontrak G). Skenario **A sampai E** adalah alur baru v1.3.0.

## Persiapan

```bash
export DATA_DIR=/tmp/acesio-e2e ADMIN_PASSWORD=admin-pass-123
rm -rf "$DATA_DIR"
npm run seed:demo        # CATAT password yang dicetak. Hanya tampil sekali.
npm start                # port 3000
```

`seed:demo` hanya mau jalan pada database kosong dan tanpa `NODE_ENV=production`. Ia mencetak seperti ini:

```
Akun baru   : <username user demo, dipisah koma>
Password    : <acak>   (acak, hanya tampil sekali ini; catat sekarang)
```

Seed juga mencetak ringkasan jadwal, mis. `Jadwal : 9 untuk hari ini (4 baru, 2 berjalan, 2 selesai, 1 batal), 1 untuk besok.` Ketiga akun user demo (sari, budi, dewi) memakai **satu password acak yang sama**; di bawah disebut `<user-demo>` dan `<password-seed>`. Akun supervisor: `admin` / `admin-pass-123` (dari `ADMIN_PASSWORD` di atas; bila belum ada, seed yang membuatnya).

> **Jam akses.** Login user hanya bisa pukul 06.00–22.59 (zona `APP_TZ`). Bila Anda menguji di luar jam itu, login user ditolak. Itu perilaku yang benar (skenario E); untuk menguji skenario lain, jalankan server dengan `ACCESS_HOURS=off npm start`.
>
> **Jadwal demo dibuat untuk tanggal saat seed dijalankan.** Bila server baru dinyalakan keesokan harinya, jadwal "hari ini" itu sudah lewat (tampil *Terlewat*). Hapus `DATA_DIR` dan seed ulang, atau buat jadwal baru lewat tab **Jadwal** sebagai supervisor. Jika Anda menjalankan seed ulang pada database yang sama, seed menolak (kecuali `--force` dengan ketikan `SAYA YAKIN`); hapus `DATA_DIR` untuk mulai bersih.

Buka http://localhost:3000 di Chrome dan satu browser lain. DevTools → Network dan Console harus terbuka; **Console harus tetap bersih** di semua skenario.

## Skenario otomatis alur baru (v1.3.0)

`node test/e2e/user-flow.mjs` menjalankan semuanya sendiri (server sementara, akun dan jadwal lewat API, jam akses dimatikan kecuali pada skenario E). Cara menjalankan: pasang Playwright + Chromium (bukan dependensi repo), lalu `NODE_PATH=<folder node_modules global> node test/e2e/user-flow.mjs`. Skrip ini tidak ikut `npm test`; di luar itu cukup `node --check test/e2e/user-flow.mjs`. Skenario manual di bawah memeriksa hal yang sama dengan mata manusia (tata letak, ponsel).

## A. Alur utama: Beranda, Jadwal Saya, SOAP

1. Supervisor (tab **Jadwal**) membuat tiga jadwal hari ini untuk `<user-demo>`: 09:00 customer X dengan 2 layanan dan catatan, 10:00 customer Y dengan 1 layanan, 11:00 customer X lagi dengan 1 layanan; plus satu jadwal besok.
2. Login `<user-demo>`. **Diharapkan:** tab awal **Beranda**; urutan menu *Beranda, Jadwal Saya, Riwayat Customer* (isi SOAP tidak punya menu; dibuka setelah approve tugas); angka **2** (customer unik, jadwal besok tidak dihitung) dan lonceng dengan jumlah belum dibaca.
3. Ketuk angka. **Diharapkan:** Jadwal Saya hari ini dengan 3 baris; tiap baris memuat jam, customer, No RM, dan ringkasan layanan.
4. Ketuk baris 09:00. **Diharapkan:** halaman **Input customer** terbuka; customer, layanan (2), dan catatan admin sudah tampil dan **tidak bisa diubah**; **tidak ada** kolom pencarian No RM maupun kotak layanan; **Simpan nonaktif**. Di tab Jadwal supervisor, jadwal itu kini **Sedang dijalani**.
5. Isi satu bagian dengan 2 karakter lalu pindah kolom: pesan bahwa minimal 3 karakter. Isi keempat bagian (S, O, A, P) lalu **Simpan**. **Diharapkan:** toast "SOAP tersimpan", kembali ke Jadwal Saya, baris itu **Selesai**; Riwayat Customer menampilkan customer X dengan 2 layanan; Beranda menghitung 1 Selesai.
6. Supervisor membuka detail jadwal itu: SOAP terlihat. Daftar jadwal tidak menampilkan SOAP.
7. Pindah tab di tengah pengisian lalu kembali lewat Jadwal Saya: draf pulih. **Keluar** lalu masuk lagi: draf kosong.
8. Buka tab **Input Customer** langsung. **Diharapkan:** "Pilih jadwal dulu" dengan tombol ke Jadwal Saya.

## B. Filter tanggal dan jadwal bukan hari ini

1. Di Jadwal Saya, bawaan hanya hari ini. Ketuk **Semua**: jadwal besok ikut tampil, dikelompokkan per tanggal, dan tanggal hari ini bertanda *Hari ini*. Coba **Besok**, **7 hari ke depan**, dan panah hari sebelumnya/berikutnya.
2. Ketuk jadwal besok. **Diharapkan:** hanya pesan bahwa jadwal tidak untuk hari ini; halaman input tidak terbuka dan status tetap Baru.
3. Jadwal hari lampau yang belum selesai (buat dengan menunggu pergantian hari, atau ubah tanggal langsung di database uji) tampil **Terlewat** dan hanya bisa dilihat.
4. Jadwal Selesai: ketuk untuk melihat rincian (layanan dan SOAP) tanpa bisa mengubah.

## C. Lonceng notifikasi

1. Saat login ada lencana jumlah belum dibaca. Buka lonceng: daftar *Tugas baru* dengan customer, tanggal, dan jam.
2. **Tandai semua dibaca**: lencana hilang. Tutup dengan `Esc` atau klik di luar; fokus kembali ke lonceng.
3. Supervisor mengubah jadwal Baru milik user: user menerima *Jadwal diubah* (daftar dimuat ulang tiap panel dibuka; lencana menyusul lewat pemeriksaan berkala sekitar 45 detik). Supervisor membatalkan jadwal: *Tugas dibatalkan*. Mengganti user pada jadwal: user lama menerima pembatalan, user baru tugas baru.
4. User memulai dan menyelesaikan jadwal: muncul *Tugas sedang dijalani* dan *Tugas selesai*.
5. Ketuk satu notifikasi: Jadwal Saya terbuka pada tanggal jadwal itu dan notifikasi bertanda dibaca.
6. Navigasi keyboard: Tab ke lonceng, Enter membuka, Tab berpindah di dalam panel, `Esc` menutup. Pembaca layar menyebut jumlah belum dibaca.

## D. Admin membuat jadwal dengan layanan

1. Tab **Jadwal** (supervisor dan admin). **Tambah jadwal** tanpa memilih layanan: ditolak dengan pesan. Pilih 29 layanan: diterima; 30 tidak mungkin (hanya ada 29 kotak).
2. Tanggal kemarin ditolak. Jam selesai sebelum jam mulai ditolak.
3. **Ubah** jadwal Baru (ganti layanan, jam, user). Pada jadwal Sedang dijalani atau Selesai tombol ubah tidak tersedia; bila dipaksa lewat API: 409 `SCHEDULE_STATE`.
4. **Batalkan**: admin hanya pada jadwal Baru; supervisor juga pada jadwal Sedang dijalani.
5. Admin tidak pernah melihat angka komisi di layar mana pun.

## E. Jam akses user

1. Otomatis: skrip memajukan jam server palsu (`APP_FAKE_NOW_FILE`, hanya berlaku dengan `NODE_ENV=test`) ke 23.30: login user ditolak dengan pesan *pukul 06.00–23.00*; admin tetap bisa login. Jam dimundurkan ke 10.00: user masuk. Jam dimajukan ke 23.05: aksi berikutnya mengembalikan user ke layar login dengan pesan jam akses.
2. Manual: jalankan server dengan `ACCESS_HOURS` yang jendelanya tidak mencakup jam sekarang (mis. `ACCESS_HOURS=03:00-03:30` bila sekarang siang). Login user ditolak dengan pesan jelas di layar login; login supervisor tetap berhasil.
3. Jalankan dengan `ACCESS_HOURS=off`: user bisa masuk kapan saja.
4. `APP_FAKE_NOW_FILE` tanpa `NODE_ENV=test` **tidak** berpengaruh (jam asli dipakai). Pastikan variabel itu tidak ada di berkas lingkungan produksi.

## #6: tab bercampur dan hasil permintaan basi menimpa tampilan

Kode lama: bila user pindah ke "Riwayat Customer" saat data tab sebelumnya masih memuat, tampilan tab sebelumnya muncul di bawah halaman riwayat (dua judul dalam satu halaman). Tampilan async menulis ke `main` setelah `await` tanpa memeriksa apakah tab masih aktif. Seharusnya `shell.select` memberi `ctx = {signal, isCurrent()}` dan hasil basi dibuang bila `isCurrent()` false; `api(path, {signal})` membatalkan fetch.

0. Otomatis: `node test/e2e/user-flow.mjs` (Playwright, bukan bagian `npm test`) menunda `/api/my/schedules` 1,5 detik, membuka Jadwal Saya lalu langsung pindah ke Riwayat Customer, dan memastikan daftar jadwal tidak muncul di sana.
1. Login sebagai supervisor. DevTools → Network → throttling **Slow 3G**.
2. Klik **Laporan**, dan **sebelum selesai memuat** klik **Customer**, lalu cepat klik **Akun User**.
3. Tunggu semua permintaan selesai. **Diharapkan:** layar akhir adalah **Akun User** saja; tidak ada kartu atau tabel Laporan/Customer yang muncul belakangan; Network menampilkan permintaan sebelumnya *canceled*.
4. Di Customer: ketik pencarian "rina", segera ubah menjadi "dimas". **Diharapkan:** hasil akhir sesuai "dimas", bukan "rina" yang datang terlambat.
5. Klik halaman 2 lalu 1 dengan cepat: nomor halaman dan isi tabel konsisten.
6. Console tidak boleh menampilkan `AbortError` yang tidak tertangani atau `TypeError` dari elemen yang sudah dilepas.

## #9: unduhan tidak menangani sesi habis

Kode lama: tombol CSV/Excel berupa `<a download href>`. Bila sesi sudah habis, browser mengunduh berkas JSON error atau tidak terjadi apa-apa, dan pengguna tidak dikembalikan ke login. Seharusnya `downloadFile(url, filename)` memakai fetch + blob, 401 memicu `hooks.onUnauthorized`, error lain muncul sebagai toast.

1. Login sebagai supervisor, buka Laporan.
2. Di tab lain, login sebagai akun yang sama lalu **ganti password** (ini mencabut sesi lain), atau hapus cookie `acesio_sid` lewat DevTools → Application → Cookies.
3. Kembali ke tab pertama, klik **CSV**.
4. **Diharapkan:** layar kembali ke halaman login dengan pesan "Sesi berakhir…"; tidak ada berkas terunduh. **Gagal bila:** berkas `.csv` berisi `{"error":…}` terunduh, atau tidak ada reaksi.
5. Ulangi dengan server dimatikan (`Ctrl+C`) lalu klik **Excel**. **Diharapkan:** toast error berbahasa Indonesia, halaman tidak rusak.
6. Pada sesi sehat, unduh CSV dan Excel dari Laporan, dari Customer, dan dari Riwayat Customer (login `<user-demo>`): nama berkas sesuai dan dapat dibuka.

## #10: pesan 413 dan galat jaringan tidak jelas

Kode lama: body terlalu besar membuat koneksi diputus tanpa respons, sehingga klien hanya melihat galat jaringan umum. Seharusnya server membalas 413 JSON dan klien menampilkan "File terlalu besar. Perkecil ukuran file lalu coba lagi."; 429 membaca `Retry-After`; offline dan timeout punya pesan sendiri.

1. Login sebagai supervisor, buka Customer, klik impor, lalu pilih berkas CSV/Excel **lebih dari 30 MB** (mis. `head -c 35000000 /dev/zero > besar.csv`).
2. **Diharapkan:** toast "File terlalu besar. Perkecil ukuran file lalu coba lagi."; halaman tetap berfungsi. **Gagal bila:** pesan generik "gagal terhubung" atau tidak ada reaksi.
3. Di tab Customer cari berulang cepat (lebih dari 60 per menit) sebagai user: toast menyebut berapa detik harus menunggu (dari `Retry-After`).
4. DevTools → Network → **Offline**, lalu klik tab apa pun: pesan "Kamu sedang offline…" dan tombol coba lagi tidak merusak halaman.

## #11: modal tertinggal saat sesi habis atau ganti akun

Kode lama: hanya `renderLogin` yang menghapus `.overlay`; modal yang dibuka dari jalur lain bisa tertinggal di atas layar login atau di sesi akun berikutnya. Seharusnya `closeAllModals()` dipanggil pada logout dan `onUnauthorized`.

1. Login sebagai supervisor, buka modal **Akun saya** (klik nama di pojok kanan atas) dan biarkan terbuka.
2. Dari tab lain, cabut sesi (ganti password akun yang sama, atau hapus cookie), lalu di tab pertama lakukan aksi yang memanggil API (klik tab menu atau tombol Simpan di modal).
3. **Diharapkan:** layar login muncul **tanpa** modal tersisa; fokus keyboard tidak terjebak di elemen yang sudah hilang.
4. Ulangi dengan modal berlapis (Detail user → konfirmasi Approve) lalu **Keluar**. Login sebagai user lain: tidak ada modal akun sebelumnya yang muncul.
5. Tekan `Esc` di layar login: tidak ada error di Console.

## Tambahan: zona waktu klien tertanam `Asia/Jakarta`

Kode lama: `ui.js` memakai `TZ = 'Asia/Jakarta'` dan `+07:00` permanen; server memakai `APP_TZ`. Jika `APP_TZ` lain, "hari ini" di klien dan server berbeda. Seharusnya `todayInTz()` memakai `tz` dari `/api/auth/me` atau respons login (`jakartaToday` tetap diekspor sebagai alias).

1. Hentikan server, jalankan dengan zona yang **tanggalnya berbeda dari Jakarta saat Anda menguji**: `APP_TZ=Pacific/Auckland` (sekitar 6 jam di depan WIB) bila Anda menguji antara 18:00–24:00 WIB, atau `APP_TZ=America/Los_Angeles` (sekitar 14–15 jam di belakang WIB) bila antara 00:00–14:00 WIB. Di luar jendela itu tanggalnya sama dan skenario tidak membuktikan apa-apa.
2. Login sebagai `<user-demo>`. Di Console: `await (await fetch('/api/auth/me')).json()` harus memuat `tz` sesuai zona yang Anda pilih.
3. Sebagai supervisor buat jadwal **hari ini** (menurut server) untuk `<user-demo>`; sebagai user jalankan dan selesaikan jadwal itu (isi SOAP). Buka Riwayat Customer: tanggal item **sama** dengan "hari ini" menurut server dan tombol hapus tersedia untuk item itu. Beranda dan Jadwal Saya juga menampilkan jadwal itu sebagai hari ini. Kolom hari di Laporan/Detail user menampilkan tanggal yang benar, bukan bergeser sehari.
4. **Gagal bila:** filter periode bawaan ("hari ini") kosong padahal data baru saja diinput, jadwal hari ini tampil sebagai *Terlewat* atau *bukan untuk hari ini*, atau tanggal bergeser satu hari. Jam akses juga mengikuti zona ini: pada `APP_TZ` yang jamnya di luar 06.00–23.00 saat Anda menguji, login user akan ditolak (gunakan `ACCESS_HOURS=off`).
5. Kontrol: ulangi dengan `APP_TZ` default (Jakarta); hasilnya harus tetap benar.

## Tambahan: daftar customer ringkas (Riwayat user dan Approve)

Riwayat Customer (user) dan Detail user (admin/supervisor, bagian approve) menampilkan **satu baris per customer**. Baris memuat tanggal (hanya di riwayat user), No RM, nama, No WA, dan jumlah layanan. Klik baris untuk membuka rincian yang **hanya berisi layanan** (nama layanan, jam, komisi untuk supervisor, tombol hapus bila boleh).

1. Supervisor membuat satu jadwal hari ini dengan 3 layanan untuk `<user-demo>`. Login `<user-demo>`, jalankan dan selesaikan jadwal itu (isi SOAP), lalu buka **Riwayat Customer**.
2. **Diharapkan:** satu baris untuk customer itu dengan "3 layanan"; tidak ada baris ganda; rincian tertutup.
3. Klik baris: muncul 3 layanan tanpa mengulang No RM, nama, atau No WA. Klik lagi: tertutup. Tab dan Enter/Spasi juga membuka baris.
4. Hapus satu layanan dari rincian: daftar dimuat ulang, baris tetap terbuka dan menjadi "2 layanan". Layanan hari lampau atau yang sudah di-approve menampilkan "Terkunci".
5. Login supervisor, buka Laporan, klik user itu: bagian **Data pelayanan** juga satu baris per customer, dengan total komisi di baris dan komisi per layanan di rincian. Tombol Approve tidak berubah.
6. Perkecil jendela (lebar ponsel): baris menyusun nama di atas, No RM dan No WA di bawah, tanpa tabel yang memotong isi.

## Catatan

- Saat satu skenario gagal, catat: langkah, browser, hasil nyata, tangkapan Network/Console, dan commit.
- Skenario #6, #9, #10, #11, zona waktu, dan A, B (sebagian), C (sebagian), E sudah otomatis di `user-flow.mjs`; sisanya (tata letak ponsel, pembaca layar, sisi supervisor) tetap manual. Skrip diuji hanya dengan Chromium.
