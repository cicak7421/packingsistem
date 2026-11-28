const user = requireLogin(['packing', 'admin']);
if (user) renderAppShell('packing');

let scanning = true;
let html5QrCode;

// ---------- Mode scan: 'packing' (bawaan) atau 'retur' (paket balik ke gudang) ----------
// Sengaja TIDAK diingat antar kunjungan: tiap buka halaman selalu mulai dari Packing, supaya
// gak ada paket yang kecatat retur gara-gara mode kemarin masih nyangkut.
let scanMode = 'packing';
let returKondisi = 'sesuai'; // 'sesuai' | 'tidak_sesuai' -- hasil cek packer; stok baru berubah setelah divalidasi admin/CS

function setScanMode(mode) {
  scanMode = mode === 'retur' ? 'retur' : 'packing';
  document.body.classList.toggle('mode-retur', scanMode === 'retur');
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === scanMode));
  document.getElementById('returOptions').style.display = scanMode === 'retur' ? 'block' : 'none';
  document.getElementById('historyTitle').textContent = scanMode === 'retur' ? 'Riwayat retur hari ini' : 'Riwayat scan hari ini';
  document.getElementById('resultArea').innerHTML = '';
  setScanStatus(scanMode === 'retur' ? 'Siap scan paket RETUR...' : 'Siap scan...');
  loadHistory();
}

function setReturKondisi(k) {
  returKondisi = k === 'tidak_sesuai' ? 'tidak_sesuai' : 'sesuai';
  document.querySelectorAll('#returKondisiSeg button').forEach((b) => b.classList.toggle('active', b.dataset.kondisi === returKondisi));
}

function toggleManual() {
  const el = document.getElementById('manualInput');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') document.getElementById('manualValue').focus();
}

function setScanStatus(text) {
  const el = document.getElementById('scanStatus');
  el.innerHTML = `<span class="dot"></span> ${text}`;
}

// ---------- Suara notifikasi scan ----------
// Berhasil -> jokowi-saya-akan-lawan.mp3 | Gagal (duplikat / gak ketemu / error) -> 0-salah-e-salah.mp3
// Sengaja pakai <audio> (bukan Web Audio API) karena <audio> jalan di jalur "media":
//  - iOS: tetap bunyi walau switch silent aktif (Web Audio API justru ikut ke-mute)
//  - Android: mode silent/getar cuma matiin ringtone & notifikasi, suara media tetap jalan
// Volume elemen dikunci 1.0 (maksimal) dan sengaja TIDAK ada tombol mute di halaman ini.
// Catatan: browser gak bisa ngatur volume media sistem HP -- kalau volume media HP di-nol-kan
// pakai tombol volume, suara tetap gak akan keluar.
const SOUNDS = {
  ok: new Audio('/sounds/jokowi-saya-akan-lawan.mp3'),
  fail: new Audio('/sounds/0-salah-e-salah.mp3'),
};
Object.values(SOUNDS).forEach((a) => { a.preload = 'auto'; a.volume = 1.0; });

let audioUnlocked = false;
// Browser mewajibkan ada sentuhan user dulu sebelum audio boleh diputar otomatis.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  if (window.VoicePlayer) VoicePlayer.unlock();
  Object.values(SOUNDS).forEach((a) => {
    a.muted = true;
    const p = a.play();
    const reset = () => { a.pause(); a.currentTime = 0; a.muted = false; };
    if (p && p.then) p.then(reset).catch(() => { a.muted = false; audioUnlocked = false; });
    else reset();
  });
}
['pointerdown', 'touchend', 'click', 'keydown'].forEach((evt) =>
  document.addEventListener(evt, unlockAudio, { once: false, passive: true })
);

function beepFallback(success) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = success ? 880 : 220;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.12 : 0.18));
  } catch (e) { /* gapapa dilewat */ }
}

function feedback(success) {
  if (navigator.vibrate) navigator.vibrate(success ? 90 : [70, 60, 70]);
  const snd = success ? SOUNDS.ok : SOUNDS.fail;
  const other = success ? SOUNDS.fail : SOUNDS.ok;
  other.pause(); other.currentTime = 0;
  snd.muted = false;
  snd.volume = 1.0;
  snd.currentTime = 0;
  const p = snd.play();
  if (p && p.catch) p.catch(() => beepFallback(success));
}

