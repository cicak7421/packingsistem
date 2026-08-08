const express = require('express');
const XLSX = require('xlsx');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { trackResi, buildTrackingLink } = require('../courierTracking');

const router = express.Router();

// Helper: tempel field "packed_by_name" DAN "imported_by_name" ke tiap order (dulu pakai
// SQL JOIN, sekarang query users terpisah lalu digabung di JS biar gak tergantung nama
// foreign key constraint di Supabase). imported_by_name dipakai buat log "siapa yang
// import & jam berapa" di kolom khusus admin pada tabel Belum Packing.
async function attachPackedByNames(orders) {
  const packedIds = orders.filter((o) => o.packed_by).map((o) => o.packed_by);
  const importedIds = orders.filter((o) => o.imported_by).map((o) => o.imported_by);
  const ids = [...new Set([...packedIds, ...importedIds])];
  if (ids.length === 0) return orders.map((o) => ({ ...o, packed_by_name: null, imported_by_name: null }));
  const { data: users } = await supabase.from('users').select('id, full_name').in('id', ids);
  const nameById = Object.fromEntries((users || []).map((u) => [u.id, u.full_name]));
  return orders.map((o) => ({
    ...o,
    packed_by_name: o.packed_by ? nameById[o.packed_by] || null : null,
    imported_by_name: o.imported_by ? nameById[o.imported_by] || null : null,
  }));
}

// Helper: tempel link tracking langsung ke web kurir (dipakai frontend buat tombol
// "Lacak di [Kurir]" begitu status_resi udah "dikirim"/"diterima" -- biar CS/pembeli gak
// perlu nunggu sistem ini cek API BinderByte lagi buat sisa perjalanan paket).
function attachTrackingLinks(orders) {
  return orders.map((o) => ({ ...o, trackingLink: buildTrackingLink(o.opsi_pengiriman, o.no_resi) }));
}

// Cari order by No. Pesanan / No. Resi (CS & admin & packing bisa lihat)
router.get('/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/,/g, '');
  if (!q) return res.json({ orders: [] });

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .or(`no_pesanan.ilike.%${q}%,no_resi.ilike.%${q}%`)
    .order('imported_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  res.json({ orders: attachTrackingLinks(await attachPackedByNames(orders)) });
});

// List semua order dengan filter status (buat dashboard).
// Bisa juga difilter per jasa kirim (opsi_pengiriman), dicari No. Pesanan / No. Resi (q),
// dan diurutkan (sort):
// - default: pesanan terlama duluan (waktu_pesanan_at asc) buat "belum packing" -- dulu
//   pakai batas_kirim, tapi kolom itu udah gak ada lagi di format XLSX yang sekarang dipakai.
// - packed_at_desc: waktu packing terbaru duluan, cocok buat lihat "sudah packing"
// - opsi_pengiriman: urut nama jasa kirim A-Z (lanjut pesanan terlama sebagai tie-breaker)
// - platform: urut nama platform A-Z (lanjut pesanan terlama sebagai tie-breaker)
router.get('/', requireAuth, async (req, res) => {
  const { status_packing, status_resi, opsi_pengiriman, platform, sort, q, page = 1, limit = 50 } = req.query;
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Number(limit) || 50);
  const from = (p - 1) * l;
  const to = from + l - 1;

  let query = supabase.from('orders').select('*', { count: 'exact' });
  if (status_packing) {
    query = query.eq('status_packing', status_packing);
    // "Sudah Packing" itu maksudnya UDAH di-packing TAPI BELUM dikirim -- begitu ditandai
    // dikirim, order-nya pindah ke bucket "Sudah Dikirim", bukan nangkring dobel di dua
    // tempat (status_packing tetep 'sudah_packing' di database, cuma gak ditampilin lagi
    // di sini). Kalau caller eksplisit minta status_resi tertentu, hormati itu aja.
    if (status_packing === 'sudah_packing' && !status_resi) {
      query = query.neq('status_resi', 'dikirim');
    }
  }
  if (status_resi) query = query.eq('status_resi', status_resi);
  if (opsi_pengiriman) query = query.eq('opsi_pengiriman', opsi_pengiriman);
  if (platform) query = query.eq('platform', platform);
  const qTrim = String(q || '').trim().replace(/,/g, '');
  if (qTrim) query = query.or(`no_pesanan.ilike.%${qTrim}%,no_resi.ilike.%${qTrim}%`);

  if (sort === 'opsi_pengiriman') {
    query = query.order('opsi_pengiriman', { ascending: true, nullsFirst: false }).order('waktu_pesanan_at', { ascending: true, nullsFirst: false });
  } else if (sort === 'platform') {
    query = query.order('platform', { ascending: true, nullsFirst: false }).order('waktu_pesanan_at', { ascending: true, nullsFirst: false });
  } else if (sort === 'packed_at_desc') {
    query = query.order('packed_at', { ascending: false, nullsFirst: false });
  } else if (sort === 'dikirim_desc') {
    query = query.order('dikirim_at', { ascending: false, nullsFirst: false });
  } else {
    query = query.order('waktu_pesanan_at', { ascending: true, nullsFirst: false });
  }
  query = query.range(from, to);

  const { data: orders, count, error } = await query;
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar pesanan' });
  res.json({ orders: attachTrackingLinks(await attachPackedByNames(orders)), total: count });
});

