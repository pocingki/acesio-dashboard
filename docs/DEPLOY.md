# Panduan deploy

Contoh di bawah memakai Linux (Debian/Ubuntu), aplikasi di `/opt/acesio-dashboard`, data di `/var/lib/acesio`, backup di `/var/backups/acesio`. Sesuaikan path dan domain.

## 1. Prinsip

- Aplikasi **hanya mendengarkan 127.0.0.1**; yang terbuka ke internet adalah reverse proxy (Caddy atau Nginx) dengan TLS.
- `TRUST_PROXY=true` membuat aplikasi mempercayai `X-Forwarded-For` dan `X-Forwarded-Proto`. Itu aman **hanya** jika klien tidak bisa menyambung langsung ke port aplikasi. Kalau port 3000 terbuka ke luar sambil `TRUST_PROXY=true`, penyerang bisa memalsukan IP-nya dan menghindari pembatasan login. Karena itu `HOST=127.0.0.1` wajib, dan firewall jangan membuka port 3000.
- `COOKIE_SECURE=true` di produksi. Cookie selalu `HttpOnly` dan `SameSite=Lax`.
- `NODE_ENV=production` menolak start bila `HOST` bukan loopback, `COOKIE_SECURE` bukan `true`, `TRUST_PROXY` bukan `true`, `SESSION_TIMER=off`, atau `APP_FAKE_NOW_FILE` terisi.

## 2. Berkas lingkungan

