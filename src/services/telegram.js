'use strict';
const TelegramBot = require('node-telegram-bot-api');
const { query } = require('../db');
const { runAutoReply } = require('./chatbot');

// =============================================================
// Integrasi Telegram Bot
// Token & chat id admin disimpan di tabel `settings` (key: 'telegram'),
// diisi lewat panel (bukan .env) supaya bisa diganti tanpa redeploy.
// =============================================================

const SETTINGS_KEY = 'telegram';

let bot = null;
let currentConfig = null; // { token, chatId, forwardMessages }
let waControllerRef = null; // di-inject dari whatsapp.js supaya command /send bisa kirim WA

function registerWaController(controller) {
  waControllerRef = controller;
}

async function getTelegramConfig() {
  const res = await query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
  if (res.rows.length === 0) return { token: '', chatId: '', forwardMessages: false, aiEnabled: true };
  const v = res.rows[0].value || {};
  return {
    token: v.token || '',
    chatId: v.chatId || '',
    forwardMessages: !!v.forwardMessages,
    // default true kalau belum pernah diset, biar AI langsung aktif out-of-the-box
    aiEnabled: v.aiEnabled === undefined ? true : !!v.aiEnabled,
  };
}

async function saveTelegramConfig({ token, chatId, forwardMessages, aiEnabled }) {
  const value = {
    token: token || '',
    chatId: chatId || '',
    forwardMessages: !!forwardMessages,
    aiEnabled: aiEnabled === undefined ? true : !!aiEnabled,
  };
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [SETTINGS_KEY, JSON.stringify(value)]
  );
  await restartBot();
  return value;
}

function getBotRuntimeStatus() {
  return {
    running: !!bot,
    chatId: currentConfig?.chatId || '',
    forwardMessages: !!currentConfig?.forwardMessages,
    aiEnabled: currentConfig?.aiEnabled !== false,
    hasToken: !!currentConfig?.token,
  };
}

async function stopBot() {
  if (bot) {
    try {
      await bot.stopPolling();
    } catch (_) {
      /* abaikan error saat stop */
    }
    bot = null;
  }
}

async function restartBot() {
  await stopBot();
  currentConfig = await getTelegramConfig();

  if (!currentConfig.token) return;

  bot = new TelegramBot(currentConfig.token, { polling: true });

  bot.on('polling_error', (err) => {
    console.error('[telegram] polling error:', err.message);
  });

  bot.onText(/^\/start|^\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        'Bot kontrol WhatsApp multi-sesi.',
        '',
        '/sessions — daftar sesi WA & statusnya',
        '/send <sessionId> <nomor> <pesan> — kirim pesan WA dari sesi tertentu',
        '',
        'Selain command di atas, chat teks biasa ke bot ini akan dijawab otomatis (AI), sama seperti chatbot di WhatsApp.',
        '',
        `Chat ID kamu: ${msg.chat.id}`,
      ].join('\n')
    );
  });

  bot.onText(/^\/sessions/, async (msg) => {
    if (!waControllerRef) return bot.sendMessage(msg.chat.id, 'Modul WhatsApp belum siap.');
    const sessions = waControllerRef.getAllStatuses();
    if (sessions.length === 0) {
      return bot.sendMessage(msg.chat.id, 'Belum ada sesi WhatsApp. Tambahkan lewat panel dulu.');
    }
    const lines = sessions.map(
      (s) => `• ${s.id} (${s.label}) — ${s.status}${s.phoneNumber ? ' — ' + s.phoneNumber : ''}`
    );
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  bot.onText(/^\/send\s+(\S+)\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
    if (!waControllerRef) return bot.sendMessage(msg.chat.id, 'Modul WhatsApp belum siap.');
    const [, sessionId, to, message] = match;
    try {
      await waControllerRef.sendTextMessage(sessionId, to, message);
      bot.sendMessage(msg.chat.id, `✅ Terkirim lewat sesi "${sessionId}" ke ${to}`);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Gagal kirim: ${err.message}`);
    }
  });

  // --- Chat AI di Telegram ---------------------------------------
  // Pesan teks biasa (bukan command) diperlakukan sama seperti chat WA:
  // dicek keyword rules dulu (tabel autoreply_rules, dishare sama WA),
  // baru fallback ke Claude Haiku kalau CHATBOT_ENABLED=true. Riwayat
  // percakapan dipisah per chat Telegram lewat prefix "telegram:".
  bot.on('message', async (msg) => {
    const text = msg.text;
    if (!text || text.startsWith('/')) return; // command sudah ditangani onText di atas
    if (currentConfig?.aiEnabled === false) return;

    const historyKey = `telegram:${msg.chat.id}`;
    try {
      bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      const reply = await runAutoReply(text, historyKey);
      if (reply) await bot.sendMessage(msg.chat.id, reply);
    } catch (err) {
      console.error('[telegram] gagal proses AI chat:', err.message);
    }
  });
}

// Dipanggil dari server.js saat start, biar bot langsung nyala kalau
// token udah pernah disimpan sebelumnya.
async function initTelegramBot() {
  currentConfig = await getTelegramConfig();
  if (currentConfig.token) await restartBot();
}

// Kirim notifikasi ke chat admin (status koneksi, QR baru, dsb).
// Aman dipanggil walau bot belum dikonfigurasi (langsung no-op).
async function notifyTelegram(text) {
  if (!bot || !currentConfig?.chatId) return;
  try {
    await bot.sendMessage(currentConfig.chatId, text);
  } catch (err) {
    console.error('[telegram] gagal kirim notifikasi:', err.message);
  }
}

// Forward pesan WA masuk ke Telegram, hanya kalau opsi forwardMessages aktif.
async function forwardIncomingMessage({ sessionId, chatId, body }) {
  if (!bot || !currentConfig?.chatId || !currentConfig?.forwardMessages) return;
  const text = `📩 [${sessionId}] ${chatId}\n${body || '(non-teks)'}`;
  await notifyTelegram(text);
}

async function sendTestMessage() {
  if (!bot) throw new Error('Bot Telegram belum aktif — simpan token dulu.');
  if (!currentConfig?.chatId) throw new Error('Chat ID admin belum diisi.');
  await bot.sendMessage(currentConfig.chatId, '✅ Tes koneksi berhasil dari panel.');
}

module.exports = {
  registerWaController,
  getTelegramConfig,
  saveTelegramConfig,
  getBotRuntimeStatus,
  initTelegramBot,
  notifyTelegram,
  forwardIncomingMessage,
  sendTestMessage,
};
