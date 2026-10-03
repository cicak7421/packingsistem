const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../supabase');
const { requireAuth, requireRole, requirePermission, effectivePermissions } = require('../auth');
const { reconcileRakBreakdown } = require('../inventoryHelpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Dipasang di /api/inventory/import-stock (lihat api/index.js).
//   POST /preview  -> baca file, hitung perubahan, TIDAK menulis apa pun ke database
//   POST /apply    -> baca file lagi, hitung ulang dari stok terbaru di DB, lalu tulis
//
// Format file (contoh: "Export_Inventory_List-....xls"): kolom "*SKU Barang" dan "Total Stok".
// Kolom lain (mis. "Gambar Barang") diabaikan. Nama kolom dicocokkan longgar (huruf besar/kecil,
// tanda *, spasi diabaikan), jadi "SKU", "sku barang", "Stok", "Qty" dll juga dikenali.
const SKU_ALIASES = ['skubarang', 'sku', 'kodesku', 'skuproduk', 'kodebarang'];
const QTY_ALIASES = ['totalstok', 'stok', 'stock', 'qty', 'jumlah', 'stokakhir', 'stoktotal'];
const NAME_ALIASES = ['namabarang', 'namaproduk', 'nama', 'productname'];

const norm = (v) => String(v ?? '').toLowerCase().replace(/[*\s_\-.]/g, '');

// ---------- Baca & validasi file ----------
function parseStockFile(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new Error('File tidak bisa dibaca. Pakai file Excel (.xls / .xlsx) atau .csv.');
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('File kosong / tidak ada sheet.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

  // Cari baris header di 10 baris pertama
  let headerIdx = -1, skuCol = -1, qtyCol = -1, nameCol = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map(norm);
    const s = cells.findIndex((c) => SKU_ALIASES.includes(c));
    const q = cells.findIndex((c) => QTY_ALIASES.includes(c));
    if (s !== -1 && q !== -1) {
      headerIdx = i; skuCol = s; qtyCol = q;
      nameCol = cells.findIndex((c) => NAME_ALIASES.includes(c));
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Kolom tidak ditemukan. File harus punya kolom "SKU Barang" dan "Total Stok".');
  }

  const entries = new Map(); // key = SKU uppercase -> { sku, qty, name, row }
  const invalid = [];
  const duplicates = [];
  let totalRows = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const sku = String(r[skuCol] ?? '').trim();
    const rawQty = r[qtyCol];
    if (!sku && (rawQty === '' || rawQty == null)) continue; // baris kosong
    totalRows++;
    const rowNo = i + 1; // nomor baris di Excel
    if (!sku) { invalid.push({ row: rowNo, sku: '', reason: 'SKU kosong' }); continue; }

    let qty = null;
    if (typeof rawQty === 'number') qty = rawQty;
    else {
      const t = String(rawQty ?? '').trim();
      if (/^-?\d+$/.test(t)) qty = Number(t);
      else if (/^\d{1,3}([.,]\d{3})+$/.test(t)) qty = Number(t.replace(/[.,]/g, '')); // "1.200" / "1,200"
    }
    if (qty === null || !Number.isFinite(qty)) { invalid.push({ row: rowNo, sku, reason: `Stok bukan angka ("${rawQty}")` }); continue; }
    if (!Number.isInteger(qty)) { invalid.push({ row: rowNo, sku, reason: `Stok harus bilangan bulat (${qty})` }); continue; }
    if (qty < 0) { invalid.push({ row: rowNo, sku, reason: `Stok negatif (${qty})` }); continue; }

    const key = sku.toUpperCase();
    if (entries.has(key)) duplicates.push({ sku, rows: [entries.get(key).row, rowNo] });
    // Kalau SKU dobel di file, baris TERAKHIR yang dipakai (dan dilaporkan sebagai peringatan)
    entries.set(key, { sku, qty, name: nameCol !== -1 ? String(r[nameCol] ?? '').trim() : '', row: rowNo });
  }
  return { entries, invalid, duplicates, totalRows };
}

// ---------- Ambil semua produk (Supabase batasi 1000 baris per query, jadi di-page) ----------
async function loadAllProducts() {
  const all = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, name, stock_qty, active')
      .order('id')
      .range(from, from + size - 1);
    if (error) throw new Error('Gagal membaca produk: ' + error.message);
    all.push(...data);
    if (data.length < size) break;
  }
  return all;
}

