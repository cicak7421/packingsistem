const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole, requirePermission } = require('../auth');
const { reconcileRakBreakdown } = require('../inventoryHelpers');

const router = express.Router();

// Role yang boleh MELIHAT modul inventory sama sekali (admin, inventory, packing --
// packing perlu lihat stok biar tau barang mana yang mau habis pas packing).
const VIEW_ROLES = ['admin', 'inventory', 'packing', 'cs'];

// ---------- Helper: upload gambar produk ke Supabase Storage ----------
// Frontend kirim base64 data URL (image/...;base64,....) lewat field `image_base64`.
// Dibatasi ~4MB biar aman di bawah limit request body Vercel (4.5MB Hobby plan).
async function uploadProductImage(imageBase64, skuHint) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageBase64 || '');
  if (!match) throw new Error('Format gambar tidak valid');
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw new Error('Ukuran gambar maksimal 4MB');

  const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const filename = `${(skuHint || 'produk').replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('product-images')
    .upload(filename, buffer, { contentType: mime, upsert: false });
  if (upErr) throw new Error('Gagal upload gambar: ' + upErr.message);

  const { data: pub } = supabase.storage.from('product-images').getPublicUrl(filename);
  return pub.publicUrl;
}

// ---------- Helper: ambil breakdown lokasi rak buat sekumpulan produk sekaligus ----------
// Dipakai di GET /products (list) biar gak N+1 query -- satu query product_rak buat semua
// produk yang lagi ditampilkan, lalu di-group per product_id di JS.
async function attachRakBreakdown(products) {
  if (products.length === 0) return products;
  const ids = products.map((p) => p.id);
  const { data: rows, error } = await supabase
    .from('product_rak')
    .select('product_id, qty, rak_id, rak_lokasi:rak_id(id, kode, keterangan)')
    .in('product_id', ids)
    .gt('qty', 0);
  if (error) return products.map((p) => ({ ...p, rak_breakdown: [], unallocated_qty: p.stock_qty }));

  const byProduct = new Map();
  for (const r of rows || []) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({ rak_id: r.rak_id, kode: r.rak_lokasi?.kode || '?', qty: r.qty });
  }

  return products.map((p) => {
    const breakdown = byProduct.get(p.id) || [];
    const placed = breakdown.reduce((s, b) => s + b.qty, 0);
    return { ...p, rak_breakdown: breakdown, unallocated_qty: Math.max(0, p.stock_qty - placed) };
  });
}

// ---------- List produk (dipakai grid utama + polling real-time di frontend) ----------
// Query opsional: ?search=&category=&low_stock=1&include_inactive=1&rak_id=
router.get('/products', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { search, category, low_stock, include_inactive, rak_id } = req.query;

  let q = supabase.from('products').select('*').order('name');
  if (!include_inactive) q = q.eq('active', true);
  if (category) q = q.eq('category', category);
  if (search) q = q.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);

  const { data: products, error } = await q;
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar produk: ' + error.message });

  let filtered = low_stock
    ? products.filter((p) => p.stock_qty <= p.min_stock)
    : products;

  let withRak = await attachRakBreakdown(filtered);

  if (rak_id) {
    withRak = withRak.filter((p) => p.rak_breakdown.some((b) => String(b.rak_id) === String(rak_id)));
  }

  res.json({ products: withRak, server_time: new Date().toISOString() });
});

// ---------- Ringkasan cepat (total produk, total item, produk stok menipis) ----------
router.get('/summary', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { data: products, error } = await supabase.from('products').select('stock_qty, min_stock, active').eq('active', true);
  if (error) return res.status(500).json({ error: 'Gagal mengambil ringkasan' });

  const total_products = products.length;
  const total_units = products.reduce((sum, p) => sum + (p.stock_qty || 0), 0);
  const low_stock_count = products.filter((p) => p.stock_qty <= p.min_stock).length;

  res.json({ total_products, total_units, low_stock_count, server_time: new Date().toISOString() });
});

// ---------- Detail 1 produk ----------
router.get('/products/:id', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { data: product, error } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Gagal mengambil produk' });
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  const [withRak] = await attachRakBreakdown([product]);
  res.json({ product: withRak });
});

// ---------- Tambah produk baru ----------
router.post('/products', requireAuth, requireRole('admin', 'inventory'), requirePermission('manage_products'), async (req, res) => {
  const { sku, name, category, unit, min_stock, stock_qty, image_base64 } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU dan Nama produk wajib diisi' });

  const { data: exists } = await supabase.from('products').select('id').eq('sku', sku).maybeSingle();
  if (exists) return res.status(409).json({ error: 'SKU sudah dipakai produk lain' });

  let image_url = null;
  if (image_base64) {
    try {
      image_url = await uploadProductImage(image_base64, sku);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const initialStock = Number(stock_qty) || 0;
  const { data: inserted, error } = await supabase
    .from('products')
    .insert({
      sku,
      name,
      category: category || null,
      unit: unit || 'pcs',
      stock_qty: initialStock,
      min_stock: Number(min_stock) || 0,
      image_url,
      created_by: req.user.id,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: 'Gagal membuat produk: ' + error.message });

  if (initialStock !== 0) {
    await supabase.from('stock_log').insert({
      product_id: inserted.id,
      change_qty: initialStock,
      resulting_stock: initialStock,
      source: 'manual',
      note: 'Stok awal saat produk dibuat',
      user_id: req.user.id,
    });
  }

  res.json({ product: inserted });
});

// ---------- Edit produk (info + ganti gambar opsional) ----------
router.patch('/products/:id', requireAuth, requireRole('admin', 'inventory'), requirePermission('manage_products'), async (req, res) => {
  const { name, category, unit, min_stock, image_base64, active, sku } = req.body;
  const { data: product, error: findErr } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  const update = {};
  if (name !== undefined) update.name = name;
  if (category !== undefined) update.category = category;
  if (unit !== undefined) update.unit = unit;
  if (min_stock !== undefined) update.min_stock = Number(min_stock) || 0;
  if (active !== undefined) update.active = !!active;
  if (sku !== undefined && sku !== product.sku) {
    const { data: exists } = await supabase.from('products').select('id').eq('sku', sku).neq('id', product.id).maybeSingle();
    if (exists) return res.status(409).json({ error: 'SKU sudah dipakai produk lain' });
    update.sku = sku;
  }
  if (image_base64) {
    try {
      update.image_url = await uploadProductImage(image_base64, sku || product.sku);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const { data: updated, error } = await supabase.from('products').update(update).eq('id', product.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Gagal update produk: ' + error.message });
  res.json({ product: updated });
});

// ---------- Hapus (nonaktifkan) produk ----------
// Sengaja soft-delete (active=false), bukan delete beneran, biar riwayat stock_log &
// integrasi SKU ke pesanan lama tetap aman/gak orphan.
router.delete('/products/:id', requireAuth, requireRole('admin', 'inventory'), requirePermission('manage_products'), async (req, res) => {
  const { error } = await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal menghapus produk' });
  res.json({ ok: true });
});

// ---------- Tambah / Kurangi stok manual ----------
// body: { change_qty: number (boleh negatif buat kurang, atau positif buat tambah), note,
//         rak_id (opsional) -- kalau diisi, breakdown lokasi rak produk ini ikut diupdate }
router.post('/products/:id/adjust', requireAuth, requireRole('admin', 'inventory', 'packing'), requirePermission('adjust_stock'), async (req, res) => {
  const changeQty = Number(req.body.change_qty);
  const note = (req.body.note || '').trim() || null;
  const rakId = req.body.rak_id ? Number(req.body.rak_id) : null;
  if (!Number.isFinite(changeQty) || changeQty === 0) {
    return res.status(400).json({ error: 'Jumlah perubahan stok wajib diisi (bukan 0)' });
  }

  const { data: product, error: findErr } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  const newStock = product.stock_qty + changeQty;
  if (newStock < 0) {
    return res.status(400).json({ error: `Stok tidak cukup. Stok saat ini ${product.stock_qty}, gak bisa dikurangi ${Math.abs(changeQty)}.` });
  }

  // Kalau adjustment ini disertai rak tujuan/asal, update breakdown lokasinya juga --
  // divalidasi DULU sebelum nulis apa pun, biar gak ada perubahan stok yang "nyangkut"
  // kalau ternyata rak-nya gak cukup buat dikurangi.
  let rakRow = null;
  if (rakId) {
    const { data: existingRak } = await supabase
      .from('product_rak')
      .select('*')
      .eq('product_id', product.id)
      .eq('rak_id', rakId)
      .maybeSingle();
    const currentRakQty = existingRak?.qty || 0;
    const newRakQty = currentRakQty + changeQty;
    if (newRakQty < 0) {
      return res.status(400).json({ error: `Stok di rak ini cuma ${currentRakQty}, gak bisa dikurangi ${Math.abs(changeQty)} dari rak tersebut.` });
    }
    rakRow = { id: existingRak?.id, product_id: product.id, rak_id: rakId, qty: newRakQty };
  }

  const { data: updated, error } = await supabase
    .from('products')
    .update({ stock_qty: newStock })
    .eq('id', product.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: 'Gagal update stok: ' + error.message });

  if (rakRow) {
    await supabase.from('product_rak').upsert(
      { product_id: rakRow.product_id, rak_id: rakRow.rak_id, qty: rakRow.qty },
      { onConflict: 'product_id,rak_id' }
    );
  }

  // Kalau stok berkurang, pastikan breakdown rak (termasuk rak lain yang gak disentuh adjustment
  // ini) gak ada yang "nyangkut" melebihi total stok baru -- lihat inventoryHelpers.js.
  if (changeQty < 0) {
    await reconcileRakBreakdown(product.id, newStock);
  }

  await supabase.from('stock_log').insert({
    product_id: product.id,
    change_qty: changeQty,
    resulting_stock: newStock,
    source: 'manual',
    note: rakId ? `${note ? note + ' — ' : ''}Lokasi: rak #${rakId}` : note,
    user_id: req.user.id,
  });

  const [withRak] = await attachRakBreakdown([updated]);
  res.json({ product: withRak });
});

