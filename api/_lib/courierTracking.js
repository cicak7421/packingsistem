// Integrasi cek resi otomatis (real-time) ke ekspedisi, pakai BinderByte API
// (https://docs.binderbyte.com/api/cek-resi) sebagai perantara ke banyak ekspedisi
// sekaligus (JNE, J&T, SiCepat, dll) dalam satu API key. Berbayar per-hit, daftar &
// ambil API key di https://binderbyte.com/, lalu isi BINDERBYTE_API_KEY di environment.
//
// CATATAN PENTING: kode kurir "spx" (Shopee Xpress) di bawah ini masih tebakan awal —
// belum kami verifikasi tersedia di daftar kurir BinderByte. Setelah kamu punya akun,
// cek dashboard/dokumentasi mereka buat konfirmasi kode kurirnya, lalu sesuaikan
// COURIER_CODE_MAP di bawah kalau kodenya beda atau kurirnya belum didukung.

const BINDERBYTE_BASE_URL = 'https://api.binderbyte.com/v1/track';

// Mapping dari teks "Opsi Pengiriman" hasil export Shopee -> kode kurir BinderByte.
// Cocokin berdasarkan kata kunci (case-insensitive). Tambahin baris baru kalau ada
// opsi pengiriman lain yang belum kecover.
const COURIER_KEYWORD_MAP = [
  { keywords: ['shopee', 'spx'], code: 'spx' },
  { keywords: ['jnt', 'j&t', 'j & t'], code: 'jnt' },
  { keywords: ['jne'], code: 'jne' },
  { keywords: ['sicepat'], code: 'sicepat' },
  { keywords: ['anteraja', 'anter aja'], code: 'anteraja' },
  { keywords: ['ninja'], code: 'ninja' },
  { keywords: ['wahana'], code: 'wahana' },
  { keywords: ['tiki'], code: 'tiki' },
  { keywords: ['pos indonesia', ' pos '], code: 'pos' },
  { keywords: ['id express', 'ide'], code: 'ide' },
  { keywords: ['sap express', 'sap'], code: 'sap' },
  { keywords: ['ncs'], code: 'ncs' },
  { keywords: ['rex'], code: 'rex' },
  { keywords: ['lion parcel', 'lion'], code: 'lion' },
  { keywords: ['jet express', 'jet'], code: 'jet' },
];

function detectCourierCode(opsiPengiriman) {
  const text = ` ${String(opsiPengiriman || '').toLowerCase()} `;
  for (const entry of COURIER_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => text.includes(kw))) return entry.code;
  }
  return null;
}

// Kurir INSTANT (GrabExpress, GoSend, Gojek, dan kurir mana pun yang varian instant/sameday-nya
// dipakai -- misal Anteraja Sameday, SPX Instant, SiCepat Sameday, JNE Instant, dst) gak lewat
// hub BinderByte sama sekali -- paket langsung dijemput driver begitu di-packing (bahkan kadang
// gak sempat di-scan sama sekali di sistem), jadi gak akan pernah ada update resi yang bisa
// dicek otomatis. Buat kurir-kurir ini, "sudah packing" DIANGGAP otomatis "sudah dikirim"
// (lihat pemakaiannya di api/_lib/routes/packing.js saat scan, dan di api/_lib/routes/import.js
// saat pesanan pertama kali masuk ke sistem -- biar pesanan instant/sameday gak nyangkut lama
// di "Menunggu Packing" cuma gara-gara emang gak pernah sempat di-scan).
//
// Dicocokkan dari teks "Opsi Pengiriman" hasil export marketplace, case-insensitive:
// - GrabExpress, Gojek, GoSend: SELALU instant/sameday (gak ada versi reguler mereka di
//   sistem ini), jadi cukup dicocokkan dari nama brand-nya doang.
// - Kurir lain (SPX, Anteraja, SiCepat, JNE, dst) punya versi REGULER juga (yang masih bisa
//   dicek resinya lewat BinderByte) -- makanya buat kurir-kurir ini WAJIB ada kata
//   "instant"/"sameday"/"same day" eksplisit di nama opsi pengirimannya, biar versi reguler
//   mereka gak ikut ke-bypass.
function isInstantCourier(opsiPengiriman) {
  const text = String(opsiPengiriman || '').toLowerCase();
  if (!text) return false;
  if (text.includes('grabexpress') || text.includes('gojek') || text.includes('gosend')) return true;
  if (text.includes('instant') || text.includes('sameday') || text.includes('same day')) return true;
  return false;
}

