# Flowmua — Sistem Tracking Packing & Pengiriman

Sistem internal buat tim CS & packing: import data pesanan dari marketplace, tim packing scan barcode resi pas packing, CS bisa cek status kapan aja.

Versi ini sudah disesuaikan supaya bisa deploy di **Vercel** dengan database **Supabase (Postgres)**. Backend aslinya pakai SQLite (file lokal di server) — itu **tidak bisa** dipakai di Vercel karena Vercel serverless nggak punya disk permanen, jadi semua query database sudah dikonversi ke Supabase.

## Struktur

```
flowmua/
  api/
    index.js         <- entry point serverless function (Express app, semua route /api/*)
    _lib/
      supabase.js     <- koneksi ke Supabase (pakai service_role key)
      auth.js          <- middleware JWT (requireAuth, requireRole)
      routes/          <- auth, users, orders, import, packing (query Supabase)
  index.html, login.html, dashboard.html, packing.html   <- frontend, di-serve statis oleh Vercel
  admin.html, cs.html   <- redirect stub ke dashboard.html (buat bookmark lama, aman dihapus)
  css/, js/
  schema.sql          <- jalanin ini di Supabase SQL Editor buat bikin tabel
  vercel.json          <- routing /api/* ke serverless function
  package.json
  .env.example
```

### Halaman & hak akses

| Halaman | Role yang bisa akses | Isi |
|---|---|---|
| `login.html` | siapa saja (belum login) | form login |
| `dashboard.html` | `admin`, `cs` | tab Dashboard, Import Pesanan, Cek Status — tab **Kirim Pesanan** dan **Kelola Akun** cuma muncul buat `admin` |
| `packing.html` | `packing`, `admin` | scan kamera buat tandai paket sudah di-packing |

Jadi CS sekarang **full akses** ke Dashboard, Import Pesanan, dan Cek Status (bisa update status resi) — cuma dibatasi dari Kirim Pesanan dan Kelola Akun (tambah/nonaktifkan user), sesuai kebutuhan. Navigasi antar tab konsisten di satu halaman (bukan pindah-pindah file terpisah), jadi gak ada lagi halaman yang "kejebak" tanpa jalan balik.

### Kirim Pesanan (khusus admin)

Tab terpisah dari Import Pesanan biasa. Admin upload file export marketplace yang isinya pesanan-pesanan yang sudah dikirim (format sama seperti file import biasa, cuma butuh kolom "No. Pesanan"). Sistem:
1. Cocokkan tiap No. Pesanan di file ke pesanan yang sudah ada di database.
2. Kalau ketemu → status resi pesanan itu ditandai `dikirim` (kolom `dikirim_at` ikut keisi).
3. Kalau tidak ketemu → masuk daftar gagal beserta alasannya, ditampilkan di tabel dan bisa diunduh jadi Excel lewat tombol "Unduh Data Gagal".

Tabel "Pesanan Sudah Dikirim" di Dashboard nampilin semua pesanan berstatus resi `dikirim`, urut dari yang paling baru ditandai. Begitu status resi jadi `dikirim` (dari mana pun sumbernya: import Kirim Pesanan, update manual, atau auto-tracking kurir), `status_packing` ikut otomatis ditandai `sudah_packing` — soalnya kalau sudah dikirim ya pasti sudah kelar packing, meski belum pernah discan lewat menu Scan Packing. Bedanya: kolom "Di-packing Oleh" bakal tampil **N/A** buat pesanan yang statusnya kelar packing lewat cara ini (bukan discan beneran).

## 1. Setup Supabase

