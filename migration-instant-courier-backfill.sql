-- Backfill SEKALI JALAN: benerin data LAMA yang udah "sudah_packing" tapi kurirnya
-- termasuk kurir instant (GrabExpress Instant, GoSend Instant Prioritas, Gojek,
-- Gojek Instant, SPX Instant, SPX Instant Prioritas, SPX Sameday) dan status_resi-nya
-- masih "belum_dikirim" -- padahal kurir-kurir ini emang gak akan pernah ke-update
-- otomatis lewat BinderByte (lihat isInstantCourier() di api/_lib/courierTracking.js).
--
-- Pola pencocokan di bawah ini SENGAJA disamain persis sama logic isInstantCourier()
-- di kode (JS), biar konsisten. Kalau nanti daftar kurir instant-nya nambah/berubah,
-- update juga bagian isInstantCourier() di courierTracking.js.
--
-- dikirim_at diisi dari packed_at (waktu packing), BUKAN NOW() -- soalnya paket
-- instant emang udah otomatis dianggap dikirim SEJAK saat packing, jadi laporan/riwayat
-- tanggalnya tetap akurat sesuai kejadian aslinya, bukan sesuai kapan backfill ini dijalankan.
--
-- CARA PAKAI: copy-paste isi file ini ke Supabase SQL Editor, lalu Run. Cukup dijalankan
-- SEKALI (aman kalau gak sengaja dijalankan ulang -- baris yang udah "dikirim"/"diterima"
-- otomatis kelewat karena ada di kondisi WHERE).

update orders
set
  status_resi = 'dikirim',
  dikirim_at = coalesce(packed_at, now())
where
  status_packing = 'sudah_packing'
  and status_resi = 'belum_dikirim'
  and (
    (opsi_pengiriman ilike '%grabexpress%' and opsi_pengiriman ilike '%instant%')
    or (opsi_pengiriman ilike '%gosend%' and opsi_pengiriman ilike '%instant%')
    or (opsi_pengiriman ilike '%gojek%')
    or (opsi_pengiriman ilike '%spx%' and (opsi_pengiriman ilike '%instant%' or opsi_pengiriman ilike '%sameday%'))
  );

-- Cek hasilnya (opsional, jalanin abis update di atas buat lihat berapa baris yang kena
-- & kurir apa aja yang ke-backfill):
-- select opsi_pengiriman, count(*) from orders
-- where status_resi = 'dikirim' and dikirim_at = packed_at
-- group by opsi_pengiriman order by count(*) desc;
