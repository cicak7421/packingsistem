-- Flowmua — Alur Retur (paket balik ke gudang)
-- Cara pakai: Supabase -> SQL Editor -> New Query -> paste semua isi file ini -> Run.
-- Aman dijalankan ulang (pakai IF NOT EXISTS).
--
-- Satu pesanan dianggap RETUR kalau retur_at terisi. Diisi lewat:
--   - halaman Scan Packing mode "Retur" (tim packing scan resi paket yang balik), atau
--   - tab "Retur" di dashboard (admin/CS input manual No. Resi / No. Pesanan).
-- Pesanan retur dihitung Rp0 di Estimasi Penghasilan dan dicatat di export Excel-nya.

alter table orders add column if not exists retur_at timestamptz;
alter table orders add column if not exists retur_by integer references users(id);
alter table orders add column if not exists retur_kondisi text; -- sesuai | tidak_sesuai (hasil cek fisik; data lama: bagus | rusak)
alter table orders add column if not exists retur_alasan text;
alter table orders add column if not exists retur_catatan text;
-- Validasi admin/CS: stok baru masuk ke Inventory SETELAH retur divalidasi "sesuai".
alter table orders add column if not exists retur_validated_at timestamptz;
alter table orders add column if not exists retur_validated_by integer references users(id);

-- Detail validasi: per SKU berapa pcs yang balik & berapa yang rusak, plus kenapa tidak sesuai.
--   retur_items  = [{ "sku": "...", "qty_pesan": 2, "qty_balik": 1, "qty_rusak": 0 }, ...]
--   retur_masalah = mis. "Jumlah kurang", "Barang rusak / cacat", "Barang beda / tertukar"
alter table orders add column if not exists retur_items jsonb;
alter table orders add column if not exists retur_masalah text;

create index if not exists idx_orders_retur_at on orders(retur_at) where retur_at is not null;
