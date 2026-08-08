const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Satu-satunya format yang didukung mulai sekarang: export "Export Order Package" dari
// Shopee Seller Center (satu file bisa berisi banyak toko/platform sekaligus, kolom toko
// & platform sudah ada langsung di file -- gak perlu input manual lagi). Kalau formatnya
// berubah lagi di kemudian hari, cukup sesuaikan mapping kolom di bawah ini.
const COLUMN_MAP = {
  no_pesanan: 'No. Pesanan',
  toko: 'Nama Toko',
  platform: 'Platform',
  opsi_pengiriman: 'Nama Logistik',
  no_resi: 'Nomor Resi',
  nama_pembeli: 'Nama',
  sku: 'SKU Platform',
  subtotal_pesanan: 'Total Jumlah Pesanan',
  no_hp: 'No. CP 1',
  negara: 'Negara/Wilayah',
  provinsi: 'Provinsi',
  kota: 'Kota',
  kode_pos: 'Kode Pos',
  alamat: 'Alamat Lengkap 1',
  nama_penerima: 'Nama Panggilan Pembeli',
  jumlah: 'Jumlah Barang',
  waktu_pesanan_dibuat: 'Waktu Pemesanan',
};

// Peta normalisasi nama toko yang "aneh"/kode internal di file export ke nama toko asli
// + platform yang benar. Tambahin entry baru di sini kalau ada toko lain yang perlu
// di-normalisasi/di-benerin otomatis pas import (key HARUS huruf kecil).
const STORE_MAP = {
  'plsfmgshop': { toko: 'Bagusbag Jakarta', platform: 'tiktok' },
  'bagusbag.jakarta': { toko: 'Bagusbag Jakarta', platform: 'shopee' },
};

// Terapin normalisasi: kalau nama toko mentah dari file ketemu di STORE_MAP, dipakai
// nilai yang sudah dibenerin (toko + platform-nya sekalian, gak peduli apa kata file).
// Kalau gak ketemu, dipakai apa adanya dari file (platform di-lowercase biar konsisten).
function normalizeStore(rawToko, rawPlatform) {
  const key = String(rawToko || '').trim().toLowerCase();
  if (STORE_MAP[key]) return STORE_MAP[key];
  const toko = String(rawToko || '').trim();
  const platform = String(rawPlatform || '').trim().toLowerCase();
  return { toko: toko || null, platform: platform || null };
}

// Kalau satu pesanan punya lebih dari satu SKU, Excel-nya nampilin baris pertama isi
// lengkap lalu baris-baris berikutnya cuma isi SKU Platform + Jumlah Barang -- kolom
// lainnya (No. Pesanan, Toko, alamat, dst) kelihatan kosong tapi sebenarnya "merged cell"
// yang nyambung ke baris pertama grupnya. SheetJS nyimpen info merge ini di
// sheet['!merges']; kita "unmerge" manual dengan nyalin nilai sel kiri-atas ke semua sel
// lain dalam rentang merge-nya, SEBELUM di-convert ke JSON. Ini lebih akurat dibanding
// nebak "isi kosong = lanjutan baris atasnya", karena pakai info merge asli dari Excel-nya.
function expandMergedCells(sheet) {
  const merges = sheet['!merges'] || [];
  for (const range of merges) {
    const topLeftAddr = XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c });
    const topLeftCell = sheet[topLeftAddr];
    if (!topLeftCell) continue;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        if (r === range.s.r && c === range.s.c) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        sheet[addr] = { ...topLeftCell };
      }
    }
  }
}

// Cari sheet yang punya kolom "No. Pesanan" (setelah cell yang di-merge di-"unmerge" dulu).
function findOrderRows(workbook) {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    expandMergedCells(sheet);
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (json.length > 0 && COLUMN_MAP.no_pesanan in json[0]) {
      return json;
    }
  }
  return null;
}

// "Waktu Pemesanan" di file formatnya "DD-MM-YYYY HH:mm:ss" (contoh: "07-08-2026 16:46:47"),
// dalam waktu Indonesia bagian Barat (WIB / UTC+7). Diparse manual (bukan `new Date(str)`)
// karena kalau diserahkan ke parser bawaan JS, DD-MM-YYYY gampang kebaca salah jadi
// MM-DD-YYYY (format Amerika). Dipakai buat kolom `waktu_pesanan_at` (timestamptz asli),
// supaya bisa diurutkan dengan benar -- teks aslinya tetap disimpan apa adanya di
// `waktu_pesanan_dibuat` buat ditampilkan ke user.
function parseWaktuPemesanan(raw) {
  const str = String(raw || '').trim();
  const m = str.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min, +ss) - 7 * 60 * 60 * 1000; // WIB -> UTC
  const date = new Date(utcMs);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

// Batch upsert biar gak kena limit ukuran request Supabase kalau file-nya gede
const BATCH_SIZE = 500;

