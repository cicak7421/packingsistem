// Flowmua LIVE: dashboard update sendiri tanpa reload.
//  1. Tiap LIVE_SYNC_MS (2 menit) minta server cek batch kecil resi ke web kurir
//     (POST /api/orders/live-sync). Kalau ada paket yang baru di-pickup / diterima,
//     muncul notifikasi + ringkasan "aktivitas kurir" (1 baris, klik buat lihat daftarnya)
//     dan tabel langsung diperbarui.
//  2. Tiap REFRESH_MS (45 detik) angka & tabel dashboard ditarik ulang diam-diam, jadi
//     perubahan dari orang lain (scan packing, import, cron GitHub Actions) ikut kelihatan.
// Semua berhenti otomatis saat tab browser tidak terlihat (hemat kuota & baterai).
(function () {
  'use strict';
  if (window.__flowmuaLive) return;
  window.__flowmuaLive = true;

  const LIVE_SYNC_MS = 120000;
  const REFRESH_MS = 45000;
  const LOG_MAX = 50; // riwayat aktivitas kurir yang disimpan selama halaman terbuka
  const PAUSE_KEY = 'flowmua_live_paused';

  const user = typeof getUser === 'function' ? getUser() : null;
  if (!user || !['admin', 'cs'].includes(user.role)) return;

  let paused = false;
  try { paused = localStorage.getItem(PAUSE_KEY) === '1'; } catch (e) { /* abaikan */ }
  let syncing = false;
  let lastSyncAt = null;
  let lastRefreshAt = Date.now();
  let bar, feed;
  let log = []; // { no_resi, kurir, status, info, at } -- terbaru di depan

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (d) => d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (t) => {
    if (!t) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' dtk lalu';
    const m = Math.round(s / 60);
    return m < 60 ? m + ' mnt lalu' : Math.round(m / 60) + ' jam lalu';
  };

  function dashboardVisible() {
    const p = document.getElementById('panel-dashboard');
    return !!p && p.style.display !== 'none' && !document.hidden;
  }
  function userBusy() {
    // Jangan ganggu kalau ada modal terbuka atau ada pesanan yang lagi dicentang.
    const modalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some((m) => m.style.display && m.style.display !== 'none');
    const bulk = document.getElementById('bulkActionBar');
    return modalOpen || (bulk && bulk.style.display && bulk.style.display !== 'none');
  }

  function mount() {
    const panel = document.getElementById('panel-dashboard');
    if (!panel || bar) return;
    const sub = panel.querySelector('.page-subtitle');
    bar = document.createElement('div');
    bar.className = 'live-bar';
    bar.innerHTML = `
      <span class="live-pill"><span class="live-dot"></span><span class="live-label">Live</span></span>
      <span class="live-meta">Sinkron kurir: <b data-live="sync">—</b> · Data: <b data-live="refresh">baru</b></span>
      <button type="button" data-live="now" title="Cek status kurir sekarang">Sync sekarang</button>
      <button type="button" data-live="toggle" title="Jeda / lanjutkan update otomatis"></button>`;
    // Aktivitas kurir: SATU baris ringkas (jumlah diterima / di-pickup + jam terakhir). Daftar
    // lengkapnya baru muncul kalau diklik, jadi gak menuhin layar tiap ada update.
    feed = document.createElement('details');
    feed.className = 'live-log';
    feed.hidden = true;
    feed.innerHTML = '<summary><span class="live-log-title">Aktivitas kurir</span><span class="live-log-counts" aria-live="polite"></span><span class="live-log-last"></span><button type="button" class="live-log-clear" title="Kosongkan daftar aktivitas">Bersihkan</button></summary><div class="live-log-list"></div>';
    feed.querySelector('.live-log-clear').onclick = (e) => { e.preventDefault(); log = []; feed.open = false; renderFeed(); };
    // Hero: judul + subjudul di kiri, status LIVE di kanan.
    const title = panel.querySelector('.page-title');
    const hero = document.createElement('div');
    hero.className = 'ops-hero';
    const left = document.createElement('div');
    left.className = 'ops-hero-left';
    if (title) { title.before(hero); left.appendChild(title); }
    else panel.prepend(hero);
    if (sub) left.appendChild(sub);
    hero.appendChild(left);
    hero.appendChild(bar);
    hero.after(feed);
    bar.querySelector('[data-live="now"]').onclick = () => runSync(true);
    bar.querySelector('[data-live="toggle"]').onclick = () => {
      paused = !paused;
      try { localStorage.setItem(PAUSE_KEY, paused ? '1' : '0'); } catch (e) { /* abaikan */ }
      render();
      if (!paused) { refreshData(); runSync(false); }
    };
    render();
  }

  function render(state) {
    if (!bar) return;
    bar.classList.toggle('is-paused', paused);
    bar.classList.toggle('is-syncing', state === 'syncing');
    bar.classList.toggle('is-error', state === 'error');
    bar.querySelector('.live-label').textContent = paused ? 'Jeda' : state === 'syncing' ? 'Sync…' : state === 'error' ? 'Offline' : 'Live';
    bar.querySelector('[data-live="sync"]').textContent = lastSyncAt ? ago(lastSyncAt) : 'menunggu';
    bar.querySelector('[data-live="refresh"]').textContent = ago(lastRefreshAt);
    bar.querySelector('[data-live="toggle"]').textContent = paused ? 'Lanjutkan' : 'Jeda';
    bar.querySelector('[data-live="now"]').disabled = syncing;
  }

  function pushFeed(changes) {
    if (!feed || !changes.length) return;
    const at = Date.now();
    for (const c of changes) {
      log = log.filter((x) => x.no_resi !== c.no_resi); // resi yang sama cukup tampil sekali (status terbaru)
      log.unshift({ no_resi: c.no_resi, kurir: c.kurir, status: c.status, info: c.info, at });
    }
    log = log.slice(0, LOG_MAX);
    renderFeed();
  }

  function renderFeed() {
    if (!feed) return;
    feed.hidden = !log.length;
    if (!log.length) return;
    const delivered = log.filter((x) => x.status === 'diterima').length;
    const picked = log.length - delivered;
    const parts = [];
    if (delivered) parts.push(`<span class="badge badge-ok">${delivered} diterima</span>`);
    if (picked) parts.push(`<span class="badge badge-warn">${picked} di-pickup</span>`);
    feed.querySelector('.live-log-counts').innerHTML = parts.join('');
    feed.querySelector('.live-log-last').textContent = 'terakhir ' + hhmm(new Date(log[0].at));
    feed.querySelector('.live-log-list').innerHTML = log.map((x) => {
      const label = x.status === 'diterima' ? '<span class="badge badge-ok">Diterima</span>' : '<span class="badge badge-warn">Di-pickup</span>';
      return `<div class="live-log-item" title="${esc(x.info || '')}">${label}<code>${esc(x.no_resi)}</code><span class="hint">${esc(x.kurir || '')}</span><span class="live-log-time">${hhmm(new Date(x.at))}</span></div>`;
    }).join('');
  }

  // Tarik ulang angka + tabel tanpa efek loading yang berkedip.
  function refreshData() {
    if (typeof loadDashboard !== 'function' || !dashboardVisible() || userBusy()) return;
    const tb = document.getElementById('pendingTable');
    if (tb) tb.classList.add('live-refresh');
    try { if (typeof shippingSummaryLastLoaded !== 'undefined') shippingSummaryLastLoaded = 0; } catch (e) { /* abaikan */ }
    try { if (typeof platformSummaryLastLoaded !== 'undefined') platformSummaryLastLoaded = 0; } catch (e) { /* abaikan */ }
    try { if (typeof sessionStorage !== 'undefined') Object.keys(sessionStorage).filter((k) => k.indexOf('flowmua_swr:/orders/summary') === 0).forEach((k) => sessionStorage.removeItem(k)); } catch (e) { /* abaikan */ }
    const page = typeof dashboardPage !== 'undefined' ? dashboardPage : 1;
    Promise.resolve(loadDashboard(page)).finally(() => {
      lastRefreshAt = Date.now();
      setTimeout(() => tb && tb.classList.remove('live-refresh'), 1200);
      render();
    });
  }

  async function runSync(manual) {
    if (syncing || (!manual && (paused || !dashboardVisible()))) return;
    syncing = true;
    render('syncing');
    let state;
    try {
      const r = await api('/orders/live-sync', { method: 'POST', background: true });
      lastSyncAt = Date.now();
      const changes = r.changes || [];
      if (changes.length) {
        pushFeed(changes);
        const picked = changes.filter((c) => c.status !== 'diterima').length;
        const delivered = changes.length - picked;
        const parts = [];
        if (picked) parts.push(`${picked} paket baru di-pickup kurir`);
        if (delivered) parts.push(`${delivered} paket diterima pembeli`);
        if (typeof toast === 'function') toast('Update kurir: ' + parts.join(', ') + '.', 'ok');
        refreshData();
      } else if (manual && typeof toast === 'function') {
        toast(r.candidates ? `Sudah dicek ${r.checked} resi, belum ada perubahan status.` : 'Semua resi sudah dicek barusan. Belum ada yang perlu disinkron.', 'info');
      }
    } catch (e) {
      state = 'error';
      if (manual && typeof toast === 'function') toast(e.message || 'Sinkronisasi gagal', 'err');
    } finally {
      syncing = false;
      render(state);
    }
  }

  function start() {
    mount();
    if (!bar) return;
    setInterval(() => render(), 15000);
    const every = typeof visibleInterval === 'function' ? visibleInterval : (fn, ms) => setInterval(fn, ms);
    every(() => { if (!paused && Date.now() - lastRefreshAt >= REFRESH_MS - 1000) refreshData(); }, REFRESH_MS);
    every(() => runSync(false), LIVE_SYNC_MS);
    setTimeout(() => runSync(false), 4000); // sync pertama sesaat setelah dashboard tampil
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
