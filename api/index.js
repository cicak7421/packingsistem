const express = require('express');
const cors = require('cors');

const authRoutes = require('./_lib/routes/auth');
const userRoutes = require('./_lib/routes/users');
const importRoutes = require('./_lib/routes/import');
const orderRoutes = require('./_lib/routes/orders');
const packingRoutes = require('./_lib/routes/packing');
const kirimPesananRoutes = require('./_lib/routes/kirimPesanan');
const cronRoutes = require('./_lib/routes/cron');
const affiliateRoutes = require('./_lib/routes/affiliate');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/import', importRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/packing', packingRoutes);
app.use('/api/kirim-pesanan', kirimPesananRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/affiliate', affiliateRoutes);

app.get('/api', (req, res) => res.json({ ok: true, service: 'flowmua-api' }));

// Kalau dijalanin langsung (`node api/index.js`) buat testing lokal, baru nge-listen.
// Di Vercel, file ini di-import sebagai serverless function handler, jadi TIDAK app.listen().
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Flowmua API jalan lokal di http://localhost:${PORT}`));
}

module.exports = app;
