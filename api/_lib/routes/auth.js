const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const { requireAuth, SECRET, effectivePermissions } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi' });
    }

    // Username dicocokkan tanpa peduli huruf besar/kecil (keyboard HP sering otomatis
    // mengkapitalkan huruf pertama). ilike + escape wildcard supaya cocok persis.
    const pattern = username.replace(/[\\%_]/g, (c) => '\\' + c);
    const { data: rows, error } = await supabase
      .from('users')
      .select('*')
      .ilike('username', pattern)
      .eq('active', true)
      .limit(5);

    if (error) {
      console.error('login query error:', error);
      return res.status(500).json({ error: 'Gagal mengambil data user' });
    }

    // Kalau ada lebih dari satu yang cocok (beda kapitalisasi), utamakan yang persis sama.
    const user = (rows || []).find((u) => u.username === username) || (rows || [])[0];

    let ok = false;
    if (user && user.password_hash) {
      try { ok = bcrypt.compareSync(password, user.password_hash); }
      catch (e) { console.error('bcrypt error untuk user', user.id, e.message); ok = false; }
    }
    if (!ok) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      permissions: effectivePermissions(user),
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: '12h' });
    res.json({ token, user: payload });
  } catch (e) {
    console.error('login fatal error:', e);
    res.status(500).json({ error: 'Terjadi kesalahan di server saat login' });
  }
});

// Data user dari JWT bisa basi (permissions ke-bake saat login, gak update sampai token
// expired/relogin) -- endpoint ini selalu ambil ulang dari DB biar frontend bisa refresh
// PERMS-nya tiap buka halaman tanpa harus nyuruh user logout-login.
router.get('/me', requireAuth, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, full_name, role, active, permissions')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error || !user || !user.active) {
    return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
  }
  const fresh = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    permissions: effectivePermissions(user),
  };
  res.json({ user: fresh });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  }

  const { data: user, error } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
  if (error || !user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (!bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(401).json({ error: 'Password lama salah' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  const { error: updErr } = await supabase.from('users').update({ password_hash: hash }).eq('id', user.id);
  if (updErr) return res.status(500).json({ error: 'Gagal update password' });

  res.json({ ok: true });
});

module.exports = router;
