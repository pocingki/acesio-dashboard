# Integrasi API dan WhatsApp

Dua arah, keduanya diuji di lingkungan tiruan (`test/integration.test.mjs`, `test/fase5-alur.test.mjs`, `test/idempotency-commission.test.mjs`). Jangan mengirim pesan ke nomor sungguhan dari tes.

## Peran

| Peran | Yang boleh |
|---|---|
| Terapis (`user`) | Beranda, jadwal sendiri, mulai tugas, isi SOAP, riwayat customer sendiri, profil |
| Admin | Laporan, customer, jadwal, approve ketepatan waktu (sekali), approve tugas |
| Supervisor | Semua yang admin bisa, plus komisi, akun, layanan, log audit, sambungan WhatsApp, mengubah atau membatalkan approve kehadiran |
| Bot | Hanya `/api/bot/*` dengan `X-API-Key`. Tidak melihat SOAP dan tidak melihat komisi |

Pemeriksaan peran ada di server, bukan hanya di menu. Admin tidak membuka `/api/sv/*`. Terapis tidak membuka API staf.

Approve kehadiran (`day_reviews`) dan approve tugas (jadwal menjadi Selesai) berdiri sendiri. Yang satu tidak mengunci atau menggandakan yang lain. Hari yang sudah di-approve kehadirannya menolak pencatatan layanan baru pada hari itu.

## API bot (pesan masuk)

Aktif hanya bila `BOT_API_KEY` terisi. Kosong = 503. Header `X-API-Key`. Key salah = 401. Sepuluh key salah per menit per IP = 429, dan selama diblokir key yang benar dari IP itu juga ditolak.

Tidak ada webhook tanpa tanda tangan. `POST /api/webhook` membalas 404.

| Metode | Path | Arti |
|---|---|---|
| GET | `/api/bot/services` | Layanan aktif, tanpa komisi |
| GET | `/api/bot/customers?rm=` atau `?phone=` atau `?q=` | Cari customer. Nomor dinormalisasi ke `62…` |
| GET | `/api/bot/customers/:id/history` | Riwayat layanan. Tanpa SOAP |
| POST | `/api/bot/records` | Catat layanan atas nama `username` terapis |

Body catat:

```json
{"username":"budi","customer_rm":"RM-001","service_ids":[1],"request_id":"wa-msg-8f31c2a9","schedule_id":12}
```

- `request_id` atau header `Idempotency-Key` wajib, 8–100 karakter. Pengiriman ulang mengembalikan hasil pertama dan header `Idempotent-Replay: true`.
- ID yang sama dengan isi berbeda: 409 `IDEMPOTENCY_CONFLICT`.
- `schedule_id` mengikat pesan ke satu jadwal, jadi bot dan approve tugas hanya satu komisi.
- Customer yang belum ada: 404. Bot tidak membuat customer.
- `service_ids` wajib. Data diperiksa sebelum disimpan; kegagalan di tengah tidak meninggalkan komisi separuh.
- Timeout klien tidak membuat baris ganda bila `request_id` yang sama dipakai lagi.

## WhatsApp keluar

Supervisor menyambungkan dari menu **Pengaturan → Integrasi**. Kode `AMN1.…` atau kunci `amk_…`. Alamat `http://` hanya untuk IP loopback atau LAN yang ditulis langsung. Nama domain yang mengarah ke jaringan internal ditolak. Pengalihan tidak diikuti. Batas waktu panggilan 10 detik.

Yang dikirim: nama, No RM, jumlah kunjungan, nama layanan, dan ucapan bila dinyalakan. SOAP kunjungan, catatan awal customer, komisi, dan nama terapis tidak ikut.

Antrean `integration_outbox` ditulis dalam transaksi yang sama dengan pencatatan. WhatsApp mati, timeout, 500, atau 401 tidak menggagalkan pencatatan. Ulangan: 30 detik, 2 menit, 10 menit, 1 jam, 6 jam, lalu status `failed`. 400 dicatat gagal tetap. 403 `BLOCKED` dilewati. Tombol kirim ulang memakai `Idempotency-Key` yang sama supaya gateway tidak menggandakan pesan. Ucapan paling sekali per customer per hari. Nomor tidak valid tidak dikirim.

Kunci akses disegel di database. Kunci enkripsi ada di `DATA_DIR/integration.key`, terpisah dari backup `.db`. Respons dan log audit tidak menampilkan kunci.

Kontrak panggilan: `GET /api/v1/ping`, `PUT /api/v1/contacts/{phone}`, `POST /api/v1/events`, `POST /api/v1/messages`. Izin yang diminta: `leads:write`, `events:write`, dan `messages:send` bila ucapan dinyalakan.