// ---------- Hitung rencana perubahan (dipakai preview & apply, biar hasilnya identik) ----------
function buildPlan(parsed, products, mode) {
  const byKey = new Map();
  for (const p of products) {
    const k = String(p.sku).trim().toUpperCase();
    if (!byKey.has(k)) byKey.set(k, p);
  }

  const changes = [], notFound = [], invalid = [...parsed.invalid];
  let unchanged = 0;

  for (const [key, e] of parsed.entries) {
    const p = byKey.get(key);
    if (!p) { notFound.push({ sku: e.sku, qty: e.qty, name: e.name }); continue; }
    const newStock = mode === 'add' ? p.stock_qty + e.qty : e.qty;
    if (newStock < 0) { invalid.push({ row: e.row, sku: e.sku, reason: `Hasil stok negatif (${p.stock_qty} + ${e.qty})` }); continue; }
    const diff = newStock - p.stock_qty;
    if (diff === 0) { unchanged++; continue; }
    changes.push({ id: p.id, sku: p.sku, name: p.name, old_stock: p.stock_qty, new_stock: newStock, diff, active: p.active });
  }
  return { changes, notFound, invalid, unchanged };
}

function summarize(parsed, plan) {
  return {
    total_rows: parsed.totalRows,
    to_update: plan.changes.length,
    unchanged: plan.unchanged,
    not_found: plan.notFound.length,
    invalid: plan.invalid.length,
    duplicates: parsed.duplicates.length,
    total_increase: plan.changes.filter((c) => c.diff > 0).reduce((s, c) => s + c.diff, 0),
    total_decrease: plan.changes.filter((c) => c.diff < 0).reduce((s, c) => s + Math.abs(c.diff), 0),
    inactive_touched: plan.changes.filter((c) => c.active === false).length,
  };
}

async function userHasPermission(req, key) {
  if (req.user.role === 'admin') return true;
  const { data } = await supabase.from('users').select('id, role, permissions, active').eq('id', req.user.id).maybeSingle();
  return !!(data && data.active && effectivePermissions(data)[key]);
}

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size));
  }
}

// Wrapper supaya error multer (file kebesaran dll) jadi JSON, bukan HTML error
function singleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File terlalu besar (maks 8MB)' : 'Upload gagal: ' + err.message });
    if (!req.file) return res.status(400).json({ error: 'Pilih file Excel dulu' });
    next();
  });
}

const guards = [requireAuth, requireRole('admin', 'inventory'), requirePermission('adjust_stock')];
const getMode = (req) => (req.body.mode === 'add' ? 'add' : 'set');

