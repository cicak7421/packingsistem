const express = require('express');
const XLSX = require('xlsx');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { trackResi, buildTrackingLink } = require('../courierTracking');

const router = express.Router();

// ---------- Filter tanggal (WIB) buat "Sudah Dikirim" ----------
// Tim CS/admin kerja di jam WIB (UTC+7), jadi "hari ini"/"kemarin" buat mereka harus
// ngikutin kalender WIB, bukan kalender UTC server. Pesanan yang ditandai dikirim jam
// 00:30 WIB (= 17:30 UTC hari SEBELUMNYA) tetap harus kehitung masuk hari WIB yang benar.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// dateStr formatnya YYYY-MM-DD -- ini tanggal KALENDER WIB yang diminta (bukan UTC).
// Balikin rentang waktu UTC [fromISO, toISO) yang pas buat query .gte()/.lt() ke kolom
// timestamptz (dikirim_at), biar hasilnya benar-benar 1 hari penuh WIB (00:00 - 23:59:59 WIB).
function wibDayBoundsUTC(dateStr) {
  const startUTCms = new Date(`${dateStr}T00:00:00.000Z`).getTime() - WIB_OFFSET_MS;
  return { fromISO: new Date(startUTCms).toISOString(), toISO: new Date(startUTCms + 24 * 60 * 60 * 1000).toISOString() };
}

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
  const { status_packing, status_resi, opsi_pengiriman, platform, sort, q, page = 1, limit = 50, dikirim_date } = req.query;
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
    // 'diterima' ikut dikecualikan juga di sini -- itu status yang LEBIH MAJU dari 'dikirim'
    // (paketnya malah udah beneran nyampe ke pembeli), jadi kalau dibiarkan cuma exact-match
    // 'dikirim', pesanan yang udah "diterima" malah nyangkut keliatan "Sudah Packing" doang.
    if (status_packing === 'sudah_packing' && !status_resi) {
      query = query.not('status_resi', 'in', '(dikirim,diterima)');
    }
  }
  if (status_resi === 'dikirim') {
    // "Sudah Dikirim" mencakup status_resi 'diterima' juga, dengan alasan yang sama seperti
    // komentar di atas -- 'diterima' otomatis dianggap "sudah dikirim" juga.
    query = query.in('status_resi', ['dikirim', 'diterima']);
  } else if (status_resi) {
    query = query.eq('status_resi', status_resi);
  }
  // Tabel "Sudah Dikirim" di Dashboard defaultnya nampilin data PER HARI (WIB), bukan
  // numpuk semua histori dikirim dari awal -- biar CS/admin gampang mantau pengiriman
  // hari ini tanpa keburu-buru sama pesanan lama. `dikirim_date` (YYYY-MM-DD, kalender
  // WIB) cuma dipakai kalau lagi liat status_resi=dikirim; hari lain tetap bisa dilihat
  // lewat filter tanggal di frontend (misal "Kemarin"), gak ilang cuma dibatasi per hari.
  if (status_resi === 'dikirim' && dikirim_date) {
    const { fromISO, toISO } = wibDayBoundsUTC(String(dikirim_date));
    query = query.gte('dikirim_at', fromISO).lt('dikirim_at', toISO);
  }
  // "Tidak Diketahui" itu cuma LABEL TAMPILAN yang dibikin di get_shipping_summary/
  // get_platform_summary (coalesce ... 'Tidak Diketahui') buat baris yang kolomnya
  // NULL/kosong di database -- gak ada baris yang isinya beneran teks "Tidak Diketahui".
  // Jadi kalau filternya persis teks itu, harus dicari yang NULL-atau-kosong, bukan `.eq`
  // literal (kalau `.eq` literal, hasilnya selalu nihil walau chip-nya nunjuk angka > 0).
  const isUnknownLabel = (v) => v === 'Tidak Diketahui';
  if (opsi_pengiriman) {
    query = isUnknownLabel(opsi_pengiriman)
      ? query.or('opsi_pengiriman.is.null,opsi_pengiriman.eq.""')
      : query.eq('opsi_pengiriman', opsi_pengiriman);
  }
  if (platform) {
    query = isUnknownLabel(platform)
      ? query.or('platform.is.null,platform.eq.""')
      : query.eq('platform', platform);
  }
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
  } else if (sort === 'packed_by') {
    // Kelompokkan berdasarkan siapa yang packing -- yang N/A (belum ada packed_by) ditaruh
    // paling depan biar langsung keliatan mana yang belum jelas siapa yang packing.
    query = query.order('packed_by', { ascending: true, nullsFirst: true }).order('waktu_pesanan_at', { ascending: true, nullsFirst: false });
  } else {
    query = query.order('waktu_pesanan_at', { ascending: true, nullsFirst: false });
  }
  query = query.range(from, to);

  const { data: orders, count, error } = await query;
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar pesanan' });
  res.json({ orders: attachTrackingLinks(await attachPackedByNames(orders)), total: count });
});

