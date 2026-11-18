# pdf.js (vendored)

Pembaca PDF untuk fitur **Import Pesanan -> Advance Fulfilment** (lihat `js/afParser.js`).
Di-host sendiri di sini (bukan CDN) supaya fitur tetap jalan walau CDN diblokir/offline.

- Paket: `pdfjs-dist` 6.2.108, build **legacy** (`legacy/build/pdf.min.mjs` + `pdf.worker.min.mjs`) -- jalan di browser yang agak lama juga.
- Lisensi: Apache-2.0 (Mozilla Foundation), lihat `LICENSE`.
- Cara update: ambil dua file di atas dari versi `pdfjs-dist` yang lebih baru, timpa di folder ini.
