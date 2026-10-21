// Menyusun kalimat suara untuk layar Scan Packing, dibaca di browser lewat speechSynthesis
// (jadi gak perlu rekaman 1-1000 pcs: angka berapa pun dibacakan otomatis).
//
// Format kolom orders.sku: "SP30S x20, SP74 x3" atau "SP30S" (+ orders.jumlah).
// SKU berawalan PKTxx- (contoh PKT50-SP24) = SKU paket isi xx pcs, dibacakan sebagai paket.
const { splitSkuQty } = require('./skuHelpers');
const PKT_RE = /^PKT(\d+)-/i;

function parseLines(order) {
  const raw = String(order.sku || '').trim();
  if (!raw) return [];
  const fallbackQty = parseInt(String(order.jumlah || '').trim(), 10) || 1;
  return raw.split(',').map((p) => p.trim()).filter(Boolean).map((part) => {
    // SKU dibersihkan dari spasi/enter nyasar (mis. "PKT50- SP29S" -> "PKT50-SP29S")
    const parsed = splitSkuQty(part);
    const sku = parsed.sku;
    const qty = parsed.qty !== null ? parsed.qty : fallbackQty;
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


// ---------- Susunan klip suara (rekaman potongan di /sounds/voice/*.mp3) ----------
// Selain teks buat TTS, tiap hasil juga membawa `clips`: daftar nama file klip yang
// disambung di browser (lihat js/voicePlayer.js). Angka dipecah jadi kata:
// 1250 -> seribu dua ratus lima puluh. Nama klip "_" = jeda singkat.
const DIGIT_CLIPS = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan'];

function belowThousand(n, out) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 1) out.push('seratus');
  else if (h > 1) out.push(DIGIT_CLIPS[h], 'ratus');
  if (r === 0) return;
  if (r < 10) out.push(DIGIT_CLIPS[r]);
  else if (r === 10) out.push('sepuluh');
  else if (r === 11) out.push('sebelas');
  else if (r < 20) out.push(DIGIT_CLIPS[r - 10], 'belas');
  else {
    out.push(DIGIT_CLIPS[Math.floor(r / 10)], 'puluh');
    if (r % 10) out.push(DIGIT_CLIPS[r % 10]);
  }
}

function numberClips(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n > 999999) n = 999999;
  if (n === 0) return ['nol'];
  const out = [];
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  if (th === 1) out.push('seribu');
  else if (th > 1) { belowThousand(th, out); out.push('ribu'); }
  if (rest) belowThousand(rest, out);
  return out;
}

// "SP30S" -> huruf satu-satu, angka dibaca utuh: l-s l-p tiga puluh l-s
// Angka berawalan 0 (mis. "007") dibaca digit per digit.
function codeClips(code) {
  const out = [];
  const parts = String(code || '').match(/[A-Za-z]|\d+/g) || [];
  parts.forEach((p) => {
    if (/^[A-Za-z]$/.test(p)) out.push('l-' + p.toLowerCase());
    else if (p.length > 1 && p[0] === '0') p.split('').forEach((d) => out.push(DIGIT_CLIPS[+d]));
    else out.push(...numberClips(parseInt(p, 10)));
  });
  return out;
}

function qtyClips(it) {
  // paket dibacakan sebagai total pcs: PKT50-SP50M x3 -> "seratus lima puluh pcs"
  return [...numberClips(it.pcs), 'pcs'];
}

function buildClips(items, totalPcs) {
  if (items.length === 1) {
    const it = items[0];
    const c = ['pesanannya', ...qtyClips(it)];
    if (it.code) c.push(...codeClips(it.code));
    c.push('ya');
    return c;
  }
  if (items.length > 3) {
    return ['pesanannya', ...numberClips(items.length), 'jenis-barang', '_', 'total', ...numberClips(totalPcs), 'pcs', 'ya'];
  }
  const c = ['pesanannya'];
  items.forEach((it, i) => {
    if (i > 0) c.push('_', 'dan');
    c.push(...qtyClips(it));
    if (it.code) c.push(...codeClips(it.code));
  });
  c.push('ya');
  return c;
}

// Mengembalikan { text, speech, clips, total_pcs, items } atau null kalau pesanan gak punya info jumlah.
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

  const rawItems = lines.map((l) => {
    const code = l.packSize ? l.sku.replace(PKT_RE, '') : l.sku;
    const pcsTotal = l.packSize ? l.qty * l.packSize : l.qty;
    const qtyText = `${pcsTotal} pcs`;
    const qtySpeech = `${pcsTotal} pis`;
    return { code, qtyText, qtySpeech, qty: l.qty, packSize: l.packSize, pcs: l.packSize ? l.qty * l.packSize : l.qty };
  });
  // SKU yang sama digabung (paket + satuan): PKT50-SP50M x2 + SP50M x5 -> 105 pcs SP50M
  const merged = new Map();
  rawItems.forEach((it) => {
    const key = it.code.toUpperCase();
    const prev = merged.get(key);
    if (prev) { prev.pcs += it.pcs; prev.qty = prev.pcs; prev.packSize = null; }
    else merged.set(key, { ...it });
  });
  const items = [...merged.values()].map((it) => ({
    ...it,
    qtyText: `${it.pcs} pcs`,
    qtySpeech: `${it.pcs} pis`,
  }));
  const totalPcs = items.reduce((s, i) => s + i.pcs, 0);
  const clips = buildClips(items, totalPcs);

  if (items.length === 1) {
    const it = items[0];
    return {
      text: `Pesanannya ${it.qtyText}${it.code ? ` ${it.code}` : ''} ya`,
      speech: `Pesanannya ${it.qtySpeech}${it.code ? ` ${spellSku(it.code)}` : ''} ya`,
      clips,
      total_pcs: totalPcs,
      items,
    };
  }
  // Lebih dari 3 jenis barang: ringkas aja biar gak jadi pidato, rinciannya ada di layar.
  if (items.length > 3) {
    return {
      text: `Pesanannya ${items.length} jenis barang, total ${totalPcs} pcs ya`,
      speech: `Pesanannya ${items.length} jenis barang, total ${totalPcs} pis ya`,
      clips,
      total_pcs: totalPcs,
      items,
    };
  }
  return {
    text: `Pesanannya ${items.map((i) => `${i.qtyText} ${i.code}`.trim()).join(' dan ')} ya`,
    speech: `Pesanannya ${items.map((i) => `${i.qtySpeech} ${spellSku(i.code)}`.trim()).join(' dan ')} ya`,
    clips,
    total_pcs: totalPcs,
    items,
  };
}

module.exports = { buildScanSpeech, numberClips, codeClips };