// ---------- Suara jumlah pesanan ("Pesanannya 50 pcs ya") ----------
// Urutan: (1) rekaman potongan suara /sounds/voice/*.mp3 yang disambung otomatis (js/voicePlayer.js)
// -> (2) kalau klip gak ada/gagal: TTS bawaan HP -> (3) kalau itu juga gagal: mp3 sukses biasa.
// TTS: dibacakan otomatis lewat speechSynthesis (suara bahasa Indonesia bawaan HP/browser),
// jadi angka berapa pun langsung bisa dibaca tanpa rekaman per angka. Kalau browser
// gak punya TTS / info jumlah kosong, jatuh ke mp3 sukses biasa.
const TTS = 'speechSynthesis' in window ? window.speechSynthesis : null;
let idVoice = null;
function pickVoice() {
  if (!TTS) return;
  const voices = TTS.getVoices();
  idVoice = voices.find((v) => /^id[-_]ID/i.test(v.lang)) || voices.find((v) => /^id/i.test(v.lang)) || null;
}
if (TTS) { pickVoice(); TTS.addEventListener && TTS.addEventListener('voiceschanged', pickVoice); }

// Pancing TTS sekali saat ada sentuhan pertama (syarat autoplay di iOS/Chrome)
['pointerdown', 'touchend', 'click', 'keydown'].forEach((evt) =>
  document.addEventListener(evt, () => {
    if (!TTS || TTS._primed) return;
    TTS._primed = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    TTS.speak(u);
  }, { passive: true })
);

let currentUtter = null; // disimpan global: Chrome bisa "membuang" utterance yang kena garbage collector
// Mengembalikan Promise<boolean>: true kalau ada suara jumlah yang mulai diputar.
async function speakQuantity(speech) {
  if (!speech) return false;
  if (speech.clips && window.VoicePlayer) {
    if (await VoicePlayer.play(speech.clips)) return true;
  }
  return speakWithTTS(speech);
}

function speakWithTTS(speech) {
  if (!TTS || !speech || !speech.speech) return false;
  let started = false;
  let fellBack = false;
  // TTS yang gagal itu sering DIAM-DIAM (gak ada error / exception), makanya dijaga pakai
  // event: kalau suara gak mulai dalam 1.2 detik atau ada onerror -> bunyikan mp3 cadangan.
  const fallback = () => { if (started || fellBack) return; fellBack = true; feedback(true); };
  try {
    pickVoice();
    const u = new SpeechSynthesisUtterance(speech.speech);
    u.lang = 'id-ID';
    if (idVoice) u.voice = idVoice;
    u.rate = 0.95;
    u.volume = 1.0;
    u.onstart = () => { started = true; };
    u.onerror = fallback;
    currentUtter = u;
    const go = () => { try { TTS.resume(); TTS.speak(u); } catch (e) { fallback(); } };
    // cancel() yang langsung disusul speak() bikin Chrome/Android sering mengabaikan speak-nya,
    // jadi cancel hanya kalau memang masih ada antrean, lalu speak dikasih jeda sebentar.
    if (TTS.speaking || TTS.pending) { TTS.cancel(); setTimeout(go, 80); } else { go(); }
    setTimeout(fallback, 1200);
    return true;
  } catch (e) { return false; }
}

async function onScanSuccess(decodedText) {
  if (!scanning) return;
  scanning = false;
  await submitScan(decodedText);
}

async function submitScan(value) {
  value = (value || '').trim();
  if (!value) { scanning = true; return; }
  setScanStatus('Memproses...');
  if (scanMode === 'retur') return submitRetur(value);
  try {
    const data = await api('/packing/scan', { method: 'POST', body: JSON.stringify({ value }) });
    if (navigator.vibrate) navigator.vibrate(90);
    speakQuantity(data.speech).then((ok) => { if (!ok) feedback(true); });
    renderResult('ok', data.message, data.order, data.speech);
  } catch (e) {
    feedback(false);
    renderResult(e.status || 'danger', e.message, e.data?.order);
  }
  const manualEl = document.getElementById('manualValue');
  if (manualEl) manualEl.value = '';
  loadHistory();
  // Jeda singkat biar gak double-scan barcode yang sama, lalu langsung siap lagi otomatis
  const cooldown = 900;
  setTimeout(() => {
    scanning = true;
    setScanStatus('Siap scan berikutnya...');
  }, cooldown);
}

