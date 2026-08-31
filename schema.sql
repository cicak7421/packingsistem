-- Flowmua — Schema Supabase (Postgres)
-- Cara pakai: buka project Supabase kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run".

create table if not exists users (
  id serial primary key,
  username text unique not null,
  password_hash text not null,
  full_name text not null,
  role text not null check (role in ('admin', 'cs', 'packing')),
  active boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists orders (
  id serial primary key,
  no_pesanan text unique not null,
  no_resi text,
  opsi_pengiriman text,
  waktu_pesanan_dibuat text,
  waktu_pesanan_at timestamptz,
  nama_penerima text,
  kota text,
  status_packing text not null default 'belum_packing', -- belum_packing | sudah_packing
  packed_by integer references users(id),
  packed_at timestamptz,
  status_resi text default 'belum_dikirim', -- belum_dikirim | dikirim | diterima
  imported_at timestamptz default now(),
  imported_by integer references users(id)
);

create table if not exists scan_log (
  id serial primary key,
  order_id integer not null,
  user_id integer not null references users(id),
  scanned_value text not null,
  -- Sejak backend versi terbaru, HANYA scan yang berhasil (result = 'ok') yang ditulis ke
  -- sini -- scan duplikat/gagal cuma ditampilkan sebagai notifikasi di layar, gak disimpan,
  -- biar tabel ini tetap seukuran jumlah paket beneran walau volume paketnya ratusan ribu.
  -- Baris lama dengan result 'sudah_pernah_packing' mungkin masih ada dari sebelum perubahan
  -- ini (aman dibiarkan, atau dihapus lewat query terpisah kalau mau bersih-bersih sekalian).
  result text not null, -- ok | sudah_pernah_packing (legacy) | tidak_ditemukan (tidak pernah dipakai)
  created_at timestamptz default now()
);

create index if not exists idx_orders_no_pesanan on orders(no_pesanan);
create index if not exists idx_orders_no_resi on orders(no_resi);
create index if not exists idx_scan_log_user_created on scan_log(user_id, created_at);

-- Kolom buat fitur cek status resi real-time ke ekspedisi (BinderByte API).
-- Aman dijalanin ulang di project yang sudah ada isinya (pakai IF NOT EXISTS).
alter table orders add column if not exists resi_courier_status text;
alter table orders add column if not exists resi_last_checked_at timestamptz;
alter table orders add column if not exists resi_history jsonb;

-- Kolom-kolom dari export "Export Order Package" (format XLSX yang dipakai sekarang):
-- SKU per platform, subtotal pesanan, jumlah barang, plus detail pembeli & alamat.
-- Disimpan sebagai text (bukan angka/timestamp) karena formatnya teks bebas dari
-- marketplace (misal subtotal "314.475" pakai titik sebagai pemisah ribuan, bukan angka
-- desimal murni), jadi lebih aman gak dipaksa jadi kolom numeric.
alter table orders add column if not exists sku text;
alter table orders add column if not exists subtotal_pesanan text;
alter table orders add column if not exists jumlah text;
alter table orders add column if not exists nama_pembeli text;
alter table orders add column if not exists no_hp text;
alter table orders add column if not exists negara text;
alter table orders add column if not exists provinsi text;
alter table orders add column if not exists kode_pos text;
alter table orders add column if not exists alamat text;

-- Waktu pesanan ditandai "Dikirim". Diisi otomatis pas admin import lewat fitur
-- "Kirim Pesanan" (atau update status resi manual jadi "dikirim"). Dipakai buat
-- urutin & nampilin tabel "Pesanan Dikirim" di Dashboard.
alter table orders add column if not exists dikirim_at timestamptz;

-- Kolom toko & platform. Diisi otomatis dari file import (format "Export Order Package"
-- sudah punya kolom "Nama Toko" & "Platform" sendiri), atau diisi manual oleh admin
-- sebagai cadangan kalau ada baris yang kosong toko/platform-nya.
-- Nama toko yang aneh/kode internal (misal "plsfmgshop") otomatis dinormalisasi ke nama
-- toko asli lewat STORE_MAP di api/_lib/routes/import.js.
alter table orders add column if not exists toko text;
alter table orders add column if not exists platform text;
create index if not exists idx_orders_toko on orders(toko);
create index if not exists idx_orders_platform on orders(platform);

-- Kolom-kolom affiliate (lihat migration-affiliate.sql buat penjelasan lengkap).
-- Ditandai lewat checkbox "Ini Pesanan Affiliate" di form Input Manual -- dipakai buat
-- rekap pengeluaran ongkir affiliate per bulan di dashboard "Affiliate".
alter table orders add column if not exists is_affiliate boolean not null default false;
alter table orders add column if not exists affiliate_name text;
alter table orders add column if not exists affiliate_ongkir numeric(12, 2);
alter table orders add column if not exists affiliate_motif text;
create index if not exists idx_orders_is_affiliate on orders(is_affiliate) where is_affiliate = true;
create index if not exists idx_orders_affiliate_name on orders(affiliate_name);

create or replace function get_affiliate_summary(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
  with aff as (
    select
      coalesce(nullif(trim(affiliate_name), ''), 'Tanpa Nama') as affiliate_name,
      coalesce(affiliate_ongkir, 0) as ongkir,
      nullif(trim(affiliate_motif), '') as motif
    from orders
    where is_affiliate = true
      and waktu_pesanan_at >= p_from and waktu_pesanan_at < p_to
  ),
  by_affiliate as (
    select affiliate_name, count(*) as total_orders, sum(ongkir) as total_ongkir
    from aff group by affiliate_name
  ),
  motif_by_affiliate as (
    select affiliate_name, coalesce(motif, 'Tanpa Motif') as motif, count(*) as total
    from aff group by affiliate_name, 2
  ),
  motif_agg as (
    select affiliate_name,
      jsonb_agg(jsonb_build_object('motif', motif, 'total', total) order by total desc) as motifs
    from motif_by_affiliate group by affiliate_name
  ),
  motif_overall as (
    select coalesce(motif, 'Tanpa Motif') as motif, count(*) as total, sum(ongkir) as total_ongkir
    from aff group by 1
  )
  select jsonb_build_object(
    'total_orders', (select count(*) from aff),
    'total_ongkir', coalesce((select sum(ongkir) from aff), 0),
    'affiliates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'affiliate_name', b.affiliate_name,
        'total_orders', b.total_orders,
        'total_ongkir', b.total_ongkir,
        'motifs', coalesce(m.motifs, '[]'::jsonb)
      ) order by b.total_ongkir desc, b.total_orders desc)
      from by_affiliate b left join motif_agg m on m.affiliate_name = b.affiliate_name
    ), '[]'::jsonb),
    'motif_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('motif', motif, 'total', total, 'total_ongkir', total_ongkir) order by total desc)
      from motif_overall
    ), '[]'::jsonb)
  );
