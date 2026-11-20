const API_BASE = '/api';

// Penyimpanan sesi: tahan terhadap localStorage yang diblokir (mode privat / browser dalam
// aplikasi) atau datanya rusak. Fallback ke memori + sessionStorage supaya login tetap jalan.
const __memSession = {};
function __storeGet(k) {
  try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* abaikan */ }
  try { const v = sessionStorage.getItem(k); if (v !== null) return v; } catch (e) { /* abaikan */ }
  return __memSession[k] || null;
}
function __storeSet(k, v) {
  __memSession[k] = v;
  try { localStorage.setItem(k, v); return; } catch (e) { /* abaikan */ }
  try { sessionStorage.setItem(k, v); } catch (e) { /* abaikan */ }
}
function __storeDel(k) {
  delete __memSession[k];
  try { localStorage.removeItem(k); } catch (e) { /* abaikan */ }
  try { sessionStorage.removeItem(k); } catch (e) { /* abaikan */ }
}
function getToken() { return __storeGet('flowmua_token'); }
function getUser() {
  const raw = __storeGet('flowmua_user');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { __storeDel('flowmua_user'); __storeDel('flowmua_token'); return null; }
}
function setSession(token, user) {
  __storeSet('flowmua_token', token);
  __storeSet('flowmua_user', JSON.stringify(user));
}
function clearSession() {
  __storeDel('flowmua_token');
  __storeDel('flowmua_user');
}

// ---------- Pemanggil API ----------
// Peningkatan performa & keandalan:
// - GET yang identik dan lagi berjalan DIGABUNG jadi satu request (gak dobel nembak server).
// - Timeout 25 detik supaya halaman gak nyangkut selamanya di "Memuat..." kalau jaringan putus.
// - GET otomatis diulang 1x kalau kena error sementara (jaringan putus, 502/503/504 = cold
//   start serverless) -- jadi user gak perlu refresh manual cuma gara-gara server baru "bangun".
const API_TIMEOUT_MS = 25000;
const apiInflight = new Map();

function apiErrorFrom(res, data, rawText) {
  const detail = data.error || data.message
    || (res.status === 404 ? 'Endpoint tidak ditemukan (404) — kemungkinan backend belum ter-deploy'
      : res.status === 413 ? 'File terlalu besar untuk server (413)'
      : `Terjadi kesalahan di server (HTTP ${res.status})${rawText ? ': ' + rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : ''}`);
  const err = new Error(detail);
  err.status = res.status;
  err.data = data;
  return err;
}

async function apiOnce(path, opts) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Upload file besar (FormData) boleh lebih lama dari request biasa.
  const timeoutMs = opts.body instanceof FormData ? 120000 : API_TIMEOUT_MS;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(API_BASE + path, { ...opts, headers, signal: opts.signal || (ctrl && ctrl.signal) });
  } catch (e) {
    if (e && e.name === 'AbortError') { const te = new Error('Server terlalu lama merespons, coba lagi'); te.transient = true; throw te; }
    const ne = new Error('Koneksi internet bermasalah, coba lagi'); ne.transient = true; throw ne;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data;
  let rawText = '';
  try { rawText = await res.text(); data = JSON.parse(rawText); } catch (e) { data = {}; }

  // 401 dari endpoint login = salah username/password, BUKAN sesi habis: tampilkan pesannya,
  // jangan reload halaman (sebelumnya pesan error hilang dan user cuma lihat halaman refresh).
  if (res.status === 401 && path !== '/auth/login') {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('Sesi berakhir');
  }
  if (!res.ok) {
    const err = apiErrorFrom(res, data, rawText);
    if ([502, 503, 504].includes(res.status)) err.transient = true;
    throw err;
  }
  return data;
}

async function apiRequest(path, opts) {
  const isGet = !opts.method || String(opts.method).toUpperCase() === 'GET';
  try {
    return await apiOnce(path, opts);
  } catch (e) {
    if (isGet && e.transient) {
      await new Promise((r) => setTimeout(r, 700));
      return apiOnce(path, opts);
    }
    throw e;
  }
}

