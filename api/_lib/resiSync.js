// Mesin sinkronisasi status resi -- dipakai bersama oleh:
//   - GET  /api/cron/refresh-resi  (Vercel Cron + GitHub Actions tiap ~10 menit)
//   - POST /api/orders/live-sync   (dipanggil dashboard yang lagi dibuka, tiap ~2 menit)
//
// Dua tahap per run:
//   1. PICKUP  : pesanan yang punya resi & masih "belum_dikirim" -> cek ke kurir. Begitu ada
//                aktivitas kurir, naik ke "dikirim" (status_packing ikut "sudah_packing").
//   2. TRANSIT : pesanan "dikirim" (maks N hari terakhir) yang kurirnya GRATIS dicek langsung
//                (SPX lewat spx.co.id) -> dipantau terus sampai "diterima". Kurir berbayar
//                (BinderByte) sengaja gak ikut tahap ini biar gak boros hit.
//
// Semua run dibatasi waktu (timeBudgetMs) supaya gak kena timeout function Vercel. Antrian
// diurutkan dari yang paling lama belum dicek, jadi sisa yang belum sempat otomatis
// dilanjutkan di run berikutnya.
const supabase = require('./supabase');
const { trackResi, isInstantCourier, isFreeDirectCourier } = require('./courierTracking');
const { autoDeductStockForOrders } = require('./inventoryHelpers');

const COLS = 'id, no_pesanan, sku, jumlah, status_packing, no_resi, opsi_pengiriman, status_resi, resi_last_checked_at, dikirim_at';
const TRANSIT_MAX_DAYS = Number(process.env.RESI_TRANSIT_MAX_DAYS || 14);
const TRANSIT_RECHECK_MIN = Number(process.env.RESI_TRANSIT_RECHECK_MINUTES || 180);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const minutesAgoIso = (m) => new Date(Date.now() - m * 60000).toISOString();
const checkedBefore = (o, iso) => !o.resi_last_checked_at || o.resi_last_checked_at < iso;

async function fetchPickupCandidates({ limit, minRecheckMinutes, hasBinderByte }) {
  let q = supabase
    .from('orders')
    .select(COLS)
    .not('no_resi', 'is', null)
    .neq('no_resi', '')
    .eq('status_resi', 'belum_dikirim');
  if (!hasBinderByte) q = q.or('opsi_pengiriman.ilike.%spx%,opsi_pengiriman.ilike.%shopee%');
  // Ambil lebih banyak dari limit, lalu saring yang baru-baru ini sudah dicek (biar gak dobel
  // ditembak kalau beberapa dashboard kebuka bersamaan).
  const { data, error } = await q
    .order('resi_last_checked_at', { ascending: true, nullsFirst: true })
    .limit(minRecheckMinutes ? limit * 3 : limit);
  if (error) throw new Error('Gagal ambil kandidat pickup: ' + error.message);
  const iso = minRecheckMinutes ? minutesAgoIso(minRecheckMinutes) : null;
  return (data || []).filter((o) => !iso || checkedBefore(o, iso)).slice(0, limit);
}

