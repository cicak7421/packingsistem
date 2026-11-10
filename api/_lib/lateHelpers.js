const supabase = require('./supabase');

// ---------- Aturan "paket telat kirim" ----------
// Paket dianggap TELAT kalau umur pesanannya (dihitung dari waktu pesanan dibuat di
// marketplace) sudah lewat LATE_AFTER_HOURS (default 24 jam = 1 hari) dan statusnya masih
// BELUM DIKIRIM (belum packing ATAU sudah packing tapi belum ditandai dikirim).
//
//   soon     : umur >= 75% batas (default 18 jam) -> "Hampir telat" (peringatan dini)
//   late     : umur >= LATE_AFTER_HOURS (default 24 jam)
//   critical : umur >= LATE_CRITICAL_AFTER_HOURS (default 2x batas = 48 jam)
//
// Pesanan yang umurnya lebih dari LATE_IGNORE_AFTER_DAYS (default 30 hari) dan masih
// "belum dikirim" dianggap data basi (biasanya batal/auto-cancel marketplace atau sisa
// data lama yang gak pernah ditandai dikirim), jadi TIDAK ikut dihitung telat -- kalau
// gak, begitu fitur ini aktif dashboard langsung banjir ribuan "telat" dari data lama.
//
// Semua angka bisa diubah lewat environment variable di Vercel tanpa ubah kode.
const HOUR_MS = 60 * 60 * 1000;
const numEnv = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

const LATE_AFTER_HOURS = numEnv(process.env.LATE_AFTER_HOURS, 24);
const CRITICAL_AFTER_HOURS = Math.max(
  numEnv(process.env.LATE_CRITICAL_AFTER_HOURS, LATE_AFTER_HOURS * 2),
  LATE_AFTER_HOURS + 1
);
const SOON_AFTER_HOURS = Math.max(1, Math.round(LATE_AFTER_HOURS * 0.75));
const STALE_AFTER_HOURS = Math.max(numEnv(process.env.LATE_IGNORE_AFTER_DAYS, 30) * 24, CRITICAL_AFTER_HOURS + 1);

// 26 jam -> "1 hr 2 j", 7 jam -> "7 j"
function formatAge(hours) {
  const h = Math.max(0, Math.floor(hours));
  const d = Math.floor(h / 24);
  const r = h % 24;
  if (d === 0) return `${h} j`;
  return r ? `${d} hr ${r} j` : `${d} hr`;
}

// Waktu acuan umur pesanan: waktu pesanan dibuat di marketplace, atau (kalau kosong)
// waktu pesanan masuk ke sistem.
function referenceTime(order) {
  return order.waktu_pesanan_at || order.imported_at || null;
}

// Hitung info telat buat 1 pesanan. Pesanan yang sudah dikirim/diterima TIDAK pernah telat.
function computeLate(order, nowMs = Date.now()) {
  const none = { is_late: false, level: null, age_hours: null, age_label: null };
  if (!order) return none;
  if (order.status_resi === 'dikirim' || order.status_resi === 'diterima') return none;
  const ref = referenceTime(order);
  if (!ref) return none;
  const ageH = (nowMs - new Date(ref).getTime()) / HOUR_MS;
  if (!Number.isFinite(ageH) || ageH < 0 || ageH >= STALE_AFTER_HOURS) return none;

  let level = null;
  if (ageH >= CRITICAL_AFTER_HOURS) level = 'critical';
  else if (ageH >= LATE_AFTER_HOURS) level = 'late';
  else if (ageH >= SOON_AFTER_HOURS) level = 'soon';

  return {
    is_late: level === 'late' || level === 'critical',
    level,
    age_hours: Math.floor(ageH),
    age_label: formatAge(ageH),
    hours_to_late: level === 'soon' ? Math.max(0, Math.ceil(LATE_AFTER_HOURS - ageH)) : 0,
  };
}

// Pasang filter "belum dikirim & umur pesanan antara minHours s/d maxHours" ke query
// builder Supabase tabel orders. maxHours kosong = sampai batas data basi.
// Kalau waktu_pesanan_at kosong, pakai imported_at sebagai acuan (sama kayak computeLate).
function ageWindow(query, minHours, maxHours = STALE_AFTER_HOURS) {
  const now = Date.now();
  const olderThan = new Date(now - minHours * HOUR_MS).toISOString();
  const newerThan = new Date(now - maxHours * HOUR_MS).toISOString();
  return query
    .or('status_resi.eq.belum_dikirim,status_resi.is.null')
    .or(
      `and(waktu_pesanan_at.lte.${olderThan},waktu_pesanan_at.gt.${newerThan}),` +
      `and(waktu_pesanan_at.is.null,imported_at.lte.${olderThan},imported_at.gt.${newerThan})`
    );
}

// Hitung jumlah paket per tingkat telat (3 query count ringan, dijalankan paralel).
async function countLate() {
  const count = (min, max) => ageWindow(
    supabase.from('orders').select('id', { count: 'exact', head: true }), min, max
  );
  const [late, critical, soon] = await Promise.all([
    count(LATE_AFTER_HOURS),
    count(CRITICAL_AFTER_HOURS),
    count(SOON_AFTER_HOURS, LATE_AFTER_HOURS),
  ]);
  const err = late.error || critical.error || soon.error;
  if (err) throw new Error(err.message);
  return {
    late_count: late.count || 0, // sudah termasuk yang kritis
    critical_count: critical.count || 0,
    soon_count: soon.count || 0,
  };
}

function thresholds() {
  return {
    soon_hours: SOON_AFTER_HOURS,
    late_hours: LATE_AFTER_HOURS,
    critical_hours: CRITICAL_AFTER_HOURS,
  };
}

module.exports = {
  computeLate, ageWindow, countLate, thresholds, formatAge, referenceTime,
  LATE_AFTER_HOURS, CRITICAL_AFTER_HOURS, SOON_AFTER_HOURS, STALE_AFTER_HOURS,
};
