const express = require('express');
const supabase = require('../supabase');
const { trackResi } = require('../courierTracking');

const router = express.Router();

// Batas jumlah pesanan yang dicek per kali jalan, biar gak kena timeout function
// (Hobby: 10 detik). Yang paling lama belum dicek diprioritaskan duluan
// (resi_last_checked_at ascending, null dianggap paling lama / belum pernah dicek).
//
// PENTING soal cakupan: cron ini CUMA ngecek pesanan yang status_resi-nya masih
// "belum_dikirim" (artinya belum ada konfirmasi kurir udah pickup/scan paketnya sama
// sekali). Begitu ketauan udah ada aktivitas (dikirim/diterima), pesanan itu otomatis
// gak ke-query lagi di run berikutnya -- jadi cron ini TIDAK terus-terusan mantau
// paket yang lagi di jalan berhari-hari (itu bikin boros hit BinderByte tanpa perlu).
// Sisa perjalanan paket, arahkan CS/pembeli buat cek langsung ke web resmi kurirnya
// (lihat trackingLink dari buildTrackingLink() -- dipakai di frontend).
//
// Ini artinya jumlah "kandidat" tiap run kira-kira = jumlah pesanan baru sejak run
// sebelumnya (bukan numpuk berhari-hari), jadi jauh lebih murah & muat di 10 detik
// meski volume harian ratusan pesanan.
const MAX_PER_RUN = Number(process.env.CRON_RESI_MAX_PER_RUN || 150);

// Jumlah request BinderByte yang jalan bersamaan (biar cepet tapi gak nembak API sekaligus).
const CONCURRENCY = Number(process.env.CRON_RESI_CONCURRENCY || 8);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /api/cron/refresh-resi
// Dipanggil otomatis oleh Vercel Cron (lihat "crons" di vercel.json), bukan dari frontend.
// Vercel otomatis kirim header "Authorization: Bearer <CRON_SECRET>" tiap manggil cron job
// kalau env var CRON_SECRET di-set -> di sini kita verifikasi biar endpoint ini gak bisa
// dipanggil sembarang orang dari luar (endpoint publik URL-nya ketebak: /api/cron/refresh-resi).
router.get('/refresh-resi', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.BINDERBYTE_API_KEY) {
    // Jangan gagal berisik — cuma log & keluar, biar cron run-nya tetep tercatat "selesai" di Vercel.
    console.log('[cron/refresh-resi] Dilewati: BINDERBYTE_API_KEY belum di-set.');
    return res.json({ ok: true, skipped: true, reason: 'BINDERBYTE_API_KEY belum di-set' });
  }

  // Ambil kandidat: punya no_resi, DAN masih "belum_dikirim" (belum ada konfirmasi
  // pickup sama sekali). Yang paling lama belum dicek diprioritaskan duluan.
  const { data: orders, error: fetchError } = await supabase
    .from('orders')
    .select('id, no_resi, opsi_pengiriman, status_resi')
    .not('no_resi', 'is', null)
    .neq('no_resi', '')
    .eq('status_resi', 'belum_dikirim')
    .order('resi_last_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  if (fetchError) {
    console.error('[cron/refresh-resi] Gagal ambil daftar pesanan:', fetchError.message);
    return res.status(500).json({ error: 'Gagal ambil daftar pesanan: ' + fetchError.message });
  }

  const results = { checked: 0, updated_pickup_confirmed: 0, failed: 0, skipped_no_courier: 0 };
  const now = new Date().toISOString();

  for (const batch of chunk(orders || [], CONCURRENCY)) {
    await Promise.all(
      batch.map(async (order) => {
        let tracked;
        try {
          tracked = await trackResi({ noResi: order.no_resi, opsiPengiriman: order.opsi_pengiriman });
        } catch (e) {
          // Kurir gak dikenali / API error / resi belum ada update -> lewati, coba lagi run berikutnya.
          if (e.message && e.message.startsWith('Kurir tidak dikenali')) results.skipped_no_courier++;
          else results.failed++;
          // Log alasan asli-nya biar kelihatan di Vercel Function Logs, bukan cuma angka doang.
          console.error(`[cron/refresh-resi] Gagal cek order ${order.id} (resi=${order.no_resi}, kurir="${order.opsi_pengiriman}"):`, e.message);
          // Rekap per-alasan di response, biar langsung kebaca tanpa buka Function Logs.
          const reasonKey = e.message || 'unknown';
          results.failure_reasons = results.failure_reasons || {};
          results.failure_reasons[reasonKey] = (results.failure_reasons[reasonKey] || 0) + 1;
          // Tetep update resi_last_checked_at biar gak nyangkut di depan antrian terus tiap run.
          await supabase.from('orders').update({ resi_last_checked_at: now }).eq('id', order.id);
          return;
        }

        results.checked++;
        const updatePayload = {
          resi_courier_status: tracked.statusText,
          resi_last_checked_at: now,
          resi_history: tracked.history,
        };

        // Begitu kedeteksi udah ada aktivitas apa pun ("dikirim" atau langsung "diterima"
        // kalau ceknya telat), catat & STOP -- run berikutnya gak akan ambil order ini lagi
        // karena query di atas cuma nyari status_resi = 'belum_dikirim'.
        if (tracked.internalStatus) {
          updatePayload.status_resi = tracked.internalStatus;
          if (tracked.internalStatus === 'dikirim' || tracked.internalStatus === 'diterima') {
            updatePayload.dikirim_at = now;
            updatePayload.status_packing = 'sudah_packing';
            results.updated_pickup_confirmed++;
          }
        }

        const { error: updateError } = await supabase.from('orders').update(updatePayload).eq('id', order.id);
        if (updateError) {
          console.error(`[cron/refresh-resi] Gagal update order ${order.id}:`, updateError.message);
          results.failed++;
        }
      })
    );
  }

  console.log('[cron/refresh-resi] Selesai:', JSON.stringify(results));
  res.json({ ok: true, candidates: (orders || []).length, ...results });
});

module.exports = router;