// Ringkasan buat dashboard (dipakai buat isi angka di stat card & label di atas tabel).
// `dikirim_date` (opsional, YYYY-MM-DD kalender WIB) bikin angka "Sudah Dikirim" ngikutin
// tanggal yang lagi dipilih di filter Dashboard (defaultnya hari ini) -- kalau parameter ini
// gak dikirim, tetap balik ke hitungan kumulatif semua waktu seperti sebelumnya (dipakai
// kalau ada caller lain yang belum di-update buat kirim tanggal).
router.get('/summary', requireAuth, async (req, res) => {
  const { dikirim_date } = req.query;
  // 'diterima' dihitung sebagai "sudah dikirim" juga -- lihat komentar serupa di endpoint
  // list order di atas kenapa 'diterima' gak boleh dianggap beda sendiri dari 'dikirim'.
  let dikirimQuery = supabase.from('orders').select('*', { count: 'exact', head: true }).in('status_resi', ['dikirim', 'diterima']);
  if (dikirim_date) {
    const { fromISO, toISO } = wibDayBoundsUTC(String(dikirim_date));
    dikirimQuery = dikirimQuery.gte('dikirim_at', fromISO).lt('dikirim_at', toISO);
  }
  const [belum, sudah, dikirim] = await Promise.all([
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status_packing', 'belum_packing'),
    // "Sudah Packing" = udah di-packing TAPI belum dikirim. Yang udah dikirim gak dihitung
    // di sini lagi (udah masuk hitungan "Sudah Dikirim" di bawah), biar gak keliatan dobel.
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status_packing', 'sudah_packing').not('status_resi', 'in', '(dikirim,diterima)'),
    dikirimQuery,
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
    'Pesanan Affiliate': o.is_affiliate ? 'Ya' : 'Tidak',
    'Nama Affiliate': o.affiliate_name || '',
    'Ongkir Affiliate': o.affiliate_ongkir ?? '',
    'Motif Produk Affiliate': o.affiliate_motif || '',
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
    // Begitu ketauan statusnya 'dikirim' ATAU LANGSUNG 'diterima' (kejadian kalau baru
    // pertama kali dicek pas paketnya udah lama jalan/nyampe) dari kondisi awal
    // 'belum_dikirim', pasti udah dipickup kurir -- catat dikirim_at & pastikan
    // status_packing ikut kebawa maju, biar gak nyangkut keliatan "Sudah Packing" doang
    // padahal barangnya udah beneran dikirim/nyampe. Dicek cuma sekali (order.status_resi
    // === 'belum_dikirim') biar dikirim_at gak ketimpa jadi "sekarang" tiap kali di-refresh
    // ulang setelah pertama kali kedeteksi dikirim.
    if (
      (tracked.internalStatus === 'dikirim' || tracked.internalStatus === 'diterima') &&
      order.status_resi === 'belum_dikirim'
    ) {
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
  if (status_resi === 'dikirim' || status_resi === 'diterima') {
    payload.status_packing = 'sudah_packing'; // sudah dikirim/diterima = pasti sudah kelar packing, meski belum pernah discan
    // dikirim_at cuma disetel kalau BELUM ada -- kalau pesanan ini sebelumnya udah ditandai
    // 'dikirim' terus sekarang dimajuin ke 'diterima', dikirim_at tetap nunjuk waktu PERTAMA
    // kali ketauan dikirim, bukan ketimpa jadi waktu sekarang tiap kali statusnya dimajuin.
    const { data: existingOrder, error: fetchError } = await supabase
      .from('orders').select('dikirim_at').eq('id', req.params.id).maybeSingle();
    if (fetchError) return res.status(500).json({ error: 'Gagal mengecek pesanan: ' + fetchError.message });
    if (!existingOrder?.dikirim_at) payload.dikirim_at = new Date().toISOString();
  }
  const { error } = await supabase.from('orders').update(payload).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal update status resi' });
  res.json({ ok: true });
});

// Set/ubah manual siapa yang packing pesanan ini (dipakai di Tracking). Ini buat nutupin
// kasus "Di-packing Oleh: N/A" -- pesanan yang ditandai sudah packing secara OTOMATIS (lewat
// import "Kirim Pesanan" atau cek resi kurir), bukan lewat scan asli di menu Scan Packing,
// jadi kolom packed_by-nya kosong. Bisa juga dipakai admin/CS buat koreksi kalau salah orang.
router.patch('/:id/packed-by', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const raw = req.body?.packed_by;
  const packerId = raw === '' || raw === null || raw === undefined ? null : Number(raw);
  if (packerId !== null && !Number.isInteger(packerId)) {
    return res.status(400).json({ error: 'packed_by tidak valid' });
  }
  if (packerId !== null) {
    const { data: packer, error: packerErr } = await supabase.from('users').select('id').eq('id', packerId).maybeSingle();
    if (packerErr) return res.status(500).json({ error: 'Gagal memvalidasi packer' });
    if (!packer) return res.status(400).json({ error: 'User packer tidak ditemukan' });
  }

  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, packed_at, status_packing')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });

  const payload = { packed_by: packerId };
  if (packerId !== null) {
    // Kalau belum pernah ada waktu packing (misal pesanan ini ditandai lewat import "Kirim
    // Pesanan"), catat sekarang sebagai waktu packing-nya. Kalau SUDAH ada packed_at
    // (misal dari scan asli sebelumnya), jangan ditimpa -- cuma nama packernya yang dikoreksi.
    if (!order.packed_at) payload.packed_at = new Date().toISOString();
    if (order.status_packing !== 'sudah_packing') payload.status_packing = 'sudah_packing';
  }

  const { data: updated, error: updErr } = await supabase
    .from('orders')
    .update(payload)
    .eq('id', order.id)
    .select('*')
    .maybeSingle();
  if (updErr) return res.status(500).json({ error: 'Gagal update packing oleh: ' + updErr.message });

  const [withNames] = attachTrackingLinks(await attachPackedByNames([updated]));
  res.json({ ok: true, order: withNames });
});

// Hapus pesanan secara manual. KHUSUS ADMIN -- dipakai buat bersihin baris hasil salah
// import (misal file yang diimport kosong/rusak sebagian kolomnya) tanpa perlu buka
// Supabase langsung. Ini hard delete (bukan soft delete/arsip), jadi sengaja dibatasi
// admin doang dan frontend-nya wajib nampilin konfirmasi yang jelas sebelum manggil ini.
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, no_pesanan, status_packing')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: 'Gagal mencari pesanan' });
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan (mungkin sudah dihapus sebelumnya)' });

  // Bersihin scan_log yang nunjuk ke order ini juga, biar gak ada baris log "nyantol" ke
  // order_id yang udah gak ada (bisa bikin rekap Performa Packing salah hitung/nyangkut).
  const { error: scanLogErr } = await supabase.from('scan_log').delete().eq('order_id', order.id);
  if (scanLogErr) return res.status(500).json({ error: 'Gagal menghapus riwayat scan terkait pesanan ini' });

  const { error: delErr } = await supabase.from('orders').delete().eq('id', order.id);
  if (delErr) return res.status(500).json({ error: 'Gagal menghapus pesanan' });

  res.json({ ok: true, no_pesanan: order.no_pesanan });
});

module.exports = router;
