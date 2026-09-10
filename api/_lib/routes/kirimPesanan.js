const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Sama seperti COLUMN_MAP di routes/import.js — mengikuti format export "Export Order
// Package" dari marketplace (Shopee dkk). Cuma butuh No. Pesanan buat cocokin ke database;
// kolom lain (status pesanan asal file, No. Resi, SKU) dipakai buat ngasih konteks di baris gagal.
const COLUMN_MAP = {
  no_pesanan: 'No. Pesanan',
  status_pesanan: 'Status Pesanan',
  no_resi: 'Nomor Resi',
  sku: 'SKU Platform',
};

// Batas jumlah nilai per query .in(...) biar gak kena limit ukuran request Supabase
// kalau file-nya gede (dipakai buat lookup & update batch).
const BATCH_SIZE = 500;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Import khusus admin: upload file export marketplace -> tiap No. Pesanan dicocokkan ke
// database -> yang ketemu ditandai status_resi = 'dikirim', yang tidak ketemu masuk daftar
// gagal (bisa diunduh lewat POST /gagal-export).
router.post('/', requireAuth, requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

  // Opsional: admin bisa pilih "Packing oleh" di form kalau SEMUA pesanan di file ini
  // di-packing oleh 1 orang yang sama (biasanya karena belum pernah discan lewat menu Scan
  // Packing, jadi kalau dibiarkan bakal tampil "N/A" terus di Tracking/Export).
  let packerId = null;
  const packerIdRaw = req.body.packed_by;
  if (packerIdRaw !== undefined && packerIdRaw !== null && String(packerIdRaw).trim() !== '') {
    packerId = Number(packerIdRaw);
    if (!Number.isInteger(packerId)) {
      return res.status(400).json({ error: 'Packer (packed_by) tidak valid' });
    }
    const { data: packerUser, error: packerErr } = await supabase.from('users').select('id').eq('id', packerId).maybeSingle();
    if (packerErr) return res.status(500).json({ error: 'Gagal memvalidasi packer' });
    if (!packerUser) return res.status(400).json({ error: 'User packer tidak ditemukan' });
  }

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'File tidak bisa dibaca. Pastikan format .xlsx / .xlsm sesuai export marketplace.' });
  }

  let rows = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (json.length > 0 && COLUMN_MAP.no_pesanan in json[0]) {
      rows = json;
      break;
    }
  }
  if (!rows) {
    return res.status(400).json({ error: 'Kolom "No. Pesanan" tidak ditemukan di file. Cek kembali file yang diupload.' });
  }

  const seenInFile = new Set();
  const items = [];
  let skippedDuplicate = 0;

  for (const item of rows) {
    const noPesanan = String(item[COLUMN_MAP.no_pesanan] || '').trim();
    if (!noPesanan || seenInFile.has(noPesanan)) {
      skippedDuplicate++;
      continue;
    }
    seenInFile.add(noPesanan);
    items.push({
      no_pesanan: noPesanan,
      status_pesanan_file: String(item[COLUMN_MAP.status_pesanan] || '').trim(),
      no_resi: String(item[COLUMN_MAP.no_resi] || '').trim(),
      sku: String(item[COLUMN_MAP.sku] || '').trim(),
    });
  }

  if (!items.length) {
    return res.json({ ok: true, total_rows: rows.length, updated: 0, skipped_duplicate_in_file: skippedDuplicate, skipped_already_dikirim: 0, failed: [] });
  }

  // Cari mana aja No. Pesanan yang ada di database, per batch — sekalian ambil status_resi
  // sekarang biar yang UDAH 'dikirim' sebelumnya gak ke-update ulang (biar dikirim_at gak
  // ketimpa timestamp hari ini dan gak numpuk ke hitungan "Sudah Dikirim (Hari Ini)") —
  // dan ambil packed_by juga, buat nentuin mana yang masih boleh diisi packer dari form ini.
  const foundRows = new Map(); // no_pesanan -> { id, status_resi, packed_by }
  for (const batch of chunk(items.map((i) => i.no_pesanan), BATCH_SIZE)) {
    const { data, error } = await supabase.from('orders').select('id, no_pesanan, status_resi, packed_by').in('no_pesanan', batch);
    if (error) return res.status(500).json({ error: 'Gagal mencocokkan pesanan ke database: ' + error.message });
    for (const row of data || []) foundRows.set(row.no_pesanan, row);
  }

  const failed = [];
  const idsToUpdate = [];
  // Subset dari idsToUpdate yang packed_by-nya masih kosong -- CUMA ini yang boleh diisi
  // dari pilihan "Packing oleh" di form, biar packing yang BENERAN discan manual (via Scan
  // Packing, packed_by-nya udah keisi) gak ketimpa jadi nama orang lain.
  const idsNeedPacker = [];
  let skippedAlreadyDikirim = 0;
  for (const item of items) {
    const row = foundRows.get(item.no_pesanan);
    if (row) {
      if (row.status_resi === 'dikirim' || row.status_resi === 'diterima') {
        // Sudah pernah ditandai dikirim (atau malah udah diterima, status yang lebih maju
        // lagi) di import sebelumnya — jangan disentuh/dimundurin lagi.
        skippedAlreadyDikirim++;
      } else {
        idsToUpdate.push(row.id);
        if (packerId && !row.packed_by) idsNeedPacker.push(row.id);
      }
    } else {
      failed.push({
        'No. Pesanan': item.no_pesanan,
        'No. Resi': item.no_resi,
        'SKU': item.sku,
        'Status di File': item.status_pesanan_file,
        'Alasan Gagal': 'No. Pesanan tidak ditemukan di database (belum pernah diimport)',
      });
    }
  }

  const now = new Date().toISOString();
  let updated = 0;
  for (const batch of chunk(idsToUpdate, BATCH_SIZE)) {
    // Kalau pesanan sudah dikirim, otomatis dianggap sudah kelar packing juga (barangnya sudah
    // keluar gudang) — biarpun belum pernah discan lewat menu Scan Packing.
    const { error } = await supabase
      .from('orders')
      .update({ status_resi: 'dikirim', dikirim_at: now, status_packing: 'sudah_packing' })
      .in('id', batch);
    if (error) {
      return res.status(500).json({
        error: 'Sebagian pesanan gagal ditandai dikirim: ' + error.message,
        updated,
        skipped_already_dikirim: skippedAlreadyDikirim,
        failed,
      });
    }
    updated += batch.length;
  }

  // Kalau admin milih "Packing oleh" di form, isi packed_by/packed_at buat pesanan yang tadi
  // belum punya packer (belum pernah discan) — biar gak numpuk jadi "N/A" terus di Tracking/Export.
  let packedByUpdated = 0;
  if (packerId && idsNeedPacker.length) {
    for (const batch of chunk(idsNeedPacker, BATCH_SIZE)) {
      const { error } = await supabase
        .from('orders')
        .update({ packed_by: packerId, packed_at: now })
        .in('id', batch);
      if (error) {
        return res.status(500).json({
          error: 'Pesanan berhasil ditandai dikirim, tapi sebagian gagal ditandai packer: ' + error.message,
          updated,
          packed_by_updated: packedByUpdated,
          skipped_already_dikirim: skippedAlreadyDikirim,
          failed,
        });
      }
      packedByUpdated += batch.length;
    }
  }

  res.json({
    ok: true,
    total_rows: rows.length,
    updated,
    packed_by_updated: packedByUpdated,
    skipped_duplicate_in_file: skippedDuplicate,
    skipped_already_dikirim: skippedAlreadyDikirim,
    failed,
  });
});

// Generate file Excel dari daftar baris gagal (dikirim dari hasil import di atas, gak
// disimpan ke database) supaya admin bisa unduh dan telusuri satu-satu.
router.post('/gagal-export', requireAuth, requireRole('admin'), (req, res) => {
  const rowsIn = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const sheetData = rowsIn.length
    ? rowsIn
    : [{ 'Tidak ada data': 'Tidak ada baris gagal' }];

  const worksheet = XLSX.utils.json_to_sheet(sheetData);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 30 }, { wch: 18 }, { wch: 45 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Gagal Kirim Pesanan');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `flowmua-kirim-pesanan-gagal-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

module.exports = router;
