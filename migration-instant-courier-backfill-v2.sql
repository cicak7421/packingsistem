-- Backfill V2 -- SEKALI JALAN: benerin SEMUA pesanan LAMA yang kurirnya termasuk
-- instant/sameday tapi masih "nyangkut" di status yang belum final.
--
-- Definisi kurir instant sekarang DIPERLUAS (lihat isInstantCourier() terbaru di
-- api/_lib/courierTracking.js): sekarang nyakup SEMUA kurir yang namanya mengandung kata
-- "instant"/"sameday"/"same day" -- bukan cuma kombinasi kata kunci per-brand kayak dulu.
-- Makanya kurir kayak "Anteraja Sameday", "SiCepat Sameday", "JNE Instant", dst yang dulu
-- KELEWAT di migration-instant-courier-backfill.sql versi lama, sekarang ikut kebenerin juga.
--
-- Ada 2 kondisi yang dibenerin di bawah:
-- 1) Pesanan yang MASIH "Menunggu Packing" (status_packing = 'belum_packing') padahal
--    kurirnya instant/sameday -- ini kejadian kalau tim packing gak sempat/lupa scan
--    barcode-nya (wajar, soalnya paket instant kadang langsung dijemput driver tanpa
--    sempat discan di sistem sama sekali). Dibenerin: langsung ditandai SEKALIGUS
--    sudah packing + sudah dikirim.
-- 2) Pesanan yang sudah "Sudah Packing" tapi status_resi-nya masih "belum_dikirim" --
--    sama kayak migration-instant-courier-backfill.sql versi lama, cuma keyword-nya
--    diperluas biar Anteraja Sameday dkk ikut kebenerin.
--
-- dikirim_at diisi dari packed_at / waktu_pesanan_at (kalau ada), BUKAN now(), biar
-- laporan/riwayat tanggalnya tetap akurat sesuai kejadian aslinya, bukan sesuai kapan
-- backfill ini dijalankan.
--
-- CARA PAKAI: copy-paste isi file ini ke Supabase SQL Editor, lalu Run. Aman dijalankan
-- berkali-kali (baris yang sudah "dikirim"/"diterima" otomatis kelewat karena ada di
-- kondisi WHERE).

-- ========== Kondisi 1: masih "Menunggu Packing" ==========
update orders
set
  status_packing = 'sudah_packing',
  status_resi = 'dikirim',
  dikirim_at = coalesce(waktu_pesanan_at, now())
where
  status_packing = 'belum_packing'
  and (
    opsi_pengiriman ilike '%grabexpress%'
    or opsi_pengiriman ilike '%gojek%'
    or opsi_pengiriman ilike '%gosend%'
    or opsi_pengiriman ilike '%instant%'
    or opsi_pengiriman ilike '%sameday%'
    or opsi_pengiriman ilike '%same day%'
  );

-- ========== Kondisi 2: sudah packing tapi status resi masih nyangkut ==========
update orders
set
  status_resi = 'dikirim',
  dikirim_at = coalesce(packed_at, now())
where
  status_packing = 'sudah_packing'
  and status_resi = 'belum_dikirim'
  and (
    opsi_pengiriman ilike '%grabexpress%'
    or opsi_pengiriman ilike '%gojek%'
    or opsi_pengiriman ilike '%gosend%'
    or opsi_pengiriman ilike '%instant%'
    or opsi_pengiriman ilike '%sameday%'
    or opsi_pengiriman ilike '%same day%'
  );

-- Cek hasilnya (opsional, jalanin abis 2 update di atas buat lihat berapa baris & kurir
-- apa aja yang ke-backfill):
-- select opsi_pengiriman, count(*) from orders
-- where status_resi = 'dikirim' and (dikirim_at = packed_at or dikirim_at = waktu_pesanan_at)
-- group by opsi_pengiriman order by count(*) desc;
