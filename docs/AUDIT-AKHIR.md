# Audit akhir (kode gabungan Fase 1-4)

## 0. Cakupan dan bukti

Audit ini atas **kode gabungan lengkap** (semua 9 paket kerja), bukan per akun.

**Dijalankan, hasilnya nyata:**

- `npm run check`: 43 berkas, 0 gagal.
- `npm test`: 140 tes, 140 lulus, 0 gagal.
- Pemindai impor bernama (seluruh `server/`, `scripts/`, `test/`, `public/`): tidak ada nama yang diimpor tetapi tidak diekspor.
- Uji asap ke server nyata: login, `/api/auth/me` memuat `tz`, endpoint staff dan `GET /api/sv/audit` 200, ETag dan `no-cache` pada berkas statis, `/api/nope` 404, body `null` 400, impor customer 2,9 MB melewati batas body (ditolak 400 oleh batas 20.000 baris, sesuai desain), body 32 MB menghasilkan 413 JSON.
- `scripts/backup.js`: membuat salinan `VACUUM INTO`, mempertahankan `--keep` terbaru, salinan bisa dibuka dengan `user_version = 4`.

**Tidak dijalankan:** skrip Playwright `test/e2e/user-flow.mjs` dan skenario manual `test/e2e/README.md` (perlu browser). Klien hanya diperiksa lewat `node --check`, pemindai impor, dan pencarian pola (`fetch(` di luar `api.js`, `<a download>`, `/api/admin`, `Asia/Jakarta`, `ctx.isCurrent`). Isi tampilan klien tidak dibuka di browser.

## 1. Pemetaan temuan rencana ke tes

| ID | Temuan | Tes |
|---|---|---|
| #1 | User menghapus data hari lampau | `test/regression-audit.test.mjs` "#1 user tidak bisa menghapus data hari lampau ..." |
| #2 | Ganti password tidak mencabut sesi lain | "#2 ganti password mencabut sesi lain ..." |
| #3 | Lockout, username raksasa, event loop | "#3 lockout per ip+username ..." |
| #4 | Data ganda | "#4 dua POST dengan Idempotency-Key sama ..." |
| #5 | Seed berbahaya | "#5 seed-demo menolak database yang sudah berisi data" |
| #6 | Tab bercampur | manual + `test/e2e/user-flow.mjs`; `test/e2e/README.md` bagian #6 |
| #7 | Pencarian salah | "#7 pencarian riwayat \"Layanan 9\" ..." |
| #8 | Apostrof merusak nama | "#8 nama \"-Andi\" utuh ..." |
| #9 | Unduhan | manual; README e2e bagian #9 |
| #10 | Pesan 413 | manual; README e2e bagian #10 (sisi server: R5) |
| #11 | Modal | manual; README e2e bagian #11 |
| R1 | Body bukan objek | "R1 ..." |
| R2 | Cookie rusak | "R2 ..." |
| R3 | URL `//` | "R3 ..." |
| R4 | XLSX `ZZZZZZ1` | "R4 ..." |
| R5 | Body terlalu besar | "R5 ..." |

## 2. Sisa temuan, urut keparahan

Tidak ada temuan tingkat tinggi yang saya temukan pada apa yang dijalankan di atas. Sisa berikut semuanya tingkat sedang ke rendah.

| # | Keparahan | Apa | Di mana | Cara menguji |
|---|---|---|---|---|
| A | Sedang | Perilaku klien (tab bercampur, unduhan, modal, 413, zona waktu) belum terbukti di browser | `public/js/*`, `test/e2e/` | Jalankan `node test/e2e/user-flow.mjs` dan skenario `test/e2e/README.md` sebelum rilis |
| B | Rendah | Throttle login dan limiter pencarian ada di memori proses: reset saat restart, dan tidak dibagi antar proses. Aman untuk satu proses (asumsi dokumen ini) | `server/ratelimit.js`, `server/auth.js` | Restart server setelah 8 login gagal; kunci hilang |
| C | Rendah | `audit_log` tidak punya retensi dan terus bertambah | `server/db.js` (tidak ada `DELETE FROM audit_log`) | Isi jutaan baris; pantau ukuran DB. Cadangkan dan pangkas manual bila perlu |
| D | Rendah | `periodWhere` mengabaikan diam-diam tanggal tidak valid. Aman sekarang karena semua pemanggil (`history.js`, `staff-report.js`) memvalidasi dulu; pemanggil baru bisa lupa | `server/routes/helpers.js:38-39` | Panggil dari rute baru tanpa validasi, lalu `from=ngawur` menghasilkan 200 |
| E | Rendah | Zona waktu bawaan `Asia/Jakarta` tersisa di server sebagai nilai default `APP_TZ` (bukan hardcode klien) | `server/clock.js:1`, `server/util.js:40`, `server/routes/auth.js:6`, `scripts/backup.js:34` | Jalankan dengan `APP_TZ=Pacific/Auckland`; `/api/auth/me` memuat `tz` itu |
| F | Rendah | Batas yang diterima dengan sadar: pencarian No RM terbuka untuk semua terapis, satu API key bot, satu berkas SQLite pada satu server | `SECURITY.md` | Bukan cacat |

## 3. Pemeriksaan khusus

- **Impor antar-berkas:** semua nama yang diimpor ada di berkas tujuannya, termasuk `LIMITS` (dari `routes/index.js`), `requireWorker` dan `resolveCustomer` (dari `routes/helpers.js`).
- **Registrasi rute:** semua rute lama masih ada, termasuk `POST` dan `DELETE /api/records` (dicakup tes inventaris endpoint di `core.test.mjs`).
- **Opsi `{limit}`:** terpasang pada `POST /api/staff/customers/import` (`LIMITS.import`) dan upload foto layanan di `sv.js` (`LIMITS.image`).
- **Audit perubahan data supervisor:** `service.update`, `commission.update`, `account.create`, `account.update`, `review.cancel`, `record.delete`, `review.approve`, `review.change`, `customer.*` tercatat melalui `logAudit`.
- **Tanpa dependensi baru:** `package.json` tidak memiliki `dependencies`.