$$;

-- Akun admin default (username: admin, password: admin123)
-- PENTING: segera login dan ganti password ini lewat menu "Kelola Akun" setelah deploy berhasil.
insert into users (username, password_hash, full_name, role)
values ('admin', '$2b$10$rOMlBwhzFKlnWwkrzMyMA.5TRNsvD/6Dm0YARl1/F7IiiPOmjRaXK', 'Administrator', 'admin')
on conflict (username) do nothing;

-- Optimasi performa (index + function agregasi). Lihat migration-performance.sql buat
-- penjelasan lengkap kenapa ini penting — singkatnya, mempercepat Dashboard & halaman
-- Performa Packing dengan mindahin perhitungan ringkasan ke Postgres, bukan di JavaScript.
create index if not exists idx_orders_status_packing_waktu on orders(status_packing, waktu_pesanan_at);
create index if not exists idx_orders_status_resi_dikirim on orders(status_resi, dikirim_at);
create index if not exists idx_orders_opsi_pengiriman on orders(opsi_pengiriman);
create index if not exists idx_orders_packed_at on orders(packed_at desc);
create index if not exists idx_orders_dikirim_at on orders(dikirim_at desc);
create index if not exists idx_orders_waktu_pesanan_at on orders(waktu_pesanan_at);
create index if not exists idx_orders_imported_at on orders(imported_at);
create index if not exists idx_orders_platform on orders(platform);
create index if not exists idx_scan_log_result_created on scan_log(result, created_at);