async function fetchTransitCandidates({ limit }) {
  const since = new Date(Date.now() - TRANSIT_MAX_DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select(COLS)
    .eq('status_resi', 'dikirim')
    .gte('dikirim_at', since)
    .not('no_resi', 'is', null)
    .neq('no_resi', '')
    .or('opsi_pengiriman.ilike.%spx%,opsi_pengiriman.ilike.%shopee%')
    .order('resi_last_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit * 3);
  if (error) throw new Error('Gagal ambil kandidat transit: ' + error.message);
  const iso = minutesAgoIso(TRANSIT_RECHECK_MIN);
  return (data || [])
    .filter((o) => isFreeDirectCourier(o.opsi_pengiriman) && !isInstantCourier(o.opsi_pengiriman) && checkedBefore(o, iso))
    .slice(0, limit);
}

/**
 * @param {object} opts
 * @param {number} opts.maxPickup          maks pesanan tahap pickup
 * @param {number} opts.maxTransit         maks pesanan tahap transit (0 = lewati)
 * @param {number} opts.timeBudgetMs       berhenti rapi setelah sekian ms
 * @param {number} opts.concurrency        request kurir bersamaan
 * @param {number} opts.requestTimeoutMs   timeout per request ke kurir
 * @param {number} [opts.minRecheckMinutes] lewati pesanan yang baru dicek < N menit lalu
 * @param {string|null} [opts.actorId]     user yang memicu (buat log potong stok)
 */
async function runResiSync(opts) {
  const {
    maxPickup = 150, maxTransit = 60, timeBudgetMs = 7500, concurrency = 8,
    requestTimeoutMs = 6000, minRecheckMinutes = 0, actorId = null,
  } = opts || {};
  const startedAt = Date.now();
  const hasBinderByte = !!process.env.BINDERBYTE_API_KEY;
  const spxDirectOn = process.env.SPX_DIRECT_DISABLE !== '1';

  const results = {
    candidates: 0, checked: 0, updated_pickup_confirmed: 0, updated_delivered: 0,
    failed: 0, skipped_no_courier: 0, stopped_early: false, changes: [],
  };
  if (!hasBinderByte && !spxDirectOn) return { ...results, skipped: true, reason: 'Tidak ada sumber tracking aktif' };

  const pickup = await fetchPickupCandidates({ limit: maxPickup, minRecheckMinutes, hasBinderByte });
  const transit = maxTransit > 0 && spxDirectOn ? await fetchTransitCandidates({ limit: maxTransit }) : [];
  const queue = [...pickup.map((o) => ({ o, phase: 'pickup' })), ...transit.map((o) => ({ o, phase: 'transit' }))];
  results.candidates = queue.length;
  results.pickup_candidates = pickup.length;
  results.transit_candidates = transit.length;

  const newlyPacked = [];
  const now = () => new Date().toISOString();

  for (const batch of chunk(queue, concurrency)) {
    // Sisakan ruang buat request terakhir + simpan hasil, biar function gak kepotong timeout.
    if (Date.now() - startedAt > timeBudgetMs - requestTimeoutMs * 0.5) { results.stopped_early = true; break; }
    await Promise.all(batch.map(async ({ o: order, phase }) => {
      let tracked;
      try {
        tracked = await trackResi({ noResi: order.no_resi, opsiPengiriman: order.opsi_pengiriman, timeoutMs: requestTimeoutMs });
      } catch (e) {
        if (e.message && e.message.startsWith('Kurir tidak dikenali')) results.skipped_no_courier++;
        else results.failed++;
        const key = (e.message || 'unknown').slice(0, 140);
        results.failure_reasons = results.failure_reasons || {};
        results.failure_reasons[key] = (results.failure_reasons[key] || 0) + 1;
        await supabase.from('orders').update({ resi_last_checked_at: now() }).eq('id', order.id);
        return;
      }

      results.checked++;
      const payload = { resi_courier_status: tracked.statusText, resi_last_checked_at: now(), resi_history: tracked.history };
      let change = null;

      if (phase === 'pickup' && tracked.internalStatus) {
        payload.status_resi = tracked.internalStatus;
        payload.dikirim_at = now();
        payload.status_packing = 'sudah_packing';
        change = tracked.internalStatus;
      } else if (phase === 'transit' && tracked.internalStatus === 'diterima') {
        payload.status_resi = 'diterima'; // gak pernah mundur: transit cuma boleh naik ke diterima
        change = 'diterima';
      }

      // Guard status lama di WHERE: kalau status keburu diubah orang lain di tengah jalan, gak ditimpa.
      const { data: upd, error } = await supabase.from('orders').update(payload).eq('id', order.id).eq('status_resi', order.status_resi).select('id');
      if (error) { results.failed++; console.error(`[resiSync] gagal update ${order.id}:`, error.message); return; }

      if (change && upd && upd.length) {
        if (change === 'diterima' && phase === 'transit') results.updated_delivered++;
        else results.updated_pickup_confirmed++;
        results.changes.push({ id: order.id, no_pesanan: order.no_pesanan, no_resi: order.no_resi, kurir: order.opsi_pengiriman, status: change, info: tracked.statusText || '' });
        if (payload.status_packing === 'sudah_packing' && order.status_packing !== 'sudah_packing') newlyPacked.push(order);
      }
    }));
  }

  // Pesanan yang naik ke sudah_packing lewat deteksi kurir (tanpa scan) ikut motong stok.
  if (newlyPacked.length) {
    try { await autoDeductStockForOrders(newlyPacked, actorId); } catch (e) { console.error('[resiSync] auto-deduct stok gagal:', e.message); }
  }
  results.duration_ms = Date.now() - startedAt;
  return results;
}

module.exports = { runResiSync };
