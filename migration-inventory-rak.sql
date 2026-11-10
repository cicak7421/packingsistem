-- Modul Lokasi Rak — jalankan SETELAH migration-inventory.sql.
-- Nambah kemampuan tracking "barang ini ditaro di rak mana", termasuk 1 produk
-- kesebar di beberapa rak sekaligus (misal 60 pcs di Rak A1, 40 pcs di T01).

-- 1) Master daftar kode rak. Admin/staff inventory bisa tambah kode baru kapan aja
--    lewat UI (bebas format: "Rak A1", "T01", "Gudang 2 - Lorong 3", dst).
create table if not exists rak_lokasi (
  id serial primary key,
  kode text unique not null,
  keterangan text,
  created_at timestamptz default now()
);

-- 2) Breakdown stok per produk per rak. Total yang "ditempatkan" di sini boleh <= 
--    products.stock_qty -- selisihnya dianggap "belum ditempatkan" (ditampilkan di UI),
--    jadi gak maksa staff harus selalu lengkap alokasi rak-nya.
create table if not exists product_rak (
  id serial primary key,
  product_id integer not null references products(id) on delete cascade,
  rak_id integer not null references rak_lokasi(id) on delete restrict,
  qty integer not null default 0 check (qty >= 0),
  updated_at timestamptz default now(),
  unique (product_id, rak_id)
);
create index if not exists idx_product_rak_product on product_rak(product_id);
create index if not exists idx_product_rak_rak on product_rak(rak_id);

create or replace function set_product_rak_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_product_rak_updated_at on product_rak;
create trigger trg_product_rak_updated_at before update on product_rak
for each row execute function set_product_rak_updated_at();
