'use strict';
const { query } = require('../db');

// =============================================================
// Pengaturan per-grup (disimpan di tabel `settings` yang sudah ada)
// Key format: gotag:<chatId>  -> { enabled: true|false }
// =============================================================

function gotagKey(chatId) {
  return `gotag:${chatId}`;
}

async function getGotagMode(chatId) {
  const res = await query(`SELECT value FROM settings WHERE key = $1`, [gotagKey(chatId)]);
  if (res.rows.length === 0) return false;
  return !!res.rows[0].value?.enabled;
}

async function setGotagMode(chatId, enabled) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [gotagKey(chatId), JSON.stringify({ enabled })]
  );
}

module.exports = { getGotagMode, setGotagMode };
