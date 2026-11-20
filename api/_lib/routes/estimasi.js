const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { splitSkuQty } = require('../skuHelpers');
const { lineValue, splitBundleSku, AF_DEFAULT_POTONGAN_PERSEN, SKU_PRICE_EXACT, PKT50_PRICE_BY_SIZE } = require('../skuPrices');

const router = express.Router();

// ---------- Estimasi penghasilan ----------
// Aturan hitung per pesanan:
//   - Pesanan regular dari import Excel: pakai "Pelepasan Dana Platform" (dana yang benar-benar
//     cair setelah potongan platform) kalau ada; kalau kosong, pakai harga pesanan
//     (subtotal_pesanan). Ubah USE_PELEPASAN_DANA ke false kalau mau selalu pakai harga pesanan.
//   - Pesanan Advance Fulfilment / advance shipment (harga "-" / kosong) -> jumlahkan
//     harga per SKU x qty dari tabel api/_lib/skuPrices.js, lalu DIKURANGI potongan (%)
//     (bawaan 26%, bisa diubah dari tab Estimasi lewat query ?potongan=).
//   - Pesanan affiliate (kiriman gratis/sample) TIDAK dihitung sebagai penghasilan.
// Pengelompokan hari & bulan pakai kalender WIB (UTC+7), konsisten sama dashboard lain.
// Periode, rekap harian/bulanan, daftar pesanan & export semuanya berdasarkan TANGGAL IMPORT
// (kolom imported_at), bukan tanggal pesanan. imported_at diisi sekali waktu pesanan pertama kali
// masuk dan TIDAK ditimpa import ulang (lihat mergeWithExisting di import.js): diimpor jam 07:00 lalu
// diimpor lagi jam 09:00 tetap tercatat 07:00. Pesanan affiliate tidak dihitung di sini.

const USE_PELEPASAN_DANA = true;

// ---------- Konfigurasi (menu "Konfigurasi Harga") ----------
// Potongan advance shipment (%) & harga per SKU advance shipment / pengiriman cepat disimpan di
// database (migration-estimasi-config.sql) supaya semua user & export pakai angka yang sama.
// Harga yang diatur di sini MENANG atas tabel bawaan di skuPrices.js. Kalau tabelnya belum dibuat,
// estimasi tetap jalan pakai nilai bawaan (ready = false).
const CONFIG_TTL_MS = 10 * 1000;
let configCache = { at: 0, potongan: null, prices: new Map(), ready: true };
let skuOverrides = new Map(); // SKU (huruf besar, tanpa spasi) -> harga

