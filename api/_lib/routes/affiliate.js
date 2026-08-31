const express = require('express');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// ---------- Rentang periode (this_month / last_month / custom) ----------
// Sama polanya kayak resolvePresetRange() di packing.js (Performa Packing), cuma di sini
// defaultnya per-bulan (bukan per-hari) karena affiliate memang mau direkap "sebulan
// berapa", bukan performa harian.
function monthBoundsUTC(year, monthIndex0) {
  const from = new Date(Date.UTC(year, monthIndex0, 1));
  const to = new Date(Date.UTC(year, monthIndex0 + 1, 1));
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

function monthLabel(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0, 1)).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function resolvePresetRange(preset, from, to) {
  const now = new Date();
  if (preset === 'last_month') {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() - 1;
    const wrapDate = new Date(Date.UTC(y, m, 1));
    const { fromISO, toISO } = monthBoundsUTC(wrapDate.getUTCFullYear(), wrapDate.getUTCMonth());
    return { fromISO, toISO, label: monthLabel(wrapDate.getUTCFullYear(), wrapDate.getUTCMonth()) };
  }
  if (preset === 'custom') {
    if (!from || !to) throw new Error('Tanggal dari dan sampai wajib diisi untuk rentang custom');
    const fromISO = `${from}T00:00:00.000Z`;
    const toDate = new Date(`${to}T00:00:00.000Z`);
    if (isNaN(toDate.getTime()) || isNaN(new Date(fromISO).getTime())) throw new Error('Format tanggal tidak valid');
    toDate.setUTCDate(toDate.getUTCDate() + 1); // batas atas eksklusif
    return { fromISO, toISO: toDate.toISOString(), label: `${from} s/d ${to}` };
  }
  // default: this_month
  const { fromISO, toISO } = monthBoundsUTC(now.getUTCFullYear(), now.getUTCMonth());
  return { fromISO, toISO, label: monthLabel(now.getUTCFullYear(), now.getUTCMonth()) };
}

// Rekap pengeluaran affiliate: total pesanan & ongkir, breakdown per affiliate (+ motif
// yang dikirim ke tiap affiliate), dan breakdown per motif secara keseluruhan.
// Query: ?preset=this_month|last_month|custom  &from=YYYY-MM-DD&to=YYYY-MM-DD (khusus custom)
router.get('/summary', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { preset = 'this_month', from, to } = req.query;

  let range;
  try {
    range = resolvePresetRange(preset, from, to);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { data, error } = await supabase.rpc('get_affiliate_summary', { p_from: range.fromISO, p_to: range.toISO });
  if (error) return res.status(500).json({ error: 'Gagal mengambil ringkasan affiliate: ' + error.message });

  res.json({
    range: { from: range.fromISO, to: range.toISO, label: range.label },
    total_orders: Number(data?.total_orders || 0),
    total_ongkir: Number(data?.total_ongkir || 0),
    affiliates: (data?.affiliates || []).map((a) => ({
      affiliate_name: a.affiliate_name,
      total_orders: Number(a.total_orders),
      total_ongkir: Number(a.total_ongkir),
      motifs: (a.motifs || []).map((m) => ({ motif: m.motif, total: Number(m.total) })),
    })),
    motif_breakdown: (data?.motif_breakdown || []).map((m) => ({
      motif: m.motif,
      total: Number(m.total),
      total_ongkir: Number(m.total_ongkir),
    })),
  });
});

// Daftar nama affiliate yang sudah pernah dipakai (buat autocomplete di form Input Manual
// & dropdown filter di dashboard Affiliate).
router.get('/list', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { data, error } = await supabase.from('orders').select('affiliate_name').eq('is_affiliate', true);
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar affiliate: ' + error.message });

  const names = [...new Set((data || []).map((r) => String(r.affiliate_name || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  res.json({ affiliates: names });
});

// Daftar pesanan affiliate tertentu di suatu periode (dipakai pas 1 baris affiliate di
// tabel diklik/di-expand, buat lihat detail pesanan apa aja yang bikin ongkirnya segitu).
router.get('/orders', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const affiliateName = String(req.query.affiliate_name || '').trim();
  const { preset = 'this_month', from, to } = req.query;
  if (!affiliateName) return res.status(400).json({ error: 'affiliate_name wajib diisi' });

  let range;
  try {
    range = resolvePresetRange(preset, from, to);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let query = supabase
    .from('orders')
    .select('*')
    .eq('is_affiliate', true)
    .gte('waktu_pesanan_at', range.fromISO)
    .lt('waktu_pesanan_at', range.toISO)
    .order('waktu_pesanan_at', { ascending: false });

  // "Tanpa Nama" itu label tampilan buat baris yang affiliate_name-nya kosong/null di
  // database (lihat get_affiliate_summary() di migration-affiliate.sql), jadi dicocokkan
  // ke kondisi kosong/null, bukan dicari literal string "Tanpa Nama".
  query = affiliateName === 'Tanpa Nama'
    ? query.or('affiliate_name.is.null,affiliate_name.eq.')
    : query.eq('affiliate_name', affiliateName);

  const { data: orders, error } = await query;
  if (error) return res.status(500).json({ error: 'Gagal mengambil pesanan affiliate: ' + error.message });

  res.json({ orders: orders || [], range: { from: range.fromISO, to: range.toISO, label: range.label } });
});

module.exports = router;