// ---------- PREVIEW: tidak menulis apa pun ----------
router.post('/preview', ...guards, singleFile, async (req, res) => {
  try {
    const parsed = parseStockFile(req.file.buffer);
    const products = await loadAllProducts();
    const plan = buildPlan(parsed, products, getMode(req));
    const LIMIT = 300;
    res.json({
      summary: summarize(parsed, plan),
      changes: plan.changes.slice(0, LIMIT),
      changes_truncated: plan.changes.length > LIMIT,
      not_found: plan.notFound.slice(0, LIMIT),
      invalid: plan.invalid.slice(0, LIMIT),
      duplicates: parsed.duplicates.slice(0, 50),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- APPLY: tulis ke database ----------
// body (multipart): file, mode = 'set' | 'add', create_new = '1' (opsional)
router.post('/apply', ...guards, singleFile, async (req, res) => {
  try {
    const mode = getMode(req);
    const createNew = req.body.create_new === '1' || req.body.create_new === 'true';
    if (createNew && !(await userHasPermission(req, 'manage_products'))) {
      return res.status(403).json({ error: 'Akun kamu tidak punya izin membuat produk baru. Matikan opsi "buat produk baru".' });
    }

    const parsed = parseStockFile(req.file.buffer);
    const products = await loadAllProducts(); // baca ulang: stok bisa berubah sejak preview (mis. auto-packing)
    const plan = buildPlan(parsed, products, mode);
    const note = `Import Excel${mode === 'add' ? ' (tambah)' : ''}: ${req.file.originalname}`;

    // 1) Update stok produk yang sudah ada.
    // .eq('stock_qty', old_stock) = optimistic lock: kalau stok produk ini berubah di antara
    // baca & tulis (mis. ada scan packing barusan), baris itu dilewati & dilaporkan, bukan ditimpa.
    const succeeded = [], conflicts = [], failed = [];
    await inChunks(plan.changes, 25, async (chunk) => {
      await Promise.all(chunk.map(async (c) => {
        const { data, error } = await supabase
          .from('products')
          .update({ stock_qty: c.new_stock })
          .eq('id', c.id)
          .eq('stock_qty', c.old_stock)
          .select('id');
        if (error) failed.push({ sku: c.sku, reason: error.message });
        else if (!data || data.length === 0) conflicts.push({ sku: c.sku, reason: 'Stok berubah saat proses (mungkin baru ada scan packing) — upload ulang untuk SKU ini' });
        else succeeded.push(c);
      }));
    });

    // 2) Catat riwayat stok
    await inChunks(succeeded, 200, async (chunk) => {
      await supabase.from('stock_log').insert(chunk.map((c) => ({
        product_id: c.id, change_qty: c.diff, resulting_stock: c.new_stock,
        source: 'import', note, user_id: req.user.id,
      })));
    });

    // 3) Rapikan breakdown rak untuk produk yang stoknya berkurang (satu query per 200 produk,
    //    bukan satu per produk, biar cepat)
    const decreased = succeeded.filter((c) => c.diff < 0);
    await inChunks(decreased, 200, async (chunk) => {
      const ids = chunk.map((c) => c.id);
      const { data: rakRows } = await supabase.from('product_rak').select('product_id').in('product_id', ids).gt('qty', 0);
      const withRak = new Set((rakRows || []).map((r) => r.product_id));
      const targets = chunk.filter((c) => withRak.has(c.id));
      await inChunks(targets, 10, (t) => Promise.all(t.map((c) => reconcileRakBreakdown(c.id, c.new_stock))));
    });

    // 4) Buat produk baru untuk SKU yang belum ada (opsional)
    let created = 0;
    const createFailed = [];
    if (createNew && plan.notFound.length > 0) {
      await inChunks(plan.notFound, 200, async (chunk) => {
        const { data: inserted, error } = await supabase
          .from('products')
          .insert(chunk.map((n) => ({ sku: n.sku, name: n.name || n.sku, stock_qty: n.qty, created_by: req.user.id })))
          .select('id, sku, stock_qty');
        if (error) { chunk.forEach((n) => createFailed.push({ sku: n.sku, reason: error.message })); return; }
        created += inserted.length;
        const logs = inserted.filter((p) => p.stock_qty !== 0).map((p) => ({
          product_id: p.id, change_qty: p.stock_qty, resulting_stock: p.stock_qty,
          source: 'import', note: `Stok awal (produk baru) — ${note}`, user_id: req.user.id,
        }));
        if (logs.length) await supabase.from('stock_log').insert(logs);
      });
    }

    res.json({
      ok: true,
      updated: succeeded.length,
      unchanged: plan.unchanged,
      created,
      skipped_not_found: createNew ? 0 : plan.notFound.length,
      invalid: plan.invalid.length,
      conflicts,
      failed: [...failed, ...createFailed],
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal import stok: ' + e.message });
  }
});

module.exports = router;
