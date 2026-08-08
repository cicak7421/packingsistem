-- Flowmua — Migration: Format XLSX baru ("Export Order Package")
-- Jalankan SEKALI di Supabase SQL Editor (project kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run"). Aman dijalankan berkali-kali (semua idempotent).
--
-- Kenapa migration ini ada:
-- Mulai sekarang sistem cuma baca 1 format XLSX (export "Export Order Package"), gantiin
-- format export "Pesanan" Shopee yang lama. Kolom "Batas Kirim" dan "Nomor Referensi SKU"
-- gak ada lagi di format baru, jadi struktur tabel `orders` disesuaikan biar rapi & sesuai
-- data yang beneran ada di file.
--
-- Isinya:
-- 1) Hapus kolom yang gak lagi dipakai (batas_kirim, nama_produk, waktu_pembayaran_dilakukan)
-- 2) Ganti nama nomor_referensi_sku -> sku (sesuai request: "disingkat jadi SKU")
-- 3) Tambah kolom baru sesuai kolom-kolom di format XLSX yang baru
-- 4) Tambah kolom waktu_pesanan_at (timestamptz asli, dipakai buat urutan "belum packing"
--    menggantikan batas_kirim yang sudah dihapus)
-- 5) Bersihin index lama yang nunjuk ke kolom yang udah dihapus, bikin index penggantinya

-- ========== 1. HAPUS KOLOM YANG GAK ADA DI FORMAT BARU ==========
alter table orders drop column if exists batas_kirim;
alter table orders drop column if exists nama_produk;
alter table orders drop column if exists waktu_pembayaran_dilakukan;

-- ========== 2. GANTI NAMA nomor_referensi_sku -> sku ==========
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'orders' and column_name = 'nomor_referensi_sku'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'orders' and column_name = 'sku'
  ) then
    alter table orders rename column nomor_referensi_sku to sku;
  end if;
end $$;

-- Jaga-jaga kalau tabel dibuat baru dari awal dan belum pernah punya kolom sku sama sekali
alter table orders add column if not exists sku text;

-- ========== 3. KOLOM BARU SESUAI FORMAT XLSX "Export Order Package" ==========
alter table orders add column if not exists nama_pembeli text;   -- kolom "Nama" (nama tersamar, mis. "A**")
alter table orders add column if not exists no_hp text;          -- kolom "No. CP 1"
alter table orders add column if not exists negara text;         -- kolom "Negara/Wilayah"
alter table orders add column if not exists provinsi text;       -- kolom "Provinsi"
alter table orders add column if not exists kode_pos text;       -- kolom "Kode Pos"
alter table orders add column if not exists alamat text;         -- kolom "Alamat Lengkap 1"

-- ========== 4. TIMESTAMP ASLI BUAT WAKTU PESANAN (pengganti urutan batas_kirim) ==========
-- waktu_pesanan_dibuat (text) tetap disimpan apa adanya buat ditampilkan ke user.
-- waktu_pesanan_at (timestamptz) ini hasil parse-nya, dipakai buat SORT yang akurat.
alter table orders add column if not exists waktu_pesanan_at timestamptz;

-- ========== 5. INDEX: BERSIHIN YANG LAMA, BIKIN PENGGANTINYA ==========
-- (drop column di langkah 1 di atas otomatis ikut drop index yang nunjuk ke kolom itu,
-- tapi tetap di-drop eksplisit di sini buat jaga-jaga project yang strukturnya beda dikit)
drop index if exists idx_orders_batas_kirim;
drop index if exists idx_orders_status_packing_batas;

create index if not exists idx_orders_waktu_pesanan_at on orders(waktu_pesanan_at);
create index if not exists idx_orders_status_packing_waktu on orders(status_packing, waktu_pesanan_at);

-- Selesai. Kolom `orders` sekarang: no_pesanan, no_resi, opsi_pengiriman, toko, platform,
-- sku, subtotal_pesanan, nama_pembeli, no_hp, negara, provinsi, kota, kode_pos, alamat,
-- nama_penerima, jumlah, waktu_pesanan_dibuat, waktu_pesanan_at, + kolom status/tracking
-- yang gak berubah (status_packing, packed_by, packed_at, status_resi, dikirim_at,
-- resi_courier_status, resi_last_checked_at, resi_history, imported_at, imported_by).
