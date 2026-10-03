const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { parseSkuLines } = require('../inventoryHelpers');
const {
  computeLate, ageWindow, countLate, thresholds,
  LATE_AFTER_HOURS, CRITICAL_AFTER_HOURS, SOON_AFTER_HOURS,
} = require('../lateHelpers');

const router = express.Router();

// Admin, CS, dan staff Inventory yang boleh cek, validasi, dan lihat paket telat.
router.use(requireAuth, requireRole('admin', 'cs', 'inventory'));

// Buang karakter yang bisa merusak filter PostgREST .or() (koma, kurung, kutip, wildcard).
const clean = (v) => String(v || '').trim().replace(/[,()*%\\"']/g, '');

// ---------- Pengecekan SKU ke Inventory ----------
async function loadProducts(skus) {
  const map = new Map(); // SKU UPPERCASE -> produk
  if (!skus.length) return map;
  const variants = [...new Set(skus.flatMap((s) => [s, s.toUpperCase()]))];
  const { data } = await supabase.from('products').select('id, sku, name, stock_qty, active').in('sku', variants);
  for (const p of data || []) map.set(String(p.sku).trim().toUpperCase(), p);
  // SKU dengan huruf besar/kecil beda dari yang terdaftar: cari case-insensitive satu-satu.
  for (const s of skus) {
    const key = s.toUpperCase();
    if (map.has(key)) continue;
    const pattern = s.replace(/[\\%_]/g, (c) => '\\' + c);
    const { data: cands } = await supabase.from('products').select('id, sku, name, stock_qty, active').ilike('sku', pattern).limit(5);
    const hit = (cands || []).find((r) => String(r.sku || '').trim().toUpperCase() === key);
    if (hit) map.set(key, hit);
  }
  return map;
}

// Gabungkan baris SKU yang sama, lalu cocokkan ke produk Inventory.
function buildItems(order, productMap) {
  const totals = new Map();
  for (const l of parseSkuLines(order)) {
    const key = String(l.sku).trim().toUpperCase();
    totals.set(key, { sku: String(l.sku).trim(), qty: (totals.get(key)?.qty || 0) + l.qty });
  }
  return [...totals.entries()].map(([key, t]) => {
    const prod = productMap.get(key);
    return {
      sku: t.sku,
      qty: t.qty,
      registered: !!prod,
      active: prod ? prod.active !== false : null,
      name: prod?.name || null,
      stock_qty: prod ? prod.stock_qty : null,
      stock_enough: prod ? prod.stock_qty >= t.qty : null,
    };
  });
}

// Daftar hasil pengecekan. level: ok | warn | error. 'error' = harus dibereskan dulu sebelum
// divalidasi (admin masih bisa memaksa). 'warn' = perlu perhatian tapi boleh divalidasi.
function buildChecks(order, items, late, dupes) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });

  if (order.no_resi) add('ok', 'Nomor resi tersedia');
  else add('error', 'Belum ada nomor resi');

  if (dupes.length) add('error', `Nomor resi dobel dengan pesanan lain: ${dupes.map((d) => d.no_pesanan).join(', ')}`);

  if (order.nama_penerima && order.alamat) add('ok', 'Data penerima & alamat terisi');
  else add('warn', 'Nama penerima atau alamat masih kosong');

  if (!items.length) {
    add('error', 'SKU pesanan kosong, isi SKU dulu supaya stok bisa dipotong');
  } else {
    const unregistered = items.filter((i) => !i.registered);
    const inactive = items.filter((i) => i.registered && i.active === false);
    const packed = order.status_packing === 'sudah_packing';
    const short = packed ? [] : items.filter((i) => i.registered && i.stock_enough === false);
    if (!unregistered.length && !inactive.length) add('ok', 'Semua SKU terdaftar di Inventory');
    if (unregistered.length) add('warn', `SKU belum terdaftar di Inventory: ${unregistered.map((i) => i.sku).join(', ')} (stok tidak akan terpotong)`);
    if (inactive.length) add('warn', `Produk nonaktif di Inventory: ${inactive.map((i) => i.sku).join(', ')}`);
    if (short.length) add('warn', `Stok kurang: ${short.map((i) => `${i.sku} (butuh ${i.qty}, ada ${i.stock_qty})`).join(', ')}`);
    else if (!packed && items.every((i) => i.registered)) add('ok', 'Stok mencukupi untuk semua SKU');
  }

  if (order.status_resi === 'dikirim' || order.status_resi === 'diterima') {
    add('ok', 'Sudah ditandai dikirim');
  } else if (late.level === 'critical') {
    add('error', `KRITIS: umur pesanan ${late.age_label}, jauh melewati batas ${LATE_AFTER_HOURS} jam`);
  } else if (late.level === 'late') {
    add('warn', `TELAT: umur pesanan ${late.age_label}, sudah lewat batas ${LATE_AFTER_HOURS} jam`);
  } else if (late.level === 'soon') {
    add('warn', `Hampir telat: umur pesanan ${late.age_label}, kirim sebelum ${LATE_AFTER_HOURS} jam`);
  } else {
    add('ok', 'Belum melewati batas waktu kirim');
  }

  if (order.status_packing !== 'sudah_packing' && order.status_resi === 'belum_dikirim') {
    add('warn', 'Belum di-packing');
  } else if (order.status_packing === 'sudah_packing' && order.status_resi === 'belum_dikirim') {
    add('warn', 'Sudah di-packing, tapi belum ditandai dikirim');
  }
  return checks;
}

