# Hasil pengujian final

Tanggal: 7 November 2026. Mesin: Windows. Perintah: `npm run check` dan `npm test`.

## Angka

| Pemeriksaan | Hasil |
|---|---|
| `npm run check` | 90 berkas, 0 gagal |
| `npm test` | 336 lulus, 0 gagal |

Audit lama mencatat 310 tes, 307 lulus, 3 gagal di Windows. Penyebab ketiganya ada di lingkungan tes, bukan di alur bisnis:

| Tes lama | Penyebab | Perlakuan |
|---|---|---|
| SIGTERM mengharapkan kode keluar 0 | Di Windows `child.kill('SIGTERM')` memakai TerminateProcess. Handler Node tidak dipanggil, jadi kalimat "Server ditutup" tidak tercetak | Penutupan rapi dibuktikan terpisah (keluar 0). Tes SIGTERM dari luar hanya menuntut kode 0 di Linux, tempat systemd mengirim sinyal sungguhan |
| `records` dan `reports` gagal menghapus folder tes (`EPERM`) | Berkas SQLite masih terkunci sesaat setelah proses anak berhenti | Koneksi ditutup, proses ditunggu, penghapusan diulang |

## Yang dibuktikan suite ini

- Approve kehadiran dan approve tugas tidak saling mengunci dan tidak menggandakan komisi.
- `request_id` yang sama, dua permintaan bersamaan, dan bot lalu approve pada jadwal yang sama hanya satu komisi.
- Produksi menolak `HOST` terbuka, cookie tidak Secure, `TRUST_PROXY` mati, `SESSION_TIMER=off`, dan jam palsu, sebelum database dibuat.
- Foto unggahan butuh sesi. SOAP tidak masuk WhatsApp, bot, atau log audit.
- API bot dan gateway WhatsApp tiruan: sukses, 400, 401, 403, 500, timeout, server mati, dan kirim ulang tanpa antrean kedua.
- Backup `VACUUM INTO` saat server hidup lolos `integrity_check`, `user_version` 4, dan customer yang baru dicatat masih ada di salinan.

## Lingkungan yang tidak dijalankan di mesin ini

- Host Linux dan `systemctl`. Prosedurnya ada di [DEPLOY.md](DEPLOY.md). Sinyal SIGTERM sungguhan baru terjadi di sana.
- Reverse proxy Caddy atau Nginx yang benar-benar menerima HTTPS publik. Aplikasi menolak konfigurasi produksi yang tidak aman, dan HSTS hanya dipasang bila proxy menyatakan HTTPS.
- Nomor WhatsApp sungguhan. Kiriman diuji ke server HTTP lokal.

Tampilan desktop, tablet, dan ponsel (360–1920 px) untuk terapis, admin, dan supervisor sudah diperiksa pada pohon kerja yang sama sebelum putaran regresi ini. Putaran ini tidak mengubah layout.

## Sisa yang diterima, bukan temuan terbuka prioritas tinggi

- SOAP tetap teks di SQLite. Pembacanya memakai kolom itu langsung. Perlindungan: peran, izin folder, dan backup mode `600` bila sistemnya mendukung.
- Satu `BOT_API_KEY`. Rotasinya ada di panduan deploy.
- Backup database tidak memuat `uploads/` dan `integration.key`. Keduanya disalin dengan perintah terpisah di panduan pemulihan.

Tidak ada temuan P0. Temuan P1 audit (approve yang saling mengunci, komisi bot ganda, bind terbuka) sudah tertutup oleh tes di atas.
