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

// Kode SKU dieja supaya TTS gak salah baca: huruf satu-satu, angka dibaca utuh.
// "SP30S" -> "S P 30 S"
function spellSku(code) {
  return String(code).replace(/[^A-Za-z0-9]+/g, ' ').trim()
    .replace(/([A-Za-z])(?=[A-Za-z])/g, '$1 ')
    .replace(/([A-Za-z])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[A-Za-z])/g, '$1 ');
}

// Mengembalikan { text, speech, total_pcs, items } atau null kalau pesanan gak punya info jumlah.
// Satu SKU : "Pesanannya 50 pcs ya, SP30S"
// 2-3 SKU  : "Pesanannya 20 pcs SP30S dan 1 paket 50 pcs SP24 ya"
// 4+ SKU   : "Pesanannya 3 jenis barang, total 23 pcs ya" (rincian tampil di layar)
function buildScanSpeech(order) {
  let lines = parseLines(order);
  if (lines.length === 0) {
    const j = parseInt(String(order.jumlah || '').trim(), 10);
    if (j > 0) lines = [{ sku: '', qty: j, packSize: null }];
  }
  if (lines.length === 0) return null;

  const items = lines.map((l) => {
    const code = l.packSize ? l.sku.replace(PKT_RE, '') : l.sku;
    const qtyText = l.packSize ? `${l.qty} paket ${l.packSize} pcs` : `${l.qty} pcs`;
    const qtySpeech = l.packSize ? `${l.qty} paket ${l.packSize} pis` : `${l.qty} pis`;
    return { code, qtyText, qtySpeech, pcs: l.packSize ? l.qty * l.packSize : l.qty };
  });
  const totalPcs = items.reduce((s, i) => s + i.pcs, 0);

  if (items.length === 1) {
    const it = items[0];
    return {
      text: `Pesanannya ${it.qtyText} ya${it.code ? `, ${it.code}` : ''}`,
      speech: `Pesanannya ${it.qtySpeech} ya${it.code ? `, ${spellSku(it.code)}` : ''}`,
      total_pcs: totalPcs,
      items,
    };
  }
  // Lebih dari 3 jenis barang: ringkas aja biar gak jadi pidato, rinciannya ada di layar.
  if (items.length > 3) {
    return {
      text: `Pesanannya ${items.length} jenis barang, total ${totalPcs} pcs ya`,
      speech: `Pesanannya ${items.length} jenis barang, total ${totalPcs} pis ya`,
      total_pcs: totalPcs,
      items,
    };
  }
  return {
    text: `Pesanannya ${items.map((i) => `${i.qtyText} ${i.code}`.trim()).join(' dan ')} ya`,
    speech: `Pesanannya ${items.map((i) => `${i.qtySpeech} ${spellSku(i.code)}`.trim()).join(' dan ')} ya`,
    total_pcs: totalPcs,
    items,
  };
}

module.exports = { buildScanSpeech };
