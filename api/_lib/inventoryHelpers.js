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

module.exports = { reconcileRakBreakdown };