function api(path, opts = {}) {
  const isGet = !opts.method || String(opts.method).toUpperCase() === 'GET';
  if (!isGet || opts.signal) return apiRequest(path, opts);
  if (apiInflight.has(path)) return apiInflight.get(path);
  const p = apiRequest(path, opts).finally(() => apiInflight.delete(path));
  apiInflight.set(path, p);
  return p;
}

// Versi "stale-while-revalidate": kalau ada data tersimpan dari kunjungan sebelumnya, langsung
// dikasih ke `onData` (tampilan muncul instan), lalu data segar diambil dan dikasih lagi.
// Disimpan di sessionStorage per tab, jadi tidak pernah bocor antar akun/perangkat.
function apiSWR(path, onData) {
  const key = 'flowmua_swr:' + path;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) onData(JSON.parse(cached), true);
  } catch (e) { /* abaikan */ }
  return api(path).then((data) => {
    try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (e) { /* abaikan */ }
    onData(data, false);
    return data;
  });
}

// Jalankan fn periodik, tapi BERHENTI saat tab tidak terlihat dan langsung jalan lagi begitu
// tab dibuka. Hemat request ke server & baterai HP. Mengembalikan fungsi stop().
function visibleInterval(fn, ms) {
  let timer = null;
  const start = () => { if (!timer) timer = setInterval(fn, ms); };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const onVis = () => { if (document.hidden) stop(); else { fn(); start(); } };
  document.addEventListener('visibilitychange', onVis);
  if (!document.hidden) start();
  return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
}