// Status mentah dari BinderByte macam-macam istilahnya tergantung ekspedisi
// (DELIVERED, TERKIRIM, DIKIRIM, ON PROCESS, dst). Kita sederhanakan jadi 3 status
// internal Flowmua: belum_dikirim | dikirim | diterima.
//
// PENTING (fix bug "status kepancet lompat ke 'dikirim' padahal belum diserahkan"):
// summary.status dari BinderByte itu KASAR -- "ON PROCESS" dipakai BinderByte baik pas
// paket baru "ditugaskan ke kurir, masih nunggu diambil" MAUPUN pas udah "beneran
// di-scan/diambil kurir, lagi transit". Jadi kita GAK BISA cuma ngandelin summary.status
// buat mutusin "dikirim". Yang lebih akurat adalah entri paling baru di `history`
// (deskripsi event, bukan cuma kode status), karena isinya bahasa asli dari kurir
// ("Kurir ditugaskan untuk menjemput", "Menunggu pesanan diserahkan ke pihak jasa
// kirim", vs "Pesanan telah diserahkan ke jasa kirim untuk diproses", dst).
//
// Strateginya: cek pola "BELUM diserahkan" dulu (assigned/menunggu pickup) -- kalau
// match, jangan naikin status. Baru kalau gak match, cek pola "SUDAH diserahkan/
// diambil/transit". Kalau dua-duanya gak ketemu (bahasa kurir yang belum kecover),
// default-nya JUGA jangan naikin -- lebih aman biarin ke-skip & dicek ulang run
// berikutnya, daripada salah nge-flag "dikirim" padahal paketnya belum disentuh kurir.
// Beda ekspedisi beda gaya bahasa dikit-dikit, makanya list pola di bawah sengaja
// dibikin longgar (regex, bukan exact match) biar nyerap variasi istilah.

const NOT_YET_HANDED_OVER_PATTERNS = [
  /menunggu.*(diserahkan|serah\s*terima|penjemputan|pick\s*up|dijemput)/i,
  /(pesanan|paket).*(menunggu|belum).*(diserahkan|dijemput|diambil)/i,
  /ditugaskan.*(menjemput|pick\s*up)/i,
  /kurir.*(ditugaskan|ditunjuk)/i,
  /(sedang |telah )?mengatur pengiriman/i,
  /pesanan (sedang )?diproses(?!.*(gudang|hub|sortir|warehouse))/i, // "pesanan diproses" polos (tanpa lokasi fasilitas) biasanya masih di sisi penjual/marketplace
  /pesanan (telah )?dibuat/i,
  /order (has been )?created/i,
  /shipping (has been )?(arranged|label)/i,
  /waiting for (pick\s*up|courier|collection)/i,
  /pending pick\s*up/i,
  /request pick\s*up/i,
  /belum diserahkan/i,
];

