-- Flowmua — Migration Optimasi Performa
-- Jalankan SEKALI di Supabase SQL Editor (project kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run"). Aman dijalankan berkali-kali (semua pakai
-- IF NOT EXISTS / OR REPLACE).
--
-- Isinya:
-- 1) Index buat kolom yang sering dipakai filter & sort di Dashboard (biar Postgres gak
--    scan seluruh tabel tiap kali ada request).
-- 2) Extension pg_trgm + index khusus buat pencarian No. Pesanan / No. Resi (ilike '%...%'),
--    karena index biasa gak kepake buat pencarian yang ada wildcard di depan.
-- 3) Function get_shipping_summary() & get_packing_performance() — mindahin perhitungan
--    ringkasan dari JavaScript (yang sebelumnya narik RIBUAN baris dari Supabase ke Vercel
--    dulu baru dihitung) ke dalam Postgres langsung (dihitung di database, cuma hasil
--    ringkasannya aja yang dikirim balik). Ini yang paling kerasa mempercepat Dashboard,
--    karena kedua function ini dipanggil di HAMPIR SETIAP interaksi Dashboard.
--
-- UPDATE: get_packing_performance() sekarang juga ngasih breakdown per-kurir UNTUK TIAP
-- PACKER (dulu breakdown kurir cuma agregat seluruh tim). Ini yang bikin fitur "klik nama
-- packer di leaderboard -> lihat dia packing apa aja" di Performa Packing bisa jalan tanpa
-- request tambahan. WAJIB jalanin ulang file ini di Supabase SQL Editor (aman, pakai `or
-- replace`) biar function-nya ke-update dengan kolom `courier_breakdown` baru di tiap
-- entry leaderboard.

-- ========== 1. INDEX BUAT FILTER & SORT DI TABEL orders ==========
-- Catatan: dulu ada index buat kolom "batas_kirim", tapi kolom itu udah dihapus di
-- migration-new-format.sql (diganti waktu_pesanan_at) -- makanya index-nya diganti juga
-- di bawah, biar file ini aman dijalanin ulang di project yang udah pindah ke format baru.
create index if not exists idx_orders_status_packing_waktu on orders(status_packing, waktu_pesanan_at);
create index if not exists idx_orders_status_resi_dikirim on orders(status_resi, dikirim_at);
create index if not exists idx_orders_opsi_pengiriman on orders(opsi_pengiriman);
create index if not exists idx_orders_packed_at on orders(packed_at desc);
create index if not exists idx_orders_dikirim_at on orders(dikirim_at desc);
create index if not exists idx_orders_waktu_pesanan_at on orders(waktu_pesanan_at);
create index if not exists idx_orders_imported_at on orders(imported_at);

-- ========== 2. PENCARIAN No. Pesanan / No. Resi (ILIKE '%q%') ==========
create extension if not exists pg_trgm;
create index if not exists idx_orders_no_pesanan_trgm on orders using gin (no_pesanan gin_trgm_ops);
create index if not exists idx_orders_no_resi_trgm on orders using gin (no_resi gin_trgm_ops);

-- ========== 3. INDEX BUAT scan_log (dipakai fitur Performa Packing) ==========
create index if not exists idx_scan_log_result_created on scan_log(result, created_at);

-- ========== 4. FUNCTION: Ringkasan per Jasa Kirim ==========
-- Ganti endpoint /orders/shipping-summary yang tadinya narik SEMUA baris orders lalu
-- ngitung di JS. Sekarang Postgres langsung yang GROUP BY & COUNT, jauh lebih cepat
-- (apalagi kalau tabel orders udah ribuan baris).
create or replace function get_shipping_summary()
returns table (
  courier text,
  total bigint,
  belum_packing bigint,
  sudah_packing bigint,
  dikirim bigint
)
language sql
stable
as $$
  select
    coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier,
    count(*) as total,
    count(*) filter (where status_packing is distinct from 'sudah_packing') as belum_packing,
    -- "Sudah Packing" = udah di-packing TAPI belum dikirim. Yang udah dikirim gak dihitung
    -- di sini lagi (masuk hitungan "dikirim" di bawah), biar gak keliatan dobel di Dashboard.
    count(*) filter (where status_packing = 'sudah_packing' and status_resi is distinct from 'dikirim') as sudah_packing,
    count(*) filter (where status_resi = 'dikirim') as dikirim
  from orders
  group by 1
  order by total desc;
$$;

-- ========== 5. FUNCTION: Performa Packing (leaderboard, tren harian, breakdown kurir) ==========
-- Ganti endpoint /packing/performance yang tadinya narik SEMUA baris scan_log (bisa puluhan
-- ribu baris buat rentang 1 bulan) + query orders terpisah buat tiap order_id, lalu digabung
-- di JS. Sekarang semua join & agregasi dikerjain di satu query Postgres, hasilnya cuma
-- ringkasan kecil (jsonb) yang dikirim balik ke Vercel.
create or replace function get_packing_performance(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
as $$
  with scans as (
    select sl.user_id, sl.created_at, o.opsi_pengiriman
    from scan_log sl
    left join orders o on o.id = sl.order_id
    where sl.result = 'ok' and sl.created_at >= p_from and sl.created_at < p_to
  ),
  by_user as (
    select u.id as user_id, u.full_name, u.role, count(*) as total
    from scans s
    join users u on u.id = s.user_id
    group by u.id, u.full_name, u.role
  ),
  by_courier as (
    select coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier, count(*) as total
    from scans
    group by 1
  ),
  by_user_courier as (
    select user_id, coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier, count(*) as total
    from scans
    group by 1, 2
  ),
  by_day as (
    select to_char(created_at, 'YYYY-MM-DD') as day, count(*) as total
    from scans
    group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from scans),
    'leaderboard', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'user_id', bu.user_id,
          'full_name', bu.full_name,
          'role', bu.role,
          'total', bu.total,
          'courier_breakdown', coalesce(
            (select jsonb_agg(jsonb_build_object('courier', buc.courier, 'total', buc.total) order by buc.total desc)
             from by_user_courier buc where buc.user_id = bu.user_id), '[]'::jsonb)
        ) order by bu.total desc)
       from by_user bu), '[]'::jsonb),
    'courier_breakdown', coalesce(
      (select jsonb_agg(jsonb_build_object('courier', courier, 'total', total) order by total desc)
       from by_courier), '[]'::jsonb),
    'daily_trend', coalesce(
      (select jsonb_agg(jsonb_build_object('date', day, 'total', total) order by day asc)
       from by_day), '[]'::jsonb)
  );
$$;
