const supabase = require('./supabase');
const { cleanSku } = require('./skuHelpers');
const { parseSkuLines, reconcileRakBreakdown } = require('./inventoryHelpers');

// ---------- Alur Retur ----------
// Pesanan retur = orders.retur_at terisi (lihat migration-retur.sql).

const RETUR_COLS = 'retur_at, retur_kondisi, retur_alasan';
const RETUR_MISSING_MSG = 'Kolom retur belum ada di database. Jalankan migration-retur.sql di Supabase SQL Editor dulu.';
const isReturColErr = (err) => /retur_(at|by|kondisi|alasan|catatan|validated|items|masalah)/i.test(String((err && err.message) || ''));
const isValidasiColErr = (err) => /retur_validated/i.test(String((err && err.message) || ''));
// Kolom detail validasi (pcs balik / rusak per SKU + kenapa tidak sesuai).
const isDetailColErr = (err) => /retur_(items|masalah)/i.test(String((err && err.message) || ''));
const DETAIL_MISSING_MSG = 'Detail validasi (pcs balik/rusak & kenapa tidak sesuai) BELUM tersimpan: jalankan ulang migration-retur.sql di Supabase SQL Editor.';
const VALIDASI_MISSING_MSG = 'Kolom validasi retur belum ada di database. Jalankan ulang migration-retur.sql di Supabase SQL Editor.';
// Kondisi hasil cek fisik: 'sesuai' | 'tidak_sesuai'. Data lama: bagus -> sesuai, rusak -> tidak_sesuai.
const normKondisi = (v) => (['tidak_sesuai', 'rusak'].includes(String(v || '').toLowerCase()) ? 'tidak_sesuai' : 'sesuai');

// Kenapa hasil validasinya TIDAK SESUAI (dipilih admin/CS saat validasi).
const RETUR_MASALAH = ['Jumlah kurang', 'Barang rusak / cacat', 'Barang beda / tertukar', 'Paket kosong', 'Segel / kemasan sudah dibuka', 'Lainnya'];

// Isi pesanan per SKU (bundle sudah dipecah, SKU kembar dijumlah): [{ sku, qty }].
function returOrderItems(order) {
  const totals = new Map();
  for (const l of parseSkuLines(order)) {
    const key = cleanSku(l.sku).toUpperCase();
    if (key) totals.set(key, (totals.get(key) || 0) + l.qty);
  }
  return [...totals].map(([sku, qty]) => ({ sku, qty }));
}

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

// Samakan stok retur pesanan ini di Inventory dengan targetnya:
//   dir = -1          -> target 0 (batalkan semua stok retur yang sempat masuk)
//   dir = 1           -> target = qty pesanan penuh, atau
//   dir = 1 + targets -> target per SKU dari Map(SKU -> pcs yang masuk stok), mis. balik sebagian.
// Aman dipanggil berulang / dikoreksi: selisihnya dihitung dari stock_log (source 'retur' /
// 'retur_batal') pesanan ini, jadi cuma BEDANYA yang ditambah / ditarik. TIDAK pernah throw.
async function adjustStockForRetur(order, userId, dir, targets) {
  const out = { restocked: [], skus_not_registered: [] };
  try {
    for (const { sku: key, qty } of returOrderItems(order)) {
      const target = dir < 0 ? 0 : targets ? Math.max(0, Math.min(qty, Number(targets.get(key)) || 0)) : qty;
      const pattern = key.replace(/[\\%_]/g, (c) => '\\' + c);
      const { data: cands, error: pErr } = await supabase.from('products').select('id, sku, stock_qty').ilike('sku', pattern).order('id');
      if (pErr) return { ...out, error: 'Gagal membaca produk: ' + pErr.message };
      const prod = (cands || []).find((r) => cleanSku(r.sku).toUpperCase() === key);
      if (!prod) { if (target > 0) out.skus_not_registered.push(key); continue; }

      const { data: logs, error: lErr } = await supabase
        .from('stock_log').select('change_qty').eq('order_id', order.id).eq('product_id', prod.id).in('source', ['retur', 'retur_batal']);
      if (lErr) return { ...out, error: 'Gagal mengecek riwayat stok: ' + lErr.message };
      const net = (logs || []).reduce((s, r) => s + Number(r.change_qty || 0), 0);
      const delta = target - Math.max(0, net);
      if (!delta) continue; // stok retur pesanan ini sudah pas
      const newStock = Math.max(0, Number(prod.stock_qty || 0) + delta);
      const { error: uErr } = await supabase.from('products').update({ stock_qty: newStock }).eq('id', prod.id);
      if (uErr) return { ...out, error: 'Gagal mengubah stok ' + prod.sku + ': ' + uErr.message };
      const { error: insErr } = await supabase.from('stock_log').insert({
        product_id: prod.id, change_qty: delta, resulting_stock: newStock, source: delta > 0 ? 'retur' : 'retur_batal',
        note: (delta > 0 ? 'Retur pesanan ' : dir < 0 ? 'Batal retur pesanan ' : 'Koreksi retur pesanan ') + (order.no_pesanan || ''), order_id: order.id, user_id: userId || null,
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

module.exports = { RETUR_COLS, RETUR_MISSING_MSG, VALIDASI_MISSING_MSG, DETAIL_MISSING_MSG, RETUR_ALASAN, RETUR_MASALAH, isReturColErr, isValidasiColErr, isDetailColErr, normKondisi, returReady, returOrderItems, adjustStockForRetur };