// Guard: panggil di awal tiap halaman yang butuh login
function requireLogin(allowedRoles) {
  const user = getUser();
  if (!getToken() || !user) {
    window.location.href = '/login.html';
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    (window.__nativeAlert || alert).call(window, 'Akun kamu tidak punya akses ke halaman ini.');
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

// ---------- Penanda paket telat kirim (dipakai dashboard, tracking, cek pesanan) ----------
// `late` datang dari backend (computeLate di api/_lib/lateHelpers.js):
// { is_late, level: 'soon' | 'late' | 'critical' | null, age_label }
// Telat = merah solid, kritis = merah tua + ikon api, hampir telat = kuning.
function lateBadge(late, opts = {}) {
  if (!late || !late.level) return '';
  const cls = opts.tag ? ' tag-inline' : '';
  if (late.level === 'critical') return `<span class="badge badge-late badge-critical${cls}" title="Kritis: sudah ${late.age_label} sejak pesanan dibuat">\u{1F525} KRITIS ${late.age_label}</span>`;
  if (late.level === 'late') return `<span class="badge badge-late${cls}" title="Telat kirim: sudah ${late.age_label} sejak pesanan dibuat">\u{1F6A8} TELAT ${late.age_label}</span>`;
  return `<span class="badge badge-warn${cls}" title="Mendekati batas waktu kirim">\u23F3 Hampir telat ${late.age_label}</span>`;
}
function lateRowClass(o) {
  const l = o && o.late;
  return l && l.level === 'critical' ? 'row-critical' : l && l.level === 'late' ? 'row-late' : l && l.level === 'soon' ? 'row-soon' : '';
}

// Bar peringatan merah di atas semua halaman untuk admin / CS / inventory kalau ada paket
// telat, biar gak ada yang kelewat walau lagi buka halaman lain. Diperbarui tiap 2 menit.
async function loadLateAlertBar() {
  const user = getUser();
  if (!user || !['admin', 'cs', 'inventory'].includes(user.role)) return;
  let bar = document.getElementById('lateAlertBar');
  try {
    const d = await api('/cek-pesanan/late-count');
    setNavBadge('cek-pesanan', d.late_count || 0);
    if (!d.late_count) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('a');
      bar.id = 'lateAlertBar';
      bar.className = 'late-alert-bar';
      bar.href = '/cek-pesanan.html?level=all';
      const mount = document.getElementById('appShell');
      mount.parentNode.insertBefore(bar, mount.nextSibling);
    }
    const hrs = d.thresholds ? d.thresholds.late_hours : 24;
    bar.innerHTML = `<span>\u{1F6A8} <b>${d.late_count} paket TELAT kirim</b> (lewat ${hrs} jam)` +
      `${d.critical_count ? ` &middot; <b>${d.critical_count} kritis</b>` : ''}` +
      `${d.soon_count ? ` &middot; ${d.soon_count} hampir telat` : ''}</span><span class="late-alert-cta">Lihat &rarr;</span>`;
  } catch (e) { /* diamkan, bar tidak kritikal */ }
}

function logout() {
  clearSession();
  window.location.href = '/login.html';
}

// ---------- Navigasi terpusat (dipakai semua halaman biar konsisten) ----------
// Setiap halaman tinggal panggil renderAppShell(activeKey) sekali di awal.
// Desktop: sidebar kiri. HP: topbar + tab strip yang bisa digeser. `group` dipakai buat
// nyisipin garis pemisah antar kelompok menu.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html', roles: ['admin', 'cs'], group: 1, icon: 'home' },
  { key: 'import', label: 'Import Pesanan', href: '/dashboard.html?tab=import', roles: ['admin', 'cs'], group: 1, icon: 'upload' },
  { key: 'kirim-pesanan', label: 'Kirim Pesanan', href: '/dashboard.html?tab=kirim-pesanan', roles: ['admin'], group: 1, icon: 'send' },
  { key: 'cek-status', label: 'Tracking', href: '/dashboard.html?tab=cek-status', roles: ['admin', 'cs'], group: 1, icon: 'pin' },
  { key: 'cek-pesanan', label: 'Cek & Validasi', href: '/cek-pesanan.html', roles: ['admin', 'cs', 'inventory'], group: 1, icon: 'check' },
  { key: 'export', label: 'Export Data', href: '/dashboard.html?tab=export', roles: ['admin', 'cs'], group: 2, icon: 'download' },
  { key: 'performance', label: 'Performa Packing', href: '/dashboard.html?tab=performance', roles: ['admin', 'cs'], group: 2, icon: 'chart' },
  { key: 'affiliate', label: 'Affiliate', href: '/dashboard.html?tab=affiliate', roles: ['admin', 'cs'], group: 2, icon: 'users' },
  { key: 'estimasi', label: 'Estimasi Penghasilan', href: '/dashboard.html?tab=estimasi', roles: ['admin', 'cs'], group: 2, icon: 'wallet' },
  { key: 'konfigurasi', label: 'Konfigurasi Harga', href: '/dashboard.html?tab=konfigurasi', roles: ['admin', 'cs'], group: 2, icon: 'settings' },
  { key: 'packing', label: 'Scan Packing', href: '/packing.html', roles: ['admin', 'packing'], group: 3, icon: 'scan' },
  { key: 'inventory', label: 'Inventory', href: '/inventory.html', roles: ['admin', 'inventory', 'packing', 'cs'], group: 3, icon: 'box' },
  { key: 'users', label: 'Kelola Akun', href: '/dashboard.html?tab=users', roles: ['admin'], group: 4, icon: 'settings' },
];

const NAV_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 10h-5a2 2 0 0 0 0 4h5z"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  check: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 14 2 2 4-4"/>',
  chevron: '<path d="m15 6-6 6 6 6"/>',
  pack: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/><path d="m7.5 5.5 9 5"/>',
};

function navIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name] || ''}</svg>`;
}

function escapeHtmlShell(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

const ROLE_LABEL = { admin: 'Admin', cs: 'Customer Service', packing: 'Tim Packing', inventory: 'Staff Inventory' };

// Bikin sidebar (desktop) + topbar & bottom nav (HP) dan nyuntik ke elemen id="appShell"
// di awal <body>. activeKey: salah satu dari NAV_ITEMS[].key
function setNavBadge(key, n) {
  document.querySelectorAll(`[data-nav-count="${key}"]`).forEach((el) => { el.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : ''; });
}

function tickShellClock() {
  const t = document.getElementById('shellClockTime');
  const d = document.getElementById('shellClockDate');
  if (!t || !d) return;
  const now = new Date();
  t.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
  d.textContent = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
}


// ---------- Tema terang / gelap ----------
// Disimpan di localStorage ('flowmua_theme': light | dark). Kalau belum pernah dipilih, ikut pengaturan sistem.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#0b1250' : '#1b2ab4');
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('flowmua_theme', next); } catch (e) { /* abaikan */ }
}
function themeIcons() {
  return '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
    + '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
}

function toggleSidebar() {
  const on = document.body.classList.toggle('side-collapsed');
  try { localStorage.setItem('flowmua_side', on ? '1' : '0'); } catch (e) { /* abaikan */ }
  setTimeout(() => positionNavPill(false), 280);
}

function toggleNavSheet(open) {
  const el = document.getElementById('navSheet');
  if (el) el.classList.toggle('open', open);
}

// ---------- Penanda menu aktif yang meluncur (pill) ----------
// Pindah menu = pill geser mulus ke posisi baru. Antar halaman (halaman dimuat ulang), posisi
// terakhir disimpan di sessionStorage lalu pill dianimasikan dari situ, jadi terasa nyambung.
function positionNavPill(fromMemory) {
  const nav = document.querySelector('.side-nav');
  const pill = nav && nav.querySelector('.nav-pill');
  const active = nav && nav.querySelector('a.active');
  if (!pill || !active) return;
  const top = active.offsetTop, h = active.offsetHeight;
  if (!h) return;
  const put = (t, hh) => { pill.style.transform = `translateY(${t}px)`; pill.style.height = hh + 'px'; };
  let from = null;
  if (fromMemory) { try { from = JSON.parse(sessionStorage.getItem('flowmua_pill') || 'null'); } catch (e) { /* abaikan */ } }
  if (from && typeof from.t === 'number' && (from.t !== top || from.h !== h)) {
    pill.style.transition = 'none';
    put(from.t, from.h);
    void pill.offsetWidth;
    pill.style.transition = '';
    requestAnimationFrame(() => put(top, h));
  } else {
    put(top, h);
  }
  pill.classList.add('ready');
  try { sessionStorage.setItem('flowmua_pill', JSON.stringify({ t: top, h })); } catch (e) { /* abaikan */ }
}

// Pindah penanda aktif tanpa render ulang shell (dipakai saat pindah tab di dashboard).
function setShellActive(key) {
  const mount = document.getElementById('appShell');
  if (!mount) return;
  mount.querySelectorAll('a[data-key]').forEach((a) => {
    const on = a.dataset.key === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const prim = mount.querySelector('.bottomnav button');
  if (prim) prim.classList.toggle('active', !mount.querySelector('.bottomnav a.active'));
  mount.dataset.shellKey = key;
  positionNavPill(false);
}
window.addEventListener('resize', () => positionNavPill(false));

function renderAppShell(activeKey) {
  const user = getUser();
  if (!user) return;
  const mount = document.getElementById('appShell');
  if (!mount) return;
  // Sudah dirender dengan menu aktif yang sama (shell dirender lebih awal biar gak loncat) -> lewati.
  if (mount.firstElementChild && mount.dataset.shellKey) {
    if (mount.dataset.shellKey !== activeKey) setShellActive(activeKey);
    return;
  }

  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));
  const name = escapeHtmlShell(user.full_name);
  const role = ROLE_LABEL[user.role] || user.role;
  const brand = `<div class="brand"><span class="brand-mark">${navIcon('pack')}</span><span class="brand-text">Flowmua</span></div>`;
  const count = (i) => `<span class="nav-count" data-nav-count="${i.key}"></span>`;
  const link = (i, extra) => `<a href="${i.href}" data-key="${i.key}" title="${i.label}" class="${i.key === activeKey ? 'active' : ''}" ${i.key === activeKey ? 'aria-current="page"' : ''}>${navIcon(i.icon)}<span>${i.label}</span>${count(i)}${extra || ''}</a>`;

  try { document.body.classList.toggle('side-collapsed', localStorage.getItem('flowmua_side') === '1'); } catch (e) { /* abaikan */ }

  let navHtml = '';
  let prevGroup = null;
  for (const i of items) {
    if (prevGroup !== null && i.group !== prevGroup) navHtml += '<div class="side-gap"></div>';
    prevGroup = i.group;
    navHtml += link(i);
  }

  // Bottom nav HP: maksimal 5 slot. Kalau menu lebih dari 5, 4 menu utama + tombol "Menu".
  const needMenu = items.length > 5;
  const prefer = ['dashboard', 'packing', 'cek-pesanan', 'inventory', 'cek-status'];
  const primary = needMenu ? prefer.map((k) => items.find((i) => i.key === k)).filter(Boolean).slice(0, 4) : items;
  const inPrimary = primary.some((i) => i.key === activeKey);
  const bottomLinks = primary.map((i) => `<a href="${i.href}" data-key="${i.key}" class="${i.key === activeKey ? 'active' : ''}">${navIcon(i.icon)}<span>${i.label.split(' ')[0]}</span>${count(i)}</a>`).join('');
  const menuBtn = needMenu ? `<button type="button" class="${inPrimary ? '' : 'active'}" onclick="toggleNavSheet(true)">${navIcon('settings').replace('<svg', '<svg')}<span>Menu</span></button>` : '';
  const sheetLinks = items.map((i) => `<a href="${i.href}" data-key="${i.key}" class="${i.key === activeKey ? 'active' : ''}">${navIcon(i.icon)}<span>${i.label}</span>${count(i)}</a>`).join('');

  mount.innerHTML = `
    <aside class="sidebar">
      ${brand}
      <div class="side-clock"><div class="clock-time" id="shellClockTime">--:--</div><div class="clock-date" id="shellClockDate"></div></div>
      <nav class="side-nav" aria-label="Menu utama"><span class="nav-pill" aria-hidden="true"></span>${navHtml}</nav>
      <div class="side-tools">
        <button type="button" class="side-search" onclick="openCommandPalette()" title="Cari menu cepat (Ctrl + K)" aria-label="Cari menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Cari</span><kbd>Ctrl K</kbd></button>
        <button type="button" class="side-theme theme-toggle" onclick="toggleTheme()" title="Ganti tema terang / gelap" aria-label="Ganti tema terang atau gelap">${themeIcons()}</button>
        <button type="button" class="side-toggle" onclick="toggleSidebar()" title="Ciutkan / lebarkan menu" aria-label="Ciutkan atau lebarkan menu">${navIcon('chevron')}</button>
      </div>
      <div class="side-user">
        <div class="side-user-info" onclick="openChangePasswordModal()" title="Ganti password">
          <span class="avatar">${initials(user.full_name)}</span>
          <span style="min-width:0;"><span class="u-name">${name}</span><span class="u-role">${role}</span></span>
        </div>
        <button class="icon-btn" onclick="confirmLogout()" title="Keluar" aria-label="Keluar">${navIcon('logout')}</button>
      </div>
    </aside>
    <header class="topbar">
      ${brand}
      <div class="topbar-right">
        <button class="icon-btn theme-toggle" onclick="toggleTheme()" title="Ganti tema terang / gelap" aria-label="Ganti tema terang atau gelap">${themeIcons()}</button>
        <button class="icon-btn" onclick="openChangePasswordModal()" title="Ganti password" aria-label="Ganti password"><span class="avatar" style="width:28px;height:28px;font-size:11px;">${initials(user.full_name)}</span></button>
        <button class="icon-btn" onclick="confirmLogout()" title="Keluar" aria-label="Keluar">${navIcon('logout')}</button>
      </div>
    </header>
    ${items.length > 1 ? `<nav class="bottomnav" aria-label="Menu utama">${bottomLinks}${menuBtn}</nav>` : ''}
    ${needMenu ? `<div class="sheet-overlay" id="navSheet" onclick="if(event.target===this)toggleNavSheet(false)"><div class="sheet"><h3>Semua menu</h3><div class="sheet-grid">${sheetLinks}</div></div></div>` : ''}
  `;
  mount.dataset.shellKey = activeKey;
  document.body.classList.add('has-shell');
  positionNavPill(true);
  tickShellClock();
  if (!window.__shellClockTimer) window.__shellClockTimer = visibleInterval(tickShellClock, 30000);
  if (!window.__lateAlertTimer) {
    // Tunda sampai browser idle supaya request data halaman itu sendiri yang diprioritaskan.
    const kick = () => { loadLateAlertBar(); window.__lateAlertTimer = visibleInterval(loadLateAlertBar, 120000); };
    window.__lateAlertTimer = true;
    if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 2500 }); else setTimeout(kick, 1200);
  }

  ensureChangePasswordModal();
}

// ---------- Modal Ganti Password (dipakai semua halaman lewat renderAppShell) ----------
function ensureChangePasswordModal() {
  if (document.getElementById('changePasswordOverlay')) return;
  const div = document.createElement('div');
  div.className = 'modal-overlay';
  div.id = 'changePasswordOverlay';
  div.style.display = 'none';
  div.onclick = function (e) { if (e.target === this) closeChangePasswordModal(); };
  div.innerHTML = `
    <div class="modal-box" style="max-width:380px;">
      <div class="modal-header">
        <div>
          <div class="modal-title">Ganti Password</div>
          <div class="modal-subtitle">Ubah password akun kamu sendiri</div>
        </div>
        <button class="modal-close" onclick="closeChangePasswordModal()">&times;</button>
      </div>
      <div style="margin-top:14px;">
        <label>Password Lama</label>
        <input id="cpOldPassword" type="password" placeholder="Masukkan password lama" autocomplete="current-password">
        <label>Password Baru</label>
        <input id="cpNewPassword" type="password" placeholder="Minimal 6 karakter" autocomplete="new-password">
        <label>Ulangi Password Baru</label>
        <input id="cpConfirmPassword" type="password" placeholder="Ulangi password baru" autocomplete="new-password">
        <div class="error-msg" id="cpErrorMsg" style="display:none;"></div>
        <div class="error-msg" id="cpSuccessMsg" style="display:none; color: var(--primary); background: var(--bg);"></div>
      </div>
      <div class="modal-actions">
        <button class="btn-outline" onclick="closeChangePasswordModal()">Batal</button>
        <button class="btn" id="cpSubmitBtn" onclick="submitChangePassword()">Simpan</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);
}

