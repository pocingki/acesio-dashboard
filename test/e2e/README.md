# Uji manual sisi klien (e2e)

Perilaku klien (DOM, fetch dari browser, zona waktu browser) tidak bisa diuji dengan `node --test` tanpa dependensi. Temuan klien **#6, #9, #10, #11** diuji dengan skenario di bawah. Jalankan sebelum rilis dan setiap kali `public/js/ui.js`, `api.js`, `shell.js`, atau tampilan apa pun di `public/js/` berubah.

> **Pemetaan.** Nomor mengikuti rencana perbaikan: #6 tab bercampur, #9 unduhan, #10 pesan 413, #11 modal. Skenario zona waktu adalah tambahan (kontrak G).

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

Ketiga akun user demo memakai **satu password acak yang sama**; di bawah disebut `<user-demo>` dan `<password-seed>`. Akun supervisor: `admin` / `admin-pass-123` (dari `ADMIN_PASSWORD` di atas). Jika Anda menjalankan seed ulang pada database yang sama, seed menolak (kecuali `--force` dengan ketikan `SAYA YAKIN`); hapus `DATA_DIR` untuk mulai bersih.

Buka http://localhost:3000 di Chrome dan satu browser lain. DevTools → Network dan Console harus terbuka; **Console harus tetap bersih** di semua skenario.

## #6: tab bercampur dan hasil permintaan basi menimpa tampilan

Kode lama: bila user pindah ke "Riwayat Customer" saat `/api/services` masih memuat, grid layanan dan panel input muncul di bawah halaman riwayat (dua judul dalam satu halaman). Tampilan async menulis ke `main` setelah `await` tanpa memeriksa apakah tab masih aktif. Seharusnya `shell.select` memberi `ctx = {signal, isCurrent()}` dan hasil basi dibuang bila `isCurrent()` false; `api(path, {signal})` membatalkan fetch.

0. Otomatis: `node test/e2e/user-flow.mjs` (Playwright, bukan bagian `npm test`) menunda `/api/services` 1,5 detik, berpindah ke Riwayat Customer, dan memastikan tidak ada `.svc-grid` di sana.
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
3. Input satu layanan. Buka Riwayat Customer: tanggal item **sama** dengan "hari ini" menurut server dan tombol hapus tersedia untuk item itu. Kolom hari di Laporan/Detail user menampilkan tanggal yang benar, bukan bergeser sehari.
4. **Gagal bila:** filter periode bawaan ("hari ini") kosong padahal data baru saja diinput, atau tanggal bergeser satu hari.
5. Kontrol: ulangi dengan `APP_TZ` default (Jakarta); hasilnya harus tetap benar.

## Tambahan: daftar customer ringkas (Riwayat user dan Approve)

Riwayat Customer (user) dan Detail user (admin/supervisor, bagian approve) menampilkan **satu baris per customer**. Baris memuat tanggal (hanya di riwayat user), No RM, nama, No WA, dan jumlah layanan. Klik baris untuk membuka rincian yang **hanya berisi layanan** (nama layanan, jam, komisi untuk supervisor, tombol hapus bila boleh).

1. Login `<user-demo>`, input 3 layanan untuk satu customer, lalu buka **Riwayat Customer**.
2. **Diharapkan:** satu baris untuk customer itu dengan "3 layanan"; tidak ada baris ganda; rincian tertutup.
3. Klik baris: muncul 3 layanan tanpa mengulang No RM, nama, atau No WA. Klik lagi: tertutup. Tab dan Enter/Spasi juga membuka baris.
4. Hapus satu layanan dari rincian: daftar dimuat ulang, baris tetap terbuka dan menjadi "2 layanan". Layanan hari lampau atau yang sudah di-approve menampilkan "Terkunci".
5. Login supervisor, buka Laporan, klik user itu: bagian **Data pelayanan** juga satu baris per customer, dengan total komisi di baris dan komisi per layanan di rincian. Tombol Approve tidak berubah.
6. Perkecil jendela (lebar ponsel): baris menyusun nama di atas, No RM dan No WA di bawah, tanpa tabel yang memotong isi.

## Catatan

- Saat satu skenario gagal, catat: langkah, browser, hasil nyata, tangkapan Network/Console, dan commit.
- Skenario ini sengaja manual. Jika kelak ada Playwright, tiap bagian di sini dapat dipindah menjadi satu berkas spesifikasi bernama `e6`, `e9`, `e10`, `e11`.