const HANDED_OVER_PATTERNS = [
  /(telah|sudah)?\s*diserahkan ke (pihak )?(jasa kirim|kurir|ekspedisi)/i,
  /telah diambil (oleh )?kurir/i,
  /(paket|pesanan).*(diambil|dijemput) (oleh )?kurir/i,
  /picked\s*up/i,
  /diterima (oleh |di )?(kurir|gudang|hub|sortir|warehouse|fasilitas)/i,
  /received (by|at) (courier|shipper|sorting|warehouse|hub)/i,
  /(sudah|telah)? ?di ?scan/i,
  /diproses di (gudang|hub|sortir|warehouse)/i,
  /dalam (proses )?pengiriman/i,
  /in\s*transit/i,
  /on\s*the\s*way/i,
  /out for delivery/i,
  /sedang dikirim/i,
  // "ITEM HAS BEEN PICKED AND READY TO BE SHIPPED" (J&T) -- kepisah dari /picked\s*up/i
  // di atas karena kalimatnya "PICKED AND READY", bukan "PICKED UP".
  /item has been picked/i,
  /picked and ready/i,
  /ready to be shipped/i,
];

// Fallback GENERIK (biar semua ekspedisi kebaca, bukan cuma yang polanya udah
// didaftar manual di atas): kalau teksnya nyebut nama lokasi/fasilitas yang cuma
// bisa disinggahi paket SETELAH fisik diambil kurir dari penjual -- transit hub,
// gudang sortir, first/last mile hub, dst -- itu tandanya sudah diserahkan/dikirim,
// walau redaksi kalimat lengkapnya beda-beda tiap kurir dan belum ada pola spesifik
// buat itu. Ini dicek PALING TERAKHIR (setelah NOT_YET_HANDED_OVER_PATTERNS di atas),
// jadi tetap aman: kalau teksnya juga nyebut "menunggu/ditugaskan/dibuat" dkk, pola
// NOT_YET udah keburu nangkep & return null duluan sebelum sampai ke sini.
// Contoh yang ketangkep pola ini: "Pesanan tiba di lokasi transit Kota Jakarta
// Pusat, Kemayoran 3 First Mile Hub." (belum ada pola spesifik buat "tiba di ...
// hub", tapi kata "transit" & "first mile hub" cukup jadi sinyal).
const FACILITY_KEYWORDS_PATTERN = /\b(hub|sortir|sorting|transit|gudang|warehouse|depo|cabang|fasilitas|facility|gateway|first\s*mile|last\s*mile|mile\s*hub)\b/i;

function mapToInternalStatus(rawStatus, historyList, rawDesc) {
  const s = String(rawStatus || '').toUpperCase();
  if (s.includes('DELIVER') || s.includes('TERKIRIM') || s.includes('DITERIMA')) return 'diterima';

  // Ambil deskripsi entri paling baru di history (index 0 = terbaru, sesuai urutan yang
  // dibalikin BinderByte / yang ditampilin di "riwayat perjalanan" pada dashboard).
  // Kalau history kosong (beberapa kurir/hasil BinderByte gak selalu isi history detail --
  // SPX contohnya), fallback ke summary.desc (deskripsi status yang lebih informatif
  // dibanding summary.status yang cuma kode pendek), baru fallback terakhir ke summary.status.
  const latestDesc = Array.isArray(historyList) && historyList.length > 0
    ? String(historyList[0]?.desc || historyList[0]?.status || '')
    : '';
  const textToCheck = latestDesc || String(rawDesc || '') || String(rawStatus || '');

  if (!textToCheck) return null; // gak ada info sama sekali -> jangan tebak, biar dicek lagi run berikutnya

  if (NOT_YET_HANDED_OVER_PATTERNS.some((re) => re.test(textToCheck))) return null; // masih belum diserahkan -> jangan naikin status
  if (HANDED_OVER_PATTERNS.some((re) => re.test(textToCheck))) return 'dikirim'; // konfirmasi udah di tangan kurir
  if (FACILITY_KEYWORDS_PATTERN.test(textToCheck)) return 'dikirim'; // gak match pola spesifik, tapi nyebut fasilitas transit/hub/gudang -> aman disimpulkan sudah dikirim

  return null; // bahasa/pola belum kecover -> aman-nya jangan naikin status dulu
}

