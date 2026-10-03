-- Flowmua — Migration: Tracking Affiliate
-- Jalankan SEKALI di Supabase SQL Editor (project kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run"). Aman dijalankan berkali-kali (semua pakai
-- IF NOT EXISTS / OR REPLACE).
--
-- Isinya:
-- 1) Kolom-kolom affiliate di tabel orders (ditandai lewat checkbox "Ini Pesanan Affiliate"
--    di form Input Manual): nama affiliate, ongkos kirim yang ditanggung toko, dan motif/desain
--    produk yang dikirim.
-- 2) Index buat query affiliate biar cepat.
-- 3) Function get_affiliate_summary(p_from, p_to) -- rekap pengeluaran affiliate per periode:
--    total pesanan & ongkir, breakdown per affiliate, breakdown per motif produk. Dipakai
--    di dashboard baru "Affiliate".

-- ========== 1. KOLOM AFFILIATE DI TABEL orders ==========
alter table orders add column if not exists is_affiliate boolean not null default false;
alter table orders add column if not exists affiliate_name text;
-- Ongkos kirim yang ditanggung toko buat kiriman affiliate ini (bukan ongkir yang dibayar
-- pembeli -- affiliate biasanya dikirimin produk gratis/sample, jadi ongkirnya jadi beban
-- toko). Disimpan sebagai numeric (beda dari subtotal_pesanan yang teks bebas) karena kolom
-- ini MEMANG perlu dijumlahkan buat rekap pengeluaran bulanan.
alter table orders add column if not exists affiliate_ongkir numeric(12, 2);
-- Motif/desain produk yang dikirim ke affiliate (contoh: "Motif Batik Kawung", "Polos Hitam"),
-- teks bebas -- dipakai buat lihat motif apa aja yang paling sering dikirim ke affiliate.
alter table orders add column if not exists affiliate_motif text;

-- ========== 2. INDEX ==========
create index if not exists idx_orders_is_affiliate on orders(is_affiliate) where is_affiliate = true;
create index if not exists idx_orders_affiliate_name on orders(affiliate_name);

-- ========== 3. FUNCTION: Rekap Affiliate per Periode ==========
-- p_from / p_to: rentang timestamptz [inklusif, eksklusif), dicocokkan ke waktu_pesanan_at
-- (konsisten sama gimana Performa Packing & rekap lain di sistem ini nentuin "periode").
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