// ---------- Pindah stok antar rak (gak mengubah total stok produk) ----------
// body: { from_rak_id (null/omit = dari "belum ditempatkan"), to_rak_id, qty }
router.post('/products/:id/rak/move', requireAuth, requireRole('admin', 'inventory', 'packing'), requirePermission('adjust_stock'), async (req, res) => {
  const qty = Number(req.body.qty);
  const fromRakId = req.body.from_rak_id ? Number(req.body.from_rak_id) : null;
  const toRakId = Number(req.body.to_rak_id);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Jumlah pindah wajib diisi (lebih dari 0)' });
  if (!toRakId) return res.status(400).json({ error: 'Rak tujuan wajib dipilih' });
  if (fromRakId === toRakId) return res.status(400).json({ error: 'Rak asal dan tujuan tidak boleh sama' });

  const { data: product, error: findErr } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  // Cek ketersediaan di sumber (rak tertentu, atau "belum ditempatkan" kalau fromRakId kosong)
  const { data: rakRows } = await supabase.from('product_rak').select('*').eq('product_id', product.id);
  const placedTotal = (rakRows || []).reduce((s, r) => s + r.qty, 0);
  const unallocated = Math.max(0, product.stock_qty - placedTotal);

  if (fromRakId) {
    const fromRow = (rakRows || []).find((r) => r.rak_id === fromRakId);
    const available = fromRow?.qty || 0;
    if (available < qty) return res.status(400).json({ error: `Stok di rak asal cuma ${available}, gak cukup buat pindah ${qty}.` });
    await supabase.from('product_rak').update({ qty: available - qty }).eq('id', fromRow.id);
  } else {
    if (unallocated < qty) return res.status(400).json({ error: `Stok "belum ditempatkan" cuma ${unallocated}, gak cukup buat pindah ${qty}.` });
  }

  const toRow = (rakRows || []).find((r) => r.rak_id === toRakId);
  if (toRow) {
    await supabase.from('product_rak').update({ qty: toRow.qty + qty }).eq('id', toRow.id);
  } else {
    await supabase.from('product_rak').insert({ product_id: product.id, rak_id: toRakId, qty });
  }

  const { data: finalProduct } = await supabase.from('products').select('*').eq('id', product.id).single();
  const [withRak] = await attachRakBreakdown([finalProduct]);
  res.json({ product: withRak });
});