`/etc/acesio/acesio.env` (izin `600`, pemilik `acesio`):

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/acesio
BACKUP_DIR=/var/backups/acesio
APP_TZ=Asia/Jakarta
ACCESS_HOURS=06:00-23:00
COOKIE_SECURE=true
TRUST_PROXY=true
SESSION_HOURS=12
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password panjang acak, hanya dipakai saat belum ada supervisor>
BOT_API_KEY=<hasil: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
```

**Zona waktu dan jam akses.** `APP_TZ` bukan sekadar tampilan: ia menentukan "hari ini" untuk jadwal (user hanya bisa menjalankan jadwal bertanggal hari ini), kunci data harian, dan **jam akses user**. Pakai nama zona IANA yang benar (mis. `Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`), jangan bergantung pada zona server. `ACCESS_HOURS` (`HH:MM-HH:MM`, bawaan `06:00-23:00`) membatasi **hanya akun role user**: boleh sampai 22:59:59, mulai 23:00:00 ditolak (403 `OUTSIDE_HOURS`) dan sesi yang sedang aktif dicabut pada permintaan berikutnya. `off` mematikan pembatasan; nilai yang salah diganti default dan peringatannya dicetak di log. Setelah mengubah `APP_TZ` atau `ACCESS_HOURS`, nyalakan ulang layanan (`sudo systemctl restart acesio`). Jadwal yang sudah dibuat tetap menyimpan tanggal teks `YYYY-MM-DD`, jadi mengganti `APP_TZ` di tengah jalan menggeser arti "hari ini" untuk jadwal yang belum jalan; ubah hanya saat tidak ada jadwal aktif.

**`APP_FAKE_NOW_FILE` khusus tes.** Variabel ini memalsukan jam server dan **hanya dibaca bila `NODE_ENV=test`**. Jangan pernah mengisinya di `acesio.env` produksi; pastikan `NODE_ENV=production` (atau tidak `test`) dan variabel itu tidak ada. Memeriksa cepat: `sudo grep -c APP_FAKE_NOW_FILE /etc/acesio/acesio.env` harus `0`.

```bash
sudo useradd --system --home /opt/acesio-dashboard --shell /usr/sbin/nologin acesio
sudo install -d -o acesio -g acesio -m 750 /var/lib/acesio /var/backups/acesio
sudo install -d -m 750 -o root -g acesio /etc/acesio
```

## 3. Caddy

`/etc/caddy/Caddyfile` (TLS otomatis lewat Let's Encrypt):

```caddyfile
dashboard.contoh.id {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	request_body {
		max_size 32MB
	}
	reverse_proxy 127.0.0.1:3000
}
```

`reverse_proxy` otomatis mengirim `X-Forwarded-For` (alamat klien sebenarnya) dan `X-Forwarded-Proto`, dan menimpa nilai kiriman klien kecuali Anda mengisi `trusted_proxies`. Jangan isi `trusted_proxies` kecuali di depan Caddy ada CDN/load balancer lain.

## 4. Nginx

```nginx
server {
    listen 80;
    server_name dashboard.contoh.id;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name dashboard.contoh.id;

    ssl_certificate     /etc/letsencrypt/live/dashboard.contoh.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dashboard.contoh.id/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Impor customer boleh sampai 30 MB (JSON base64). Bawaan Nginx hanya 1 MB.
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;   # menimpa, bukan menambah: nilai kiriman klien dibuang
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Sengaja memakai `$remote_addr`, bukan `$proxy_add_x_forwarded_for`: yang terakhir menambahkan ke header kiriman klien, sehingga klien bisa menyisipkan IP palsu di depan.

Sertifikat: `sudo certbot certonly --nginx -d dashboard.contoh.id`.

## 5. systemd

`/etc/systemd/system/acesio.service`:

```ini
[Unit]
Description=Acesio Dashboard
After=network.target

[Service]
Type=simple
User=acesio
Group=acesio
WorkingDirectory=/opt/acesio-dashboard
EnvironmentFile=/etc/acesio/acesio.env
# Cek lokasi Node dengan: command -v node  (harus 22.13 atau lebih baru)
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/acesio

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now acesio
journalctl -u acesio -f          # password supervisor acak (bila ADMIN_PASSWORD kosong) tercetak di sini sekali
```

Pembaruan: `git pull && npm run check && npm test && sudo systemctl restart acesio`.

## 6. Backup terjadwal

`/etc/cron.d/acesio-backup`:

```cron
# Setiap hari 02:15, simpan 14 backup terbaru. Aman saat server hidup (VACUUM INTO).
15 2 * * * acesio cd /opt/acesio-dashboard && DATA_DIR=/var/lib/acesio BACKUP_DIR=/var/backups/acesio /usr/bin/node --no-warnings scripts/backup.js --keep 14 >> /var/lib/acesio/backup.log 2>&1
```

Catatan penting:

- Backup database **tidak** menyertakan `/var/lib/acesio/uploads/` (foto layanan). Salin juga, misalnya `rsync -a /var/lib/acesio/uploads/ /var/backups/acesio-uploads/`.
- Database (dan backup-nya) memuat **SOAP kunjungan**, yaitu data klinis. Pastikan `/var/backups/acesio` berizin `750` untuk pemilik `acesio`, dan kirim salinan luar server lewat kanal terenkripsi.
- Backup di mesin yang sama tidak melindungi dari disk rusak. Kirim ke luar server (rsync/rclone/object storage) setiap hari.
- Uji pemulihan minimal sekali sebelum Anda membutuhkannya. `npm test` sudah mencakup `test/backup-restore.test.mjs` (salinan saat server hidup, lalu dibuka lagi).
- `integration.key` (kunci token WhatsApp) tidak ada di dalam berkas `.db`. Salin terpisah: `cp -a /var/lib/acesio/integration.key /var/backups/acesio/integration.key`.
- Target layanan adalah Linux dengan systemd. Di Windows, menghentikan proses lewat TerminateProcess tidak menjalankan handler SIGTERM; itu batas sistem operasi, bukan alur aplikasi. Di server, `systemctl stop acesio` mengirim SIGTERM dan aplikasi menutup database lalu keluar 0.

## 7. Rotasi `BOT_API_KEY`

Hanya ada **satu** key aktif, jadi ada jeda singkat saat bot memakai key lama dan server sudah memakai key baru. Lakukan di jam sepi.

1. Buat key baru: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Ganti nilai `BOT_API_KEY` di `/etc/acesio/acesio.env`.
3. `sudo systemctl restart acesio`.
4. Ganti key di server bot, lalu uji: `curl -H "X-API-Key: <baru>" https://dashboard.contoh.id/api/bot/services` (harus 200; key lama harus 401).
5. Bot yang mengirim `request_id`/`Idempotency-Key` aman mengulang kiriman yang gagal selama jeda.

Rotasi segera bila key pernah muncul di log, chat, atau repositori. Sesi login staf tidak terpengaruh.

## 8. Pemulihan dari backup

```bash
sudo systemctl stop acesio

# 1. Amankan kondisi sekarang (jangan langsung menimpa)
sudo -u acesio mkdir -p /var/lib/acesio/sebelum-pulih
sudo -u acesio mv /var/lib/acesio/acesio.db* /var/lib/acesio/sebelum-pulih/ 2>/dev/null

# 2. Pasang backup. Berkas -wal dan -shm lama HARUS tidak ada (sudah dipindahkan di atas),
#    kalau tidak SQLite bisa memadukan sisa transaksi lama ke database hasil pulih.
sudo -u acesio cp /var/backups/acesio/acesio-YYYYMMDD-HHMM.db /var/lib/acesio/acesio.db
sudo -u acesio cp -a /var/backups/acesio/integration.key /var/lib/acesio/integration.key
sudo -u acesio rsync -a /var/backups/acesio-uploads/ /var/lib/acesio/uploads/

# 3. Periksa keutuhan (sqlite3 CLI tidak wajib; pakai Node)
sudo -u acesio node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/var/lib/acesio/acesio.db',{readOnly:true});
console.log(d.prepare('PRAGMA integrity_check').get(), d.prepare('SELECT COUNT(*) n FROM users').get(), d.prepare('SELECT COUNT(*) n FROM records').get());"

sudo systemctl start acesio
```

Setelah start: login sebagai supervisor, cek jumlah data di Laporan, dan cek log audit. Data yang dicatat setelah waktu backup tidak ada lagi; beri tahu terapis untuk mengisi ulang bila perlu. Foto layanan dipulihkan dari salinan `uploads/` terpisah.