const normSku = (v) => String(v ?? '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, '').toUpperCase();
const CONFIG_MISSING_MSG = 'Tabel konfigurasi belum ada di database. Jalankan migration-estimasi-config.sql di Supabase SQL Editor dulu.';
const isCfgTableErr = (err) => /estimasi_(settings|sku_prices)/i.test(String((err && err.message) || ''));

async function loadConfig(force = false) {
  if (!force && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache;
  let potongan = null;
  const prices = new Map();
  let ready = true;
  try {
    const [st, pr] = await Promise.all([
      supabase.from('estimasi_settings').select('value').eq('key', 'potongan').maybeSingle(),
      supabase.from('estimasi_sku_prices').select('sku, price, note, updated_at'),
    ]);
    if (st.error) ready = false;
    else if (st.data) {
      const n = Number(st.data.value);
      if (Number.isFinite(n)) potongan = Math.min(100, Math.max(0, n));
    }
    if (pr.error) ready = false;
    else for (const r of pr.data || []) prices.set(r.sku, { sku: r.sku, price: Number(r.price), note: r.note || '', updated_at: r.updated_at });
  } catch (e) {
    ready = false;
  }
  configCache = { at: Date.now(), potongan, prices, ready };
  skuOverrides = new Map([...prices.values()].map((r) => [r.sku, r.price]));
  return configCache;
}

// Harga yang diatur di menu Konfigurasi (menang atas price list di skuPrices.js); null kalau gak ada.
function getOverride(key) {
  return skuOverrides.has(key) ? skuOverrides.get(key) : null;
}
// Nilai 1 baris item (sudah di-split): { total, perUnit, acuan, ... } atau null kalau harga belum ada.
function itemValue(it) {
  return lineValue(it.pack, it.packQty, getOverride);
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const PAGE_SIZE = 1000; // batas PostgREST per request
const MAX_ROWS = 50000; // pengaman

function wibDateStr(ts) {
  return new Date(new Date(ts).getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}
function todayWIB() {
  return new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function wibStartUTC(dateStr) {
  return new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - WIB_OFFSET_MS).toISOString();
}
function labelTanggal(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function labelBulan(ym) {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Rentang [fromDate, toDate] inklusif, dalam tanggal kalender WIB.
function resolveRange(preset, from, to) {
  const today = todayWIB();
  if (preset === 'today') return { from: today, to: today, label: labelTanggal(today) };
  if (preset === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y, label: labelTanggal(y) }; }
  if (preset === 'last_month') {
    const [yy, mm] = today.split('-').map(Number);
    const first = new Date(Date.UTC(yy, mm - 2, 1));
    const last = new Date(Date.UTC(yy, mm - 1, 0));
    const f = first.toISOString().slice(0, 10);
    return { from: f, to: last.toISOString().slice(0, 10), label: labelBulan(f.slice(0, 7)) };
  }
  if (preset === 'custom') {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(String(from || '')) || !re.test(String(to || ''))) throw new Error('Tanggal dari dan sampai wajib diisi (format YYYY-MM-DD)');
    if (from > to) throw new Error('Tanggal awal tidak boleh setelah tanggal akhir');
    return { from, to, label: from === to ? labelTanggal(from) : `${from} s/d ${to}` };
  }
  // default this_month
  const first = `${today.slice(0, 7)}-01`;
  return { from: first, to: today, label: labelBulan(today.slice(0, 7)) };
}

// "126000", "126.000", "314.475", "572892.00", "1,234,567", "Rp 150.000", "150000,50" -> angka.
// Selain itu ("-", kosong, teks) -> null.
function parseMoney(raw) {
  let s = String(raw ?? '').trim().replace(/^rp\.?\s*/i, '').replace(/\s+/g, '');
  if (!s || s === '-') return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234.567,50
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); // 1,234,567.50
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // 150000,50
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Pecah kolom sku ("PKT50-SP29S x2, SP35M x1") jadi item per SKU SATUAN.
// Paket PKT{n}-KODE otomatis di-split: "PKT100-SP35M x2" -> { sku: 'SP35M', qty: 200 }.
//   sku/qty          = SKU satuan & total pcs (setelah split)
//   pack/packQty     = SKU & qty persis seperti ditulis di pesanan (dipakai buat cari harga)
//   perPack          = isi per paket (1 kalau bukan paket)
function parseItems(order) {
  const raw = String(order.sku || '').trim();
  if (!raw) return [];
  const fallbackQty = parseInt(String(order.jumlah || '').trim(), 10) || 1;
  return raw.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const parsed = splitSkuQty(p);
    const packQty = parsed.qty !== null ? parsed.qty : fallbackQty;
    const b = splitBundleSku(parsed.sku);
    if (!b) return { sku: parsed.sku, qty: packQty, pack: parsed.sku, packQty, perPack: 1 };
    return { sku: b.base, qty: packQty * b.perPack, pack: parsed.sku, packQty, perPack: b.perPack };
  }).filter((i) => i.sku);
}

// "PKT100-SP35M x2" -> "SP35M x200 (dari PKT100-SP35M x2)"; SKU satuan apa adanya.
function splitLabel(items) {
  return items.map((i) => (i.perPack > 1 ? `${i.sku} x${i.qty} (dari ${i.pack} x${i.packQty})` : `${i.sku} x${i.qty}`)).join(', ');
}

// -> { estimasi, qty (total pcs setelah split PKT), sumber, sku_tanpa_harga: [], sku_acuan: [] }
//    sku_acuan = SKU yang harganya cuma ACUAN dari price list (satuan x pcs), bukan harga patokan.
function estimateOrder(order, potonganPersen) {
  const potongan = Number.isFinite(potonganPersen) ? potonganPersen : AF_DEFAULT_POTONGAN_PERSEN;
  const items = parseItems(order);
  const qty = items.reduce((s, i) => s + i.qty, 0);
  if (USE_PELEPASAN_DANA) {
    const dana = parseMoney(order.pelepasan_dana);
    if (dana !== null && dana > 0) return { estimasi: dana, qty, sumber: 'dana_platform', sku_tanpa_harga: [], sku_acuan: [] };
  }
  const subtotal = parseMoney(order.subtotal_pesanan);
  if (subtotal !== null) return { estimasi: subtotal, qty, sumber: 'harga_pesanan', sku_tanpa_harga: [], sku_acuan: [] };

  let total = 0;
  const unknown = [];
  const acuan = [];
  for (const it of items) {
    const v = itemValue(it);
    if (v === null) unknown.push(it.pack);
    else {
      total += v.total;
      if (v.acuan) acuan.push(it.pack);
    }
  }
  return { estimasi: Math.round(total * (1 - potongan / 100)), bruto: Math.round(total), potongan, qty, sumber: 'harga_sku', sku_tanpa_harga: unknown, sku_acuan: acuan };
}

const SELECT_COLS = 'no_pesanan, sku, jumlah, subtotal_pesanan, pelepasan_dana, waktu_pesanan_at, toko, imported_at';
// Daftar pesanan & export juga bawa status "sudah diinput tim CS" (kolom cs_input_done, lihat
// migration-estimasi-cs-input.sql). Kalau migration-nya belum dijalankan, daftar tetap jalan
// (semua dianggap merah/belum) -- ringkasan & rekap gak pernah butuh kolom ini.
const SELECT_COLS_LIST = SELECT_COLS + ', cs_input_done';
const isCsColErr = (err) => /cs_input_done/i.test(String((err && err.message) || ''));

function baseQuery(range, cols = SELECT_COLS) {
  return supabase
    .from('orders')
    .select(cols)
    .eq('is_affiliate', false)
    .not('imported_at', 'is', null)
    .gte('imported_at', wibStartUTC(range.from))
    .lt('imported_at', wibStartUTC(addDays(range.to, 1)))
    .order('imported_at', { ascending: false })
    .order('id', { ascending: false });
}

// Potongan (%) advance shipment dari query ?potongan=, dibatasi 0-100; kosong/ngaco -> bawaan.
function getPotongan(req, cfg) {
  if (cfg && cfg.potongan !== null) return cfg.potongan; // yang disimpan di menu Konfigurasi
  const raw = String(req.query.potongan ?? '').trim().replace(',', '.');
  if (raw === '') return AF_DEFAULT_POTONGAN_PERSEN;
  const n = Number(raw);
  if (!Number.isFinite(n)) return AF_DEFAULT_POTONGAN_PERSEN;
  return Math.min(100, Math.max(0, n));
}

function getRange(req) {
  const { preset = 'this_month', from, to } = req.query;
  return resolveRange(preset, from, to);
}

// Ringkasan: total, rekap per hari, rekap per bulan.
router.get('/summary', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  let range;
  try { range = getRange(req); } catch (e) { return res.status(400).json({ error: e.message }); }

  const potongan = getPotongan(req, await loadConfig());
  const days = new Map(); // 'YYYY-MM-DD' -> { orders, qty, estimasi }
  let totalOrders = 0, totalQty = 0, totalEstimasi = 0, ordersTanpaHarga = 0;
  const skuTanpaHarga = new Set();

  for (let off = 0; off < MAX_ROWS; off += PAGE_SIZE) {
    const { data, error } = await baseQuery(range).range(off, off + PAGE_SIZE - 1);
    if (error) return res.status(500).json({ error: 'Gagal mengambil data estimasi: ' + error.message });
    for (const o of data || []) {
      const e = estimateOrder(o, potongan);
      const day = wibDateStr(o.imported_at);
      const d = days.get(day) || { orders: 0, qty: 0, estimasi: 0 };
      d.orders += 1; d.qty += e.qty; d.estimasi += e.estimasi;
      days.set(day, d);
      totalOrders += 1; totalQty += e.qty; totalEstimasi += e.estimasi;
      if (e.sku_tanpa_harga.length) { ordersTanpaHarga += 1; e.sku_tanpa_harga.forEach((s) => skuTanpaHarga.add(s)); }
    }
    if (!data || data.length < PAGE_SIZE) break;
  }

  const dayList = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, v]) => ({ date, label: labelTanggal(date), ...v }));

  const months = new Map();
  for (const d of dayList) {
    const ym = d.date.slice(0, 7);
    const m = months.get(ym) || { orders: 0, qty: 0, estimasi: 0 };
    m.orders += d.orders; m.qty += d.qty; m.estimasi += d.estimasi;
    months.set(ym, m);
  }
  const monthList = [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([ym, v]) => ({ month: ym, label: labelBulan(ym), ...v }));

  res.json({
    range: { from: range.from, to: range.to, label: range.label },
    potongan,
    total_orders: totalOrders,
    total_qty: totalQty,
    total_estimasi: totalEstimasi,
    orders_tanpa_harga: ordersTanpaHarga,
    sku_tanpa_harga: [...skuTanpaHarga].sort(),
    days: dayList,
    months: monthList,
  });
});