// Setelah status_resi berubah jadi "dikirim" (artinya udah dikonfirmasi di-pickup /
// discan kurir), kita BERHENTI cek otomatis ke BinderByte buat resi itu (baik dari cron
// maupun auto-cek pas search) -- soalnya BinderByte bayar per-hit, dan sisa perjalanan
// paket (dikirim -> diterima, bisa berhari-hari) lebih murah dipantau langsung lewat
// halaman resmi kurirnya. Ini map kode kurir -> link tracking publik mereka.
//
// CATATAN: cuma "spx" yang confirmed bisa deep-link langsung nampilin hasil (tinggal
// tempel nomor resi ke query string, tanpa "="). Kurir lain kebanyakan butuh isi nomor
// resi manual di form mereka (kadang + captcha), jadi kita arahkan ke halaman
// tracking-nya aja dan user tinggal paste nomor resi yang udah ditampilkan di sistem ini.
const COURIER_TRACKING_PAGES = {
  spx: { name: 'Shopee Xpress', buildUrl: (resi) => `https://spx.co.id/track?${encodeURIComponent(resi)}`, deepLink: true },
  jnt: { name: 'J&T Express', buildUrl: () => 'https://www.jet.co.id/track', deepLink: false },
  jne: { name: 'JNE', buildUrl: () => 'https://www.jne.co.id/id/tracking/trace', deepLink: false },
  sicepat: { name: 'SiCepat', buildUrl: () => 'https://www.sicepat.com/checkAwb', deepLink: false },
  anteraja: { name: 'AnterAja', buildUrl: () => 'https://anteraja.id/tracking', deepLink: false },
  ninja: { name: 'Ninja Xpress', buildUrl: () => 'https://www.ninjaxpress.co/id-id/tracking', deepLink: false },
  wahana: { name: 'Wahana', buildUrl: () => 'https://www.wahana.com/', deepLink: false },
  tiki: { name: 'TIKI', buildUrl: () => 'https://www.tiki.id/id/tracking', deepLink: false },
  pos: { name: 'Pos Indonesia', buildUrl: () => 'https://www.posindonesia.co.id/id/tracking', deepLink: false },
  ide: { name: 'ID Express', buildUrl: () => 'https://id-express.com/', deepLink: false },
  sap: { name: 'SAP Express', buildUrl: () => 'https://www.sap-express.id/', deepLink: false },
  ncs: { name: 'NCS', buildUrl: () => 'https://www.ncs.co.id/', deepLink: false },
  rex: { name: 'REX', buildUrl: () => 'https://rex.co.id/', deepLink: false },
  lion: { name: 'Lion Parcel', buildUrl: () => 'https://lionparcel.com/', deepLink: false },
  jet: { name: 'JET Express', buildUrl: () => 'https://www.jet.co.id/', deepLink: false },
};

// Dipakai frontend buat nampilin tombol "Lacak di [Kurir]". Balikin null kalau kurirnya
// gak dikenali atau belum ada no_resi -- frontend tinggal sembunyiin tombolnya.
function buildTrackingLink(opsiPengiriman, noResi) {
  if (!noResi) return null;
  const courierCode = detectCourierCode(opsiPengiriman);
  const info = courierCode ? COURIER_TRACKING_PAGES[courierCode] : null;
  if (!info) return null;
  return {
    courierName: info.name,
    url: info.buildUrl(noResi),
    // deepLink true = link-nya langsung nampilin hasil. false = user masih perlu
    // paste no_resi manual di halaman itu (kita kasih tau di frontend).
    deepLink: info.deepLink,
  };
}

