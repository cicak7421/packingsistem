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
alter table orders add column if not exists retur_kondisi text; -- bagus (stok balik ke inventory) | rusak (stok tidak balik)
alter table orders add column if not exists retur_alasan text;
alter table orders add column if not exists retur_catatan text;

create index if not exists idx_orders_retur_at on orders(retur_at) where retur_at is not null;
