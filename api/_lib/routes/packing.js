const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { isInstantCourier } = require('../courierTracking');

const router = express.Router();

// Tim packing scan barcode No. Resi (atau No. Pesanan) di label paket
router.post('/scan', requireAuth, requireRole('packing', 'admin'), async (req, res) => {
  const scannedValue = String(req.body.value || '').trim().replace(/,/g, '');
  if (!scannedValue) return res.status(400).json({ error: 'Nilai scan kosong' });

  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .or(`no_resi.eq.${scannedValue},no_pesanan.eq.${scannedValue}`)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Gagal mencari pesanan' });

  if (!order) {
    // Paket gagal ditemukan (salah scan / belum diimport) -> TIDAK dicatat ke riwayat,
    // biar riwayat cuma isinya scan yang beneran valid.
    return res.status(404).json({
      status: 'tidak_ditemukan',
      message: 'Nomor resi/pesanan ini tidak ada di sistem. Cek lagi apakah sudah diimport, atau kemungkinan salah paket.',
    });
  }

  if (order.status_packing === 'sudah_packing') {
    await supabase
      .from('scan_log')
      .insert({ order_id: order.id, user_id: req.user.id, scanned_value: scannedValue, result: 'sudah_pernah_packing' });

    let packedByName = 'akun lain';
    if (order.packed_by) {
      const { data: packer } = await supabase.from('users').select('full_name').eq('id', order.packed_by).maybeSingle();
      if (packer) packedByName = packer.full_name;
    }
    return res.status(409).json({
      status: 'sudah_pernah_packing',
      message: `Paket ini SUDAH di-packing sebelumnya oleh ${packedByName}. Cek ulang, kemungkinan salah ambil paket.`,
      order: { ...order, packed_by_name: packedByName },
    });
  }

  const now = new Date().toISOString();
  const updatePayload = { status_packing: 'sudah_packing', packed_by: req.user.id, packed_at: now };

  // Kurir instant (GrabExpress/GoSend/Gojek/SPX Instant & Sameday) gak lewat hub BinderByte,
  // jadi statusnya gak akan pernah ke-update otomatis lewat cek resi. Buat kurir-kurir ini,
  // begitu di-packing langsung dianggap sudah dikirim juga (driver jemput langsung di tempat) --
  // gak perlu nunggu konfirmasi resi. Cuma diterapin kalau status_resi belum "diterima" (jaga-jaga
  // biar gak mundurin status kalau entah gimana udah "diterima" duluan).
  const bypassKeSudahDikirim = isInstantCourier(order.opsi_pengiriman) && order.status_resi !== 'diterima';
  if (bypassKeSudahDikirim) {
    updatePayload.status_resi = 'dikirim';
    updatePayload.dikirim_at = now;
  }

  const { data: updated, error: updErr } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', order.id)
    .select('*')
    .single();

  if (updErr) return res.status(500).json({ error: 'Gagal update status packing' });

  await supabase.from('scan_log').insert({ order_id: order.id, user_id: req.user.id, scanned_value: scannedValue, result: 'ok' });

  const message = bypassKeSudahDikirim
    ? `Paket berhasil ditandai sudah packing & OTOMATIS sudah dikirim (kurir instant: ${order.opsi_pengiriman}).`
    : 'Paket berhasil ditandai sudah packing.';

  res.json({ status: 'ok', message, order: { ...updated, packed_by_name: req.user.full_name } });
});

// Riwayat scan hari ini untuk akun yang login (biar packing bisa lihat progressnya sendiri)
router.get('/my-scans-today', requireAuth, requireRole('packing', 'admin'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  const { data: scans, error } = await supabase
    .from('scan_log')
    .select('*')
    .eq('user_id', req.user.id)
    .gte('created_at', `${today}T00:00:00.000Z`)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Gagal mengambil riwayat scan' });

  const orderIds = [...new Set(scans.filter((s) => s.order_id).map((s) => s.order_id))];
  let orderById = {};
  if (orderIds.length > 0) {
    const { data: orders } = await supabase.from('orders').select('id, no_pesanan, no_resi, sku').in('id', orderIds);
    orderById = Object.fromEntries((orders || []).map((o) => [o.id, o]));
  }

  const enriched = scans.map((s) => ({
    ...s,
    no_pesanan: orderById[s.order_id]?.no_pesanan,
    no_resi: orderById[s.order_id]?.no_resi,
    sku: orderById[s.order_id]?.sku,
  }));

  res.json({ scans: enriched });
});

// ---------- Performa Packing ----------
// Semua tanggal di sini dipakai sebagai kalender UTC (format YYYY-MM-DD), konsisten
// sama cara "my-scans-today" di atas ngitung "hari ini".