// Daftar pesanan (No. Pesanan, SKU, Jumlah, Estimasi), dipaginasi.
// Query: preset/from/to (sama seperti /summary), page, limit. Klik 1 hari di rekap harian
// = panggil dengan preset=custom&from=hari&to=hari.
router.get('/orders', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  let range;
  try { range = getRange(req); } catch (e) { return res.status(400).json({ error: e.message }); }

  const potongan = getPotongan(req, await loadConfig());
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const fromIdx = (page - 1) * limit;

  const countQ = supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('is_affiliate', false)
    .not('imported_at', 'is', null)
    .gte('imported_at', wibStartUTC(range.from))
    .lt('imported_at', wibStartUTC(addDays(range.to, 1)));

  let csReady = true;
  let [{ count, error: cErr }, { data, error }] = await Promise.all([countQ, baseQuery(range, SELECT_COLS_LIST).range(fromIdx, fromIdx + limit - 1)]);
  if (error && isCsColErr(error)) {
    csReady = false; // migration belum dijalankan -> tampilkan daftar tanpa status input CS
    ({ data, error } = await baseQuery(range, SELECT_COLS).range(fromIdx, fromIdx + limit - 1));
  }
  if (cErr || error) return res.status(500).json({ error: 'Gagal mengambil daftar pesanan: ' + (cErr || error).message });

  const orders = (data || []).map((o) => {
    const e = estimateOrder(o, potongan);
    return {
      no_pesanan: o.no_pesanan,
      toko: o.toko || '',
      sku: o.sku || '',
      sku_split: splitLabel(parseItems(o)),
      jumlah: e.qty,
      estimasi: e.estimasi,
      sumber: e.sumber,
      bruto: e.bruto ?? null,
      potongan: e.sumber === 'harga_sku' ? e.potongan : null,
      sku_tanpa_harga: e.sku_tanpa_harga,
      sku_acuan: e.sku_acuan,
      tanggal: wibDateStr(o.imported_at),
      cs_input: !!o.cs_input_done,
    };
  });

  res.json({ orders, page, limit, total: count || 0, total_pages: Math.max(1, Math.ceil((count || 0) / limit)), cs_input_ready: csReady });
});

