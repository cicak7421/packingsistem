const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../supabase');
const { requireAuth, requireRole, effectivePermissions, DEFAULT_PERMISSIONS } = require('../auth');

const router = express.Router();

// List user yang bisa dipilih sebagai "packing oleh" (dipakai di dropdown halaman Tracking
// & Kirim Pesanan). Sengaja dibuka buat admin & CS (bukan cuma admin) karena Tracking juga
// bisa diakses CS -- tapi cuma expose id & nama, gak expose username/data sensitif lain.
router.get('/packers', requireAuth, requireRole('admin', 'cs'), async (req, res) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, full_name, role')
    .in('role', ['packing', 'admin'])
    .eq('active', true)
    .order('full_name');
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar packer' });
  res.json({ users });
});

// List all users (admin only) -- termasuk permissions efektif (default role + override)
// biar UI Kelola Akun bisa nampilin toggle yang sesuai kondisi sebenarnya tiap akun.
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, username, full_name, role, active, permissions, created_at')
    .order('id');
  if (error) return res.status(500).json({ error: 'Gagal mengambil daftar user' });
  const enriched = users.map((u) => ({ ...u, effective_permissions: effectivePermissions(u) }));
  res.json({ users: enriched, default_permissions: DEFAULT_PERMISSIONS });
});

// Create user (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name || !role) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }
  if (!['admin', 'cs', 'packing', 'inventory'].includes(role)) {
    return res.status(400).json({ error: 'Role tidak valid' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  }

  const { data: exists } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  if (exists) return res.status(409).json({ error: 'Username sudah dipakai' });

  const hash = bcrypt.hashSync(password, 10);
  const { data: inserted, error } = await supabase
    .from('users')
    .insert({ username, password_hash: hash, full_name, role })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: 'Gagal membuat user' });
  res.json({ id: inserted.id });
});

// Atur permission granular per akun (admin only) -- ini yang bikin "sub account bisa
// di-adjust sesuai kebutuhan". body: { permissions: { view_stock, adjust_stock,
// manage_products, manage_users } } -- cuma key yang dikirim yang di-override, key lain
// tetap ikut default role (lihat effectivePermissions() di auth.js).
router.patch('/:id/permissions', requireAuth, requireRole('admin'), async (req, res) => {
  const incoming = req.body.permissions;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'Field permissions wajib diisi (object)' });
  }
  const ALLOWED_KEYS = ['view_stock', 'adjust_stock', 'manage_products', 'manage_users'];
  const cleaned = {};
  for (const key of ALLOWED_KEYS) {
    if (key in incoming) cleaned[key] = !!incoming[key];
  }

  const { data: target, error: findErr } = await supabase.from('users').select('*').eq('id', req.params.id).maybeSingle();
  if (findErr || !target) return res.status(404).json({ error: 'User tidak ditemukan' });

  const merged = { ...(target.permissions || {}), ...cleaned };
  const { data: updated, error } = await supabase
    .from('users')
    .update({ permissions: merged })
    .eq('id', target.id)
    .select('id, username, full_name, role, permissions')
    .single();
  if (error) return res.status(500).json({ error: 'Gagal update izin akses: ' + error.message });

  res.json({ user: { ...updated, effective_permissions: effectivePermissions(updated) } });
});

// Deactivate / reactivate user (admin only)
router.patch('/:id/active', requireAuth, requireRole('admin'), async (req, res) => {
  const { active } = req.body;
  const { error } = await supabase.from('users').update({ active: !!active }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal update status user' });
  res.json({ ok: true });
});

// Reset password (admin only)
router.post('/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Gagal reset password' });
  res.json({ ok: true });
});

module.exports = router;
