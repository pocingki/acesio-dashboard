# Keamanan

## Model ancaman

Aplikasi dipakai oleh staf klinik (terapis, admin, supervisor) lewat browser, dan oleh satu WA bot lewat API. Data yang dilindungi: data customer (nama, No WA, tanggal lahir, No RM), riwayat layanan, dan angka komisi.

| Penyerang | Yang dijaga |
|---|---|
| Orang di internet tanpa akun | Tebak password, banjir login, request cacat yang menjatuhkan server |
| Terapis (user) yang nakal atau akunnya dibajak | Tidak boleh melihat komisi, mengubah/hapus data hari lampau, atau memakai fitur admin/supervisor |
| Admin | Tidak melihat komisi, tidak bisa menghapus data input, tidak bisa mengatur akun atau komisi |
| Halaman web pihak ketiga | Tidak boleh memicu aksi atas nama staf yang sedang login (CSRF) |
| Orang yang bisa mengirim file | Upload CSV/XLSX tidak boleh menghabiskan memori atau menjalankan formula di Excel |

Kontrol yang ada:

- **Login**: password disimpan dengan scrypt (asinkron, tidak memblokir server). Percobaan gagal dibatasi per kombinasi IP + username, sehingga satu akun yang diserang tidak mengunci akun lain. Ganti password mencabut semua sesi lain milik akun itu.
- **Sesi**: cookie `HttpOnly`, `SameSite=Lax`, `Secure` bila HTTPS. Tidak ada token di URL.
- **CSRF**: request yang mengubah data wajib `Content-Type: application/json` (form lintas situs tidak bisa mengirimnya tanpa preflight), ditambah `SameSite=Lax`.
- **Otorisasi**: dicek di server pada setiap rute (`public`, `user`, `staff`, `sv`, `bot`). Komisi hanya ikut dikirim untuk supervisor.
- **Aturan hapus**: user hanya menghapus data miliknya, hari ini (zona `APP_TZ`), belum di-approve. Supervisor boleh menghapus apa saja dan setiap penghapusan tercatat di `audit_log`.
- **Anti data ganda**: `Idempotency-Key` pada `POST /api/records`.
- **Ekspor**: sel CSV yang diawali karakter formula dinetralkan; sel XLSX ditulis sebagai teks.
- **Klien**: CSP ketat (`script-src 'self'`, tanpa inline), semua teks pengguna dimasukkan lewat `textContent`, bukan `innerHTML`.
- **Proxy**: `X-Forwarded-For` dan `X-Forwarded-Proto` hanya dipercaya bila `TRUST_PROXY=true`.
- **Input**: body JSON harus objek, ukuran dibatasi (413), URL dan cookie rusak ditolak 400/401, XLSX dengan sel di luar jangkauan ditolak.

## Batasan yang disengaja

Ini keputusan desain, bukan kelalaian. Jangan dilaporkan sebagai celah kecuali Anda menemukan cara memperluasnya.

1. **Pencarian No RM terbuka untuk semua terapis.** Terapis harus bisa mencari customer lewat No RM saat input. Pencarian mengembalikan hanya No RM dan nama (maksimal 8 hasil, 60 permintaan per menit per user), tidak ada nomor WA atau data medis. Konsekuensinya, terapis yang gigih tetap bisa mengumpulkan daftar No RM + nama pelan-pelan. Pembatasan laju memperlambat, tidak mencegah.
2. **Satu API key untuk bot** (`BOT_API_KEY`). Siapa pun yang memegang key bisa membaca customer dan mencatat layanan atas nama terapis mana pun. Tidak ada key per bot, per terapis, atau kedaluwarsa otomatis. Mitigasi: simpan key hanya di server bot, rotasi berkala (lihat docs/DEPLOY.md), dan pantau lonjakan data `source = bot`.
3. **Foto layanan di `/uploads/` dapat dibuka tanpa login.** Isinya hanya gambar kotak layanan, bukan data customer. Jangan mengunggah foto yang berisi data pribadi.
4. **Tanpa 2FA.** Perlindungan akun bergantung pada password dan pembatasan percobaan.
5. **Sesi berlaku `SESSION_HOURS` (default 12 jam)** dan tidak diperpanjang otomatis.
6. **Log audit ada di database yang sama.** Siapa pun yang punya akses tulis ke berkas database bisa mengubahnya. Backup luar server menjaga salinan yang tidak bisa disentuh.
7. **Rate limit disimpan di memori proses.** Restart server mengosongkannya; menjalankan beberapa proses berarti setiap proses punya hitungan sendiri.

## Cara melapor

Mohon **jangan** membuka issue publik untuk celah keamanan.

- Gunakan *Report a vulnerability* di tab *Security* repositori ini bila fiturnya aktif, atau
- hubungi pemilik repositori secara langsung dan privat.

> TODO pemilik repositori: tuliskan alamat email/kontak keamanan yang sebenarnya di sini sebelum rilis. Berkas ini sengaja tidak memuat alamat karangan.

Sertakan: langkah mereproduksi, versi/commit, dampak yang Anda perkirakan, dan (bila ada) usulan perbaikan. Jangan sertakan data customer asli di laporan.
