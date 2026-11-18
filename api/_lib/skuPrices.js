// Harga per SKU buat ESTIMASI PENGHASILAN pesanan Advance Fulfilment / advance shipment
// (pesanan yang di database harganya "-" karena resi PDF gak punya info harga).
//
// Pesanan biasa (hasil import Excel / input manual yang ada harganya) TIDAK pakai tabel ini --
// estimasinya diambil dari kolom "Total Jumlah Pesanan" (subtotal_pesanan) apa adanya.
//
// Cara ubah harga / nambah SKU baru: edit tabel di bawah, simpan, deploy ulang.
const cleanSkuLocal = (v) => String(v ?? '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, '').toUpperCase();

// Potongan (%) dari harga SKU buat dapetin ESTIMASI PENGHASILAN advance shipment.
// Ini cuma nilai bawaan -- di tab Estimasi Penghasilan ada kolom buat ngubahnya.
const AF_DEFAULT_POTONGAN_PERSEN = 26;

// 1) Harga persis per SKU (menang duluan dibanding aturan ukuran di bawah).
const SKU_PRICE_EXACT = {
  'PKT50-SP29S': 126000,
  'PKT50-SP29M': 136000,
  'PKT50-SP29L': 183500,
  'PKT50-SP29XL': 193500,
};

// 2) Aturan paket 50: SEMUA SKU berawalan "PKT50-" dihargai berdasarkan UKURAN di ujung kode
//    (S / M / L / XL), apa pun motifnya -- jadi PKT50-SP35M otomatis 136.000 juga.
const PKT50_PRICE_BY_SIZE = { S: 126000, M: 136000, L: 183500, XL: 193500 };
const PKT50_RE = /^PKT50-.*?(XL|S|M|L)$/; // lazy supaya "...XL" kebaca XL, bukan L

// Balikin harga satuan SKU, atau null kalau SKU belum ada di tabel.
function priceForSku(sku) {
  const key = cleanSkuLocal(sku);
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(SKU_PRICE_EXACT, key)) return SKU_PRICE_EXACT[key];
  const m = PKT50_RE.exec(key);
  if (m) return PKT50_PRICE_BY_SIZE[m[1]];
  return null;
}

module.exports = { AF_DEFAULT_POTONGAN_PERSEN, priceForSku, SKU_PRICE_EXACT, PKT50_PRICE_BY_SIZE };
