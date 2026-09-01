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

// Daftar provinsi Indonesia, dipakai buat deteksi otomatis provinsi dari teks alamat
// lengkap (fitur "Input Manual" -- CS cuma isi alamat lengkap, sisanya (kota/provinsi/
// kode pos) otomatis kesplit, gak perlu isi form terpisah-pisah). Diurutkan dari nama
// terpanjang ke terpendek biar "Kalimantan Timur" ke-match duluan sebelum "Kalimantan".
const INDONESIA_PROVINCES = [
  'Kepulauan Bangka Belitung', 'Kepulauan Riau', 'Daerah Istimewa Yogyakarta', 'DI Yogyakarta',
  'DKI Jakarta', 'Sulawesi Tenggara', 'Sulawesi Selatan', 'Sulawesi Tengah', 'Sulawesi Utara',
  'Sulawesi Barat', 'Kalimantan Selatan', 'Kalimantan Tengah', 'Kalimantan Timur',
  'Kalimantan Barat', 'Kalimantan Utara', 'Nusa Tenggara Timur', 'Nusa Tenggara Barat',
  'Papua Barat Daya', 'Papua Pegunungan', 'Papua Selatan', 'Papua Tengah', 'Papua Barat',
  'Sumatera Selatan', 'Sumatera Utara', 'Sumatera Barat', 'Jawa Tengah', 'Jawa Timur',
  'Jawa Barat', 'Bangka Belitung', 'Bengkulu', 'Lampung', 'Banten', 'Jambi', 'Aceh', 'Riau',
  'Bali', 'Gorontalo', 'Maluku Utara', 'Maluku', 'Papua', 'Yogyakarta',
];