create extension if not exists pg_trgm;
create index if not exists idx_orders_no_pesanan_trgm on orders using gin (no_pesanan gin_trgm_ops);
create index if not exists idx_orders_no_resi_trgm on orders using gin (no_resi gin_trgm_ops);

create or replace function get_shipping_summary()
returns table (courier text, total bigint, belum_packing bigint, sudah_packing bigint, dikirim bigint)
language sql stable as $$
  select
    coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier,
    count(*) as total,
    count(*) filter (where status_packing is distinct from 'sudah_packing') as belum_packing,
    -- status_resi 'diterima' ikut dihitung "sudah dikirim" (lihat 'dikirim' filter di bawah) --
    -- itu status yang LEBIH MAJU dari 'dikirim' (paketnya malah udah beneran nyampe ke
    -- pembeli), jadi jangan sampai nyangkut di "sudah_packing" gara-gara bukan exact match
    -- 'dikirim'.
    count(*) filter (where status_packing = 'sudah_packing' and status_resi not in ('dikirim', 'diterima')) as sudah_packing,
    count(*) filter (where status_resi in ('dikirim', 'diterima')) as dikirim
  from orders group by 1 order by total desc;
$$;

create or replace function get_platform_summary()
returns table (platform text, total bigint, belum_packing bigint, sudah_packing bigint, dikirim bigint)
language sql stable as $$
  select
    coalesce(nullif(trim(platform), ''), 'Tidak Diketahui') as platform,
    count(*) as total,
    count(*) filter (where status_packing is distinct from 'sudah_packing') as belum_packing,
    -- Lihat komentar di get_shipping_summary() di atas -- 'diterima' diperlakukan setara 'dikirim'.
    count(*) filter (where status_packing = 'sudah_packing' and status_resi not in ('dikirim', 'diterima')) as sudah_packing,
    count(*) filter (where status_resi in ('dikirim', 'diterima')) as dikirim
  from orders group by 1 order by total desc;
$$;

create or replace function get_packing_performance(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
  with scans as (
    select sl.user_id, sl.created_at, o.opsi_pengiriman
    from scan_log sl left join orders o on o.id = sl.order_id
    where sl.result = 'ok' and sl.created_at >= p_from and sl.created_at < p_to
  ),
  by_user as (
    select u.id as user_id, u.full_name, u.role, count(*) as total
    from scans s join users u on u.id = s.user_id group by u.id, u.full_name, u.role
  ),
  by_courier as (
    select coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier, count(*) as total
    from scans group by 1
  ),
  by_day as (
    select to_char(created_at, 'YYYY-MM-DD') as day, count(*) as total from scans group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from scans),
    'leaderboard', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'full_name', full_name, 'role', role, 'total', total) order by total desc) from by_user), '[]'::jsonb),
    'courier_breakdown', coalesce((select jsonb_agg(jsonb_build_object('courier', courier, 'total', total) order by total desc) from by_courier), '[]'::jsonb),
    'daily_trend', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'total', total) order by day asc) from by_day), '[]'::jsonb)
  );
$$;

-- Catatan soal Row Level Security (RLS):
-- Backend Flowmua pakai Supabase SERVICE ROLE KEY (bukan anon key), yang otomatis
-- bypass RLS. Jadi kamu TIDAK perlu bikin RLS policy apa pun di tabel-tabel ini,
-- selama SUPABASE_SERVICE_ROLE_KEY di server tetap dirahasiakan (jangan pernah
-- dipakai di kode frontend / browser).
