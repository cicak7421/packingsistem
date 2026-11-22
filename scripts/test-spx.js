// Diagnostik tracking SPX langsung. Jalankan dari mesin/server yang punya internet:
//     node scripts/test-spx.js SPXID0123456789
// Mencetak hasil mentah (dipotong) + hasil yang sudah dipetakan sistem. Kalau hasil parsing
// kosong/salah, kirim output "RESPONS MENTAH" ke developer buat nyocokin nama field.
const { trackSpxDirect } = require('../api/_lib/courierTracking');

const resi = process.argv[2];
if (!resi) { console.error('Pemakaian: node scripts/test-spx.js <no_resi_SPX>'); process.exit(1); }

(async () => {
  const base = process.env.SPX_TRACKING_URL || 'https://spx.co.id/api/v2/fleet_order/tracking/search';
  try {
    const r = await fetch(`${base}?sls_tracking_number=${encodeURIComponent(resi)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://spx.co.id/' },
    });
    const t = await r.text();
    console.log(`--- RESPONS MENTAH (HTTP ${r.status}) ---`);
    console.log(t.slice(0, 1500));
  } catch (e) { console.log('Gagal fetch mentah:', e.message); }
  console.log('\n--- HASIL TERPETAKAN ---');
  try { console.log(JSON.stringify(await trackSpxDirect(resi), null, 2)); }
  catch (e) { console.log('GAGAL:', e.userMessage || e.message, '\n(detail:', e.message + ')'); }
})();