// Ringkasan buat dashboard (dipakai buat isi angka di stat card & label di atas tabel).
router.get('/summary', requireAuth, async (req, res) => {
  const [belum, sudah, dikirim] = await Promise.all([
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status_packing', 'belum_packing'),
    // "Sudah Packing" = udah di-packing TAPI belum dikirim. Yang udah dikirim gak dihitung
    // di sini lagi (udah masuk hitungan "Sudah Dikirim" di bawah), biar gak keliatan dobel.
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status_packing', 'sudah_packing').neq('status_resi', 'dikirim'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status_resi', 'dikirim'),
  ]);
  if (belum.error || sudah.error || dikirim.error) return res.status(500).json({ error: 'Gagal mengambil ringkasan' });
  res.json({ belum_packing: belum.count, sudah_packing: sudah.count, dikirim: dikirim.count });
});

// Ringkasan jumlah pesanan per jasa kirim (Opsi Pengiriman), dipecah belum/sudah packing.
// Dipakai buat isi dropdown filter jasa kirim & chip breakdown di Dashboard.
//
// Dulu narik SEMUA baris orders ke Vercel (dipaginasi 1000/request) lalu dihitung di JS —
// lemot banget begitu jumlah pesanan udah ribuan, dan endpoint ini dipanggil di HAMPIR SETIAP
// interaksi Dashboard. Sekarang perhitungannya didelegasikan ke Postgres lewat RPC
// get_shipping_summary() (lihat migration-performance.sql) — cuma hasil ringkasannya aja
// yang dikirim balik, jauh lebih ringan & cepat.
router.get('/shipping-summary', requireAuth, async (req, res) => {
  const { data, error } = await supabase.rpc('get_shipping_summary');
  if (error) return res.status(500).json({ error: 'Gagal mengambil ringkasan jasa kirim: ' + error.message });

  const couriers = (data || []).map((row) => ({
    courier: row.courier,
    total: Number(row.total),
    belum_packing: Number(row.belum_packing),
    sudah_packing: Number(row.sudah_packing),
    dikirim: Number(row.dikirim),
  }));
  res.json({ couriers });
});

// Ringkasan per Platform (shopee, tiktok, dst) -- dipakai isi dropdown filter Platform di Dashboard.
router.get('/platform-summary', requireAuth, async (req, res) => {
  const { data, error } = await supabase.rpc('get_platform_summary');
  if (error) return res.status(500).json({ error: 'Gagal mengambil ringkasan platform: ' + error.message });

  const platforms = (data || []).map((row) => ({
    platform: row.platform,
    total: Number(row.total),
    belum_packing: Number(row.belum_packing),
    sudah_packing: Number(row.sudah_packing),
    dikirim: Number(row.dikirim),
  }));
  res.json({ platforms });
});

// Export pesanan ke Excel, difilter berdasarkan rentang tanggal import (maksimal 1 bulan / 31 hari).
// Dipakai kolom "imported_at" (timestamp asli, bukan teks bebas dari file marketplace) biar filternya akurat.
const EXPORT_MAX_RANGE_DAYS = 31;

