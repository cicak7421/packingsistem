// Memutar kalimat suara dari potongan rekaman (/sounds/voice/<nama>.mp3).
// Server mengirim daftar nama klip (contoh: ["pesanannya","dua","puluh","pcs","ya"]).
// Klip di-decode, disambung jadi satu rekaman WAV di memori, lalu diputar lewat <audio>
// (jalur "media": tetap bunyi walau HP mode silent/getar, dan sambungan antar kata mulus).
// Kalau ada klip yang hilang / gagal dimuat -> play() mengembalikan false supaya pemanggil
// bisa jatuh ke cadangan (TTS bawaan HP, lalu mp3 sukses biasa).
(function () {
  const BASE = '/sounds/voice/';
  const GAP = 0.015;      // detik, jeda tipis antar kata
  const PAUSE = 0.22;     // detik, untuk token "_"
  const ALL = [
    'nol','satu','dua','tiga','empat','lima','enam','tujuh','delapan','sembilan',
    'sepuluh','sebelas','belas','puluh','seratus','ratus','seribu','ribu',
    'pesanannya','pcs','paket','ya','dan','jenis-barang','total',
  ].concat('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => 'l-' + c));

  let ctx = null;
  const clipCache = new Map();   // nama -> Promise<{data: Float32Array, rate: number}>
  const wavCache = new Map();    // kunci klip -> blob URL (maks 40)
  const el = new Audio();
  el.preload = 'auto';
  el.volume = 1.0;
  let playToken = 0;

  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('no AudioContext');
      ctx = new AC();
    }
    return ctx;
  }

  function decode(buf) {
    const c = getCtx();
    return new Promise((resolve, reject) => {
      // bentuk callback dipakai karena Safari lama belum mendukung versi Promise
      const p = c.decodeAudioData(buf, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
  }

  function loadClip(name) {
    if (!clipCache.has(name)) {
      const p = fetch(BASE + name + '.mp3')
        .then((r) => { if (!r.ok) throw new Error('klip ' + name + ' tidak ada'); return r.arrayBuffer(); })
        .then(decode)
        .then((ab) => ({ data: ab.getChannelData(0), rate: ab.sampleRate }));
      p.catch(() => clipCache.delete(name)); // boleh dicoba lagi nanti
      clipCache.set(name, p);
    }
    return clipCache.get(name);
  }

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function build(clips) {
    const key = clips.join(',');
    if (wavCache.has(key)) return wavCache.get(key);
    const parts = await Promise.all(clips.map((n) => (n === '_' ? null : loadClip(n))));
    const rate = (parts.find(Boolean) || { rate: 44100 }).rate;
    let total = 0;
    parts.forEach((p) => { total += p ? p.data.length + Math.round(GAP * rate) : Math.round(PAUSE * rate); });
    const out = new Float32Array(total);
    let pos = 0;
    parts.forEach((p) => {
      if (!p) { pos += Math.round(PAUSE * rate); return; }
      out.set(p.data, pos);   // semua klip se-rate (dibuat satu skrip); decode mengikuti rate context
      pos += p.data.length + Math.round(GAP * rate);
    });
    const url = URL.createObjectURL(encodeWav(out, rate));
    if (wavCache.size >= 40) {
      const first = wavCache.keys().next().value;
      URL.revokeObjectURL(wavCache.get(first));
      wavCache.delete(first);
    }
    wavCache.set(key, url);
    return url;
  }

  window.VoicePlayer = {
    // Muat semua klip di belakang layar supaya scan pertama gak telat.
    preload() { ALL.forEach((n) => loadClip(n).catch(() => {})); },

    // Panggil dari sentuhan user pertama (syarat autoplay iOS/Chrome).
    unlock() {
      try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch (e) { /* abaikan */ }
      try {
        if (!el.src) el.src = URL.createObjectURL(encodeWav(new Float32Array(800), 8000)); // rekaman hening buat memancing izin play
        el.muted = true;
        const p = el.play();
        const reset = () => { el.pause(); el.muted = false; };
        if (p && p.then) p.then(reset).catch(() => { el.muted = false; }); else reset();
      } catch (e) { /* abaikan */ }
    },

    // true = suara mulai diputar. false = ada klip hilang / browser menolak -> pakai cadangan.
    async play(clips) {
      if (!Array.isArray(clips) || clips.length === 0) return false;
      const token = ++playToken;
      try {
        const url = await build(clips);
        if (token !== playToken) return true;   // ada scan lebih baru, yang ini dilewati
        el.pause();
        el.muted = false;
        el.volume = 1.0;
        el.src = url;
        await el.play();
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  // Mulai muat klip setelah halaman siap
  if (document.readyState === 'complete') setTimeout(window.VoicePlayer.preload, 300);
  else window.addEventListener('load', () => setTimeout(window.VoicePlayer.preload, 300));
})();
