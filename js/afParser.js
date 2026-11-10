// Parser resi "Advance Fulfilment" (PDF batch resi dari Shopee -- satu halaman = satu resi).
//
// Dipakai di browser (dashboard.html -> menu Import Pesanan) -- PDF dibaca LANGSUNG di
// browser pakai pdf.js, bukan di server. Alasannya: Vercel membatasi body request ~4,5MB
// sedangkan satu halaman resi ~55KB (gambar barcode/QR), jadi batch 100+ resi gak akan muat
// kalau PDF-nya di-upload. Yang dikirim ke server cuma hasil bacaannya (teks, beberapa KB).
//
// File ini TIDAK bergantung ke pdf.js secara langsung: parser cuma butuh daftar potongan
// teks + posisinya per halaman ({ str, x, y, w, h }), jadi gampang dites di Node juga
// (module.exports di bawah).
//
// Isi satu resi (contoh):
//   - "Pesan: (261109AASBLJA5BTPAQ) (SPXID06279270867B)"  -> No. Pesanan + No. Resi
//   - "Penerima: Kosambi RDC - Pengiriman Kilat  Pengirim: okeokebag" -> penerima & pengirim
//   - blok alamat di bawah "Penerima:" (kolom kiri; kolom kanan itu data pengirim)
//   - tabel produk: # | Nama Produk | SKU | Variasi | Qty -- teks tiap sel bisa patah jadi
//     beberapa baris (misal SKU "PKT50-" / "SP35M"), makanya dibaca per kolom (posisi x
//     header tabel), bukan per baris.
//
// Harga barang TIDAK ada di resi Advance Fulfilment, jadi sengaja gak dibaca di sini
// (backend yang ngisi "-").
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdvanceFulfilmentParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LINE_TOL = 2; // selisih y (pt) yang masih dianggap satu baris
  const DEFAULT_PAGE_WIDTH = 297; // resi 100x150mm
  const LEFT_COLUMN_RATIO = 0.64; // kolom kiri (penerima) vs kanan (pengirim)

  const cleanToken = (s) => String(s == null ? '' : s).replace(/[\s ​-‍﻿]+/g, '');
  const normSpace = (s) => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();

  // Hasil getTextContent() pdf.js -> potongan teks horizontal bersertakan posisi.
  // Teks vertikal (kode resi yang diulang di tepi resi) dibuang karena cuma "hiasan".
  function itemsFromTextContent(textContent) {
    const out = [];
    for (const it of (textContent && textContent.items) || []) {
      if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 0.1 || Math.abs(c) > 0.1) continue; // teks miring/vertikal
      out.push({ str: it.str, x: e, y: f, w: it.width || 0, h: Math.hypot(c, d) || it.height || 7 });
    }
    return out;
  }

  // Kelompokkan potongan teks jadi baris (y turun dari atas ke bawah halaman).
  function groupLines(items) {
    const sorted = items.slice().sort((p, q) => (q.y - p.y) || (p.x - q.x));
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= LINE_TOL) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((p, q) => p.x - q.x);
      ln.x = ln.items[0].x;
      ln.h = Math.max(...ln.items.map((i) => i.h));
      let text = '';
      let prevEnd = null;
      for (const it of ln.items) {
        if (prevEnd !== null && it.x - prevEnd > 1.2) text += ' ';
        text += it.str;
        prevEnd = it.x + it.w;
      }
      ln.text = text.replace(/\s+/g, ' ').trim();
    }
    return lines;
  }

  // Token pendek di baris tepat di bawah (patahan baris dari kode yang kepanjangan),
  // misal "No.Reservasi:261109AASBLJA5BTP" + "AQ".
  function continuationOf(lines, idx, maxGap, maxLen) {
    const cur = lines[idx];
    const nxt = lines[idx + 1];
    if (!cur || !nxt) return '';
    if (cur.y - nxt.y > maxGap) return '';
    const t = nxt.text;
    if (!/^[A-Za-z0-9]+$/.test(t) || t.length > maxLen) return '';
    const curEnd = cur.items[cur.items.length - 1].x + cur.items[cur.items.length - 1].w;
    if (nxt.x < cur.x - 3 || nxt.x > curEnd + 3) return '';
    return t;
  }

  // Satu halaman -> { ok:true, order, warnings } atau { ok:false, reason }.
  function parseLabelPage(rawItems, opts) {
    const pageWidth = (opts && opts.pageWidth) || DEFAULT_PAGE_WIDTH;
    const items = rawItems.filter((i) => i && typeof i.str === 'string' && i.str.trim());
    const lines = groupLines(items);
    const warnings = [];

    const pesanIdx = lines.findIndex((l) => /^Pesan\s*:/i.test(l.text));
    const penerimaIdx = lines.findIndex((l) => /Penerima\s*:/i.test(l.text));
    const headerIdx = lines.findIndex((l) => /Nama\s*Produk/i.test(l.text) && /\bSKU\b/i.test(l.text));
    if (penerimaIdx < 0 && headerIdx < 0 && pesanIdx < 0) {
      return { ok: false, reason: 'bukan halaman resi Advance Fulfilment (tidak ada Penerima / tabel produk)' };
    }

    // ---- No. Pesanan & No. Resi ----
    let noPesanan = '';
    let noResi = '';
    if (pesanIdx >= 0) {
      const m = lines[pesanIdx].text.match(/Pesan\s*:\s*\(\s*([A-Za-z0-9]+)\s*\)\s*\(\s*([A-Za-z0-9]+)\s*\)/i);
      if (m) { noPesanan = m[1]; noResi = m[2]; }
    }
    // Cadangan: "No.Reservasi:" (= No. Pesanan) & "Resi:" -- keduanya bisa patah baris.
    const rsvIdx = lines.findIndex((l) => /^No\.?\s*Reservasi\s*:/i.test(l.text));
    let rsvNo = '';
    if (rsvIdx >= 0) {
      const m = lines[rsvIdx].text.match(/Reservasi\s*:\s*([A-Za-z0-9 ]+)/i);
      if (m) rsvNo = cleanToken(m[1]) + continuationOf(lines, rsvIdx, 14, 8);
    }
    const resiIdx = lines.findIndex((l) => /^Resi\s*:/i.test(l.text));
    let resiTop = '';
    if (resiIdx >= 0) {
      const m = lines[resiIdx].text.match(/Resi\s*:\s*([A-Za-z0-9 ]+)/i);
      if (m) resiTop = cleanToken(m[1]) + continuationOf(lines, resiIdx, 14, 4);
    }
    if (!noPesanan && rsvNo) noPesanan = rsvNo;
    if (!noResi && resiTop) noResi = resiTop;
    if (noPesanan && rsvNo && noPesanan !== rsvNo) warnings.push(`No. Pesanan di "Pesan:" (${noPesanan}) beda dengan "No.Reservasi" (${rsvNo})`);
    if (noResi && resiTop && noResi !== resiTop) warnings.push(`No. Resi di "Pesan:" (${noResi}) beda dengan "Resi:" (${resiTop})`);
    if (!noPesanan) return { ok: false, reason: 'No. Pesanan tidak terbaca' };
    if (!noResi) return { ok: false, reason: `No. Resi tidak terbaca (pesanan ${noPesanan})` };

    // ---- Penerima & Pengirim ----
    let penerima = '';
    let pengirim = '';
    if (penerimaIdx >= 0) {
      const t = lines[penerimaIdx].text;
      const m = t.match(/Penerima\s*:\s*([\s\S]*?)\s*Pengirim\s*:\s*([\s\S]*)$/i);
      if (m) { penerima = normSpace(m[1]); pengirim = normSpace(m[2]); }
      else {
        const only = t.match(/Penerima\s*:\s*([\s\S]*)$/i);
        if (only) penerima = normSpace(only[1]);
      }
    }
    if (!penerima) warnings.push('Penerima tidak terbaca');
    if (!pengirim) warnings.push('Pengirim tidak terbaca');

    // ---- Alamat (kolom kiri di bawah "Penerima:") ----
    // Baris-baris alamat rapat (jarak ~1 tinggi huruf); setelahnya ada kotak kota/kecamatan
    // dengan jarak jauh lebih besar -- itu bukan bagian alamat, jadi berhenti di situ.
    const leftLimit = pageWidth * LEFT_COLUMN_RATIO;
    const addrLines = [];
    if (penerimaIdx >= 0) {
      let prevY = lines[penerimaIdx].y;
      for (let i = penerimaIdx + 1; i < lines.length; i++) {
        const ln = lines[i];
        if (/^Berat\s*:/i.test(ln.text) || /Nama\s*Produk/i.test(ln.text)) break;
        const left = ln.items.filter((it) => it.x < leftLimit);
        if (!left.length) continue;
        const gap = prevY - ln.y;
        if (addrLines.length === 0 ? gap > 45 : gap > ln.h * 1.9) break;
        addrLines.push(normSpace(left.map((it) => it.str).join(' ')));
        prevY = ln.y;
      }
    }
    const alamat = normSpace(addrLines.join(' '));
    if (!alamat) warnings.push('Alamat tidak terbaca');

    // ---- Layanan kirim (teks besar di atas, misal "ECO") ----
    let layanan = '';
    const topLimitY = resiIdx >= 0 ? lines[resiIdx].y : -Infinity;
    for (const ln of lines) {
      if (ln.y < topLimitY) break;
      const hit = ln.items.find((it) => /^[A-Z]{2,12}$/.test(it.str.trim()) && it.str.trim() !== 'COD');
      if (hit) { layanan = hit.str.trim(); break; }
    }
    const kurir = /^SPX/i.test(noResi) ? 'SPX' : '';
    const opsiPengiriman = [kurir, layanan].filter(Boolean).join(' ');

    // ---- Tabel produk ----
    const products = [];
    if (headerIdx >= 0) {
      const header = lines[headerIdx];
      const colX = {};
      for (const it of header.items) {
        const s = it.str.trim().toLowerCase();
        if (s === '#' || s === 'no') colX.idx = it.x;
        else if (/^nama\s*produk$/.test(s)) colX.name = it.x;
        else if (s === 'sku') colX.sku = it.x;
        else if (s === 'variasi') colX.variasi = it.x;
        else if (s === 'qty' || s === 'jml' || s === 'jumlah') colX.qty = it.x;
      }
      if (colX.name === undefined || colX.sku === undefined) {
        return { ok: false, reason: `kolom Nama Produk / SKU tidak ditemukan (pesanan ${noPesanan})` };
      }
      const cols = Object.entries(colX).filter(([k]) => k !== 'idx').map(([key, x]) => ({ key, x })).sort((p, q) => p.x - q.x);
      const columnOf = (x) => {
        let found = null;
        for (const c of cols) if (x >= c.x - 2.5) found = c.key;
        return found;
      };
      const bottomY = pesanIdx >= 0 ? lines[pesanIdx].y : -Infinity;
      const region = items.filter((it) => it.y < header.y - LINE_TOL && it.y > bottomY + LINE_TOL);
      const idxLimit = colX.name - 1;
      const starts = region
        .filter((it) => it.x < idxLimit && /^\d{1,3}$/.test(it.str.trim()))
        .sort((p, q) => q.y - p.y);
      const rowsItems = [];
      if (starts.length === 0) {
        rowsItems.push(region);
      } else {
        starts.forEach((st, k) => {
          const top = st.y + LINE_TOL;
          const bottom = k + 1 < starts.length ? starts[k + 1].y + LINE_TOL : -Infinity;
          rowsItems.push(region.filter((it) => it.y <= top && it.y > bottom));
        });
      }
      for (const rowItems of rowsItems) {
        const cell = { name: [], sku: [], variasi: [], qty: [] };
        rowItems
          .slice()
          .sort((p, q) => (q.y - p.y) || (p.x - q.x))
          .forEach((it) => {
            if (it.x < idxLimit) return; // kolom nomor urut
            const key = columnOf(it.x);
            if (key && cell[key]) cell[key].push(it.str.trim());
          });
        const sku = cleanToken(cell.sku.join(''));
        if (!sku) continue;
        let qty = parseInt(cell.qty.join(''), 10);
        if (!Number.isInteger(qty) || qty < 1) {
          qty = 1;
          warnings.push(`Qty untuk SKU ${sku} tidak terbaca, dianggap 1`);
        }
        products.push({ sku, qty, nama_produk: normSpace(cell.name.join(' ')), variasi: normSpace(cell.variasi.join(' ')) });
      }
    }
    if (products.length === 0) return { ok: false, reason: `SKU tidak terbaca (pesanan ${noPesanan})` };

    return {
      ok: true,
      warnings,
      order: {
        no_pesanan: noPesanan,
        no_resi: noResi,
        pengirim,
        penerima,
        alamat,
        opsi_pengiriman: opsiPengiriman,
        items: products,
      },
    };
  }

  // Gabungkan hasil banyak halaman: No. Pesanan yang sama persis (resi sama) dianggap dobel
  // & diabaikan; No. Pesanan sama tapi resi beda (paket dipecah) -> dipakai yang pertama,
  // yang lain masuk peringatan (satu No. Pesanan cuma bisa punya satu resi di sistem).
  function dedupeOrders(entries) {
    const byNo = new Map();
    const duplikat = [];
    const peringatan = [];
    for (const e of entries) {
      const prev = byNo.get(e.order.no_pesanan);
      if (!prev) { byNo.set(e.order.no_pesanan, e); continue; }
      if (prev.order.no_resi === e.order.no_resi) duplikat.push({ page: e.page, no_pesanan: e.order.no_pesanan });
      else peringatan.push(`Halaman ${e.page}: pesanan ${e.order.no_pesanan} punya resi lain (${e.order.no_resi}); dipakai resi pertama (${prev.order.no_resi}, halaman ${prev.page})`);
    }
    return { orders: [...byNo.values()], duplikat, peringatan };
  }

  // Baca seluruh dokumen pdf.js. `pdfDoc` = hasil pdfjsLib.getDocument(...).promise.
  // Satu halaman gagal TIDAK menggagalkan halaman lain -- dicatat di `gagal`.
  async function parsePdfDocument(pdfDoc, onProgress) {
    const entries = [];
    const gagal = [];
    const peringatan = [];
    const total = pdfDoc.numPages;
    for (let p = 1; p <= total; p++) {
      if (onProgress) onProgress(p, total);
      try {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const res = parseLabelPage(itemsFromTextContent(tc), { pageWidth: vp.width });
        if (res.ok) {
          entries.push({ page: p, order: res.order });
          for (const w of res.warnings) peringatan.push(`Halaman ${p}: ${w}`);
        } else {
          gagal.push({ page: p, reason: res.reason });
        }
        if (typeof page.cleanup === 'function') page.cleanup();
      } catch (e) {
        gagal.push({ page: p, reason: 'gagal dibaca: ' + (e && e.message ? e.message : e) });
      }
    }
    const d = dedupeOrders(entries);
    return {
      total_halaman: total,
      orders: d.orders.map((e) => ({ ...e.order, page: e.page })),
      gagal,
      duplikat_di_file: d.duplikat,
      peringatan: peringatan.concat(d.peringatan),
    };
  }

  return { itemsFromTextContent, groupLines, parseLabelPage, dedupeOrders, parsePdfDocument };
});