1. Bikin akun / login di [supabase.com](https://supabase.com) → **New Project**.
2. Kasih nama, password database (simpan baik-baik, tapi kita gak akan pakai password ini langsung), pilih region terdekat (misal Singapore).
3. Setelah project selesai dibuat, buka menu **SQL Editor** (ikon di sidebar kiri) → **New query**.
4. Copy-paste seluruh isi file `schema.sql` dari folder ini → klik **Run**.
   - Ini bakal bikin 3 tabel: `users`, `orders`, `scan_log`.
   - Otomatis juga bikin akun admin default: **username `admin`, password `admin123`** — nanti wajib diganti setelah login pertama.
5. Buka menu **Project Settings → API**. Catat dua hal ini:
   - **Project URL** (contoh: `https://abcdefgh.supabase.co`)
   - **service_role key** (di bagian "Project API keys" — bukan yang `anon public`, tapi yang `service_role`, biasanya ada tulisan "secret"). Key ini yang dipakai backend, dan **jangan pernah** ditaruh di kode frontend/browser karena dia bisa akses semua data tanpa batasan.

## 2. Push ke GitHub

1. Bikin repo baru di GitHub (public atau private, bebas).
2. Push semua isi folder ini (yang isinya `api/`, `schema.sql`, `vercel.json`, `package.json`, file-file `.html`, dst) ke repo tersebut.

```bash
cd flowmua-vercel
git init
git add .
git commit -m "Initial commit - Flowmua for Vercel + Supabase"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

## 3. Deploy di Vercel

1. Login di [vercel.com](https://vercel.com) (bisa pakai akun GitHub langsung).
2. **Add New… → Project** → pilih repo GitHub yang tadi di-push.
3. Di halaman konfigurasi:
   - **Framework Preset**: pilih **Other** (soalnya ini bukan Next.js/React dkk, cuma HTML polos + serverless function).
   - **Root Directory**: biarin default (root repo).
   - Build & Output Settings: gak perlu diubah, biarin default kosong (gak ada build step).
4. Buka bagian **Environment Variables**, tambahkan 3 ini (Environment: pilih Production, Preview, dan Development semua biar aman):
   - `SUPABASE_URL` = Project URL dari Supabase tadi
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role key dari Supabase tadi
   - `JWT_SECRET` = string acak panjang bebas (buat keamanan token login), contoh bikin lewat `openssl rand -hex 32` di terminal
5. Klik **Deploy**. Tunggu proses build selesai (biasanya cuma hitungan detik–1 menit karena gak ada build step berat).
6. Setelah selesai, Vercel kasih URL publik (misal `flowmua.vercel.app`). Buka URL itu → otomatis diarahkan ke halaman login.

## 4. Login Pertama Kali & Ganti Password

- **username:** `admin`
- **password:** `admin123`

**⚠️ Segera login dan ganti password ini** (menu di admin.html), lalu buat akun-akun packing & CS lewat menu "Kelola Akun".

## Menjalankan di Lokal (buat testing sebelum push/deploy)

```bash
npm install
cp .env.example .env   # isi SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET
npm run dev
```

Ini cuma menjalankan API-nya di `http://localhost:3000/api/...`. Untuk lihat halaman frontend sekaligus API secara lokal persis seperti di Vercel, install [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`) lalu jalankan `vercel dev` di folder ini.

## Cek Status Resi Real-Time (opsional)

Halaman "Cek Status" punya tombol **"🔄 Cek Status Terbaru"** yang manggil API cek resi ke ekspedisi terkait (JNE, J&T, SiCepat, Shopee Xpress, dll) lewat [BinderByte](https://binderbyte.com/) — ini API pihak ketiga berbayar per-hit cek, bukan gratis.

Cara aktifin:
1. Daftar akun di [binderbyte.com](https://binderbyte.com/), ambil API key dari dashboard.
2. Tambahin environment variable `BINDERBYTE_API_KEY` di Vercel (Project Settings → Environment Variables), lalu redeploy.
3. Cek dokumentasi/dashboard BinderByte buat konfirmasi kode kurir yang mereka dukung — khususnya **Shopee Xpress (SPX)**, karena kode `spx` di `api/_lib/courierTracking.js` masih tebakan awal dan belum terverifikasi. Kalau kodenya beda atau kurirnya gak didukung, sesuaikan `COURIER_KEYWORD_MAP` di file itu.

Tanpa `BINDERBYTE_API_KEY` di-set, fitur ini bakal kasih pesan error yang jelas ke user (bukan error yang membingungkan), dan update status resi manual (dropdown + tombol Update yang sudah ada) tetap jalan normal.

## Cek Status Resi Otomatis (Cron — baru)

Selain tombol manual "Cek Status Terbaru", sekarang ada **cron job** (`GET /api/cron/refresh-resi`) yang jalan sendiri tanpa perlu ada orang klik apa-apa.

**Prinsip pentingnya: cron ini cuma dipakai buat 1 hal — mengonfirmasi paket udah di-*pickup*/discan kurir apa belum.** Begitu status berubah jadi `dikirim` (ada aktivitas kurir, sekali aja), cron **berhenti** ngecek pesanan itu lewat API. Sisa perjalanan paket (`dikirim` → `diterima`, bisa berhari-hari) **gak lagi dipantau lewat API berbayar** — user tinggal klik tombol **"Lacak di [Kurir]"** yang muncul otomatis di kartu pesanan, yang mengarah ke halaman tracking resmi kurirnya (misal `spx.co.id/track?...` buat Shopee Xpress — nomor resi udah otomatis kepasang di link-nya; kurir lain diarahkan ke halaman tracking mereka + nomor resi ditampilkan biar tinggal di-paste, soalnya kebanyakan kurir butuh isi manual/captcha).

Ini bikin cakupan cron per hari kira-kira = jumlah **pesanan baru sejak run sebelumnya** (bukan numpuk seluruh pesanan yang lagi di-jalan berhari-hari) — jauh lebih murah dan cocok buat volume ratusan pesanan/hari, sekaligus tetap muat di limit waktu 10 detik Vercel Hobby.

Tiap kali jalan, cron-nya:
1. Ambil pesanan yang sudah ada `no_resi`-nya dan `status_resi` MASIH `belum_dikirim` (maksimal 150 pesanan per run — bisa diubah lewat env var `CRON_RESI_MAX_PER_RUN`, yang paling lama belum dicek diprioritaskan duluan).
2. Cek status masing-masing ke BinderByte (8 request bersamaan — env var `CRON_RESI_CONCURRENCY`).
3. Begitu ketemu ada aktivitas kurir, update `status_resi` jadi `dikirim` (atau langsung `diterima` kalau ceknya kebetulan telat) dan `status_packing` ikut otomatis jadi `sudah_packing`. Setelah ini, pesanan itu otomatis gak diambil lagi di run-run berikutnya.

**Jadwal default:** jam 14:00 dan 19:00 WIB (di `vercel.json` ditulis dalam UTC: `07:00` & `12:00`, karena Vercel Cron cuma bisa UTC). Vercel Hobby membolehkan tiap cron job jalan maksimal 1x/hari — makanya ini dipecah jadi **2 cron job terpisah** (masing-masing 1x/hari), cukup buat kebutuhan sekarang (2x/hari) tanpa perlu upgrade ke Pro.

**Kalau di suatu run jumlah kandidatnya (field `candidates` di response/log) selalu mentok di batas `CRON_RESI_MAX_PER_RUN`** — tandanya volume harian udah kebesaran buat sekali proses dalam 10 detik. Opsinya: naikkan `CRON_RESI_MAX_PER_RUN` & `CRON_RESI_CONCURRENCY` dikit-dikit sambil dipantau (BinderByte punya limit rate juga), tambah cron job lagi di jam lain (masih boleh di Hobby, asal tiap cron job cuma 1x/hari), atau upgrade ke Pro (function bisa sampai 300 detik + boleh cron tiap beberapa menit).

**Yang wajib disiapkan:**
- `BINDERBYTE_API_KEY` — kalau belum di-set, cron ini otomatis di-skip (gak error, cuma gak ngapa-ngapain).
- `CRON_SECRET` — string rahasia biar endpoint `/api/cron/refresh-resi` gak bisa dipanggil orang lain dari luar (Vercel otomatis kirim header ini tiap manggil cron job kamu). Sangat disarankan di-set, meski kalau kosong tetap jalan normal.
- Setelah nambah kedua env var di atas di Vercel (Project Settings → Environment Variables), **redeploy** dulu supaya cron job-nya kebaca dan aktif (cron didaftarkan Vercel pas deploy, bukan otomatis kalau cuma ganti env var).

**Cara cek cron-nya beneran jalan:** buka tab **Cron Jobs** di dashboard project Vercel kamu — di situ kelihatan riwayat tiap run (sukses/gagal, kapan terakhir jalan, berapa kandidat/berapa yang berhasil dicek — lihat response JSON-nya). Bisa juga trigger manual dari situ buat testing tanpa nunggu jadwal.

**Catatan soal link "Lacak di [Kurir]":** URL deep-link yang confirmed langsung nampilin hasil cuma buat Shopee Xpress (SPX), sesuai contoh yang dikasih. Kurir lain (JNE, J&T, SiCepat, dll) diarahkan ke halaman tracking resmi mereka + nomor resinya ditampilkan (ada tombol "Salin Resi"), karena kebanyakan situs kurir butuh isi manual (kadang + captcha), jadi gak bisa dipastikan bisa di-deep-link otomatis. Kalau ternyata ada kurir lain yang bisa di-deep-link juga, tinggal update `COURIER_TRACKING_PAGES` di `api/_lib/courierTracking.js`.

## Update Terbaru

- **Import multi-format + toko/platform (baru)**: menu Import Pesanan sekarang otomatis mendeteksi dua format file — export "Pesanan" Shopee (seperti biasa) ATAU file rekap multi-toko/multi-platform (header 平台/店铺名称/订单号 dkk, satu pesanan bisa punya beberapa baris SKU). Kolom **Toko** & **Platform** otomatis kebaca dari file kalau ada, atau bisa diisi manual di form import (dipakai buat file lama yang gak punya info toko/platform sendiri). Nama toko yang "aneh"/kode internal (misal `plsfmgshop`) otomatis dinormalisasi ke nama toko asli lewat `STORE_MAP` di `api/_lib/routes/import.js` — tinggal tambah entry baru di situ kalau ada toko lain yang perlu dibenerin otomatis. Kolom Toko/Platform juga sudah muncul di tabel Dashboard, detail pesanan, hasil pencarian, dan export Excel.
- **Cek status resi real-time (baru)**: tombol "Cek Status Terbaru" di halaman Cek Status buat narik status terkini dari ekspedisi lewat BinderByte API (opsional, perlu API key sendiri — lihat bagian di atas).
- **Export ke Excel (baru)**: tab "Export Data" buat download data pesanan ke `.xlsx`, filter rentang tanggal import (maksimal 1 bulan / 31 hari).
- **Scan packing lebih cepat**: kamera auto-detect barcode → langsung diproses → dapet getar + bunyi sebagai tanda berhasil/gagal (gak perlu natap layar) → otomatis siap scan paket berikutnya (jeda ±0.9 detik biar gak ke-scan dobel). Gak ada tombol "konfirmasi" yang perlu ditekan.
- **Riwayat scan**: paket yang gagal ditemukan (nomor salah / belum diimport) sekarang **tidak** lagi masuk ke riwayat scan. Cuma scan yang berhasil atau kena duplikat yang tercatat.
- **CS full akses**: role `cs` sekarang bisa akses Dashboard, Import Pesanan, dan Cek Status penuh (termasuk update status resi) — cuma tab Kelola Akun yang dikunci buat `admin`.
- **UI dirapihin**: satu komponen navigasi (header + tab) dipakai konsisten di semua halaman, styling tombol/tabel/badge diperbarui, dan halaman Admin+CS digabung jadi satu `dashboard.html` biar gak ada halaman yang kehilangan jalan navigasi.

## Hal-hal yang Perlu Diperhatikan

- **Batas ukuran upload file import**: Vercel serverless function punya batas ukuran request sekitar 4.5MB (plan Hobby). Kalau file export Shopee kamu biasanya kecil (ratusan–ribuan baris teks), harusnya aman. Kalau nanti sering kena error pas upload file gede, bilang aja, nanti kita akalin (misal upload ke Supabase Storage dulu lalu diproses).
- **Riwayat scan "hari ini"**: dihitung berdasarkan tanggal UTC (bukan WIB), karena server Vercel jalan di UTC. Kalau mau pas jam 00:00 WIB, kasih tau nanti gua sesuaikan.
- **Keamanan `service_role` key**: key ini cuma dipakai di `api/_lib/supabase.js` (kode backend/server), gak pernah dikirim ke browser. Pastikan pas isi Environment Variables di Vercel, kamu isi di kolom yang benar (server-side env var, bukan yang di-expose ke publik).
- Kalau nanti mau tambah marketplace lain (Tokopedia/TikTok Shop) yang nama kolom Excel-nya beda, tinggal sesuaikan `COLUMN_MAP` (format Shopee) atau `COLUMN_MAP_MULTI` (format multi-platform) di `api/_lib/routes/import.js`.
- **Penting: jalanin ulang `schema.sql` di Supabase SQL Editor** setelah update ini (ada kolom baru `toko` & `platform` di tabel `orders`). Aman dijalanin ulang meski project udah ada isinya, karena semua statement-nya pakai `IF NOT EXISTS`.

## Rencana Pengembangan Lanjutan (opsional)
- ~~Integrasi API kurir (JNE/SPX/J&T) buat update status resi otomatis~~ — **sudah ada**, lihat bagian "Cek Status Resi Otomatis (Cron)" di atas.
- Notifikasi WhatsApp/Telegram kalau ada pesanan mendekati batas kirim tapi belum packing.
- Export laporan produktivitas per akun packing (harian/mingguan).
