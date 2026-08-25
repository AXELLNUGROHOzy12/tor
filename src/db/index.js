const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

// Membuat tabel yang dibutuhkan jika belum ada.
// Dipanggil sekali saat server start (aman dijalankan berkali-kali).
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id TEXT PRIMARY KEY,
      creds JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wa_session_keys (
      session_id TEXT NOT NULL,
      key_type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (session_id, key_type, key_id)
    );
  `);

  // Metadata sesi multi-nomor (nama/label tiap sesi WA yang ditambahkan lewat panel).
  // wa_sessions/wa_session_keys tetap nyimpen creds & signal keys per session_id.
  await query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      phone_number TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      wa_message_id TEXT,
      session_id TEXT NOT NULL DEFAULT 'default',
      chat_id TEXT NOT NULL,
      sender TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      body TEXT,
      media_type TEXT,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Migrasi ringan buat DB lama yang tabel messages-nya belum punya kolom session_id
  await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'default';`);

  await query(`
    CREATE TABLE IF NOT EXISTS autoreply_rules (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'exact', 'startswith')),
      reply TEXT NOT NULL,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT[] DEFAULT '{}',
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB
    );
  `);

  // Multi-session Telegram: tiap bot (token) punya baris sendiri, mirip bot_sessions untuk WA.
  await query(`
    CREATE TABLE IF NOT EXISTS telegram_bots (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token TEXT NOT NULL,
      chat_id TEXT,
      forward_messages BOOLEAN DEFAULT false,
      ai_enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Migrasi: config Telegram lama (single bot, disimpan di settings key 'telegram')
  // dipindah jadi baris pertama di telegram_bots, biar yang udah setup gak perlu ulang.
  await query(`
    INSERT INTO telegram_bots (id, label, token, chat_id, forward_messages, ai_enabled)
    SELECT
      'default',
      'Bot Utama',
      value->>'token',
      value->>'chatId',
      COALESCE((value->>'forwardMessages')::boolean, false),
      COALESCE((value->>'aiEnabled')::boolean, true)
    FROM settings
    WHERE key = 'telegram'
      AND value->>'token' IS NOT NULL
      AND value->>'token' != ''
      AND NOT EXISTS (SELECT 1 FROM telegram_bots WHERE id = 'default');
  `);

  // Migrasi: sesi WA lama (sebelum fitur multi-session, id-nya selalu
  // 'default') tapi belum ada di bot_sessions, daftarkan otomatis biar tetap
  // muncul di panel setelah update tanpa perlu scan ulang QR.
  await query(`
    INSERT INTO bot_sessions (id, label)
    SELECT ws.id, 'Default'
    FROM wa_sessions ws
    LEFT JOIN bot_sessions bs ON bs.id = ws.id
    WHERE bs.id IS NULL;
  `);
}

module.exports = { pool, query, initSchema };
