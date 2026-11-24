// Integrasi cek resi otomatis (real-time) ke ekspedisi, pakai BinderByte API
// (https://docs.binderbyte.com/api/cek-resi) sebagai perantara ke banyak ekspedisi
// sekaligus (JNE, J&T, SiCepat, dll) dalam satu API key. Berbayar per-hit, daftar &
// ambil API key di https://binderbyte.com/, lalu isi BINDERBYTE_API_KEY di environment.
//
// SPX (Shopee Xpress) dicek LANGSUNG ke endpoint publik spx.co.id (lihat trackSpxDirect di bawah),
// tanpa BinderByte. BinderByte tetap dipakai buat kurir lain, dan jadi cadangan SPX kalau
// jalur langsung gagal. Tes dengan resi asli: node scripts/test-spx.js <no_resi>

const BINDERBYTE_BASE_URL = 'https://api.binderbyte.com/v1/track';
// Circuit breaker: kalau BinderByte nolak karena saldo/kuota/API key, jangan dipanggil lagi
// selama BB_COOLDOWN_MS (berlaku per instance function yang masih hangat).
const BB_COOLDOWN_MS = Number(process.env.BINDERBYTE_COOLDOWN_MS || 30 * 60 * 1000);
let bbBlockedUntil = 0;
function isBinderByteAvailable() {
  return !!process.env.BINDERBYTE_API_KEY && Date.now() >= bbBlockedUntil;
}

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
// (lihat pemakaiannya di api/_lib/routes/packing.js saat scan tim packing).
//
// Bypass ini CUMA jalan pas discan packing, BUKAN pas import/Input Manual -- pesanan
// instant/sameday tetap masuk sebagai "belum_packing" seperti pesanan biasa begitu
// diimport, dan baru lompat ke "sudah dikirim" begitu beneran discan tim packing. Flow-nya
// tetap sama seperti kurir reguler, cuma pas discan langsung "sudah packing" DAN "sudah
// dikirim" sekaligus (bukan cuma "sudah packing").
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


// ---------- SPX (Shopee Xpress) langsung ke endpoint publik tracking spx.co.id ----------
// Halaman https://spx.co.id/track memanggil endpoint JSON ini di belakang layar. Pakai ini
// artinya SPX gak perlu BinderByte (gratis, gak per-hit). Kalau gagal (diblokir, format
// berubah, timeout), trackResi() otomatis jatuh ke BinderByte kalau API key-nya ada.
//
// Env opsional:
//   SPX_TRACKING_URL   -> ganti base endpoint (default di bawah)
//   SPX_COOKIE         -> cookie browser kalau SPX mulai minta sesi (jarang perlu; JANGAN di-log)
//   SPX_DIRECT_DISABLE -> isi "1" buat matiin jalur langsung & paksa lewat BinderByte
const SPX_TRACKING_URL = process.env.SPX_TRACKING_URL || 'https://spx.co.id/api/v2/fleet_order/tracking/search';
const SPX_TIMEOUT_MS = Number(process.env.SPX_TIMEOUT_MS || 12000);

function spxFormatDate(ts) {
  const n = Number(ts);
  if (!n) return '';
  const ms = n < 1e12 ? n * 1000 : n; // SPX pakai detik; jaga-jaga kalau milidetik
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  // Format "YYYY-MM-DD HH:mm" di zona WIB, biar konsisten sama riwayat dari BinderByte.
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return parts.replace(',', '');
}

// Ubah JSON mentah SPX jadi bentuk yang sama dengan hasil BinderByte. Sengaja longgar soal
// nama field, karena SPX kadang menamai ulang field di versi baru.
function parseSpxResponse(json) {
  const data = json && json.data;
  const list = data && (data.tracking_list || data.trackingList || data.tracking || data.list);
  if (!Array.isArray(list) || list.length === 0) return null;

  const events = list.map((it) => {
    const loc = it.current_location || it.location || {};
    return {
      ts: Number(it.timestamp || it.update_time || it.time || 0),
      desc: String(it.message || it.buyer_description || it.description || it.seller_description || it.status || '').trim(),
      status: String(it.status || it.milestone_name || it.milestone_code || '').trim(),
      location: typeof loc === 'string' ? loc : String(loc.location_name || loc.name || loc.full_address || '').trim(),
    };
  }).filter((e) => e.desc || e.status);

  if (!events.length) return null;
  events.sort((a, b) => b.ts - a.ts); // terbaru di index 0, sama seperti BinderByte
  const history = events.map((e) => ({ date: spxFormatDate(e.ts), desc: e.desc || e.status, location: e.location }));
  const latest = events[0];
  return {
    rawStatus: latest.status || latest.desc,
    statusText: latest.desc || latest.status,
    history,
  };
}

