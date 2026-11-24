const express = require('express');
const supabase = require('../supabase');
const { runResiSync } = require('../resiSync');

const router = express.Router();

// Verifikasi pemanggil cron. Vercel Cron otomatis kirim "Authorization: Bearer <CRON_SECRET>",
// dan workflow GitHub Actions (.github/workflows/refresh-resi.yml) kirim header yang sama.
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

// GET /api/cron/refresh-resi
// Dipanggil otomatis (Vercel Cron 2x/hari + GitHub Actions tiap ~10 menit). Logika lengkapnya
// ada di api/_lib/resiSync.js: tahap PICKUP (belum_dikirim -> dikirim) untuk semua kurir yang
// bisa dicek, plus tahap TRANSIT (dikirim -> diterima) khusus kurir gratis (SPX langsung).
// Env opsional: CRON_RESI_MAX_PER_RUN (150), CRON_RESI_TRANSIT_PER_RUN (60),
// CRON_RESI_TIME_BUDGET_MS (7500), CRON_RESI_CONCURRENCY (8).
router.get('/refresh-resi', async (req, res) => {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const results = await runResiSync({
      maxPickup: Number(process.env.CRON_RESI_MAX_PER_RUN || 150),
      maxTransit: Number(process.env.CRON_RESI_TRANSIT_PER_RUN || 60),
      timeBudgetMs: Number(process.env.CRON_RESI_TIME_BUDGET_MS || 7500),
      concurrency: Number(process.env.CRON_RESI_CONCURRENCY || 8),
      requestTimeoutMs: 5000,
    });
    const { changes, ...summary } = results;
    console.log('[cron/refresh-resi] Selesai:', JSON.stringify(summary));
    res.json({ ok: true, ...summary, changed: (changes || []).length });
  } catch (e) {
    console.error('[cron/refresh-resi] Gagal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cron/cleanup-old-orders
// Hapus pesanan yang lebih tua dari RETENTION_DAYS (default 60 hari) + scan_log-nya.
// Dihapus per batch lewat function SQL purge_old_orders (lihat migration-auto-cleanup.sql),
// diulang selama masih ada sisa dan waktu function belum mepet (Hobby: 10 detik).
// Kalau backlog banyak, sisanya otomatis dilanjut di run cron berikutnya.
const RETENTION_DAYS = Number(process.env.ORDER_RETENTION_DAYS || 60);
const CLEANUP_BATCH = Number(process.env.CLEANUP_BATCH_SIZE || 5000);
const KEEP_AFFILIATE = process.env.CLEANUP_KEEP_AFFILIATE === 'true';

router.get('/cleanup-old-orders', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const startedAt = Date.now();
  const total = { orders: 0, scan_log: 0, rounds: 0 };

  try {
    while (Date.now() - startedAt < 7000) {
      const { data, error } = await supabase.rpc('purge_old_orders', {
        p_days: RETENTION_DAYS,
        p_batch: CLEANUP_BATCH,
        p_keep_affiliate: KEEP_AFFILIATE,
      });
      if (error) throw new Error(error.message);
      total.rounds++;
      total.orders += Number(data?.orders || 0);
      total.scan_log += Number(data?.scan_log || 0);
      if (!data || Number(data.orders) < CLEANUP_BATCH) break; // sudah habis
    }
  } catch (e) {
    console.error('[cron/cleanup-old-orders] Gagal:', e.message);
    return res.status(500).json({ error: e.message, ...total });
  }

  console.log('[cron/cleanup-old-orders] Selesai:', JSON.stringify(total));
  res.json({ ok: true, retention_days: RETENTION_DAYS, ...total });
});

module.exports = router;