// Lengkapi order dengan late, items, checks, nama packer/validator. Data pribadi pembeli
// (HP, alamat lengkap, nominal) disembunyikan untuk staff Inventory -- mereka cuma butuh
// info barang & status.
async function buildDetails(orders, role) {
  if (!orders.length) return [];
  const nowMs = Date.now();
  const allSkus = [...new Set(orders.flatMap((o) => parseSkuLines(o).map((l) => String(l.sku).trim())))];
  const productMap = await loadProducts(allSkus);

  const userIds = [...new Set(orders.flatMap((o) => [o.packed_by, o.validated_by]).filter(Boolean))];
  let nameById = {};
  if (userIds.length) {
    const { data: users } = await supabase.from('users').select('id, full_name').in('id', userIds);
    nameById = Object.fromEntries((users || []).map((u) => [u.id, u.full_name]));
  }

  return Promise.all(orders.map(async (o) => {
    let dupes = [];
    if (o.no_resi) {
      const { data } = await supabase.from('orders').select('id, no_pesanan').eq('no_resi', o.no_resi).neq('id', o.id).limit(5);
      dupes = data || [];
    }
    const late = computeLate(o, nowMs);
    const items = buildItems(o, productMap);
    const checks = buildChecks(o, items, late, dupes);
    const base = {
      ...o,
      late,
      items,
      checks,
      can_validate: !checks.some((c) => c.level === 'error'),
      packed_by_name: o.packed_by ? nameById[o.packed_by] || null : null,
      validated_by_name: o.validated_by ? nameById[o.validated_by] || null : null,
    };
    if (role === 'inventory') {
      delete base.no_hp; delete base.alamat; delete base.nama_pembeli; delete base.subtotal_pesanan;
      delete base.kode_pos; delete base.provinsi; delete base.negara;
    }
    return base;
  }));
}

// GET /api/cek-pesanan/lookup?q=...  -- cocok persis dulu (resi / no. pesanan), kalau gak ada
// baru cari yang mengandung teks tsb.
router.get('/lookup', async (req, res) => {
  const q = clean(req.query.q);
  if (!q) return res.json({ orders: [], exact: true });

  let { data: orders, error } = await supabase
    .from('orders').select('*').or(`no_resi.eq.${q},no_pesanan.eq.${q}`).limit(10);
  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });

  let exact = true;
  if (!orders.length && q.length >= 4) {
    exact = false;
    const r = await supabase
      .from('orders').select('*').or(`no_pesanan.ilike.%${q}%,no_resi.ilike.%${q}%`)
      .order('imported_at', { ascending: false }).limit(10);
    if (r.error) return res.status(500).json({ error: 'Gagal mencari pesanan' });
    orders = r.data || [];
  }
  res.json({ orders: await buildDetails(orders, req.user.role), exact });
});

