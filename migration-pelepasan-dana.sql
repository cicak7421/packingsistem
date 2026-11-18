-- Estimasi Penghasilan: simpan kolom "Pelepasan Dana Platform" dari file Export Order Package
-- (dana yang benar-benar cair dari platform setelah potongan). Disimpan sebagai text, sama
-- seperti subtotal_pesanan. JALANKAN INI DI SUPABASE SQL EDITOR SEBELUM deploy versi baru --
-- kalau belum, import Excel & tab Estimasi Penghasilan akan error karena kolomnya belum ada.
alter table orders add column if not exists pelepasan_dana text;