// Split alamat lengkap (satu baris teks bebas dari CS) jadi negara/provinsi/kota/kode pos
// secara otomatis, biar CS gak perlu isi 4 kolom terpisah pas Input Manual:
// - Kode pos: ambil angka 5 digit TERAKHIR yang berdiri sendiri di teks (biasanya di ujung alamat).
// - Provinsi: dicocokkan ke daftar 38 provinsi Indonesia (INDONESIA_PROVINCES di atas).
// - Kota: cari pola "Kota <nama>" / "Kabupaten <nama>" / "Kab. <nama>" di teks.
// - Negara: default "Indonesia" (sistem ini buat pengiriman domestik).
// Ini heuristik berbasis pola teks, bukan geocoding penuh -- kalau alamatnya gak nyebut
// pola-pola di atas secara eksplisit, field terkait tetap dikosongin (bukan error, karena
// semua kolom ini opsional) dan bisa dibenerin manual belakangan kalau perlu.
function parseAlamatLengkap(alamatRaw) {
  const text = String(alamatRaw || '').trim();
  if (!text) return { negara: '', provinsi: '', kota: '', kode_pos: '' };

  const kodePosMatches = text.match(/\b\d{5}\b/g);
  const kodePos = kodePosMatches ? kodePosMatches[kodePosMatches.length - 1] : '';

  let provinsi = '';
  const lower = text.toLowerCase();
  for (const p of INDONESIA_PROVINCES) {
    if (lower.includes(p.toLowerCase())) { provinsi = p; break; }
  }

  let kota = '';
  const kotaMatch = text.match(/\b(Kota|Kabupaten|Kab\.)\s+([A-Za-z.]+(?:\s+[A-Za-z.]+)?)/i);
  if (kotaMatch) {
    const prefix = /^kab/i.test(kotaMatch[1]) ? 'Kabupaten' : 'Kota';
    kota = `${prefix} ${kotaMatch[2].trim()}`;
  }

  return { negara: 'Indonesia', provinsi, kota, kode_pos: kodePos };
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

// Field-field yang boleh "dipertahankan" dari data lama di database kalau file yang lagi
// diimpor kebetulan gak bawa info itu (kolomnya kosong) buat No. Pesanan yang SAMA.
// Ini penting karena `upsert` normalnya nimpa SELURUH kolom apa adanya -- jadi kalau ada
// pesanan yang sebelumnya sudah lengkap (Toko, No. Resi, SKU, Jumlah, dst dari file
// "Export Order Package" yang lengkap), lalu No. Pesanan yang sama nongol lagi di file lain
// yang formatnya beda/gak selengkap itu (misal file rekap resi doang, atau baris yang
// kolomnya kebetulan kosong di sumbernya), field-field itu bisa KETIMPA jadi kosong tanpa
// sengaja walau sebenarnya data lamanya sudah benar. Field yang TIDAK masuk daftar ini
// (imported_by, waktu_pesanan_at) sengaja dibiarkan nimpa seperti biasa karena itu memang
// harus selalu reflect aktor/waktu import yang paling baru.
const MERGE_KEEP_OLD_IF_BLANK_FIELDS = [
  'toko', 'platform', 'opsi_pengiriman', 'no_resi', 'nama_pembeli', 'sku',
  'subtotal_pesanan', 'no_hp', 'negara', 'provinsi', 'kota', 'kode_pos',
  'alamat', 'nama_penerima', 'jumlah', 'waktu_pesanan_dibuat',
  // affiliate_name/affiliate_motif/affiliate_ongkir ikut aturan yang sama: kalau CS cuma
  // mau benerin field lain (misal No. Resi doang) lewat Input Manual dan gak nyentuh bagian
  // affiliate, data affiliate yang sudah ada sebelumnya gak boleh ke-blank-in. Buat
  // affiliate_ongkir, "kosong" artinya null (bukan string ""), soalnya angka 0 itu valid
  // (misal ongkirnya beneran gratis) -- lihat isBlankValue().
  'affiliate_name', 'affiliate_motif', 'affiliate_ongkir',
];

// "jumlah" itu total barang -- kalau nilainya "0" itu sama aja gak ada info (gak masuk akal
// ada pesanan isi 0 barang), jadi diperlakukan sebagai kosong juga, bukan cuma string kosong.
function isBlankValue(field, value) {
  if (field === 'affiliate_ongkir') return value === null || value === undefined; // 0 itu valid, bukan "kosong"
  const str = String(value ?? '').trim();
  if (field === 'jumlah') return str === '' || str === '0';
  return str === '';
}

// Gabungkan baris baru (dari file yang lagi diimpor) dengan baris lama di database (kalau
// No. Pesanan-nya sudah ada) -- field yang kosong di baris baru dipertahankan dari baris
// lama, field yang ada isinya di baris baru tetap dipakai (baris baru selalu menang kalau
// beneran bawa data). Lihat komentar MERGE_KEEP_OLD_IF_BLANK_FIELDS di atas buat alasannya.
//
// CATATAN: bypass otomatis buat kurir instant/sameday (lihat isInstantCourier() di
// courierTracking.js) SENGAJA TIDAK diterapkan di sini (saat import/Input Manual) --
// pesanan instant/sameday tetap masuk sebagai "belum_packing" seperti pesanan lain, dan
// baru di-bypass ke "sudah_packing" + "sudah dikirim" pas beneran discan tim packing (lihat
// api/_lib/routes/packing.js). Ini biar flow-nya konsisten: import cuma nyatet pesanan
// masuk, packing yang nentuin kapan pesanan dianggap sudah diproses -- bukan langsung
// "lompat" ke sudah dikirim dari import.
function mergeWithExisting(newRow, existingRow) {
  const merged = { ...newRow };

  // status_packing itu status internal sistem, BUKAN field yang datang dari file
  // export/form Input Manual -- baris dari buildRowsFromFile()/route manual gak pernah
  // nyetel field ini kecuali kena instant courier bypass. Kalau dibiarkan gak disetel sama
  // sekali di sini, WAJIB disetel eksplisit: kalau pesanannya sudah ada, pertahankan status
  // lama; kalau pesanan baru, pakai default 'belum_packing'. Ini PENTING buat proses import
  // file yang upsert banyak baris sekaligus dalam satu batch -- kalau ada baris lain di batch
  // yang SUDAH punya key `status_packing` (misal kena instant courier bypass) sementara baris
  // ini nggak punya key itu sama sekali, Supabase/PostgREST bakal nyetel NULL eksplisit buat
  // baris yang gak punya key ini, ngelewatin default kolom di database & bikin error
  // "null value in column status_packing violates not-null constraint".
  if (merged.status_packing === undefined) {
    merged.status_packing = existingRow ? existingRow.status_packing : 'belum_packing';
  }

  if (!existingRow) return merged;
  for (const field of MERGE_KEEP_OLD_IF_BLANK_FIELDS) {
    if (isBlankValue(field, merged[field]) && !isBlankValue(field, existingRow[field])) {
      merged[field] = existingRow[field];
    }
  }
  // waktu_pesanan_at (timestamptz asli, dipakai buat urutan) ngikut waktu_pesanan_dibuat --
  // kalau teksnya dipertahankan dari data lama di atas, timestamp-nya juga harus ikut data
  // lama (bukan malah jadi null padahal teksnya ada), biar tetap konsisten & bisa diurutkan.
  if (merged.waktu_pesanan_dibuat === existingRow.waktu_pesanan_dibuat && !merged.waktu_pesanan_at && existingRow.waktu_pesanan_at) {
    merged.waktu_pesanan_at = existingRow.waktu_pesanan_at;
  }
  return merged;
}

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

  // Ambil data LENGKAP (bukan cuma No. Pesanan) buat pesanan yang sudah ada di database
  // sebelum di-upsert -- dipakai buat dua hal: (1) tau berapa yang beneran baru vs duplikat
  // (udah pernah diimport sebelumnya) buat laporan hasil import, dan (2) "mempertahankan"
  // field yang kosong di file yang lagi diimpor lewat mergeWithExisting() (lihat komentar di
  // atas MERGE_KEEP_OLD_IF_BLANK_FIELDS), biar re-import dari file yang formatnya beda/gak
  // selengkap sebelumnya gak menghapus data yang sudah lengkap.
  const allNoPesanan = toUpsert.map((o) => o.no_pesanan);
  const existingByNoPesanan = new Map();
  for (let i = 0; i < allNoPesanan.length; i += BATCH_SIZE) {
    const chunk = allNoPesanan.slice(i, i + BATCH_SIZE);
    const { data: existingRows, error: checkError } = await supabase
      .from('orders')
      .select('*')
      .in('no_pesanan', chunk);
    if (checkError) {
      console.error(checkError);
      return res.status(500).json({ error: 'Gagal mengecek pesanan yang sudah ada: ' + checkError.message });
    }
    for (const row of existingRows) existingByNoPesanan.set(row.no_pesanan, row);
  }
  const duplikat = allNoPesanan.filter((no) => existingByNoPesanan.has(no)).length;
  const baru = totalPesananUnik - duplikat;

  const mergedToUpsert = toUpsert.map((row) => {
    const existingRow = existingByNoPesanan.get(row.no_pesanan);
    return mergeWithExisting(row, existingRow);
  });

  let inserted = 0;
  for (let i = 0; i < mergedToUpsert.length; i += BATCH_SIZE) {
    const batch = mergedToUpsert.slice(i, i + BATCH_SIZE);
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

// Input manual satu pesanan (dipakai CS/admin lewat popup "Input Manual" di halaman Import
// Pesanan, buat kasus pesanan yang gak kebawa/gak ada di file export marketplace -- misal
// pesanan COD, pesanan dari platform yang belum didukung export-nya, atau perbaikan data
// satu pesanan tanpa perlu re-upload file lengkap). Field wajib cuma No. Pesanan, sisanya
// opsional (konsisten sama kolom `orders` yang emang nullable). Pakai upsert onConflict
// no_pesanan yang sama kayak import file, jadi kalau No. Pesanan-nya udah ada, datanya
// diperbarui (bukan bikin baris duplikat) -- makanya kita cek dulu ada/nggaknya SEBELUM
// upsert, biar bisa dikasih tau ke user apakah ini pesanan baru atau nimpa data lama.
router.post('/manual', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const b = req.body || {};
  const noPesanan = String(b.no_pesanan || '').trim();
  if (!noPesanan) return res.status(400).json({ error: 'No. Pesanan wajib diisi' });

  // Ambil baris LENGKAP (bukan cuma No. Pesanan) kalau pesanan ini sudah ada -- dipakai buat
  // (1) info is_duplicate di response, dan (2) mergeWithExisting() di bawah, biar field yang
  // gak diisi di form (misal CS cuma mau benerin No. Resi doang) gak nge-blank-in field lain
  // yang sudah terisi lengkap sebelumnya dari import file.
  const { data: existing, error: checkError } = await supabase
    .from('orders')
    .select('*')
    .eq('no_pesanan', noPesanan)
    .maybeSingle();
  if (checkError) {
    console.error(checkError);
    return res.status(500).json({ error: 'Gagal mengecek pesanan yang sudah ada: ' + checkError.message });
  }

  const store = normalizeStore(b.toko, b.platform);
  const waktuPesananDibuat = String(b.waktu_pesanan_dibuat || '').trim();
  const jumlahRaw = String(b.jumlah || '').trim();
  const alamat = String(b.alamat || '').trim();
  const namaPembeli = String(b.nama_pembeli || '').trim();

  // Kode pos/negara/provinsi/kota gak ada lagi di form Input Manual -- otomatis kesplit
  // dari Alamat Lengkap. Body request masih boleh ngirim nilainya langsung (misal dari
  // integrasi lain di masa depan), makanya tetap diprioritaskan kalau ada.
  const parsedAddress = parseAlamatLengkap(alamat);
  const negara = String(b.negara || '').trim() || parsedAddress.negara;
  const provinsi = String(b.provinsi || '').trim() || parsedAddress.provinsi;
  const kota = String(b.kota || '').trim() || parsedAddress.kota;
  const kodePos = String(b.kode_pos || '').trim() || parsedAddress.kode_pos;

  // Pesanan Affiliate: checkbox "Ini Pesanan Affiliate" di form Input Manual. Beda dari
  // field lain, is_affiliate SENGAJA selalu nimpa nilai lama sesuai state checkbox pas
  // disubmit (gak masuk MERGE_KEEP_OLD_IF_BLANK_FIELDS) -- form ini nge-assert status
  // TERKINI tiap kali disubmit, konsisten sama gimana field lain di Input Manual dipakai
  // buat "koreksi data sekarang", bukan cuma nambahin info baru.
  const isAffiliate = b.is_affiliate === true || b.is_affiliate === 'true';
  // Ongkir diketik user sebagai teks bebas (misal "15.000" atau "15000") -- dibersihin dulu
  // ke angka murni. String kosong -> null (bukan 0), biar isBlankValue() bisa bedain
  // "belum diisi" dari "beneran 0".
  const affiliateOngkirRaw = String(b.affiliate_ongkir || '').trim();
  const affiliateOngkir = affiliateOngkirRaw ? Number(affiliateOngkirRaw.replace(/[^0-9.]/g, '')) : null;

  const row = {
    no_pesanan: noPesanan,
    toko: store.toko || null,
    platform: store.platform || null,
    opsi_pengiriman: String(b.opsi_pengiriman || '').trim(),
    no_resi: String(b.no_resi || '').trim(),
    nama_pembeli: namaPembeli,
    sku: String(b.sku || '').trim(),
    subtotal_pesanan: String(b.subtotal_pesanan || '').trim(),
    no_hp: String(b.no_hp || '').trim(),
    negara,
    provinsi,
    kota,
    kode_pos: kodePos,
    alamat,
    // Nama Panggilan Penerima gak ada lagi di form Input Manual -- default ke Nama
    // Pembeli (biasanya orang yang sama), kalau body ngirim nilainya sendiri baru dipakai itu.
    nama_penerima: String(b.nama_penerima || '').trim() || namaPembeli,
    jumlah: jumlahRaw,
    waktu_pesanan_dibuat: waktuPesananDibuat,
    // Null kalau teksnya kosong/gak bisa diparse -- biar mergeWithExisting() di bawah bisa
    // narik nilai lama (kalau ada) sebelum jatuh ke fallback new Date() di baris berikutnya.
    waktu_pesanan_at: parseWaktuPemesanan(waktuPesananDibuat),
    imported_by: req.user.id,
    is_affiliate: isAffiliate,
    affiliate_name: String(b.affiliate_name || '').trim(),
    affiliate_motif: String(b.affiliate_motif || '').trim(),
    affiliate_ongkir: (affiliateOngkir === null || isNaN(affiliateOngkir)) ? null : affiliateOngkir,
  };

  const mergedRow = mergeWithExisting(row, existing);
  if (!mergedRow.waktu_pesanan_at) mergedRow.waktu_pesanan_at = new Date().toISOString();

  const { error } = await supabase.from('orders').upsert(mergedRow, { onConflict: 'no_pesanan' });
  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Gagal menyimpan pesanan: ' + error.message });
  }

  res.json({ ok: true, no_pesanan: noPesanan, is_duplicate: !!existing });
});

module.exports = router;
