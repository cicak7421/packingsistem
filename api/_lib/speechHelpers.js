// Menyusun kalimat suara untuk layar Scan Packing, dibaca di browser lewat speechSynthesis
// (jadi gak perlu rekaman 1-1000 pcs: angka berapa pun dibacakan otomatis).
//
// Format kolom orders.sku: "SP30S x20, SP74 x3" atau "SP30S" (+ orders.jumlah).
// SKU berawalan PKTxx- (contoh PKT50-SP24) = SKU paket isi xx pcs, dibacakan sebagai paket.
const PKT_RE = /^PKT(\d+)-/i;

function parseLines(order) {
  const raw = String(order.sku || '').trim();
  if (!raw) return [];
  const fallbackQty = parseInt(String(order.jumlah || '').trim(), 10) || 1;
  return raw.split(',').map((p) => p.trim()).filter(Boolean).map((part) => {
    const m = /^(.*?)\s*[xX×]\s*(\d+)$/.exec(part);
    const sku = m ? m[1].trim() : part;
    const qty = m ? (parseInt(m[2], 10) || 1) : fallbackQty;
    const pk = PKT_RE.exec(sku);
    return { sku, qty, packSize: pk ? parseInt(pk[1], 10) : null };
  });
}

// Mengembalikan { text, speech, total_pcs, singles_pcs, packs: [{size, qty}] } atau null
// kalau pesanan gak punya info jumlah sama sekali.
function buildScanSpeech(order) {
  const lines = parseLines(order);
  let singles = 0;
  const packMap = new Map(); // ukuran paket -> jumlah paket
  for (const l of lines) {
    if (l.packSize) packMap.set(l.packSize, (packMap.get(l.packSize) || 0) + l.qty);
    else singles += l.qty;
  }
  // SKU kosong tapi kolom jumlah ada
  if (lines.length === 0) {
    const j = parseInt(String(order.jumlah || '').trim(), 10);
    if (j > 0) singles = j;
  }
  const packs = [...packMap.entries()].map(([size, qty]) => ({ size, qty }));
  if (singles === 0 && packs.length === 0) return null;

  const parts = [];
  const spoken = [];
  if (singles > 0) { parts.push(`${singles} pcs`); spoken.push(`${singles} pis`); }
  for (const p of packs) {
    parts.push(`${p.qty} paket ${p.size}`);
    spoken.push(`${p.qty} paket ${p.size}`);
  }
  const totalPcs = singles + packs.reduce((s, p) => s + p.qty * p.size, 0);
  return {
    text: `Pesanannya ${parts.join(' dan ')} ya`,
    speech: `Pesanannya ${spoken.join(' dan ')} ya`,
    total_pcs: totalPcs,
    singles_pcs: singles,
    packs,
  };
}

module.exports = { buildScanSpeech };