// ---------- SPX v2: endpoint yang dipakai halaman spx.co.id/track sejak 2026 ----------
// Respons: data.sls_tracking_info.records[] (terbaru di index 0), tiap record punya
// milestone_code resmi SPX: 1 = Preparing to ship (belum diserahkan), 5 = In transit,
// 8 = Delivered. Jauh lebih pasti dibanding menebak dari teks deskripsi.
const SPX_ORDER_INFO_URL = process.env.SPX_ORDER_INFO_URL || 'https://spx.co.id/shipment/order/open/order/get_order_info';
const SPX_MILESTONE_PREPARING = 1;
const SPX_MILESTONE_DELIVERED = 8;

function parseSpxOrderInfo(json) {
  const records = json && json.data && json.data.sls_tracking_info && json.data.sls_tracking_info.records;
  if (!Array.isArray(records) || records.length === 0) return null;
  const events = records
    .filter((r) => r && (r.display_flag === undefined || r.display_flag === 1 || r.display_flag_v2 === 1))
    .map((r) => {
      const loc = r.current_location || {};
      return {
        ts: Number(r.actual_time || 0),
        desc: String(r.buyer_description || r.description || r.tracking_name || '').trim(),
        code: String(r.tracking_code || ''),
        name: String(r.tracking_name || ''),
        milestone: Number(r.milestone_code || 0),
        milestoneName: String(r.milestone_name || ''),
        location: typeof loc === 'string' ? loc : String(loc.location_name || '').trim(),
      };
    });
  if (!events.length) return null;
  events.sort((a, b) => b.ts - a.ts);
  const latest = events[0];
  const maxMilestone = Math.max(...events.map((e) => e.milestone));
  let internalStatus = null;
  if (maxMilestone >= SPX_MILESTONE_DELIVERED && latest.milestone >= SPX_MILESTONE_DELIVERED) internalStatus = 'diterima';
  else if (maxMilestone > SPX_MILESTONE_PREPARING) internalStatus = 'dikirim';
  else if (!maxMilestone) internalStatus = mapToInternalStatus(latest.name, [{ desc: latest.desc }], latest.desc); // field milestone hilang -> tebak dari teks
  return {
    rawStatus: latest.milestoneName || latest.name,
    statusText: latest.desc || latest.name,
    internalStatus,
    history: events.map((e) => ({ date: spxFormatDate(e.ts), desc: e.desc || e.name, location: e.location })),
  };
}

async function spxGetJson(url, opts) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    Referer: 'https://spx.co.id/track',
  };
  if (process.env.SPX_COOKIE) headers.Cookie = process.env.SPX_COOKIE;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || SPX_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(url, { headers, signal: ctrl && ctrl.signal });
  } catch (e) {
    const err = new Error('Gagal menghubungi SPX: ' + (e && e.name === 'AbortError' ? 'timeout' : e.message));
    err.userMessage = 'Gagal menghubungi SPX (jaringan/timeout). Coba lagi sebentar.';
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const rawText = await res.text();
  let json;
  try { json = JSON.parse(rawText); } catch (e) {
    const err = new Error(`SPX balikin non-JSON (HTTP ${res.status}): ${rawText.slice(0, 160).replace(/\s+/g, ' ').trim()}`);
    err.userMessage = `SPX balikin halaman aneh (HTTP ${res.status}), kemungkinan request diblokir.`;
    throw err;
  }
  if (!res.ok || (json.retcode !== undefined && json.retcode !== 0)) {
    const err = new Error(`SPX error (HTTP ${res.status}, retcode ${json.retcode}): ${json.message || json.msg || '-'}`);
    err.userMessage = `SPX belum bisa cek resi ini: ${json.message || json.msg || 'resi belum terdaftar / belum ada update'}.`;
    throw err;
  }
  return json;
}

