-- Fitur Cek & Validasi Pesanan + penanda paket telat kirim.
-- Jalankan di Supabase SQL Editor. Aman dijalankan ulang (IF NOT EXISTS).

-- 1) Kolom validasi: siapa yang memvalidasi pesanan, kapan, plus catatan opsional.
alter table orders add column if not exists validated_at timestamptz;
alter table orders add column if not exists validated_by integer references users(id);
alter table orders add column if not exists validation_note text;
create index if not exists idx_orders_validated_at on orders(validated_at desc) where validated_at is not null;

-- 2) Index khusus query "paket telat": pesanan yang belum dikirim diurutkan dari yang
--    paling lama. Partial index ini kecil (hanya baris belum dikirim) jadi cepat walau
--    tabel orders sudah ratusan ribu baris.
create index if not exists idx_orders_belum_kirim_waktu
  on orders(waktu_pesanan_at)
  where status_resi = 'belum_dikirim';
create index if not exists idx_orders_belum_kirim_imported
  on orders(imported_at)
  where status_resi = 'belum_dikirim' and waktu_pesanan_at is null;
