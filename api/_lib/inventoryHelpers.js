const supabase = require('./supabase');

// ---------- Reconcile breakdown rak (product_rak) supaya gak pernah melebihi total stok produk ----------
// Ada 2 jalur yang bisa NGURANGIN products.stock_qty tanpa nyentuh breakdown product_rak sama
// sekali: (1) auto-deduct stok pas packing scan (packing.js), dan (2) adjust manual kurang stok
// tanpa milih rak asal (inventory.js). Kalau dibiarkan, breakdown per-rak jadi "nyangkut" --
// masih nunjukin ada stok di rak X padahal total stok produknya udah berkurang/habis. Efeknya:
// rak jadi gak bisa dihapus (dianggap "masih dipakai") padahal fisiknya udah kosong.
//
// Fungsi ini dipanggil SETELAH products.stock_qty di-update, dan motong breakdown rak (mulai
// dari rak dengan qty paling banyak) sampai total breakdown <= stok baru. Aman dipanggil kapan
// aja walau produk belum ada breakdown rak sama sekali (langsung no-op).
async function reconcileRakBreakdown(productId, newTotalStock) {
  const { data: rows } = await supabase
    .from('product_rak')
    .select('*')
    .eq('product_id', productId)
    .gt('qty', 0)
    .order('qty', { ascending: false });
  if (!rows || rows.length === 0) return;

  const placed = rows.reduce((sum, r) => sum + r.qty, 0);
  let excess = placed - newTotalStock;
  if (excess <= 0) return;

  for (const row of rows) {
    if (excess <= 0) break;
    const cut = Math.min(row.qty, excess);
    if (cut > 0) {
      await supabase.from('product_rak').update({ qty: row.qty - cut }).eq('id', row.id);
      excess -= cut;
    }
  }
}

// ---------- Paginasi: PostgREST/Supabase membatasi 1000 baris per request ----------
// buildQuery harus mengembalikan query BARU tiap dipanggil (builder Supabase sekali pakai).
async function fetchAllRows(buildQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { data: all, error: null };
}

// ---------- Auto-deduct stok saat pesanan selesai di-packing ----------
// Kolom orders.sku: "SP30S x20, SP74 x3" (multi-item) atau "SP30S" (pakai orders.jumlah).
// Varian bundling "PKTxx-KODE" (contoh PKT20-SP24 = 1 paket isi 20pcs SP24) dikali jumlah pcs.
const BUNDLE_SKU_RE = /^PKT(\d+)-(.+)$/i;
function resolveBundle(sku, qty) {
  const m = BUNDLE_SKU_RE.exec(sku);
  if (!m) return { sku, qty };
  const perPack = parseInt(m[1], 10) || 1;
  return { sku: m[2].trim(), qty: qty * perPack };
}

function parseSkuLines(order) {
  const raw = String(order.sku || '').trim();
  if (!raw) return [];
  const fallbackQty = parseInt(String(order.jumlah || '').trim(), 10) || 1;
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    // terima "x" biasa maupun "×" (tanda kali) supaya format apa pun tetap ke-parse
    const m = /^(.*?)\s*[xX×]\s*(\d+)$/.exec(part);
    const rawSku = m ? m[1].trim() : part;
    const rawQty = m ? (parseInt(m[2], 10) || 1) : fallbackQty;
    return resolveBundle(rawSku, rawQty);
  }).filter((l) => l.sku);
}

// Error "fungsi Postgres belum ada" (migration-inventory-realtime.sql belum dijalankan di
// Supabase). Kalau ini yang terjadi, stok tetap dipotong lewat jalur cadangan di bawah --
// sebelumnya error ini cuma di-log diam-diam & stok gak pernah berkurang.
function isMissingRpc(error) {
  const txt = `${error?.code || ''} ${error?.message || ''}`;
  return /PGRST202|could not find the function|schema cache|does not exist/i.test(txt);
}