async function trackSpxDirect(noResi, opts = {}) {
  // 1) Endpoint baru (v2) -- status dari milestone resmi SPX.
  let v2Error;
  try {
    const json = await spxGetJson(`${SPX_ORDER_INFO_URL}?spx_tn=${encodeURIComponent(noResi)}&language_code=id`, opts);
    const parsed = parseSpxOrderInfo(json);
    if (parsed) {
      return {
        courierCode: 'spx', rawStatus: parsed.rawStatus, statusText: parsed.statusText,
        internalStatus: parsed.internalStatus, history: parsed.history.slice(0, 10), source: 'spx-direct-v2',
      };
    }
    v2Error = new Error('SPX v2: resi belum punya riwayat perjalanan');
  } catch (e) {
    v2Error = e;
  }

  // 2) Endpoint lama sebagai cadangan.
  try {
    return await trackSpxLegacy(noResi, opts);
  } catch (e) {
    throw v2Error; // error v2 lebih relevan karena itu endpoint utama sekarang
  }
}

async function trackSpxLegacy(noResi, opts = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    Referer: 'https://spx.co.id/',
    Origin: 'https://spx.co.id',
  };
  if (process.env.SPX_COOKIE) headers.Cookie = process.env.SPX_COOKIE;

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || SPX_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${SPX_TRACKING_URL}?sls_tracking_number=${encodeURIComponent(noResi)}`, { headers, signal: ctrl && ctrl.signal });
  } catch (e) {
    const err = new Error('Gagal menghubungi SPX: ' + (e && e.name === 'AbortError' ? 'timeout' : e.message));
    err.userMessage = 'Gagal menghubungi SPX (jaringan/timeout). Coba lagi sebentar.';
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const rawText = await res.text();
  let json;
  try { json = JSON.parse(rawText); } catch (e) {
    const snippet = rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const err = new Error(`SPX balikin non-JSON (HTTP ${res.status}): ${snippet}`);
    err.userMessage = `SPX balikin halaman aneh (HTTP ${res.status}), kemungkinan request diblokir.`;
    throw err;
  }
  if (!res.ok || (json.retcode !== undefined && json.retcode !== 0)) {
    const err = new Error(`SPX error (HTTP ${res.status}, retcode ${json.retcode}): ${json.message || json.msg || '-'}`);
    err.userMessage = `SPX belum bisa cek resi ini: ${json.message || json.msg || 'resi belum terdaftar / belum ada update'}.`;
    throw err;
  }
  const parsed = parseSpxResponse(json);
  if (!parsed) {
    const err = new Error('SPX: resi ketemu tapi belum ada riwayat perjalanan (atau format respons berubah)');
    err.userMessage = 'Belum ada riwayat perjalanan untuk resi SPX ini.';
    throw err;
  }
  return {
    courierCode: 'spx',
    rawStatus: parsed.rawStatus,
    statusText: parsed.statusText,
    internalStatus: mapToInternalStatus(parsed.rawStatus, parsed.history, parsed.statusText),
    history: parsed.history.slice(0, 10),
    source: 'spx-direct',
  };
}

// ======================= Rantai provider: GRATIS dulu, baru BERBAYAR =======================
// trackResi() mencoba provider sesuai urutan di bawah. Provider gratis (endpoint publik milik
// kurirnya sendiri) selalu duluan; BinderByte (berbayar per-hit) cuma dipakai kalau semua
// provider gratis untuk kurir itu gagal / gak ada. Mau nambah provider gratis baru (misal
// kurir lain yang punya endpoint tracking publik)? Tambah satu entri di FREE_PROVIDERS:
//   { name, couriers: ['kode'], enabled: () => bool, track: (noResi, { timeoutMs }) => hasil }
// Hasil track wajib berbentuk sama dengan trackSpxDirect: { courierCode, rawStatus, statusText,
// internalStatus, history, source }.
const FREE_PROVIDERS = [
  { name: 'spx-direct', couriers: ['spx'], enabled: () => process.env.SPX_DIRECT_DISABLE !== '1', track: trackSpxDirect },
];

function freeProvidersFor(courierCode) {
  return FREE_PROVIDERS.filter((p) => p.couriers.includes(courierCode) && p.enabled());
}

// Lempar Error dengan .userMessage buat pesan yang aman ditampilkan ke user.
async function trackResi({ noResi: rawNoResi, opsiPengiriman, timeoutMs }) {
  const noResi = String(rawNoResi || '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, ''); // resi legacy yang kotor tetap bisa dilacak

  const courierCode = detectCourierCode(opsiPengiriman);
  if (!courierCode) {
    const err = new Error(`Kurir tidak dikenali dari opsi pengiriman: "${opsiPengiriman}"`);
    err.userMessage = `Kurir "${opsiPengiriman || '-'}" belum kekenal sama sistem, jadi belum bisa dicek otomatis. Update status resi manual dulu ya.`;
    throw err;
  }

  // 1) Provider gratis.
  let freeError = null;
  for (const p of freeProvidersFor(courierCode)) {
    try {
      const result = await p.track(noResi, { timeoutMs });
      return { ...result, source: result.source || p.name };
    } catch (e) {
      console.warn(`[${p.name}] gagal:`, e.message);
      if (!freeError) { e.message = `[${courierCode}/${p.name}] ` + e.message; freeError = e; }
    }
  }

  // 2) Cadangan berbayar. Kalau gak tersedia, kembalikan error provider gratis (lebih informatif).
  if (!isBinderByteAvailable() && freeError) throw freeError;
  return trackBinderByte(noResi, courierCode, timeoutMs);
}

async function trackBinderByte(noResi, courierCode, timeoutMs) {
  const apiKey = process.env.BINDERBYTE_API_KEY;
  if (apiKey && Date.now() < bbBlockedUntil) {
    const err = new Error(`[${courierCode}] BinderByte diistirahatkan (saldo/kuota habis atau API key ditolak)`);
    err.userMessage = 'Layanan cek resi BinderByte sedang tidak bisa dipakai (saldo/kuota habis). Top up di binderbyte.com atau cek manual lewat tombol Lacak.';
    throw err;
  }

  if (!apiKey) {
    const err = new Error('BINDERBYTE_API_KEY belum di-set di environment variables');
    err.userMessage = 'Fitur cek status otomatis belum di-setup. Tambahkan BINDERBYTE_API_KEY di Environment Variables (daftar & ambil key di binderbyte.com), lalu deploy ulang.';
    throw err;
  }

  const url = `${BINDERBYTE_BASE_URL}?api_key=${encodeURIComponent(apiKey)}&courier=${encodeURIComponent(courierCode)}&awb=${encodeURIComponent(noResi)}`;

  let res;
  try {
    // User-Agent eksplisit -- beberapa WAF/CDN nge-block request tanpa UA yang jelas,
    // apalagi kalau datengnya burst (banyak request bersamaan dari IP yang sama).
    const bbCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const bbTimer = bbCtrl ? setTimeout(() => bbCtrl.abort(), Number(timeoutMs) || 15000) : null;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'packingsistem-cron/1.0 (+refresh-resi)' }, signal: bbCtrl && bbCtrl.signal });
    } finally {
      if (bbTimer) clearTimeout(bbTimer);
    }
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
    // Saldo/kuota habis atau API key salah -> istirahatkan BinderByte sebentar, biar sync
    // berikutnya gak buang waktu nembak ulang (dan antrian fokus ke kurir gratis seperti SPX).
    if (res.status === 401 || res.status === 402 || res.status === 403 || /credit|kredit|kuota|quota|saldo|limit|topup|api.?key/i.test(String(json?.message || ''))) {
      bbBlockedUntil = Date.now() + BB_COOLDOWN_MS;
    }
    const err = new Error(`[${courierCode}] BinderByte error (HTTP ${res.status}): ` + (json?.message || 'unknown, status field: ' + json?.status));
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
    source: 'binderbyte',
  };
}

// Kurir yang punya provider GRATIS (lihat FREE_PROVIDERS). Buat kurir ini sistem terus memantau
// sampai paket DITERIMA (bukan cuma sampai pickup), karena gak ada biaya per-hit.
function isFreeDirectCourier(opsiPengiriman) {
  return freeProvidersFor(detectCourierCode(opsiPengiriman)).length > 0;
}

module.exports = { trackResi, detectCourierCode, buildTrackingLink, isInstantCourier, isFreeDirectCourier, isBinderByteAvailable, parseSpxResponse, parseSpxOrderInfo, trackSpxDirect };
