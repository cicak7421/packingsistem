-- Modul Inventory Stock — jalankan file ini di Supabase SQL Editor (Project yang sama
-- dengan Flowmua) setelah schema.sql. Aman dijalankan ulang (pakai IF NOT EXISTS / OR REPLACE).

-- 1) Tambah role baru 'inventory' buat staff gudang/inventory (di luar 'admin','cs','packing').
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'cs', 'packing', 'inventory'));

-- 2) Kolom permission granular per akun (jsonb, admin bisa atur satu-satu lewat menu Kelola Akun).
--    Kalau kosong ({}), akses ditentukan dari role default (lihat DEFAULT_PERMISSIONS di kode).
--    Field yang dipakai: view_stock, adjust_stock, manage_products, manage_users
alter table users add column if not exists permissions jsonb not null default '{}'::jsonb;

-- 3) Tabel produk inventory
create table if not exists products (
  id serial primary key,
  sku text unique not null,
  name text not null,
  category text,
  unit text default 'pcs',
  stock_qty integer not null default 0,
  min_stock integer not null default 0,
  image_url text,
  active boolean not null default true,
  created_by integer references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_products_sku on products(sku);
create index if not exists idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index if not exists idx_products_active on products(active);

-- 4) Riwayat perubahan stok (manual tambah/kurang, atau otomatis dari packing)
create table if not exists stock_log (
  id serial primary key,
  product_id integer not null references products(id) on delete cascade,
  change_qty integer not null, -- positif = tambah, negatif = kurang
  resulting_stock integer not null,
  source text not null default 'manual', -- manual | auto_packing | adjustment
  note text,
  order_id integer references orders(id),
  user_id integer references users(id),
  created_at timestamptz default now()
);
create index if not exists idx_stock_log_product_created on stock_log(product_id, created_at desc);

-- Auto-update updated_at tiap kali produk diubah
create or replace function set_products_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at before update on products
for each row execute function set_products_updated_at();

-- 5) Bucket Storage buat gambar produk (public read, upload lewat backend pakai service_role).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Catatan: karena backend pakai SUPABASE_SERVICE_ROLE_KEY (bypass RLS & storage policy),
-- kamu TIDAK wajib bikin storage policy tambahan. Bucket di-set public=true supaya URL
-- gambar produk bisa langsung diakses browser tanpa perlu signed URL.