// Satu pesanan (dikelompokkan per No. Pesanan) bisa punya beberapa baris SKU -- digabung
// jadi satu baris `orders` di database, dengan SKU + jumlahnya masing-masing digabung
// dalam satu kolom `sku` (contoh: "SP30S x20, SP74 x3, SP35L x2"), dan `jumlah` diisi
// total keseluruhan barang di pesanan itu.
function buildRowsFromFile(rows, opts) {
  const groups = new Map(); // no_pesanan -> { field-field pesanan, skuLines: [], jumlahTotal }
  let skippedTanpaNoPesanan = 0;

  for (const item of rows) {
    const noPesanan = String(item[COLUMN_MAP.no_pesanan] || '').trim();
    if (!noPesanan) {
      skippedTanpaNoPesanan++;
      continue;
    }

    const sku = String(item[COLUMN_MAP.sku] || '').trim();
    const jumlahBaris = parseInt(String(item[COLUMN_MAP.jumlah] || '0').trim(), 10) || 0;

    if (!groups.has(noPesanan)) {
      groups.set(noPesanan, {
        toko: String(item[COLUMN_MAP.toko] || '').trim(),
        platform: String(item[COLUMN_MAP.platform] || '').trim(),
        opsi_pengiriman: String(item[COLUMN_MAP.opsi_pengiriman] || '').trim(),
        no_resi: String(item[COLUMN_MAP.no_resi] || '').trim(),
        nama_pembeli: String(item[COLUMN_MAP.nama_pembeli] || '').trim(),
        subtotal_pesanan: String(item[COLUMN_MAP.subtotal_pesanan] || '').trim(),
        no_hp: String(item[COLUMN_MAP.no_hp] || '').trim(),
        negara: String(item[COLUMN_MAP.negara] || '').trim(),
        provinsi: String(item[COLUMN_MAP.provinsi] || '').trim(),
        kota: String(item[COLUMN_MAP.kota] || '').trim(),
        kode_pos: String(item[COLUMN_MAP.kode_pos] || '').trim(),
        alamat: String(item[COLUMN_MAP.alamat] || '').trim(),
        nama_penerima: String(item[COLUMN_MAP.nama_penerima] || '').trim(),
        waktu_pesanan_dibuat: String(item[COLUMN_MAP.waktu_pesanan_dibuat] || '').trim(),
        skuLines: [],
        jumlahTotal: 0,
      });
    }
    const g = groups.get(noPesanan);
    if (sku) g.skuLines.push(jumlahBaris ? `${sku} x${jumlahBaris}` : sku);
    g.jumlahTotal += jumlahBaris;
  }

  const toUpsert = [];
  for (const [noPesanan, g] of groups.entries()) {
    const store = normalizeStore(g.toko, g.platform);
    toUpsert.push({
      no_pesanan: noPesanan,
      toko: store.toko || null,
      platform: store.platform || null,
      opsi_pengiriman: g.opsi_pengiriman,
      no_resi: g.no_resi,
      nama_pembeli: g.nama_pembeli,
      sku: g.skuLines.join(', '),
      subtotal_pesanan: g.subtotal_pesanan,
      no_hp: g.no_hp,
      negara: g.negara,
      provinsi: g.provinsi,
      kota: g.kota,
      kode_pos: g.kode_pos,
      alamat: g.alamat,
      nama_penerima: g.nama_penerima,
      jumlah: String(g.jumlahTotal),
      waktu_pesanan_dibuat: g.waktu_pesanan_dibuat,
      waktu_pesanan_at: parseWaktuPemesanan(g.waktu_pesanan_dibuat),
      imported_by: opts.userId,
    });
  }

  return { toUpsert, skipped: skippedTanpaNoPesanan, totalPesananUnik: toUpsert.length };
}

router.post('/', requireAuth, requireRole('admin', 'cs'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'File tidak bisa dibaca. Pastikan format .xlsx / .xlsm sesuai export "Export Order Package".' });
  }

  const rows = findOrderRows(workbook);
  if (!rows) {
    return res.status(400).json({
      error: 'Format file tidak dikenali. Pastikan file hasil export "Export Order Package" (harus ada kolom "No. Pesanan").',
    });
  }

  const { toUpsert, skipped, totalPesananUnik } = buildRowsFromFile(rows, { userId: req.user.id });

  // Cek dulu No. Pesanan mana yang SUDAH ADA di database sebelum di-upsert, biar bisa
  // dikasih tau ke user berapa yang beneran baru vs berapa yang duplikat (udah pernah
  // diimport sebelumnya -- datanya tetap diperbarui/upsert seperti biasa, cuma dihitung
  // terpisah di laporan hasil import).
  const allNoPesanan = toUpsert.map((o) => o.no_pesanan);
  const existingSet = new Set();
  for (let i = 0; i < allNoPesanan.length; i += BATCH_SIZE) {
    const chunk = allNoPesanan.slice(i, i + BATCH_SIZE);
    const { data: existingRows, error: checkError } = await supabase
      .from('orders')
      .select('no_pesanan')
      .in('no_pesanan', chunk);
    if (checkError) {
      console.error(checkError);
      return res.status(500).json({ error: 'Gagal mengecek pesanan yang sudah ada: ' + checkError.message });
    }
    for (const row of existingRows) existingSet.add(row.no_pesanan);
  }
  const duplikat = allNoPesanan.filter((no) => existingSet.has(no)).length;
  const baru = totalPesananUnik - duplikat;

  let inserted = 0;
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('orders').upsert(batch, { onConflict: 'no_pesanan' });
    if (error) {
      console.error(error);
      return res.status(500).json({
        error: 'Gagal menyimpan sebagian data ke database: ' + error.message,
        inserted,
        skipped_baris_tanpa_no_pesanan: skipped,
      });
    }
    inserted += batch.length;
  }

  res.json({
    ok: true,
    total_rows: rows.length,
    inserted,
    total_pesanan_unik: totalPesananUnik,
    pesanan_baru: baru,
    pesanan_duplikat: duplikat,
    skipped_baris_tanpa_no_pesanan: skipped,
  });
});

module.exports = router;
