const API_BASE = '/api';

function getToken() { return localStorage.getItem('flowmua_token'); }
function getUser() {
  const raw = localStorage.getItem('flowmua_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('flowmua_token', token);
  localStorage.setItem('flowmua_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('flowmua_token');
  localStorage.removeItem('flowmua_user');
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, { ...opts, headers });
  let data;
  let rawText = '';
  try { rawText = await res.text(); data = JSON.parse(rawText); } catch (e) { data = {}; }

  if (res.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('Sesi berakhir');
  }
  if (!res.ok) {
    const detail = data.error || data.message
      || (res.status === 404 ? 'Endpoint tidak ditemukan (404) — kemungkinan backend belum ter-deploy'
        : res.status === 413 ? 'File terlalu besar untuk server (413)'
        : `Terjadi kesalahan di server (HTTP ${res.status})${rawText ? ': ' + rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : ''}`);
    const err = new Error(detail);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Guard: panggil di awal tiap halaman yang butuh login
function requireLogin(allowedRoles) {
  const user = getUser();
  if (!getToken() || !user) {
    window.location.href = '/login.html';
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    alert('Akun kamu tidak punya akses ke halaman ini.');
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
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  check: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 14 2 2 4-4"/>',
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

// Bikin sidebar (desktop) + topbar/tab strip (HP) dan nyuntik ke elemen id="appShell"
// di awal <body>. activeKey: salah satu dari NAV_ITEMS[].key
function renderAppShell(activeKey) {
  const user = getUser();
  if (!user) return;
  const mount = document.getElementById('appShell');
  if (!mount) return;

  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));
  const name = escapeHtmlShell(user.full_name);
  const role = ROLE_LABEL[user.role] || user.role;
  const brand = `<div class="brand"><span class="brand-mark">${navIcon('pack')}</span> Flowmua</div>`;

  let navHtml = '';
  let prevGroup = null;
  for (const i of items) {
    if (prevGroup !== null && i.group !== prevGroup) navHtml += '<div class="side-gap"></div>';
    prevGroup = i.group;
    navHtml += `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}" ${i.key === activeKey ? 'aria-current="page"' : ''}>${navIcon(i.icon)}<span>${i.label}</span></a>`;
  }

  mount.innerHTML = `
    <aside class="sidebar">
      ${brand}
      <nav class="side-nav" aria-label="Menu utama">${navHtml}</nav>
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
        <button class="icon-btn" onclick="openChangePasswordModal()" title="Ganti password" aria-label="Ganti password"><span class="avatar" style="width:28px;height:28px;font-size:11px;">${initials(user.full_name)}</span></button>
        <button class="icon-btn" onclick="confirmLogout()" title="Keluar" aria-label="Keluar">${navIcon('logout')}</button>
      </div>
    </header>
    ${items.length > 1 ? `<nav class="tabstrip" aria-label="Menu utama">${items.map((i) => `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}">${navIcon(i.icon)}${i.label}</a>`).join('')}</nav>` : ''}
  `;
  document.body.classList.add('has-shell');
  if (!window.__lateAlertTimer) {
    loadLateAlertBar();
    window.__lateAlertTimer = setInterval(loadLateAlertBar, 120000);
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
