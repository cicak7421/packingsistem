// Pembersih kode SKU supaya typo spasi / baris baru tidak merusak voice & stok.
//   "PKT50- SP29S"   -> "PKT50-SP29S"
//   "PKT50-\nSP29S"  -> "PKT50-SP29S"
//   "PKT50 -SP29S"   -> "PKT50-SP29S"
// Semua whitespace (spasi, tab, enter, non-breaking space, zero-width) dibuang.
// Huruf besar/kecil TIDAK diubah di sini (pencocokan ke database tetap case-insensitive).
function cleanSku(value) {
  return String(value ?? '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, '');
}

// Memecah satu potongan "SKU xQty" jadi { sku, qty }. qty = null kalau tidak ada "xN".
// Pakai [\s\S] (bukan .) supaya SKU yang patah baris tetap terbaca utuh.
function splitSkuQty(part) {
  const text = String(part ?? '').trim();
  const m = /^([\s\S]*?)\s*[xX×]\s*(\d+)$/.exec(text);
  if (m && cleanSku(m[1])) return { sku: cleanSku(m[1]), qty: parseInt(m[2], 10) || 1 };
  return { sku: cleanSku(text), qty: null };
}

module.exports = { cleanSku, splitSkuQty };