// Lempar Error dengan .userMessage buat pesan yang aman ditampilkan ke user.
async function trackResi({ noResi, opsiPengiriman }) {
  const apiKey = process.env.BINDERBYTE_API_KEY;
  if (!apiKey) {
    const err = new Error('BINDERBYTE_API_KEY belum di-set di environment variables');
    err.userMessage = 'Fitur cek status otomatis belum di-setup. Tambahkan BINDERBYTE_API_KEY di Environment Variables (daftar & ambil key di binderbyte.com), lalu deploy ulang.';
    throw err;
  }

  const courierCode = detectCourierCode(opsiPengiriman);
  if (!courierCode) {
    const err = new Error(`Kurir tidak dikenali dari opsi pengiriman: "${opsiPengiriman}"`);
    err.userMessage = `Kurir "${opsiPengiriman || '-'}" belum kekenal sama sistem, jadi belum bisa dicek otomatis. Update status resi manual dulu ya.`;
    throw err;
  }

  const url = `${BINDERBYTE_BASE_URL}?api_key=${encodeURIComponent(apiKey)}&courier=${encodeURIComponent(courierCode)}&awb=${encodeURIComponent(noResi)}`;

  let res;
  try {
    // User-Agent eksplisit -- beberapa WAF/CDN nge-block request tanpa UA yang jelas,
    // apalagi kalau datengnya burst (banyak request bersamaan dari IP yang sama).
    res = await fetch(url, { headers: { 'User-Agent': 'packingsistem-cron/1.0 (+refresh-resi)' } });
  } catch (e) {
    // Ini murni gagal connect (DNS/network/timeout) -- belum sempat dapet response sama sekali.
    const err = new Error('Gagal menghubungi layanan cek resi: ' + e.message);
    err.userMessage = 'Gagal menghubungi layanan cek resi (masalah jaringan). Coba lagi sebentar.';
    throw err;
  }

  // Baca body sebagai TEXT dulu (bukan langsung .json()), biar kalau ternyata bukan JSON
  // (halaman HTML error/rate-limit/WAF block dari BinderByte atau CDN di depannya) kita
  // masih bisa log isinya buat debug, bukan cuma exception "Unexpected token '<'".
  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    // Potong biar log gak kebanjiran -- 300 karakter pertama biasanya udah cukup buat
    // kenalin ini halaman apa (judul <title>, pesan Cloudflare, dll).
    const snippet = rawText.slice(0, 300).replace(/\s+/g, ' ').trim();
    const err = new Error(
      `Respons bukan JSON (HTTP ${res.status} ${res.statusText}, content-type: ${res.headers.get('content-type') || '-'}). Body: ${snippet}`
    );
    err.userMessage = `Layanan cek resi balikin halaman aneh (HTTP ${res.status}), bukan data. Kemungkinan lagi rate-limit, maintenance, atau diblokir. Cek Function Logs buat detail body responsnya.`;
    throw err;
  }

  // BinderByte balikin field "status": 200 di body buat sukses, selain itu berarti gagal
  // (resi belum ketemu, kurir gak didukung, api key salah/kuota habis, dll). Kita sertakan
  // juga HTTP status code aslinya di pesan error -- kalau body-nya JSON tapi HTTP-nya
  // 401/403/429/500, itu clue penting (auth/rate-limit/server error) yang sebelumnya ketutup.
  if (!json || json.status !== 200) {
    const err = new Error(`BinderByte error (HTTP ${res.status}): ` + (json?.message || 'unknown, status field: ' + json?.status));
    err.userMessage = json?.message
      ? `Belum bisa cek status: ${json.message}`
      : `Belum bisa cek status resi ini (HTTP ${res.status}, mungkin belum ada update dari kurir, nomor resi belum terdaftar, atau kuota/rate-limit habis).`;
    throw err;
  }

  const summary = json.data?.summary || {};
  const history = Array.isArray(json.data?.history) ? json.data.history : [];
  const internalStatus = mapToInternalStatus(summary.status, history, summary.desc);

  return {
    courierCode,
    rawStatus: summary.status || '',
    statusText: summary.desc || summary.status || '',
    internalStatus, // null kalau gak bisa dipetakan -> jangan timpa status_resi yang ada
    history: history.slice(0, 10).map((h) => ({
      date: h.date || '',
      desc: h.desc || '',
      location: h.location || '',
    })),
  };
}

module.exports = { trackResi, detectCourierCode, buildTrackingLink, isInstantCourier };
