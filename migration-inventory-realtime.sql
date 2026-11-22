-- Perbaikan Inventory real-time + fix hapus pesanan.
-- Jalankan di Supabase SQL Editor SEBELUM deploy kode baru. Aman dijalankan ulang.

-- 1) Fix "Gagal menghapus pesanan": stock_log.order_id sebelumnya FK tanpa ON DELETE,
--    jadi pesanan yang sudah di-packing (punya baris stock_log) gak bisa dihapus.
--    Sekarang riwayat stok TETAP ada, cuma order_id-nya jadi NULL.
alter table stock_log drop constraint if exists stock_log_order_id_fkey;
alter table stock_log
  add constraint stock_log_order_id_fkey
  foreign key (order_id) references orders(id) on delete set null;
create index if not exists idx_stock_log_order on stock_log(order_id) where order_id is not null;

-- 2) Trim breakdown rak biar gak melebihi stok baru (versi SQL dari reconcileRakBreakdown).
create or replace function reconcile_rak_breakdown(p_product_id integer, p_new_stock integer)
returns void language plpgsql as $$
declare
  r record;
  v_excess integer;
  v_cut integer;
begin
  select coalesce(sum(qty), 0) - p_new_stock into v_excess
  from product_rak where product_id = p_product_id and qty > 0;
  if v_excess <= 0 then return; end if;
  for r in select id, qty from product_rak where product_id = p_product_id and qty > 0 order by qty desc loop
    exit when v_excess <= 0;
    v_cut := least(r.qty, v_excess);
    update product_rak set qty = qty - v_cut where id = r.id;
    v_excess := v_excess - v_cut;
  end loop;
end;
$$;

-- 3) Auto-deduct stok ATOMIK + IDEMPOTEN (1 pesanan tidak akan pernah dipotong 2x).
--    - SKU dicocokkan case-insensitive & di-trim
--    - row produk di-lock (for update) -> scan bersamaan gak saling menimpa
--    - p_orders: [{"id":1,"no":"NO123","lines":[{"sku":"SP35M","qty":15}]}]
create or replace function deduct_stock_for_orders(p_user_id integer, p_orders jsonb)
returns jsonb language plpgsql as $$
declare
  o jsonb;
  l record;
  prod record;
  v_new integer;
  v_order_id integer;
  v_order_no text;
  v_missing text[] := '{}';
begin
  for o in select value from jsonb_array_elements(p_orders) loop
    v_order_id := (o->>'id')::integer;
    v_order_no := o->>'no';
    for l in
      select upper(btrim(x->>'sku')) as sku_key, sum((x->>'qty')::integer)::integer as qty
      from jsonb_array_elements(o->'lines') x
      where coalesce(btrim(x->>'sku'), '') <> ''
      group by 1
    loop
      select * into prod from products
      where upper(btrim(products.sku)) = l.sku_key
      order by id limit 1
      for update;

      if not found then
        if not (l.sku_key = any(v_missing)) then v_missing := array_append(v_missing, l.sku_key); end if;
        continue;
      end if;

      if exists (select 1 from stock_log s
                 where s.order_id = v_order_id and s.product_id = prod.id and s.source = 'auto_packing') then
        continue;
      end if;

      v_new := greatest(0, prod.stock_qty - l.qty);
      update products set stock_qty = v_new where id = prod.id;
      perform reconcile_rak_breakdown(prod.id, v_new);
      insert into stock_log (product_id, change_qty, resulting_stock, source, note, order_id, user_id)
      values (prod.id, -l.qty, v_new, 'auto_packing', 'Otomatis dari packing pesanan ' || coalesce(v_order_no, ''), v_order_id, p_user_id);
    end loop;
  end loop;
  return jsonb_build_object('skus_not_registered', to_jsonb(v_missing));
end;
$$;

-- 4) Grafik pergerakan stok: agregasi di Postgres (sebelumnya narik baris stock_log mentah
--    lewat API yang kena limit 1000 baris -> grafik kosong/salah). Hari dihitung WIB.
create or replace function get_stock_movement(p_days integer default 14)
returns table(day text, masuk bigint, keluar bigint)
language sql stable as $$
  select to_char((created_at at time zone 'Asia/Jakarta')::date, 'YYYY-MM-DD'),
         coalesce(sum(case when change_qty > 0 then change_qty end), 0)::bigint,
         coalesce(sum(case when change_qty < 0 then -change_qty end), 0)::bigint
  from stock_log
  where created_at >= (((now() at time zone 'Asia/Jakarta')::date - (p_days - 1))::timestamp at time zone 'Asia/Jakarta')
  group by 1
  order by 1;
$$;
