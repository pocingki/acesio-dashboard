# Skema database

SQLite satu berkas: `DATA_DIR/acesio.db`. `PRAGMA user_version` saat ini **4**. Migrasi hanya menaikkan versi, di dalam transaksi, dan tidak menurunkan database yang lebih baru. Kolom yang ditambah setelah versi 4 memakai `ALTER TABLE` yang aman dijalankan berulang, tanpa menaikkan nomor versi.

## Versi

| Versi | Isi |
|---|---|
| 1 | Akun admin punya akses penuh, komisi menempel di layanan |
| 2 | Admin lama menjadi supervisor. Komisi pindah ke `user_commissions` |
| 3 | Penyesuaian indeks dan kolom kerja harian |
| 4 | `audit_log` dan `idempotency_keys` |

Setelah versi 4, start tetap menambah bila belum ada: `customers.medical_note`, `idempotency_keys.fingerprint`, kolom profil user (`phone`, `email`, `birth_date`, `address`, `photo`, `job_title`, `join_date`), kolom jadwal `flow`, `due_at`, `approved_at`, `approved_by`, serta tabel jadwal, notifikasi, dan antrean WhatsApp.

## Tabel

| Tabel | Fungsi |
|---|---|
| `users` | Akun. `role` = `user`, `admin`, atau `supervisor` |
| `sessions` | Sesi login. Cookie hanya menyimpan id sesi |
| `customers` | Data customer. `medical_note` adalah catatan awal (kolom SOAP di tabel Customer) |
| `services` | Kotak layanan |
| `user_commissions` | Komisi per user per layanan |
| `records` | Satu baris per layanan tercatat. `batch` menyatukan satu kunjungan. `source` = `web` atau `bot` |
| `day_reviews` | Approve ketepatan waktu. Tidak menyimpan komisi |
| `schedules`, `schedule_services` | Jadwal dan layanan yang ditugaskan. SOAP kunjungan di `soap_s/o/a/p` |
| `notifications` | Notifikasi terapis |
| `audit_log` | Jejak aksi. Isi SOAP tidak disimpan di `detail` |
| `idempotency_keys` | Hasil permintaan yang boleh diulang. `fingerprint` menolak isi berbeda untuk id yang sama |
| `integration_settings` | Sambungan WhatsApp. Kunci akses tersegel, bukan teks polos |
| `integration_outbox` | Antrean kiriman. Payload tanpa SOAP |

`DATA_DIR/uploads/` dan `DATA_DIR/integration.key` bukan bagian dari berkas database. Backup dan pemulihan keduanya ada di [DEPLOY.md](DEPLOY.md).
