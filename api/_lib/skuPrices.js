// Harga per SKU buat ESTIMASI PENGHASILAN pesanan Advance Fulfilment / advance shipment
// (pesanan yang di database harganya "-" karena resi PDF gak punya info harga).
//
// Pesanan biasa (hasil import Excel / input manual yang ada harganya) TIDAK pakai tabel ini --
// estimasinya diambil dari kolom "Total Jumlah Pesanan" (subtotal_pesanan) apa adanya.
//
// Cara ubah harga / nambah SKU baru: edit tabel di bawah, simpan, deploy ulang
// (atau atur lewat menu Konfigurasi Harga, itu menang atas tabel ini).
const cleanSkuLocal = (v) => String(v ?? '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, '').toUpperCase();

// Potongan (%) dari harga SKU buat dapetin ESTIMASI PENGHASILAN advance shipment.
// Ini cuma nilai bawaan -- di tab Estimasi Penghasilan ada kolom buat ngubahnya.
const AF_DEFAULT_POTONGAN_PERSEN = 26;

// ---------------------------------------------------------------------------------------------
// SKU PAKET "PKT{n}-{KODE}" -> OTOMATIS DI-SPLIT
//   PKT100-SP35M x2  ==  SP35M x200 pcs   (n = isi per paket, dikali qty paket)
//   PKT12-SP24, PKT20-SP24, PKT50-SP29S, dst: semua angka n berlaku, gak perlu didaftarin satu-satu.
// ---------------------------------------------------------------------------------------------
const PKT_RE = /^PKT(\d+)-(.+)$/i;

// "PKT100-SP35M" -> { perPack: 100, base: "SP35M" }; bukan paket -> null.
function splitBundleSku(sku) {
  const m = PKT_RE.exec(cleanSkuLocal(sku));
  if (!m) return null;
  const perPack = parseInt(m[1], 10);
  if (!perPack || perPack < 1 || !m[2]) return null;
  return { perPack, base: m[2] };
}

// Harga satuan (per 1 pcs) dari price list "Harga Normal". HANYA ACUAN, bukan patokan inti:
// harga yang diatur di menu Konfigurasi / SKU_PRICE_EXACT selalu menang.
const UNIT_PRICES = {
  'SP1': 3388,
  'SP2': 3388,
  'SP3M': 2720,
  'SP3L': 3670,
  'SP4': 3388,
  'SP5': 3388,
  'SP6M': 2850,
  'SP6L': 3850,
  'SP7': 3388,
  'SP8': 3388,
  'SP9': 3388,
  'SP10M': 2720,
  'SP10L': 3670,
  'SP11': 3388,
  'SP12': 3388,
  'SP13': 3094,
  'SP15M': 2720,
  'SP15L': 3670,
  'SP16': 3388,
  'SP17': 3388,
  'SP18': 3388,
  'SP19': 3388,
  'SP20M': 2720,
  'SP20L': 3670,
  'SP21': 3388,
  'SP22': 3388,
  'SP23': 3388,
  'SP24': 4699,
  'SP25': 3994,
  'SP26': 3594,
  'SP27': 3594,
  'SP28': 3594,
  'SP29S': 2520,
  'SP29M': 2720,
  'SP29L': 3670,
  'SP29XL': 3870,
  'SP30S': 3290,
  'SP30M': 3499,
  'SP30L': 4690,
  'SP30XL': 5690,
  'SP31': 5094,
  'SP32': 5094,
  'SP33': 5094,
  'SP34S': 2520,
  'SP34M': 2720,
  'SP34L': 3670,
  'SP34XL': 3870,
  'SP35S': 2520,
  'SP35M': 2720,
  'SP35L': 3670,
  'SP35XL': 3870,
  'SP36S': 2720,
  'SP36M': 3670,
  'SP37S': 2520,
  'SP37M': 2720,
  'SP37L': 3670,
  'SP38S': 2520,
  'SP38M': 2720,
  'SP39S': 2520,
  'SP39M': 2720,
  'SP40S': 2520,
  'SP40M': 2720,
  'SP40L': 3870,
  'SP41': 2720,
  'SP42': 5094,
  'SP43': 2720,
  'SP44': 2720,
  'SP45': 2720,
  'SP46': 2720,
  'SP47': 2999,
  'SP48': 2999,
  'SP49S': 2520,
  'SP49M': 2720,
  'SP50': 3994,
  'SP51': 4699,
  'SP52': 3994,
  'SP53S': 2520,
  'SP53M': 2720,
  'SP54': 3094,
  'SP55': 3094,
  'SP56': 2999,
  'SP57': 3094,
  'SP58': 4699,
  'SP59': 3094,
  'SP60': 4294,
  'SP61': 5094,
  'SP62': 5094,
  'SP63S': 2520,
  'SP63M': 2720,
  'SP63L': 3670,
  'SP64S': 2520,
  'SP64M': 2720,
  'SP64L': 3670,
  'SP65': 3994,
  'SP66': 3994,
  'SP67': 4699,
  'SP68': 4699,
  'SP69': 4699,
  'SP70': 4394,
  'SP71': 4394,
  'SP72': 4394,
  'SP73': 4394,
  'SPH5': 4394,
  'SP75M': 2999,
  'SP75L': 3999,
  'SP76M': 4094,
  'SP76L': 4094,
  'SP77L': 4094,
  'SP78M': 2994,
  'SP79M': 2720,
  'SP79L': 3670,
  'SP80M': 2720,
  'SP81M': 2994,
  'SP82M': 2994,
  'SP83M': 2720,
  'SP83L': 3670,
  'SP84M': 2994,
  'SP84L': 3994,
  'SP90S': 2650,
  'SP90M': 2850,
  'SP91M': 2894,
  'SP92M': 2894,
  'SP93M': 2894,
  'NC3': 3094,
  'NC4': 3094,
  'NC5': 3094,
  'PB1S': 6999,
  'PB2S': 6999,
  'PB3S': 6999,
  'PB4S': 6999,
  'PB5S': 6999,
  'PB6S': 6999,
  'PB7S': 6999,
  'PB8S': 6999,
  'PB9S': 6999,
  'PB10S': 6999,
  'PB11S': 6999,
  'PB12S': 6999,
  'PB13S': 6999,
  'PB14S': 6999,
  'PB15S': 6999,
  'PB16S': 6999,
  'PB17S': 6999,
  'PB18S': 6999,
  'PB1M': 7999,
  'PB2M': 7999,
  'PB3M': 7999,
  'PB4M': 7999,
  'PB5M': 7999,
  'PB6M': 7999,
  'PB7M': 7999,
  'PB8M': 7999,
  'PB9M': 7999,
  'PB10M': 7999,
  'PB11M': 7999,
  'PB12M': 7999,
  'PB13M': 7999,
  'PB14M': 7999,
  'PB15M': 7999,
  'PB16M': 7999,
  'PB17M': 7999,
  'PB18M': 7999,
  'PB19': 10994,
  'PB20': 10994,
  'PB21': 10994,
  'PB22': 10994,
  'PB23': 10994,
  'PB24': 2299,
  'IF1S': 7099,
  'IF1M': 8099,
  'IF2S': 7099,
  'IF2M': 8099,
  'NPBS': 5899,
  'NPBM': 8899,
  'NPBL': 11899,
  'CB-S': 3899,
  'CB-M': 4099,
  'CB-L': 4399,
  'CB-XL': 4999,
  'HBS': 2994,
  'HBM': 4694,
};

// Harga persis per SKU (menang duluan dibanding acuan price list). Harga ini per 1 SKU apa adanya,
// jadi untuk paket = harga 1 paket (dikali qty paket di pesanan).
const SKU_PRICE_EXACT = {};

// Cadangan lama: paket 50 yang motifnya BELUM ada di price list dihargai berdasarkan UKURAN
// di ujung kode (S / M / L / XL). Cuma dipakai kalau acuan price list gak ketemu.
const PKT50_PRICE_BY_SIZE = { S: 126000, M: 136000, L: 183500, XL: 193500 };
const PKT50_RE = /^PKT50-.*?(XL|S|M|L)$/; // lazy supaya "...XL" kebaca XL, bukan L

// Harga acuan 1 pcs untuk SKU satuan (tanpa PKT), atau null kalau gak ada di price list.
// getOverride (opsional): fungsi SKU -> harga dari menu Konfigurasi, dicek duluan.
function unitPrice(sku, getOverride) {
  const key = cleanSkuLocal(sku);
  if (!key) return null;
  if (getOverride) {
    const o = getOverride(key);
    if (o !== null && o !== undefined) return o;
  }
  if (Object.prototype.hasOwnProperty.call(SKU_PRICE_EXACT, key)) return SKU_PRICE_EXACT[key];
  if (Object.prototype.hasOwnProperty.call(UNIT_PRICES, key)) return UNIT_PRICES[key];
  return null;
}

// Nilai 1 baris SKU "sku x qty" (qty = jumlah SKU persis seperti ditulis di pesanan).
// -> { total, perUnit, pcs, acuan, base, perPack } atau null kalau harganya gak ketemu.
//   - Paket PKTn-KODE: pcs = qty * n, dipecah jadi KODE x pcs.
//   - acuan = true kalau harganya dari price list (satuan x pcs), bukan harga yang dipatok manual.
// Urutan: (1) harga persis SKU paket (Konfigurasi / SKU_PRICE_EXACT)
//         (2) harga satuan KODE x n (Konfigurasi KODE dulu, baru price list)  -> ACUAN
//         (3) cadangan PKT50 per ukuran                                       -> ACUAN
function lineValue(sku, qty, getOverride) {
  const key = cleanSkuLocal(sku);
  const bundle = splitBundleSku(key);
  const packs = Number(qty) || 0;
  if (!bundle) {
    const p = unitPrice(key, getOverride);
    if (p === null) return null;
    const fromList = !(getOverride && getOverride(key) != null) && !Object.prototype.hasOwnProperty.call(SKU_PRICE_EXACT, key);
    return { total: p * packs, perUnit: p, pcs: packs, acuan: fromList, base: key, perPack: 1 };
  }
  const pcs = packs * bundle.perPack;
  // (1) harga paket yang dipatok manual
  let packPrice = null;
  if (getOverride) {
    const o = getOverride(key);
    if (o !== null && o !== undefined) packPrice = o;
  }
  if (packPrice === null && Object.prototype.hasOwnProperty.call(SKU_PRICE_EXACT, key)) packPrice = SKU_PRICE_EXACT[key];
  if (packPrice !== null) {
    return { total: packPrice * packs, perUnit: packPrice / bundle.perPack, pcs, acuan: false, base: bundle.base, perPack: bundle.perPack };
  }
  // (2) acuan: harga satuan KODE x isi paket
  const u = unitPrice(bundle.base, getOverride);
  if (u !== null) {
    return { total: u * pcs, perUnit: u, pcs, acuan: true, base: bundle.base, perPack: bundle.perPack };
  }
  // (3) cadangan lama PKT50 per ukuran
  const m = PKT50_RE.exec(key);
  if (m) {
    const pp = PKT50_PRICE_BY_SIZE[m[1]];
    return { total: pp * packs, perUnit: pp / bundle.perPack, pcs, acuan: true, base: bundle.base, perPack: bundle.perPack };
  }
  return null;
}

// Balikin harga SATU SKU (untuk paket = harga 1 paket), atau null kalau belum ada. Dipertahankan
// buat kode lama; yang baru sebaiknya pakai lineValue().
function priceForSku(sku, getOverride) {
  const v = lineValue(sku, 1, getOverride);
  return v ? Math.round(v.total) : null;
}

module.exports = {
  AF_DEFAULT_POTONGAN_PERSEN, priceForSku, lineValue, unitPrice, splitBundleSku,
  SKU_PRICE_EXACT, PKT50_PRICE_BY_SIZE, UNIT_PRICES,
};