// ---- Konfigurasi: potongan advance shipment & harga per SKU ----
router.get('/config', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const cfg = await loadConfig(true);
  res.json({
    ready: cfg.ready,
    potongan: cfg.potongan !== null ? cfg.potongan : AF_DEFAULT_POTONGAN_PERSEN,
    potongan_default: AF_DEFAULT_POTONGAN_PERSEN,
    prices: [...cfg.prices.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1)),
    defaults: { exact: SKU_PRICE_EXACT, by_size: PKT50_PRICE_BY_SIZE },
  });
});

router.put('/config/potongan', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const n = Number(String((req.body && req.body.potongan) ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'Potongan harus angka 0 sampai 100' });
  const { error } = await supabase.from('estimasi_settings')
    .upsert({ key: 'potongan', value: String(n), updated_at: new Date().toISOString(), updated_by: req.user.id }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: isCfgTableErr(error) ? CONFIG_MISSING_MSG : 'Gagal menyimpan potongan: ' + error.message });
  configCache.at = 0;
  res.json({ potongan: n });
});

router.put('/config/prices', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const sku = normSku(req.body && req.body.sku);
  const rawPrice = req.body && req.body.price;
  const price = typeof rawPrice === 'number' ? rawPrice : parseMoney(rawPrice); // "50.000" = 50 ribu
  const note = String((req.body && req.body.note) || '').trim().slice(0, 120);
  if (!sku || sku.length > 60) return res.status(400).json({ error: 'Kode SKU wajib diisi (maksimal 60 karakter)' });
  if (price === null || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Harga harus angka (Rp), minimal 0' });
  const { error } = await supabase.from('estimasi_sku_prices')
    .upsert({ sku, price: Math.round(price), note: note || null, updated_at: new Date().toISOString(), updated_by: req.user.id }, { onConflict: 'sku' });
  if (error) return res.status(500).json({ error: isCfgTableErr(error) ? CONFIG_MISSING_MSG : 'Gagal menyimpan harga: ' + error.message });
  configCache.at = 0;
  res.json({ sku, price: Math.round(price), note });
});

