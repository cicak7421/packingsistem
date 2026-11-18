-- Flowmua — Migration: Ringkasan & Filter per Platform
-- Jalankan SEKALI di Supabase SQL Editor (project kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run"). Aman dijalankan berkali-kali (semua pakai
-- IF NOT EXISTS / OR REPLACE).
--
-- Isinya:
-- 1) Index buat kolom platform (biar filter/query cepat).
-- 2) Function get_platform_summary() -- sama polanya kayak get_shipping_summary() di
--    migration-performance.sql, tapi di-group per platform (shopee, tiktok, dst),
--    dipakai buat ngisi dropdown filter Platform di Dashboard.

-- ========== 1. INDEX BUAT KOLOM platform ==========
create index if not exists idx_orders_platform on orders(platform);

-- ========== 2. FUNCTION: Ringkasan per Platform ==========
create or replace function get_platform_summary()
returns table (
  platform text,
  total bigint,
  belum_packing bigint,
  sudah_packing bigint,
  dikirim bigint
)
language sql
stable
as $$
  select
    coalesce(nullif(trim(platform), ''), 'Tidak Diketahui') as platform,
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