function openChangePasswordModal() {
  ensureChangePasswordModal();
  ['cpOldPassword', 'cpNewPassword', 'cpConfirmPassword'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('cpErrorMsg').style.display = 'none';
  document.getElementById('cpSuccessMsg').style.display = 'none';
  document.getElementById('changePasswordOverlay').style.display = 'flex';
}

function closeChangePasswordModal() {
  const overlay = document.getElementById('changePasswordOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function submitChangePassword() {
  const oldPassword = document.getElementById('cpOldPassword').value;
  const newPassword = document.getElementById('cpNewPassword').value;
  const confirmPassword = document.getElementById('cpConfirmPassword').value;
  const errBox = document.getElementById('cpErrorMsg');
  const okBox = document.getElementById('cpSuccessMsg');
  const btn = document.getElementById('cpSubmitBtn');
  errBox.style.display = 'none';
  okBox.style.display = 'none';

  if (!oldPassword || !newPassword || !confirmPassword) {
    errBox.textContent = 'Semua kolom wajib diisi';
    errBox.style.display = 'block';
    return;
  }
  if (newPassword.length < 6) {
    errBox.textContent = 'Password baru minimal 6 karakter';
    errBox.style.display = 'block';
    return;
  }
  if (newPassword !== confirmPassword) {
    errBox.textContent = 'Konfirmasi password baru tidak cocok';
    errBox.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    okBox.textContent = 'Password berhasil diganti.';
    okBox.style.display = 'block';
    ['cpOldPassword', 'cpNewPassword', 'cpConfirmPassword'].forEach((id) => { document.getElementById(id).value = ''; });
    setTimeout(closeChangePasswordModal, 1200);
  } catch (e) {
    errBox.textContent = e.message || 'Gagal mengganti password';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan';
  }
}

function confirmLogout() {
  if (confirm('Yakin mau keluar?')) logout();
}