router.delete('/config/prices/:sku', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const sku = normSku(req.params.sku);
  if (!sku) return res.status(400).json({ error: 'Kode SKU wajib diisi' });
  const { error } = await supabase.from('estimasi_sku_prices').delete().eq('sku', sku);
  if (error) return res.status(500).json({ error: isCfgTableErr(error) ? CONFIG_MISSING_MSG : 'Gagal menghapus harga: ' + error.message });
  configCache.at = 0;
  res.json({ sku, deleted: true });
});

// Tandai pesanan sudah / belum diinput tim CS (merah = belum, hijau = sudah). Body: { no_pesanan, done }.
router.patch('/cs-input', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const noPesanan = String((req.body && req.body.no_pesanan) || '').trim();
  if (!noPesanan) return res.status(400).json({ error: 'No. Pesanan wajib diisi' });
  const done = !!(req.body && req.body.done === true);

  const { data, error } = await supabase
    .from('orders')
    .update({ cs_input_done: done, cs_input_at: done ? new Date().toISOString() : null })
    .eq('no_pesanan', noPesanan)
    .select('no_pesanan');
  if (error) {
    if (/cs_input_(done|at)/i.test(error.message || '')) {
      return res.status(500).json({ error: 'Kolom status input CS belum ada di database. Jalankan migration-estimasi-cs-input.sql di Supabase SQL Editor dulu.' });
    }
    return res.status(500).json({ error: 'Gagal menyimpan status: ' + error.message });
  }
  if (!data || !data.length) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  res.json({ no_pesanan: noPesanan, cs_input: done });
});

// Export ke Excel dengan format "Report Daily Order": sheet Orders (semua), satu sheet per hari
// (nama sheet = tanggal import, otomatis terpisah), dan sheet Daily Summary.
// Satu baris = satu SKU dalam pesanan (pesanan multi-SKU jadi beberapa baris); "Shopee Estimated
// Order Income" per PESANAN, jadi diisi di baris pertama pesanan saja (biar total tidak dobel).
// Periode, tanggal & urutan semuanya pakai TANGGAL IMPORT, sama seperti angka di layar.
// Query: preset/from/to/potongan (sama seperti /summary), sort:
//   toko    (bawaan) -> urut nama toko A-Z, di dalam toko dari import terlama ke terbaru
//   terlama           -> urut tanggal import terlama dulu
//   terbaru           -> urut tanggal import terbaru dulu
const EXPORT_HEAD = [
  'Order Date 日期', 'Order No. 订单号', 'Store 商店 ', 'SKU 商品编码', 'Quantity 数量',
  'Unit Price 单价', 'Line Total 行金额', 'Shopee Estimated Order Income 预计订单收入',
];
const SUMMARY_HEAD = [
  'Date 日期', 'Orders 订单数', 'SKU Lines SKU行数', 'Total Quantity 总数量',
  'SKU Line Total 商品行金额合计', 'Shopee Estimated Order Income 预计订单收入合计',
];
const RP_FMT = '"Rp" #,##0;[Red]-"Rp" #,##0';