// ---------- Riwayat perubahan stok 1 produk ----------
router.get('/products/:id/logs', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { data: logs, error } = await supabase
    .from('stock_log')
    .select('*, users:user_id(full_name)')
    .eq('product_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: 'Gagal mengambil riwayat stok' });

  const enriched = logs.map((l) => ({ ...l, user_name: l.users?.full_name || (l.source === 'auto_packing' ? 'Sistem (Auto)' : 'N/A') }));
  res.json({ logs: enriched });
});

// ---------- Grafik: pergerakan stok (masuk vs keluar) per hari, N hari terakhir ----------
// Dipakai buat grafik di halaman Inventory. Masuk = jumlah change_qty positif (manual restock),
// Keluar = jumlah |change_qty| negatif (manual kurang + auto_packing digabung, karena dari sisi
// gudang dua-duanya sama-sama "barang keluar").
router.get('/stock-chart', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);

  const { data: logs, error } = await supabase
    .from('stock_log')
    .select('change_qty, source, created_at')
    .gte('created_at', since.toISOString());
  if (error) return res.status(500).json({ error: 'Gagal mengambil data grafik: ' + error.message });

  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), masuk: 0, keluar: 0 });
  }
  for (const log of logs || []) {
    const key = log.created_at.slice(0, 10);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    if (log.change_qty > 0) bucket.masuk += log.change_qty;
    else bucket.keluar += Math.abs(log.change_qty);
  }

  res.json({ daily: [...byDay.values()] });
});

// ---------- Daftar kategori unik (buat dropdown filter) ----------
router.get('/categories', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { data, error } = await supabase.from('products').select('category').not('category', 'is', null);
  if (error) return res.status(500).json({ error: 'Gagal mengambil kategori' });
  const categories = [...new Set(data.map((d) => d.category).filter(Boolean))].sort();
  res.json({ categories });
});