function dateBoundsUTC(fromDateStr, toDateStrInclusive) {
  const fromISO = `${fromDateStr}T00:00:00.000Z`;
  const toDate = new Date(`${toDateStrInclusive}T00:00:00.000Z`);
  toDate.setUTCDate(toDate.getUTCDate() + 1); // batas atas eksklusif = awal hari berikutnya
  return { fromISO, toISO: toDate.toISOString() };
}

function resolvePresetRange(preset, from, to) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysAgoStr = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  if (preset === 'yesterday') {
    const y = daysAgoStr(1);
    return { from: y, to: y, label: 'Kemarin' };
  }
  if (preset === 'month') {
    return { from: daysAgoStr(29), to: todayStr, label: '1 Bulan Terakhir' };
  }
  if (preset === 'custom') {
    if (!from || !to) throw new Error('Tanggal dari dan sampai wajib diisi untuk rentang custom');
    return { from, to, label: `${from} s/d ${to}` };
  }
  return { from: todayStr, to: todayStr, label: 'Hari Ini (Real Time)' };
}

// Ringkasan performa packing per orang, buat admin/CS pantau produktivitas tim.
// Query: ?preset=realtime|yesterday|month|custom  &from=YYYY-MM-DD&to=YYYY-MM-DD (khusus custom)
router.get('/performance', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { preset = 'realtime', from, to } = req.query;

  let range;
  try {
    range = resolvePresetRange(preset, from, to);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const rangeDays = Math.round((new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / 86400000) + 1;
  if (!Number.isFinite(rangeDays) || rangeDays < 1) {
    return res.status(400).json({ error: 'Rentang tanggal tidak valid' });
  }
  if (rangeDays > 366) {
    return res.status(400).json({ error: 'Rentang tanggal maksimal 366 hari' });
  }

  const { fromISO, toISO } = dateBoundsUTC(range.from, range.to);

  // Dulu narik SEMUA baris scan_log di rentang ini ke Vercel (dipaginasi 1000/request, bisa
  // puluhan ribu baris buat rentang 1 bulan) + query orders terpisah per order_id buat cari
  // opsi_pengiriman, semuanya digabung & dihitung di JS. Sekarang semua join + GROUP BY
  // dikerjain langsung di Postgres lewat RPC get_packing_performance() (lihat
  // migration-performance.sql) — jauh lebih cepat & cuma hasil ringkasannya yang ditransfer.
  const { data: perf, error: perfError } = await supabase.rpc('get_packing_performance', {
    p_from: fromISO,
    p_to: toISO,
  });
  if (perfError) return res.status(500).json({ error: 'Gagal mengambil data performa: ' + perfError.message });

  const total = Number(perf?.total || 0);
  const byDay = Object.fromEntries((perf?.daily_trend || []).map((d) => [d.date, Number(d.total)]));

  const leaderboard = (perf?.leaderboard || [])
    .map((u) => {
      const userTotal = Number(u.total);
      return {
        user_id: u.user_id,
        full_name: u.full_name,
        role: u.role,
        total: userTotal,
        percentage: total ? Math.round((userTotal / total) * 1000) / 10 : 0,
        // Breakdown kurir KHUSUS packer ini (persentase dihitung dari total packing
        // dia sendiri, bukan dari total tim) -- dipakai pas nama packer di-klik/expand.
        courier_breakdown: (u.courier_breakdown || [])
          .map((c) => ({
            courier: c.courier,
            total: Number(c.total),
            percentage: userTotal ? Math.round((Number(c.total) / userTotal) * 1000) / 10 : 0,
          }))
          .sort((a, b) => b.total - a.total),
      };
    })
    .sort((a, b) => b.total - a.total);
  const userIds = leaderboard.map((u) => u.user_id);

  // Isi hari yang gak ada scan sama sekali dengan 0 biar grafik trennya gak bolong.
  const dailyTrend = [];
  const cursor = new Date(`${range.from}T00:00:00.000Z`);
  const end = new Date(`${range.to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    dailyTrend.push({ date: day, total: byDay[day] || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const courierBreakdown = (perf?.courier_breakdown || [])
    .map((c) => ({
      courier: c.courier,
      total: Number(c.total),
      percentage: total ? Math.round((Number(c.total) / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  res.json({
    range: { from: range.from, to: range.to, label: range.label, days: rangeDays },
    total_packing: total,
    active_packers: userIds.length,
    avg_per_packer: userIds.length ? Math.round((total / userIds.length) * 10) / 10 : 0,
    leaderboard,
    daily_trend: dailyTrend,
    courier_breakdown: courierBreakdown,
  });
});

module.exports = router;
