require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');

const { initSchema, pool } = require('./db');
const { startSocket } = require('./services/whatsapp');
const apiRoutes = require('./routes/api');
const panelRoutes = require('./routes/panel');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway (dan reverse proxy sejenisnya) menerima koneksi HTTPS di edge lalu
// meneruskan sebagai HTTP biasa ke container. Tanpa `trust proxy`, Express
// tidak tahu koneksi aslinya HTTPS, sehingga kombinasi ini dengan cookie
// `secure: true` bisa membuat cookie sesi tidak pernah tersimpan/terkirim
// balik oleh browser -> user kelihatan "login sukses" tapi langsung
// terlempar ke halaman login lagi di request berikutnya.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'ganti_ini_di_production',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 jam
    },
  })
);

// Panel admin (static UI + API-nya sendiri)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/panel', panelRoutes);

// REST API publik (butuh x-api-key)
app.use('/api/v1', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

async function main() {
  await initSchema();
  await startSocket();

  app.listen(PORT, () => {
    console.log(`Server jalan di port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Gagal start server:', err);
  process.exit(1);
});
