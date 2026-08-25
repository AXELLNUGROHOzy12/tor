# Nova C2 Backend (Baileys + Panel Admin)

Backend WhatsApp multi-device (Node.js + Baileys) dengan panel admin web dan REST API,
didesain untuk deploy di Railway dengan sesi tersimpan di PostgreSQL (bukan filesystem),
sehingga tidak perlu scan ulang QR tiap kali container restart/redeploy.

## Struktur

```
src/
  server.js          entry point
  db/index.js        koneksi Postgres + schema
  services/
    pgAuthState.js   auth state Baileys tersimpan di Postgres
    whatsapp.js      koneksi WA, QR, kirim/terima pesan
    chatbot.js       auto-reply (keyword rules + hook API eksternal)
    webhooks.js       fire event ke webhook terdaftar
  routes/
    api.js           REST API publik (/api/v1/*, butuh x-api-key)
    panel.js         API untuk panel admin (/panel/*, butuh login sesi)
  middleware/
    apiKeyAuth.js
    panelAuth.js
public/index.html    panel admin (single page)
```

## Setup Lokal

```bash
npm install
cp .env.example .env
# isi .env: minimal DATABASE_URL (Postgres lokal atau Railway), API_KEY, ADMIN_USERNAME/PASSWORD, SESSION_SECRET
npm run dev
```

Buka `http://localhost:3000` untuk panel admin, login dengan `ADMIN_USERNAME`/`ADMIN_PASSWORD` dari `.env`.

## Deploy ke Railway

1. Push folder ini ke repo GitHub.
2. Di Railway: **New Project → Deploy from GitHub repo**, pilih repo ini.
3. Tambahkan plugin **PostgreSQL** di project yang sama (Railway otomatis inject `DATABASE_URL`).
4. Di tab **Variables**, isi:
   - `API_KEY` — key rahasia untuk REST API
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` — login panel
   - `SESSION_SECRET` — string acak panjang
   - `NODE_ENV=production`
   - (opsional) `CHATBOT_ENABLED`, `CHATBOT_API_URL`, `CHATBOT_API_KEY` — diisi belakangan
5. Deploy. Railway otomatis `npm install` lalu `npm start`.
6. Buka domain Railway yang di-generate → panel admin akan tampil, status awal `connecting` lalu `qr_pending` dengan QR muncul di dashboard.
7. Scan QR dari WhatsApp: **Perangkat Tertaut → Tautkan Perangkat**.
8. Setelah connect, sesi tersimpan di Postgres — restart/redeploy container tidak akan minta scan ulang.

## REST API (`/api/v1/*`)

Semua request wajib header `x-api-key: <API_KEY>`.

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/v1/qr` | QR pairing saat ini (404 jika tidak dalam status `qr_pending`) |
| GET | `/api/v1/session/status` | Status koneksi: `connecting`/`qr_pending`/`connected`/`logged_out` |
| POST | `/api/v1/session/logout` | Logout & hapus sesi |
| POST | `/api/v1/session/restart` | Mulai ulang koneksi (misal untuk pairing baru) |
| POST | `/api/v1/send-message` | Body: `{ "to": "6281234567890", "message": "..." }` |
| GET | `/api/v1/messages` | Query: `chatId`, `from`, `to`, `limit` |
| GET/POST | `/api/v1/chatbot/config` | Kelola rule auto-reply keyword |
| GET/POST | `/api/v1/webhook` | Kelola webhook: `{ "url": "...", "events": ["message.received", ...] }` |

Event webhook yang tersedia: `message.received`, `message.sent`, `connection.update`, `session.logout`.

## Auto-Reply: API Chatbot Eksternal

Belum diisi — di `src/services/chatbot.js`, fungsi `callChatbotAPI()` sudah disiapkan sebagai
placeholder generic. Begitu API-nya sudah dipilih, tinggal:
1. Isi `CHATBOT_ENABLED=true`, `CHATBOT_API_URL`, `CHATBOT_API_KEY` di environment variables.
2. Sesuaikan bentuk request body & parsing response di `callChatbotAPI()` sesuai dokumentasi API tersebut.

Keyword rules (diatur lewat panel/API) selalu dicek lebih dulu sebelum fallback ke chatbot API.

## Catatan Penting Railway

- Filesystem container Railway **tidak persisten** — karena itu sesi Baileys (creds + signal keys)
  disimpan di PostgreSQL lewat `pgAuthState.js`, bukan file `auth_info_baileys` biasa.
- Jika koneksi WA putus karena sebab selain logout, backend otomatis reconnect.
- Jika status `logged_out`, sesi di DB otomatis dihapus — perlu scan QR baru lewat panel/`/api/v1/qr`.

## Multi-Session (banyak nomor WA sekaligus)

Setiap sesi = satu nomor WhatsApp, punya socket & auth state sendiri (disimpan di Postgres per `session_id`).

- Tambah sesi baru lewat panel: **Sesi WhatsApp → Tambah Sesi** (isi nama, scan QR yang muncul di kartu sesi).
- Restart / Logout / Hapus tersedia per kartu sesi.
- Semua sesi otomatis disambungkan ulang saat server restart (`restoreSessions()` di `server.js`).
- REST API sekarang menerima `sessionId` di query/body (`/api/v1/send-message`, `/api/v1/qr?sessionId=...`, dst). Kalau `sessionId` tidak dikirim, default ke `"default"` (sesi lama sebelum fitur ini ada tetap kompatibel).

## Integrasi Telegram

Alih-alih taruh token di `.env`, token & Chat ID admin disimpan lewat panel (**Integrasi Telegram**), tersimpan di tabel `settings` supaya bisa diganti tanpa redeploy.

- Bot Telegram jalan pakai polling (`node-telegram-bot-api`).
- Command yang tersedia di bot: `/start`, `/sessions` (list sesi & status), `/send <sessionId> <nomor> <pesan>` (kirim WA dari Telegram).
- Toggle "Forward semua pesan WA masuk ke Telegram" kalau mau semua chat masuk WA diteruskan ke chat Telegram admin.
- Notifikasi otomatis dikirim ke Telegram saat: QR baru muncul, sesi konek, dan sesi logout.
