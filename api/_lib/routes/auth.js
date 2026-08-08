const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const { requireAuth, SECRET } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Gagal mengambil data user' });
  }
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  const payload = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  const token = jwt.sign(payload, SECRET, { expiresIn: '12h' });
  res.json({ token, user: payload });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
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
