// Pemuatan library `xlsx` secara malas (lazy).
// `xlsx` itu berat (~1 MB). Karena SEMUA route jalan di satu serverless function, kalau
// di-require di atas file route, setiap cold start (login, dashboard, scan packing, dst)
// ikut menanggung biaya load-nya padahal cuma import/export Excel yang butuh. Dengan Proxy
// ini, library baru benar-benar dimuat saat XLSX.* dipakai pertama kali.
let lib = null;
module.exports = new Proxy({}, {
  get(_target, prop) {
    if (!lib) lib = require('xlsx');
    return lib[prop];
  },
});