// ---------- Master lokasi rak ----------
router.get('/rak-lokasi', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { data: rak, error } = await supabase.from('rak_lokasi').select('*').order('kode');
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar rak' });
  res.json({ rak });
});

// Tambah kode rak baru -- boleh dibuat bebas kapan aja ("Rak A1", "T01", dst), sesuai
// kebutuhan gudang. Dibuka juga buat role 'packing' yang punya izin adjust_stock, karena
// staf packing sering yang paling tau kalau ada rak baru dipakai di lapangan.
router.post('/rak-lokasi', requireAuth, requireRole('admin', 'inventory', 'packing'), requirePermission('adjust_stock'), async (req, res) => {
  const kode = (req.body.kode || '').trim();
  const keterangan = (req.body.keterangan || '').trim() || null;
  if (!kode) return res.status(400).json({ error: 'Kode rak wajib diisi' });

  const { data: exists } = await supabase.from('rak_lokasi').select('id').eq('kode', kode).maybeSingle();
  if (exists) return res.status(409).json({ error: 'Kode rak ini sudah ada' });

  const { data: inserted, error } = await supabase.from('rak_lokasi').insert({ kode, keterangan }).select('*').single();
  if (error) return res.status(500).json({ error: 'Gagal menambah rak: ' + error.message });
  res.json({ rak: inserted });
});

// Ubah nama/keterangan kode rak yang sudah ada. Dibuka buat admin & inventory (sama seperti
// hapus rak) -- staff packing yang cuma boleh tambah rak baru gak boleh rename/hapus, biar
// penamaan rak tetap konsisten dan gak berantakan diubah-ubah dari lapangan.
router.patch('/rak-lokasi/:id', requireAuth, requireRole('admin', 'inventory'), requirePermission('manage_products'), async (req, res) => {
  const { data: rak, error: findErr } = await supabase.from('rak_lokasi').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !rak) return res.status(404).json({ error: 'Rak tidak ditemukan' });

  const update = {};
  if (req.body.kode !== undefined) {
    const kode = String(req.body.kode).trim();
    if (!kode) return res.status(400).json({ error: 'Kode rak wajib diisi' });
    if (kode !== rak.kode) {
      const { data: exists } = await supabase.from('rak_lokasi').select('id').eq('kode', kode).neq('id', rak.id).maybeSingle();
      if (exists) return res.status(409).json({ error: 'Kode rak ini sudah dipakai' });
    }
    update.kode = kode;
  }
  if (req.body.keterangan !== undefined) {
    update.keterangan = String(req.body.keterangan).trim() || null;
  }

  const { data: updated, error } = await supabase.from('rak_lokasi').update(update).eq('id', rak.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Gagal mengubah rak: ' + error.message });
  res.json({ rak: updated });
});

// Hapus kode rak -- ditolak kalau masih dipakai produk manapun, biar gak ada data
// breakdown yang jadi orphan / nyasar.
router.delete('/rak-lokasi/:id', requireAuth, requireRole('admin', 'inventory'), requirePermission('manage_products'), async (req, res) => {
  // Self-heal dulu: breakdown rak bisa "nyangkut" kalau stoknya berkurang lewat jalur yang gak
  // nyentuh product_rak (auto-deduct packing / adjust tanpa pilih rak, dari sebelum perbaikan
  // reconcileRakBreakdown ada). Reconcile tiap produk yang kesangkut di rak ini terhadap stok
  // aslinya sekarang, biar cek "masih dipakai" di bawah ini gak salah nolak.
  const { data: rowsInRak } = await supabase.from('product_rak').select('product_id').eq('rak_id', req.params.id).gt('qty', 0);
  const productIds = [...new Set((rowsInRak || []).map((r) => r.product_id))];
  if (productIds.length > 0) {
    const { data: products } = await supabase.from('products').select('id, stock_qty').in('id', productIds);
    for (const p of products || []) {
      await reconcileRakBreakdown(p.id, p.stock_qty);
    }
  }

  const { data: inUse } = await supabase.from('product_rak').select('id').eq('rak_id', req.params.id).gt('qty', 0).limit(1);
  if (inUse && inUse.length > 0) {
    return res.status(409).json({ error: 'Rak ini masih dipakai buat nyimpen produk. Pindahkan dulu stoknya sebelum menghapus rak.' });
  }
  const { error } = await supabase.from('rak_lokasi').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal menghapus rak' });
  res.json({ ok: true });
});

// ---------- Breakdown lokasi rak 1 produk (dipakai modal "Lokasi Rak") ----------
router.get('/products/:id/rak', requireAuth, requireRole(...VIEW_ROLES), async (req, res) => {
  const { data: product, error: findErr } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  const [withRak] = await attachRakBreakdown([product]);
  res.json({ product: withRak });
});

module.exports = router;
