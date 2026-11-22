-- Konfigurasi Estimasi Penghasilan (menu "Konfigurasi Harga"): potongan advance shipment (%) dan
-- harga per SKU buat pesanan Advance Fulfilment / pengiriman cepat. Dipakai bersama semua user.
-- Cara pakai: Supabase -> SQL Editor -> New Query -> paste -> Run. Aman dijalankan berulang.
create table if not exists estimasi_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now(),
  updated_by integer references users(id) on delete set null
);

create table if not exists estimasi_sku_prices (
  sku text primary key,
  price numeric not null check (price >= 0),
  note text,
  updated_at timestamptz default now(),
  updated_by integer references users(id) on delete set null
);
