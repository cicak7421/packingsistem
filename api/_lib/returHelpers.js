const supabase = require('./supabase');
const { cleanSku } = require('./skuHelpers');
const { parseSkuLines, reconcileRakBreakdown } = require('./inventoryHelpers');

// ---------- Alur Retur ----------
// Pesanan retur = orders.retur_at terisi (lihat migration-retur.sql).

const RETUR_COLS = 'retur_at, retur_kondisi, retur_alasan';
const RETUR_MISSING_MSG = 'Kolom retur belum ada di database. Jalankan migration-retur.sql di Supabase SQL Editor dulu.';
const isReturColErr = (err) => /retur_(at|by|kondisi|alasan|catatan)/i.test(String((err && err.message) || ''));

const RETUR_ALASAN = ['Gagal kirim / alamat tidak ditemukan', 'Pembeli menolak / tidak di tempat', 'Pembeli ajukan pengembalian', 'Barang rusak / cacat', 'Salah kirim barang', 'Lainnya'];

// Cek sekali apakah kolom retur sudah ada. Hasil "sudah ada" diingat selama function hidup;
// hasil "belum ada" cuma diingat 30 detik supaya langsung aktif begitu migration dijalankan.
let ready = { ok: false, at: 0 };
async function returReady() {
  if (ready.ok) return true;
  if (Date.now() - ready.at < 30000) return false;
  const { error } = await supabase.from('orders').select('retur_at').limit(1);
  ready = { ok: !error, at: Date.now() };
  return ready.ok;
}

// Balikin stok barang retur ke Inventory (dir = 1), atau batalkan pengembalian itu (dir = -1).
// Aman dipanggil berulang: dicek dulu dari stock_log (source 'retur' / 'retur_batal') apakah stok
// pesanan ini lagi dalam keadaan "sudah dibalikin". TIDAK pernah throw.
async function adjustStockForRetur(order, userId, dir) {
  const out = { restocked: [], skus_not_registered: [] };
  try {
    const totals = new Map();
    for (const l of parseSkuLines(order)) {
      const key = cleanSku(l.sku).toUpperCase();
      if (key) totals.set(key, (totals.get(key) || 0) + l.qty);
    }
    for (const [key, qty] of totals) {
      const pattern = key.replace(/[\\%_]/g, (c) => '\\' + c);
      const { data: cands, error: pErr } = await supabase.from('products').select('id, sku, stock_qty').ilike('sku', pattern).order('id');
      if (pErr) return { ...out, error: 'Gagal membaca produk: ' + pErr.message };
      const prod = (cands || []).find((r) => cleanSku(r.sku).toUpperCase() === key);
      if (!prod) { out.skus_not_registered.push(key); continue; }

      const { data: logs, error: lErr } = await supabase
        .from('stock_log').select('change_qty').eq('order_id', order.id).eq('product_id', prod.id).in('source', ['retur', 'retur_batal']);
      if (lErr) return { ...out, error: 'Gagal mengecek riwayat stok: ' + lErr.message };
      const net = (logs || []).reduce((s, r) => s + Number(r.change_qty || 0), 0);
      if (dir > 0 && net > 0) continue; // sudah pernah dibalikin
      if (dir < 0 && net <= 0) continue; // gak ada yang perlu dibatalkan

      const delta = dir > 0 ? qty : -net;
      const newStock = Math.max(0, Number(prod.stock_qty || 0) + delta);
      const { error: uErr } = await supabase.from('products').update({ stock_qty: newStock }).eq('id', prod.id);
      if (uErr) return { ...out, error: 'Gagal mengubah stok ' + prod.sku + ': ' + uErr.message };
      const { error: insErr } = await supabase.from('stock_log').insert({
        product_id: prod.id, change_qty: delta, resulting_stock: newStock, source: dir > 0 ? 'retur' : 'retur_batal',
        note: (dir > 0 ? 'Retur pesanan ' : 'Batal retur pesanan ') + (order.no_pesanan || ''), order_id: order.id, user_id: userId || null,
      });
      if (insErr) console.error('[retur] gagal catat stock_log:', insErr.message);
      if (delta < 0) await reconcileRakBreakdown(prod.id, newStock);
      out.restocked.push({ sku: prod.sku, qty: delta });
    }
  } catch (e) {
    console.error('[retur] ubah stok gagal:', e.message);
    return { ...out, error: e.message };
  }
  return out;
}

module.exports = { RETUR_COLS, RETUR_MISSING_MSG, RETUR_ALASAN, isReturColErr, returReady, adjustStockForRetur };
