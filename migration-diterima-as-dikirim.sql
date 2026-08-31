-- Flowmua — Migration: perlakukan status_resi 'diterima' setara 'dikirim' di ringkasan
-- Jalankan SEKALI di Supabase SQL Editor (project kamu -> menu "SQL Editor" -> New Query
-- -> paste semua isi file ini -> klik "Run"). Aman dijalankan berkali-kali (function pakai
-- `or replace`, backfill UPDATE-nya idempotent — cuma nyentuh baris yang emang belum sesuai).
--
-- Kenapa perlu ini: sebelum perbaikan ini, pesanan yang status resinya sudah "diterima"
-- (paketnya beneran udah sampai ke pembeli) masih ke-hitung nyangkut di bucket "Sudah
-- Packing" di Dashboard, bukan ikut kehitung "Sudah Dikirim" — soalnya kode lama cuma
-- ngecek status_resi = 'dikirim' persis di banyak tempat (ringkasan, filter list, dll),
-- padahal "diterima" itu status yang JUSTRU LEBIH MAJU dari "dikirim" (harusnya otomatis
-- ikut dihitung "sudah dikirim" juga, bukan malah dianggap "belum dikirim").
--
-- Kode aplikasinya juga sudah dibenerin di sisi lain (api/_lib/routes/orders.js,
-- kirimPesanan.js, dashboard.html) supaya konsisten treat 'diterima' seperti 'dikirim'.
-- Migration ini nutup sisi database-nya: function ringkasan + backfill data lama.

-- ========== 1. FUNCTION: Ringkasan per Jasa Kirim & per Platform ==========
create or replace function get_shipping_summary()
returns table (courier text, total bigint, belum_packing bigint, sudah_packing bigint, dikirim bigint)
language sql stable as $$
  select
    coalesce(nullif(trim(opsi_pengiriman), ''), 'Tidak Diketahui') as courier,
    count(*) as total,
    count(*) filter (where status_packing is distinct from 'sudah_packing') as belum_packing,
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
    count(*) filter (where status_packing = 'sudah_packing' and status_resi not in ('dikirim', 'diterima')) as sudah_packing,
    count(*) filter (where status_resi in ('dikirim', 'diterima')) as dikirim
  from orders group by 1 order by total desc;
$$;

-- ========== 2. BACKFILL: benerin data lama yang kejebak ==========
-- Pesanan yang status_resi-nya udah 'diterima' tapi status_packing-nya entah kenapa belum
-- ikut kebawa maju ke 'sudah_packing' (harusnya mustahil kalau udah "diterima", tapi jaga-jaga
-- kalau ada data lama dari sebelum perbaikan ini).
update orders
set status_packing = 'sudah_packing'
where status_resi = 'diterima' and status_packing <> 'sudah_packing';

-- Pesanan yang status_resi-nya 'diterima' tapi dikirim_at masih kosong (ini yang bikin
-- pesanan itu gak pernah kehitung di filter tanggal "Sudah Dikirim" walau sudah ikut
-- kehitung di angka total). Dipakein resi_last_checked_at (waktu terakhir dicek ke kurir)
-- sebagai perkiraan waktu dikirim yang paling mendekati, atau waktu sekarang kalau itu juga
-- kosong -- daripada dibiarin null selamanya.
update orders
set dikirim_at = coalesce(resi_last_checked_at, now())
where status_resi = 'diterima' and dikirim_at is null;
