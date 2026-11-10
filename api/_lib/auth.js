const jwt = require('jsonwebtoken');
const supabase = require('./supabase');
const SECRET = process.env.JWT_SECRET || 'ganti-secret-ini-di-env';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Belum login' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload; // { id, username, full_name, role }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Tidak punya akses untuk aksi ini' });
    }
    next();
  };
}

// ---------- Permission granular (dipakai modul Inventory) ----------
// Tiap role punya default akses masuk akal, tapi admin bisa override per-akun lewat
// kolom users.permissions (jsonb) -- lihat routes/users.js (PATCH /:id/permissions).
const DEFAULT_PERMISSIONS = {
  admin: { view_stock: true, adjust_stock: true, manage_products: true, manage_users: true },
  inventory: { view_stock: true, adjust_stock: true, manage_products: true, manage_users: false },
  packing: { view_stock: true, adjust_stock: false, manage_products: false, manage_users: false },
  cs: { view_stock: true, adjust_stock: false, manage_products: false, manage_users: false },
};

// Gabungkan default role + override per-akun (kalau ada key yang di-set eksplisit di
// users.permissions, itu yang menang -- baik true maupun false).
function effectivePermissions(user) {
  const base = DEFAULT_PERMISSIONS[user.role] || {};
  const override = user.permissions || {};
  return { ...base, ...override };
}

// Middleware: requirePermission('adjust_stock') dst. Admin selalu lolos semua permission
// (jaga-jaga biar admin gak pernah kekunci sendiri walau ada salah setting).
//
// PENTING: permission SELALU diambil ulang dari database (bukan dari field `permissions`
// yang ikut ke-bake di JWT saat login). Kalau ambil dari JWT, begitu admin ubah izin lewat
// "Atur Akses Akun", user yang sesi-nya sudah aktif gak bakal kerasa perubahannya sampai
// token-nya expired (12 jam) atau dia logout-login ulang -- ini bikin kesan "udah diaktifin
// tapi masih kekunci" padahal datanya sudah benar di DB.
function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (req.user.role === 'admin') return next();
    const { data: freshUser, error } = await supabase
      .from('users')
      .select('id, role, permissions, active')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !freshUser || !freshUser.active) {
      return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
    }
    const perms = effectivePermissions(freshUser);
    if (!perms[key]) {
      return res.status(403).json({ error: 'Akun kamu tidak punya izin untuk aksi ini. Hubungi admin.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requirePermission, effectivePermissions, DEFAULT_PERMISSIONS, SECRET };