// GET /api/cek-pesanan/late-count -- dipakai bar peringatan merah di semua halaman.
router.get('/late-count', async (req, res) => {
  try {
    res.json({ ...(await countLate()), thresholds: thresholds() });
  } catch (e) {
    res.status(500).json({ error: 'Gagal menghitung paket telat: ' + e.message });
  }
});

// GET /api/cek-pesanan/late?level=all|critical|soon&status_packing=&page=&limit=
// Daftar paket telat, yang paling lama di atas.
router.get('/late', async (req, res) => {
  const level = ['all', 'critical', 'soon'].includes(req.query.level) ? req.query.level : 'all';
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const from = (page - 1) * limit;

  const [min, max] = level === 'critical' ? [CRITICAL_AFTER_HOURS]
    : level === 'soon' ? [SOON_AFTER_HOURS, LATE_AFTER_HOURS]
      : [LATE_AFTER_HOURS];

  let query = ageWindow(
    supabase.from('orders').select(
      'id, no_pesanan, no_resi, toko, platform, opsi_pengiriman, nama_penerima, kota, sku, jumlah, ' +
      'status_packing, status_resi, packed_by, waktu_pesanan_dibuat, waktu_pesanan_at, imported_at, validated_at',
      { count: 'exact' }
    ),
    min, max
  );
  if (['belum_packing', 'sudah_packing'].includes(req.query.status_packing)) {
    query = query.eq('status_packing', req.query.status_packing);
  }
  const { data, count, error } = await query
    .order('waktu_pesanan_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + limit - 1);
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar paket telat: ' + error.message });

  const nowMs = Date.now();
  res.json({
    orders: (data || []).map((o) => ({ ...o, late: computeLate(o, nowMs) })),
    total: count || 0,
    page,
    limit,
    thresholds: thresholds(),
  });
});

// POST /api/cek-pesanan/:id/validate  { note?, force? }
// Tandai pesanan sudah dicek & valid. Kalau ada pengecekan level 'error', ditolak (409) kecuali
// admin mengirim force=true.
router.post('/:id/validate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID pesanan tidak valid' });
  const note = String(req.body?.note || '').trim().slice(0, 300);
  const force = req.body?.force === true && req.user.role === 'admin';

  const { data: order, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Gagal mengambil pesanan' });
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });

  const [before] = await buildDetails([order], req.user.role);
  if (!before.can_validate && !force) {
    return res.status(409).json({
      error: 'Ada masalah yang harus dibereskan dulu sebelum divalidasi.',
      order: before,
      can_force: req.user.role === 'admin',
    });
  }

  const { data: updated, error: updErr } = await supabase
    .from('orders')
    .update({ validated_at: new Date().toISOString(), validated_by: req.user.id, validation_note: note || null })
    .eq('id', id).select('*').single();
  if (updErr) return res.status(500).json({ error: 'Gagal menyimpan validasi: ' + updErr.message });

  const [after] = await buildDetails([updated], req.user.role);
  res.json({ ok: true, order: after });
});

// DELETE /api/cek-pesanan/:id/validate -- batalkan validasi (admin & CS).
router.delete('/:id/validate', requireRole('admin', 'cs'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID pesanan tidak valid' });
  const { data: updated, error } = await supabase
    .from('orders')
    .update({ validated_at: null, validated_by: null, validation_note: null })
    .eq('id', id).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: 'Gagal membatalkan validasi: ' + error.message });
  if (!updated) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  const [after] = await buildDetails([updated], req.user.role);
  res.json({ ok: true, order: after });
});

module.exports = router;