function styleHeader(row, argb, height) {
  row.height = height;
  row.eachCell((c) => {
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
}

router.get('/export', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  let range;
  try { range = getRange(req); } catch (e) { return res.status(400).json({ error: e.message }); }

  const potongan = getPotongan(req, await loadConfig());
  const sort = ['toko', 'terlama', 'terbaru'].includes(req.query.sort) ? req.query.sort : 'toko';

  const all = [];
  let cols = SELECT_COLS_LIST;
  for (let off = 0; off < MAX_ROWS; off += PAGE_SIZE) {
    let { data, error } = await baseQuery(range, cols).range(off, off + PAGE_SIZE - 1);
    if (error && cols === SELECT_COLS_LIST && isCsColErr(error)) {
      cols = SELECT_COLS; // migration belum dijalankan -> semua dianggap belum diinput
      ({ data, error } = await baseQuery(range, cols).range(off, off + PAGE_SIZE - 1));
    }
    if (error) return res.status(500).json({ error: 'Gagal mengambil data untuk export: ' + error.message });
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  // t = waktu import (ms); pesanan tanpa imported_at (seharusnya gak ada) ditaruh paling akhir.
  const items = all.map((o) => ({ o, e: estimateOrder(o, potongan), t: o.imported_at ? new Date(o.imported_at).getTime() : null }));
  const tCmp = (a, b, dir) => {
    if (a.t === null && b.t === null) return 0;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return dir * (a.t - b.t);
  };
  const tokoKey = (x) => String(x.o.toko || '').trim().toLowerCase();
  if (sort === 'terlama') items.sort((a, b) => tCmp(a, b, 1));
  else if (sort === 'terbaru') items.sort((a, b) => tCmp(a, b, -1));
  else {
    items.sort((a, b) => {
      const ka = tokoKey(a), kb = tokoKey(b);
      if (ka !== kb) {
        if (!ka) return 1; // pesanan tanpa nama toko ditaruh paling bawah
        if (!kb) return -1;
        return ka < kb ? -1 : 1;
      }
      return tCmp(a, b, 1);
    });
  }

  // Pecah jadi baris per SKU.
  const lines = [];
  const perDay = new Map(); // tanggal -> { orders, lines, qty, total, income }
  for (const { o, e } of items) {
    const day = o.imported_at ? wibDateStr(o.imported_at) : '-';
    const skuItems = parseItems(o);
    const rows = skuItems.length ? skuItems : [{ sku: '', qty: null }];
    const d = perDay.get(day) || { orders: 0, lines: 0, qty: 0, total: 0, income: 0 };
    d.orders += 1;
    d.income += e.estimasi;
    // Harga satuan: kalau pesanan punya total harga (subtotal_pesanan) -> total / jumlah barang
    // (rata-rata kalau pesanannya multi-SKU, karena harga per SKU gak disimpen); kalau gak ada
    // (advance fulfilment) -> harga dari tabel SKU (skuPrices.js), kosong kalau SKU belum terdaftar.
    const subtotal = parseMoney(o.subtotal_pesanan);
    const orderQty = rows.reduce((sum, it) => sum + (it.qty || 0), 0);
    const avgPrice = subtotal !== null && orderQty > 0 ? subtotal / orderQty : null;
    rows.forEach((it, idx) => {
      // Pesanan multi-SKU: harga tiap SKU diambil dari skuPrices / Konfigurasi (bukan dibagi rata).
      // Rata-rata (subtotal / jumlah) cuma dipakai kalau pesanan 1 SKU, atau harga SKU-nya belum ada.
      const useSkuPrice = it.sku && (avgPrice === null || rows.length > 1);
      const val = useSkuPrice ? itemValue(it) : null;
      const usedAvg = !val && avgPrice !== null;
      const price = val ? val.perUnit : (usedAvg ? avgPrice : null);
      const lineTotal = it.qty !== null && price !== null ? it.qty * price : null;
      lines.push({
        day,
        no: o.no_pesanan,
        toko: o.toko || '-',
        sku: it.sku,
        qty: it.qty,
        price,
        lineTotal,
        income: idx === 0 ? e.estimasi : null,
        notes: [
          idx === 0 && o.cs_input_done ? 'Sudah diinput CS' : '',
          it.perPack > 1 ? `Split dari ${it.pack} x${it.packQty}` : '',
          val && val.acuan ? 'Harga acuan (price list)' : '',
          usedAvg && rows.length > 1 ? 'Harga rata-rata per unit (harga SKU belum ada)' : '',
        ].filter(Boolean).join(' | ') || null,
      });
      d.lines += 1;
      d.qty += it.qty || 0;
      d.total += lineTotal || 0;
    });
    perDay.set(day, d);
  }
  const days = [...perDay.keys()].sort();

  const ExcelJS = require('exceljs'); // lazy: lumayan berat, cuma dibutuhkan waktu export
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Flowmua';

  function addLineSheet(name, subset, withNotes, asDate) {
    const ws = wb.addWorksheet(name);
    const head = withNotes ? [...EXPORT_HEAD, 'Notes 备注'] : EXPORT_HEAD;
    ws.columns = (withNotes ? [14, 24, 24, 24, 12, 14, 18, 30, 22] : [14, 24, 24, 24, 12, 14, 18, 30]).map((width) => ({ width }));
    styleHeader(ws.addRow(head), 'FF1F4E78', 48);
    subset.forEach((l, i) => {
      const r = i + 2;
      const row = ws.addRow([
        asDate ? new Date(Date.UTC(+l.day.slice(0, 4), +l.day.slice(5, 7) - 1, +l.day.slice(8, 10))) : l.day,
        l.no, l.toko, l.sku, l.qty, l.price,
        { formula: `IF(OR(E${r}="",F${r}=""),"",E${r}*F${r})`, result: l.lineTotal === null ? '' : l.lineTotal },
        l.income,
        ...(withNotes ? [l.notes] : []),
      ]);
      row.getCell(1).numFmt = asDate ? 'yyyy-mm-dd' : '@';
      row.getCell(5).numFmt = '#,##0';
      row.getCell(6).numFmt = '#,##0';
      row.getCell(7).numFmt = RP_FMT;
      row.getCell(8).numFmt = RP_FMT;
      if (asDate) for (let c = 5; c <= 8; c++) row.getCell(c).alignment = { horizontal: 'center' };
      row.eachCell({ includeEmpty: true }, (c) => { c.font = { name: 'Calibri', size: 11 }; });
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (asDate && subset.length) ws.autoFilter = { from: 'A1', to: { row: subset.length + 1, column: withNotes ? 9 : 8 } };
    return ws;
  }

  addLineSheet('Orders', lines, true, true);
  for (const day of days) addLineSheet(day, lines.filter((l) => l.day === day), false, false);

  const sum = wb.addWorksheet('Daily Summary');
  sum.columns = [14, 11, 18, 16, 22, 38].map((width) => ({ width }));
  styleHeader(sum.addRow(SUMMARY_HEAD), 'FF548235', 46);
  days.forEach((day, i) => {
    const d = perDay.get(day);
    const q = `'${day}'`;
    const row = sum.addRow([
      day,
      d.orders,
      { formula: `COUNTA(${q}!B:B)-1`, result: d.lines },
      { formula: `SUM(${q}!E:E)`, result: d.qty },
      { formula: `SUM(${q}!G:G)`, result: d.total },
      { formula: `SUM(${q}!H:H)`, result: d.income },
    ]);
    row.getCell(1).numFmt = '@';
    for (let c = 2; c <= 4; c++) row.getCell(c).numFmt = '#,##0';
    row.getCell(5).numFmt = RP_FMT;
    row.getCell(6).numFmt = RP_FMT;
    for (let c = 2; c <= 6; c++) row.getCell(c).alignment = { horizontal: 'center' };
    row.eachCell({ includeEmpty: true }, (c) => { c.font = { name: 'Calibri', size: 11 }; });
  });
  sum.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `Report_Daily_Order_${range.from}_sd_${range.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

module.exports = router;
module.exports.estimateOrder = estimateOrder;
module.exports.parseMoney = parseMoney;
