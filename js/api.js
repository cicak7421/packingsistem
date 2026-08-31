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
  try { data = await res.json(); } catch (e) { data = {}; }

  if (res.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('Sesi berakhir');
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || 'Terjadi kesalahan');
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

function logout() {
  clearSession();
  window.location.href = '/login.html';
}

// ---------- Navigasi terpusat (dipakai semua halaman biar konsisten) ----------
// Setiap halaman tinggal panggil renderAppShell(activeKey) sekali di awal.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html', roles: ['admin', 'cs'] },
  { key: 'import', label: 'Import Pesanan', href: '/dashboard.html?tab=import', roles: ['admin', 'cs'] },
  { key: 'kirim-pesanan', label: 'Kirim Pesanan', href: '/dashboard.html?tab=kirim-pesanan', roles: ['admin'] },
  { key: 'cek-status', label: 'Tracking', href: '/dashboard.html?tab=cek-status', roles: ['admin', 'cs'] },
  { key: 'export', label: 'Export Data', href: '/dashboard.html?tab=export', roles: ['admin', 'cs'] },
  { key: 'performance', label: 'Performa Packing', href: '/dashboard.html?tab=performance', roles: ['admin', 'cs'] },
  { key: 'affiliate', label: 'Affiliate', href: '/dashboard.html?tab=affiliate', roles: ['admin', 'cs'] },
  { key: 'users', label: 'Kelola Akun', href: '/dashboard.html?tab=users', roles: ['admin'] },
  { key: 'packing', label: 'Scan Packing', href: '/packing.html', roles: ['admin', 'packing'] },
];

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

const ROLE_LABEL = { admin: 'Admin', cs: 'Customer Service', packing: 'Tim Packing' };

// Bikin header + subnav dan nyuntik ke elemen dengan id="appShell" di awal <body>.
// activeKey: salah satu dari NAV_ITEMS[].key
function renderAppShell(activeKey) {
  const user = getUser();
  if (!user) return;
  const mount = document.getElementById('appShell');
  if (!mount) return;

  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));

  mount.innerHTML = `
    <div class="app-header">
      <div class="app-header-inner">
        <div class="brand"><span class="brand-mark">F</span> Flowmua</div>
        <div class="app-header-right">
          <div class="user-chip" onclick="openChangePasswordModal()" style="cursor:pointer;" title="Ganti password">
            <span class="avatar">${initials(user.full_name)}</span>
            <span>
              <span class="u-name">${user.full_name}</span>
              <span class="u-role">${ROLE_LABEL[user.role] || user.role}</span>
            </span>
          </div>
          <button class="logout" onclick="confirmLogout()">Keluar</button>
        </div>
      </div>
    </div>
    ${items.length > 1 ? `
    <div class="subnav">
      <div class="subnav-inner">
        ${items.map((i) => `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}">${i.label}</a>`).join('')}
      </div>
    </div>` : ''}
  `;

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