router.get('/export', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Tanggal awal dan tanggal akhir wajib diisi' });
  }

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'Format tanggal tidak valid' });
  }
  if (toDate < fromDate) {
    return res.status(400).json({ error: 'Tanggal akhir harus setelah atau sama dengan tanggal awal' });
  }
  const rangeDays = Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24));
  if (rangeDays > EXPORT_MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `Rentang tanggal maksimal ${EXPORT_MAX_RANGE_DAYS} hari (1 bulan)` });
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .gte('imported_at', fromDate.toISOString())
    .lte('imported_at', toDate.toISOString())
    .order('imported_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Gagal mengambil data pesanan untuk export' });

  const withNames = await attachPackedByNames(orders || []);

  const rows = withNames.map((o) => ({
    'No. Pesanan': o.no_pesanan,
    'Toko': o.toko || '',
    'Platform': o.platform || '',
    'Nama Logistik': o.opsi_pengiriman || '',
    'No. Resi': o.no_resi || '',
    'Nama': o.nama_pembeli || '',
    'SKU': o.sku || '',
    'Jumlah': o.jumlah || '',
    'Total Jumlah Pesanan': o.subtotal_pesanan || '',
    'No. CP 1': o.no_hp || '',
    'Negara/Wilayah': o.negara || '',
    'Provinsi': o.provinsi || '',
    'Kota': o.kota || '',
    'Kode Pos': o.kode_pos || '',
    'Alamat Lengkap 1': o.alamat || '',
    'Nama Panggilan Pembeli': o.nama_penerima || '',
    'Waktu Pemesanan': o.waktu_pesanan_dibuat || '',
    'Status Packing': o.status_packing === 'sudah_packing' ? 'Sudah Packing' : 'Belum Packing',
    'Di-packing Oleh': o.packed_by_name || '',
    'Waktu Packing': o.packed_at || '',
    'Status Resi': o.status_resi || '',
    'Tanggal Import ke Sistem': o.imported_at || '',
  }));

  const sheetData = rows.length ? rows : [{ 'Tidak ada data': 'Tidak ada pesanan pada rentang tanggal ini' }];
  const worksheet = XLSX.utils.json_to_sheet(sheetData);
  worksheet['!cols'] = [
    { wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 10 },
    { wch: 24 }, { wch: 10 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 16 },
    { wch: 20 }, { wch: 10 }, { wch: 40 }, { wch: 22 }, { wch: 20 },
    { wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 14 }, { wch: 20 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Pesanan');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `flowmua-pesanan-${from}_sd_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

// Cek status resi real-time ke ekspedisi terkait (on-demand, dipanggil pas CS klik tombol).
router.post('/:id/refresh-status', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('id, no_resi, opsi_pengiriman, status_resi')
    .eq('id', req.params.id)
    .maybeSingle();

  if (fetchError) return res.status(500).json({ error: 'Gagal mengambil data pesanan' });
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (!order.no_resi) return res.status(400).json({ error: 'Pesanan ini belum punya nomor resi' });

  let tracked;
  try {
    tracked = await trackResi({ noResi: order.no_resi, opsiPengiriman: order.opsi_pengiriman });
  } catch (e) {
    return res.status(502).json({ error: e.userMessage || 'Gagal cek status resi' });
  }

  const now = new Date().toISOString();
  const updatePayload = {
    resi_courier_status: tracked.statusText,
    resi_last_checked_at: now,
    resi_history: tracked.history,
  };
  // Cuma timpa status_resi kalau hasil dari kurir bisa dipetakan, dan gak pernah "mundur"
  // dari diterima ke status lain (jaga-jaga kalau API kurirnya kasih data aneh).
  if (tracked.internalStatus && order.status_resi !== 'diterima') {
    updatePayload.status_resi = tracked.internalStatus;
    if (tracked.internalStatus === 'dikirim' && order.status_resi !== 'dikirim') {
      updatePayload.dikirim_at = now;
      updatePayload.status_packing = 'sudah_packing'; // sudah dikirim = pasti sudah kelar packing, meski belum pernah discan
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle();

  if (updateError) {
    console.error('Gagal update hasil cek status resi:', updateError);
    return res.status(500).json({ error: 'Gagal menyimpan hasil cek status: ' + updateError.message });
  }

  const [withNames] = attachTrackingLinks(await attachPackedByNames([updated]));
  res.json({ ok: true, order: withNames, courier_code: tracked.courierCode });
});

// Admin/CS bisa update status resi manual (misal: "dikirim", "diterima")
router.patch('/:id/status-resi', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { status_resi } = req.body;
  if (!['belum_dikirim', 'dikirim', 'diterima'].includes(status_resi)) {
    return res.status(400).json({ error: 'Status resi tidak valid' });
  }
  const payload = { status_resi };
  if (status_resi === 'dikirim') {
    payload.dikirim_at = new Date().toISOString();
    payload.status_packing = 'sudah_packing'; // sudah dikirim = pasti sudah kelar packing, meski belum pernah discan
  }
  const { error } = await supabase.from('orders').update(payload).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal update status resi' });
  res.json({ ok: true });
});

module.exports = router;
