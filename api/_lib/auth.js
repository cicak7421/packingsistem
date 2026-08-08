const jwt = require('jsonwebtoken');
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

module.exports = { requireAuth, requireRole, SECRET };
