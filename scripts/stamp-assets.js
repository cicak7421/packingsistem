// Menempelkan "sidik jari" (hash isi file) ke referensi JS & CSS di semua file .html,
// contoh: <script src="js/api.js?v=3f9a1c2b"> . Dengan begitu file JS/CSS boleh di-cache
// browser SETAHUN (lihat headers di vercel.json) dan otomatis ter-update begitu isinya
// berubah, karena URL-nya ikut berubah.
//
// Jalankan SETIAP KALI habis mengubah file di folder js/ atau css/:
//     npm run stamp
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const hashOf = (file) => crypto.createHash('md5').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 8);

let changed = 0;
for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
  const file = path.join(root, name);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/(src|href)="((?:js|css)\/[^"?]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g, (m, attr, rel) => {
    if (rel.startsWith('js/vendor/') || !fs.existsSync(path.join(root, rel))) return m;
    return `${attr}="${rel}?v=${hashOf(rel)}"`;
  });
  if (after !== before) { fs.writeFileSync(file, after); changed++; }
}
console.log(`Selesai. ${changed} file HTML diperbarui.`);
