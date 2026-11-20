-- Status "sudah diinput tim CS" di tab Estimasi Penghasilan (merah = belum, hijau = sudah).
-- Cara pakai: Supabase -> SQL Editor -> New Query -> paste -> Run. Aman dijalankan berulang.
alter table orders add column if not exists cs_input_done boolean not null default false;
alter table orders add column if not exists cs_input_at timestamptz;
