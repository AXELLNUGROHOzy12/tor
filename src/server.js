require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const { initSchema } = require('./db');
const { startSocket } = require('./services/whatsapp');
const apiRoutes = require('./routes/api');
const panelRoutes = require('./routes/panel');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'ganti_ini_di_production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
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