// Jalur cadangan (logikanya sama dengan deduct_stock_for_orders di SQL): cocokkan SKU
// case-insensitive, lewati kalau pesanan+produk ini sudah pernah dipotong (cek stock_log),
// stok gak pernah di bawah 0, catat ke stock_log, lalu rapikan breakdown rak. Gak seatomik
// versi SQL (gak ada row lock), makanya cuma dipakai kalau fungsi SQL-nya belum terpasang.
async function deductStockFallback(payload, userId) {
  const missing = new Set();
  for (const o of payload) {
    const totals = new Map();
    for (const l of o.lines) {
      const key = String(l.sku || '').trim().toUpperCase();
      if (key) totals.set(key, (totals.get(key) || 0) + l.qty);
    }
    for (const [key, qty] of totals) {
      const pattern = key.replace(/[\\%_]/g, (c) => '\\' + c);
      const { data: cands, error: pErr } = await supabase
        .from('products').select('id, sku, stock_qty').ilike('sku', pattern).order('id');
      if (pErr) return { error: 'Gagal membaca produk: ' + pErr.message };
      const prod = (cands || []).find((r) => String(r.sku || '').trim().toUpperCase() === key);
      if (!prod) { missing.add(key); continue; }

      const { data: done, error: lErr } = await supabase
        .from('stock_log').select('id').eq('order_id', o.id).eq('product_id', prod.id).eq('source', 'auto_packing').limit(1);
      if (lErr) return { error: 'Gagal mengecek riwayat stok: ' + lErr.message };
      if (done && done.length) continue;

      const newStock = Math.max(0, prod.stock_qty - qty);
      const { error: uErr } = await supabase.from('products').update({ stock_qty: newStock }).eq('id', prod.id);
      if (uErr) return { error: 'Gagal mengurangi stok ' + prod.sku + ': ' + uErr.message };
      const { error: insErr } = await supabase.from('stock_log').insert({
        product_id: prod.id, change_qty: -qty, resulting_stock: newStock, source: 'auto_packing',
        note: 'Otomatis dari packing pesanan ' + (o.no || ''), order_id: o.id, user_id: userId || null,
      });
      if (insErr) console.error('[inventory] gagal catat stock_log:', insErr.message);
      await reconcileRakBreakdown(prod.id, newStock);
    }
  }
  return missing.size ? { skus_not_registered: [...missing] } : null;
}

// Versi bulk: orders = [{ id, no_pesanan, sku, jumlah }]. Atomik & idempotent di sisi Postgres
// (fungsi deduct_stock_for_orders di migration-inventory-realtime.sql), jadi aman dipanggil
// dari jalur mana pun tanpa risiko dobel potong. TIDAK pernah throw -- kegagalan dikembalikan
// sebagai { error } / { skus_not_registered } (dan di-log) supaya proses packing/kirim gak ikut
// gagal, tapi pemanggil bisa nampilin peringatannya ke user.
async function autoDeductStockForOrders(orders, userId) {
  const payload = (orders || [])
    .map((o) => ({ id: o.id, no: o.no_pesanan || null, lines: parseSkuLines(o) }))
    .filter((o) => o.id && o.lines.length);
  if (payload.length === 0) return null;

  const missing = new Set();
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    const { data, error } = await supabase.rpc('deduct_stock_for_orders', {
      p_user_id: userId || null,
      p_orders: chunk,
    });
    if (error && isMissingRpc(error)) {
      console.warn('[inventory] fungsi deduct_stock_for_orders belum ada di database -- pakai jalur cadangan. Jalankan migration-inventory-realtime.sql.');
      const fb = await deductStockFallback(chunk, userId);
      if (fb?.error) { console.error('[inventory] auto-deduct (cadangan) gagal:', fb.error); return fb; }
      for (const s of fb?.skus_not_registered || []) missing.add(s);
      continue;
    }
    if (error) {
      console.error('[inventory] auto-deduct gagal:', error.message);
      return { error: error.message };
    }
    for (const s of data?.skus_not_registered || []) missing.add(s);
  }
  return missing.size ? { skus_not_registered: [...missing] } : null;
}

// Satu pesanan. Beda dari versi bulk: kalau pesanannya gak punya SKU sama sekali, itu
// dikembalikan sebagai { no_sku: true } (bukan diam-diam dilewatin) biar kelihatan di layar scan.
async function autoDeductStockForOrder(order, userId) {
  if (parseSkuLines(order).length === 0) return { no_sku: true };
  return autoDeductStockForOrders([order], userId);
}

module.exports = { reconcileRakBreakdown, fetchAllRows, parseSkuLines, autoDeductStockForOrder, autoDeductStockForOrders, isMissingRpc };
