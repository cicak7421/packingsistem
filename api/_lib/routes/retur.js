const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { cleanResi } = require('../skuHelpers');
const { AF_DEFAULT_POTONGAN_PERSEN } = require('../skuPrices');
const { RETUR_MISSING_MSG, VALIDASI_MISSING_MSG, RETUR_ALASAN, isReturColErr, isValidasiColErr, normKondisi, adjustStockForRetur } = require('../returHelpers');
const estimasi = require('./estimasi');

const router = express.Router();

// ---------- Alur Retur ----------
// 1. Paket balik ke gudang -> tim packing buka Scan Packing, pindah ke mode "Retur", pilih kondisi
//    cek (Sesuai / Tidak sesuai), lalu scan resinya. Alasan retur diisi admin/CS di tab Retur.
// 2. Pesanan ditandai retur (orders.retur_at) dengan hasil cek packer: SESUAI / TIDAK SESUAI.
//    Stok BELUM berubah di tahap ini -- statusnya "menunggu validasi".
// 2b. Admin/CS memvalidasi di tab Retur (boleh mengoreksi sesuai / tidak sesuai). Baru setelah
//    divalidasi SESUAI stoknya masuk ke Inventory; TIDAK SESUAI -> stok tidak masuk.
// 3. Estimasi Penghasilan: pesanan retur dihitung Rp0, nilainya dicatat terpisah (layar & Excel).
// 4. Salah scan? Batalkan dari tab Retur -> status & stok kembali seperti semula.

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const wibDate = (ts) => new Date(new Date(ts).getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
const wibStartUTC = (dateStr) => new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - WIB_OFFSET_MS).toISOString();
const addDays = (dateStr, n) => { const d = new Date(`${dateStr}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

async function findOrder(rawValue) {
  // Buang spasi/enter nyasar + karakter yang punya arti khusus di filter PostgREST.
  const value = cleanResi(rawValue).replace(/[,()"\\]/g, '');
  if (!value) return { value };
  const { data, error } = await supabase.from('orders').select('*').or(`no_resi.eq.${value},no_pesanan.eq.${value}`).limit(1).maybeSingle();
  return { value, order: data, error };
}

async function userName(id) {
  if (!id) return null;
  const { data } = await supabase.from('users').select('full_name').eq('id', id).maybeSingle();
  return data ? data.full_name : null;
}

// Alasan & catatan retur KHUSUS admin/CS: akun packing tidak bisa mengisi maupun melihatnya.
const canSeeAlasan = (user) => ['admin', 'cs'].includes(user.role);
const hideAlasan = (order) => { const o = { ...order }; delete o.retur_alasan; delete o.retur_catatan; return o; };

// Tandai satu paket sebagai retur. Body: { value, kondisi: 'sesuai'|'tidak_sesuai' } + khusus admin/CS: alasan, catatan.
// Siapa pun yang mencatat, stok TIDAK langsung berubah: harus divalidasi dulu (POST /:id/validate).
router.post('/scan', requireAuth, requireRole('packing', 'admin', 'cs'), async (req, res) => {
  const body = req.body || {};
  const staff = canSeeAlasan(req.user);
  const view = (o) => (staff || !o ? o : hideAlasan(o));
  const kondisi = normKondisi(body.kondisi);
  const { value, order, error } = await findOrder(body.value);
  if (!value) return res.status(400).json({ error: 'Nilai scan kosong' });
  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  if (!order) {
    return res.status(404).json({
      status: 'tidak_ditemukan',
      message: 'Nomor resi/pesanan ini tidak ada di sistem. Pesanan lama (lebih dari 60 hari) sudah otomatis terhapus — catat manual kalau itu kasusnya.',
    });
  }
  if (order.retur_at) {
    const by = (await userName(order.retur_by)) || 'akun lain';
    return res.status(409).json({ status: 'sudah_retur', message: `Paket ini SUDAH dicatat retur sebelumnya oleh ${by}.`, order: view(order) });
  }
  if (order.status_packing !== 'sudah_packing' && !['dikirim', 'diterima'].includes(order.status_resi)) {
    return res.status(409).json({
      status: 'belum_packing',
      message: 'Pesanan ini belum pernah di-packing / dikirim, jadi bukan paket retur. Cek lagi paketnya.',
      order: view(order),
    });
  }

  const payload = {
    retur_at: new Date().toISOString(),
    retur_by: req.user.id,
    retur_kondisi: kondisi,
    retur_alasan: staff ? text(body.alasan, 80) || null : null,
    retur_catatan: staff ? text(body.catatan, 300) || null : null,
  };
  const { data: updated, error: updErr } = await supabase.from('orders').update(payload).eq('id', order.id).is('retur_at', null).select('*').maybeSingle();
  if (updErr) return res.status(500).json({ error: isReturColErr(updErr) ? RETUR_MISSING_MSG : 'Gagal mencatat retur: ' + updErr.message });
  if (!updated) return res.status(409).json({ status: 'sudah_retur', message: 'Paket ini baru saja dicatat retur oleh akun lain.', order: view(order) });

  const message = `Retur dicatat: ${kondisi === 'sesuai' ? 'SESUAI' : 'TIDAK SESUAI'}. Menunggu validasi admin/CS — stok belum berubah.`;
  res.json({ status: 'ok', message, order: { ...view(updated), retur_by_name: req.user.full_name } });
});

// Riwayat retur hari ini (kalender WIB) untuk akun yang login -- dipakai halaman Scan Packing.
router.get('/my-today', requireAuth, requireRole('packing', 'admin', 'cs'), async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, no_pesanan, no_resi, sku, retur_at, retur_kondisi')
    .eq('retur_by', req.user.id)
    .gte('retur_at', wibStartUTC(wibDate(Date.now())))
    .order('retur_at', { ascending: false })
    .limit(200);
  if (error) return res.json({ returs: [], ready: !isReturColErr(error) });
  res.json({ returs: data || [], ready: true });
});

// Daftar retur + ringkasan. Query: from, to (YYYY-MM-DD, tanggal retur WIB; bawaan 30 hari terakhir),
// q (cari No. Resi / No. Pesanan), page, limit.
router.get('/', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const today = wibDate(Date.now());
  const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : addDays(today, -29);
  const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : today;
  if (from > to) return res.status(400).json({ error: 'Tanggal awal tidak boleh setelah tanggal akhir' });
  const q = cleanResi(req.query.q).replace(/[,()"\\%*]/g, '').slice(0, 60);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const build = () => {
    let query = supabase.from('orders').select('*').not('retur_at', 'is', null)
      .gte('retur_at', wibStartUTC(from)).lt('retur_at', wibStartUTC(addDays(to, 1)));
    if (q) query = query.or(`no_resi.ilike.%${q}%,no_pesanan.ilike.%${q}%`);
    return query.order('retur_at', { ascending: false }).order('id', { ascending: false });
  };

  const all = [];
  for (let off = 0; off < 20000; off += 1000) {
    const { data, error } = await build().range(off, off + 999);
    if (error) {
      if (isReturColErr(error)) return res.json({ ready: false, message: RETUR_MISSING_MSG, returs: [], total: 0, page: 1, total_pages: 1, summary: { total: 0, nilai: 0, menunggu: 0, sesuai: 0, tidak_sesuai: 0 }, range: { from, to }, alasan: RETUR_ALASAN });
      return res.status(500).json({ error: 'Gagal mengambil data retur: ' + error.message });
    }
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const cfg = await estimasi.loadConfig();
  const potongan = cfg.potongan !== null ? cfg.potongan : AF_DEFAULT_POTONGAN_PERSEN;
  // menunggu = belum divalidasi; sesuai / tidak_sesuai = hasil akhir yang SUDAH divalidasi.
  const summary = { total: all.length, nilai: 0, menunggu: 0, sesuai: 0, tidak_sesuai: 0 };
  const rows = all.map((o) => {
    const nilai = o.is_affiliate ? 0 : estimasi.estimateOrder(o, potongan).estimasi;
    summary.nilai += nilai;
    summary[o.retur_validated_at ? normKondisi(o.retur_kondisi) : 'menunggu'] += 1;
    return { o, nilai };
  });

  const slice = rows.slice((page - 1) * limit, page * limit);
  const userIds = [...new Set(slice.flatMap((r) => [r.o.retur_by, r.o.retur_validated_by]).filter(Boolean))];
  let names = {};
  if (userIds.length) {
    const { data: users } = await supabase.from('users').select('id, full_name').in('id', userIds);
    names = Object.fromEntries((users || []).map((u) => [u.id, u.full_name]));
  }

  res.json({
    ready: true,
    range: { from, to },
    alasan: RETUR_ALASAN,
    summary,
    total: rows.length,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(rows.length / limit)),
    returs: slice.map(({ o, nilai }) => ({
      id: o.id,
      no_pesanan: o.no_pesanan,
      no_resi: o.no_resi,
      toko: o.toko,
      platform: o.platform,
      opsi_pengiriman: o.opsi_pengiriman,
      sku: o.sku || '',
      jumlah: o.jumlah,
      retur_at: o.retur_at,
      retur_kondisi: normKondisi(o.retur_kondisi),
      validated: !!o.retur_validated_at,
      retur_validated_at: o.retur_validated_at || null,
      retur_validated_by_name: names[o.retur_validated_by] || null,
      retur_alasan: o.retur_alasan || '',
      retur_catatan: o.retur_catatan || '',
      retur_by_name: names[o.retur_by] || null,
      nilai,
    })),
  });
});

// Isi / ubah alasan & catatan retur (admin/CS) -- dipakai buat retur yang discan tim packing,
// karena packer tidak mengisi alasan. Body: { alasan, catatan } (yang tidak dikirim tidak diubah).
router.patch('/:id', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID pesanan tidak valid' });
  const body = req.body || {};
  const payload = {};
  if ('alasan' in body) payload.retur_alasan = text(body.alasan, 80) || null;
  if ('catatan' in body) payload.retur_catatan = text(body.catatan, 300) || null;
  if (!Object.keys(payload).length) return res.status(400).json({ error: 'Tidak ada yang diubah' });
  const { data, error } = await supabase.from('orders').update(payload).eq('id', id).not('retur_at', 'is', null).select('id, retur_alasan, retur_catatan');
  if (error) return res.status(500).json({ error: isReturColErr(error) ? RETUR_MISSING_MSG : 'Gagal menyimpan alasan: ' + error.message });
  if (!data || !data.length) return res.status(404).json({ error: 'Pesanan retur tidak ditemukan' });
  res.json({ ok: true, ...data[0] });
});

// Validasi retur oleh admin/CS. Body: { kondisi: 'sesuai'|'tidak_sesuai' } = hasil akhir (boleh beda
// dari cek packer). SESUAI -> stok masuk ke Inventory; TIDAK SESUAI -> stok tidak masuk (kalau
// sebelumnya sempat divalidasi sesuai, stoknya ditarik lagi). Aman diulang / dikoreksi kapan saja.
router.post('/:id/validate', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID pesanan tidak valid' });
  const { data: order, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  if (!order || !order.retur_at) return res.status(404).json({ error: 'Pesanan retur tidak ditemukan' });

  const kondisi = normKondisi((req.body || {}).kondisi ?? order.retur_kondisi);
  const { error: updErr } = await supabase.from('orders')
    .update({ retur_kondisi: kondisi, retur_validated_at: new Date().toISOString(), retur_validated_by: req.user.id })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: isValidasiColErr(updErr) ? VALIDASI_MISSING_MSG : 'Gagal memvalidasi retur: ' + updErr.message });

  const restock = await adjustStockForRetur(order, req.user.id, kondisi === 'sesuai' ? 1 : -1);
  let message;
  if (restock.error) message = 'Retur divalidasi, tapi stok gagal diubah: ' + restock.error;
  else if (kondisi === 'tidak_sesuai') message = restock.restocked.length ? 'Divalidasi TIDAK SESUAI. Stok yang sempat masuk ditarik lagi.' : 'Divalidasi TIDAK SESUAI. Stok tidak masuk.';
  else if (restock.restocked.length) message = `Divalidasi SESUAI. Stok masuk: ${restock.restocked.map((r) => `${r.sku} +${r.qty}`).join(', ')}.`;
  else if (restock.skus_not_registered.length) message = `Divalidasi SESUAI. Stok tidak berubah: SKU belum terdaftar di Inventory (${restock.skus_not_registered.join(', ')}).`;
  else message = 'Divalidasi SESUAI. Stok sudah masuk sebelumnya.';
  res.json({ ok: true, no_pesanan: order.no_pesanan, kondisi, message, restock });
});

// Batalkan retur (salah scan). Stok yang sempat dikembalikan ikut ditarik lagi.
router.delete('/:id', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID pesanan tidak valid' });
  const { data: order, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (!order.retur_at) return res.status(409).json({ error: 'Pesanan ini tidak berstatus retur' });

  const clear = { retur_at: null, retur_by: null, retur_kondisi: null, retur_alasan: null, retur_catatan: null };
  let { error: updErr } = await supabase.from('orders').update({ ...clear, retur_validated_at: null, retur_validated_by: null }).eq('id', id);
  if (updErr && isValidasiColErr(updErr)) ({ error: updErr } = await supabase.from('orders').update(clear).eq('id', id)); // kolom validasi belum ada
  if (updErr) return res.status(500).json({ error: 'Gagal membatalkan retur: ' + updErr.message });

  const restock = await adjustStockForRetur(order, req.user.id, -1);
  res.json({ ok: true, no_pesanan: order.no_pesanan, restock });
});

module.exports = router;
