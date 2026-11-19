const express = require('express');
const XLSX = require('../xlsxLazy'); // lazy: lihat xlsxLazy.js
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { splitSkuQty } = require('../skuHelpers');
const { priceForSku, AF_DEFAULT_POTONGAN_PERSEN } = require('../skuPrices');

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

// Pecah kolom sku ("PKT50-SP29S x2, PKT50-SP29M x1") jadi [{ sku, qty }].
function parseItems(order) {
  const raw = String(order.sku || '').trim();
  if (!raw) return [];
  const fallbackQty = parseInt(String(order.jumlah || '').trim(), 10) || 1;
  return raw.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const parsed = splitSkuQty(p);
    return { sku: parsed.sku, qty: parsed.qty !== null ? parsed.qty : fallbackQty };
  }).filter((i) => i.sku);
}

// -> { estimasi, qty, sumber: 'harga_pesanan' | 'harga_sku', sku_tanpa_harga: [] }
function estimateOrder(order, potonganPersen) {
  const potongan = Number.isFinite(potonganPersen) ? potonganPersen : AF_DEFAULT_POTONGAN_PERSEN;
  const items = parseItems(order);
  const qty = items.reduce((s, i) => s + i.qty, 0);
  if (USE_PELEPASAN_DANA) {
    const dana = parseMoney(order.pelepasan_dana);
    if (dana !== null && dana > 0) return { estimasi: dana, qty, sumber: 'dana_platform', sku_tanpa_harga: [] };
  }
  const subtotal = parseMoney(order.subtotal_pesanan);
  if (subtotal !== null) return { estimasi: subtotal, qty, sumber: 'harga_pesanan', sku_tanpa_harga: [] };

  let total = 0;
  const unknown = [];
  for (const it of items) {
    const price = priceForSku(it.sku);
    if (price === null) unknown.push(it.sku);
    else total += price * it.qty;
  }
  return { estimasi: Math.round(total * (1 - potongan / 100)), bruto: total, potongan, qty, sumber: 'harga_sku', sku_tanpa_harga: unknown };
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
function getPotongan(req) {
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

  const potongan = getPotongan(req);
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

  const potongan = getPotongan(req);
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
      sku: o.sku || '',
      jumlah: e.qty,
      estimasi: e.estimasi,
      sumber: e.sumber,
      bruto: e.bruto ?? null,
      potongan: e.sumber === 'harga_sku' ? e.potongan : null,
      sku_tanpa_harga: e.sku_tanpa_harga,
      tanggal: wibDateStr(o.imported_at),
      cs_input: !!o.cs_input_done,
    };
  });

  res.json({ orders, page, limit, total: count || 0, total_pages: Math.max(1, Math.ceil((count || 0) / limit)), cs_input_ready: csReady });
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

// Export daftar pesanan (periode yang sama dengan tampilan) ke Excel, lengkap dengan Nama Toko.
// Periode, kolom tanggal & urutan semuanya pakai TANGGAL IMPORT, sama seperti angka di layar.
// Query: preset/from/to/potongan (sama seperti /summary), sort:
//   toko    (bawaan) -> urut nama toko A-Z, di dalam toko dari import terlama ke terbaru
//   terlama           -> urut tanggal import terlama dulu
//   terbaru           -> urut tanggal import terbaru dulu
const SUMBER_LABEL = {
  dana_platform: 'Dana Platform',
  harga_pesanan: 'Harga Pesanan',
  harga_sku: 'Harga SKU (dikurangi potongan)',
};

function wibDateTimeStr(ts) {
  return new Date(new Date(ts).getTime() + WIB_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

router.get('/export', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  let range;
  try { range = getRange(req); } catch (e) { return res.status(400).json({ error: e.message }); }

  const potongan = getPotongan(req);
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
  const byTime = (a, b) => tCmp(a, b, 1);
  if (sort === 'terlama') items.sort(byTime);
  else if (sort === 'terbaru') items.sort((a, b) => tCmp(a, b, -1));
  else {
    items.sort((a, b) => {
      const ka = tokoKey(a), kb = tokoKey(b);
      if (ka !== kb) {
        if (!ka) return 1; // pesanan tanpa nama toko ditaruh paling bawah
        if (!kb) return -1;
        return ka < kb ? -1 : 1;
      }
      return byTime(a, b);
    });
  }

  const rows = items.map(({ o, e }, i) => ({
    'No': i + 1,
    'No. Pesanan': o.no_pesanan,
    'Nama Toko': o.toko || '-',
    'Tanggal Import (WIB)': o.imported_at ? wibDateTimeStr(o.imported_at) : '-',
    'SKU': o.sku || '',
    'Jumlah': e.qty,
    'Sumber Perhitungan': SUMBER_LABEL[e.sumber] || e.sumber,
    'Estimasi Penghasilan': e.estimasi,
    'Status Input CS': o.cs_input_done ? 'Sudah' : 'Belum',
  }));

  const totalQty = items.reduce((s, x) => s + x.e.qty, 0);
  const totalEstimasi = items.reduce((s, x) => s + x.e.estimasi, 0);
  if (rows.length) {
    rows.push({
      'No': '', 'No. Pesanan': 'TOTAL', 'Nama Toko': '', 'Tanggal Import (WIB)': '', 'SKU': '',
      'Jumlah': totalQty, 'Sumber Perhitungan': '', 'Estimasi Penghasilan': totalEstimasi, 'Status Input CS': '',
    });
  }

  const sheetData = rows.length ? rows : [{ 'Tidak ada data': 'Tidak ada pesanan pada periode ini' }];
  const worksheet = XLSX.utils.json_to_sheet(sheetData);
  worksheet['!cols'] = [{ wch: 5 }, { wch: 22 }, { wch: 22 }, { wch: 20 }, { wch: 36 }, { wch: 9 }, { wch: 30 }, { wch: 20 }, { wch: 16 }];

  // Format angka rupiah (#,##0) di kolom Estimasi Penghasilan (kolom H).
  if (rows.length && worksheet['!ref']) {
    const ref = XLSX.utils.decode_range(worksheet['!ref']);
    for (let r = ref.s.r + 1; r <= ref.e.r; r++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r, c: 7 })];
      if (cell && typeof cell.v === 'number') cell.z = '"Rp"#,##0';
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Estimasi Penghasilan');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `estimasi-penghasilan-${range.from}_sd_${range.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

module.exports = router;
module.exports.estimateOrder = estimateOrder;
module.exports.parseMoney = parseMoney;