// Mode Retur: catat paket balik. Packer cuma pilih hasil cek (Sesuai / Tidak sesuai); ALASAN retur diisi & dilihat
// admin/CS saja (tab Retur di dashboard), tidak tampil di halaman ini.
async function submitRetur(value) {
  try {
    const data = await api('/retur/scan', { method: 'POST', body: JSON.stringify({ value, kondisi: returKondisi }) });
    feedback(true);
    renderResult('ok', data.message, data.order, null, 'retur');
  } catch (e) {
    feedback(false);
    renderResult(e.status || 'danger', e.message, e.data?.order);
  }
  const manualEl = document.getElementById('manualValue');
  if (manualEl) manualEl.value = '';
  loadHistory();
  setTimeout(() => {
    scanning = true;
    setScanStatus(scanMode === 'retur' ? 'Siap scan paket RETUR berikutnya...' : 'Siap scan berikutnya...');
  }, 900);
}

function escHtml(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderResult(status, message, order, speech, kind) {
  const area = document.getElementById('resultArea');
  let cls = 'result-ok', icon = kind === 'retur' ? '↩️' : '✅';
  if (status !== 'ok') { cls = 'result-danger'; icon = '⚠️'; }
  // Paket telat (umur pesanan lewat batas kirim): kotak hasil jadi kuning-merah + peringatan jelas
  // supaya packer tahu paket ini harus ikut dikirim hari ini.
  const late = status === 'ok' && order && order.late && order.late.is_late ? order.late : null;
  if (late) { cls = 'result-warn'; icon = late.level === 'critical' ? '🔥' : '🚨'; }
  area.innerHTML = `
    <div class="result-box ${cls}">
      <div class="icon">${icon}</div>
      <div class="msg">${escHtml(message)}</div>
      ${speech ? `<div class="msg" style="font-size:1.25em;font-weight:700;margin-top:6px;">🔊 ${escHtml(speech.text)}</div>` : ''}
      ${speech && speech.items && speech.items.length > 3 ? `<div class="sub" style="text-align:left;">${speech.items.map((i) => `• ${escHtml(i.code)} — ${escHtml(i.qtyText)}`).join('<br>')}</div>` : ''}
      ${late ? `<div style="margin:6px 0 4px;"><span class="badge badge-late${late.level === 'critical' ? ' badge-critical' : ''}">${late.level === 'critical' ? 'KRITIS' : 'TELAT'} ${escHtml(late.age_label)}</span></div>` : ''}
      ${order ? `<div class="sub">No. Pesanan: ${escHtml(order.no_pesanan)}<br>No. Resi: ${escHtml(order.no_resi || '-')}</div>` : ''}
    </div>
  `;
}

async function loadReturHistory() {
  const list = document.getElementById('historyList');
  try {
    const data = await api('/retur/my-today');
    if (scanMode !== 'retur') return;
    document.getElementById('todayCount').textContent = data.returs.length;
    if (data.ready === false) {
      list.innerHTML = '<div class="empty-state">Fitur retur belum aktif: admin perlu menjalankan migration-retur.sql di Supabase dulu.</div>';
      return;
    }
    if (!data.returs.length) {
      list.innerHTML = '<div class="empty-state">Belum ada retur hari ini</div>';
      return;
    }
    list.innerHTML = data.returs.slice(0, 15).map((r) => {
      const rusak = ['tidak_sesuai', 'rusak'].includes(r.retur_kondisi);
      const time = new Date(r.retur_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return `<div class="history-item">
        <div class="row">
          <span>${escHtml(r.no_resi || r.no_pesanan)}</span>
          <span class="badge ${rusak ? 'badge-danger' : 'badge-ok'}">${rusak ? 'Tidak sesuai' : 'Sesuai'}</span>
        </div>
        <div class="time">${time}</div>
      </div>`;
    }).join('');
  } catch (e) { /* diamkan */ }
}

async function loadHistory() {
  if (scanMode === 'retur') return loadReturHistory();
  try {
    const data = await api('/packing/my-scans-today');
    if (scanMode !== 'packing') return;
    document.getElementById('todayCount').textContent = data.scans.filter((s) => s.result === 'ok').length;
    const list = document.getElementById('historyList');
    if (data.scans.length === 0) {
      list.innerHTML = '<div class="empty-state">Belum ada scan hari ini</div>';
      return;
    }
    list.innerHTML = data.scans.slice(0, 15).map((s) => {
      const badge = s.result === 'ok' ? 'badge-ok' : 'badge-warn';
      const label = s.result === 'ok' ? 'Berhasil' : 'Duplikat';
      const time = new Date(s.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return `<div class="history-item">
        <div class="row">
          <span>${s.no_pesanan || s.scanned_value}</span>
          <span class="badge ${badge}">${label}</span>
        </div>
        <div class="time">${time}</div>
      </div>`;
    }).join('');
  } catch (e) { /* diamkan */ }
}

// Library scanner (html5-qrcode) dimuat belakangan & non-blocking, bukan di <head> --
// dulu halaman gak tampil sama sekali sampai unpkg selesai merespons. Kalau CDN pertama
// lambat/gagal, otomatis coba CDN cadangan.
const QR_LIB_URLS = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
];
let qrLibPromise = null;
function loadQrLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (qrLibPromise) return qrLibPromise;
  const tryLoad = (i) => new Promise((resolve, reject) => {
    if (i >= QR_LIB_URLS.length) return reject(new Error('Library scanner gagal dimuat'));
    const el = document.createElement('script');
    el.src = QR_LIB_URLS[i];
    el.async = true;
    const timer = setTimeout(() => { el.remove(); tryLoad(i + 1).then(resolve, reject); }, 8000);
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); el.remove(); tryLoad(i + 1).then(resolve, reject); };
    document.head.appendChild(el);
  });
  qrLibPromise = tryLoad(0).catch((e) => { qrLibPromise = null; throw e; });
  return qrLibPromise;
}

async function startScanner() {
  try {
    await loadQrLib();
  } catch (e) {
    document.getElementById('reader').innerHTML = '<div class="empty-state">Scanner gagal dimuat (cek koneksi internet). Gunakan input manual di bawah.</div>';
    toggleManual();
    return;
  }

  // PENTING: barcode di label ekspedisi (No. Resi/No. Pesanan) itu barcode LINEAR/1D
  // (CODE_128 kebanyakan, kadang CODE_39/ITF/EAN tergantung kurir/percetakan) -- BEDA
  // sama QR code yang kotak. Tanpa `formatsToSupport` eksplisit + tanpa native barcode
  // detector, library ini sering gagal/lambat baca barcode 1D meski QR code jalan mulus,
  // makanya sebelumnya kerasa "gak kebaca" pas discan padahal input manual (yang cuma
  // baca teks No. Pesanan-nya langsung) tetap jalan normal.
  html5QrCode = new Html5Qrcode("reader", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.QR_CODE,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93,
      Html5QrcodeSupportedFormats.CODABAR,
      Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
    ],
    verbose: false,
    // Kalau browser-nya support (Chrome Android umumnya support), pakai native
    // BarcodeDetector API -- jauh lebih akurat & cepat buat barcode 1D dibanding
    // decoder JS (ZXing) bawaan library ini. Kalau gak support, otomatis fallback ke
    // decoder biasa, jadi aman di-set true terus.
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  // Kotak scan diperbesar & dilebarin (gak kotak sama sisi) -- barcode 1D biasanya
  // memanjang horizontal, jadi kalau kotaknya kekecilan/terlalu persegi, sebagian
  // garis barcode kepotong di luar area scan dan gagal ke-decode.
  const config = { fps: 15, qrbox: { width: 300, height: 140 }, aspectRatio: 1.7777778 };
  Html5Qrcode.getCameras().then((cameras) => {
    if (!cameras || cameras.length === 0) {
      document.getElementById('reader').innerHTML = '<div class="empty-state">Kamera tidak ditemukan. Gunakan input manual di bawah.</div>';
      toggleManual();
      return;
    }
    const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];
    html5QrCode.start(backCam.id, config, onScanSuccess).catch(() => {
      document.getElementById('reader').innerHTML = '<div class="empty-state">Gagal membuka kamera. Cek izin kamera di browser, atau gunakan input manual.</div>';
      toggleManual();
    });
  }).catch(() => {
    document.getElementById('reader').innerHTML = '<div class="empty-state">Tidak bisa mengakses kamera. Gunakan input manual di bawah.</div>';
    toggleManual();
  });
}

document.getElementById('manualValue')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitScan(e.target.value);
});

if (user) {
  startScanner();
  loadHistory();
}
