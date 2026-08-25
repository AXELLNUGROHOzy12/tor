'use strict';
const TelegramBot = require('node-telegram-bot-api');
const { query } = require('../db');
const { runAutoReply } = require('./chatbot');

// =============================================================
// Multi-session Telegram: tiap bot (token beda-beda) punya instance
// polling sendiri, mirip pola multi-session di whatsapp.js. Config
// disimpan di tabel `telegram_bots`, diisi/diubah lewat panel.
// =============================================================

const bots = new Map();
// bentuk tiap entry:
// { instance, label, token, chatId, forwardMessages, aiEnabled, running, lastError }

let waControllerRef = null; // di-inject dari whatsapp.js supaya command /send bisa kirim WA

function registerWaController(controller) {
  waControllerRef = controller;
}

async function listBotRows() {
  const res = await query(
    `SELECT id, label, token, chat_id, forward_messages, ai_enabled FROM telegram_bots ORDER BY created_at ASC`
  );
  return res.rows;
}

async function upsertBotRow({ id, label, token, chatId, forwardMessages, aiEnabled }) {
  await query(
    `INSERT INTO telegram_bots (id, label, token, chat_id, forward_messages, ai_enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       token = EXCLUDED.token,
       chat_id = EXCLUDED.chat_id,
       forward_messages = EXCLUDED.forward_messages,
       ai_enabled = EXCLUDED.ai_enabled`,
    [id, label, token, chatId || null, !!forwardMessages, aiEnabled === undefined ? true : !!aiEnabled]
  );
}

async function stopBotInstance(id) {
  const entry = bots.get(id);
  if (entry?.instance) {
    try {
      await entry.instance.stopPolling();
    } catch (_) {
      /* abaikan */
    }
  }
}

// Nyalakan (atau restart) satu bot berdasarkan config yang ada di DB.
async function startBot(id) {
  await stopBotInstance(id);

  const res = await query(
    `SELECT id, label, token, chat_id, forward_messages, ai_enabled FROM telegram_bots WHERE id = $1`,
    [id]
  );
  if (res.rows.length === 0) {
    bots.delete(id);
    return;
  }
  const row = res.rows[0];

  const entry = {
    instance: null,
    label: row.label,
    token: row.token,
    chatId: row.chat_id || '',
    forwardMessages: !!row.forward_messages,
    aiEnabled: row.ai_enabled !== false,
    running: false,
    lastError: null,
  };
  bots.set(id, entry);

  if (!row.token) return; // belum ada token, jangan dinyalain dulu

  try {
    const instance = new TelegramBot(row.token, { polling: true });
    entry.instance = instance;

    instance.on('polling_error', (err) => {
      entry.lastError = err.message;
      console.error(`[telegram:${id}] polling error:`, err.message);
    });

    instance.onText(/^\/start|^\/help/, (msg) => {
      instance.sendMessage(
        msg.chat.id,
        [
          `Bot kontrol WhatsApp multi-sesi (${entry.label}).`,
          '',
          '/sessions — daftar sesi WA & statusnya',
          '/send <sessionId> <nomor> <pesan> — kirim pesan WA dari sesi tertentu',
          '',
          'Chat teks biasa ke bot ini akan dijawab otomatis (AI), sama seperti chatbot di WhatsApp.',
          '',
          `Chat ID kamu: ${msg.chat.id}`,
        ].join('\n')
      );
    });

    instance.onText(/^\/sessions/, async (msg) => {
      if (!waControllerRef) return instance.sendMessage(msg.chat.id, 'Modul WhatsApp belum siap.');
      const sessions = waControllerRef.getAllStatuses();
      if (sessions.length === 0) {
        return instance.sendMessage(msg.chat.id, 'Belum ada sesi WhatsApp. Tambahkan lewat panel dulu.');
      }
      const lines = sessions.map(
        (s) => `• ${s.id} (${s.label}) — ${s.status}${s.phoneNumber ? ' — ' + s.phoneNumber : ''}`
      );
      instance.sendMessage(msg.chat.id, lines.join('\n'));
    });

    instance.onText(/^\/send\s+(\S+)\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
      if (!waControllerRef) return instance.sendMessage(msg.chat.id, 'Modul WhatsApp belum siap.');
      const [, sessionId, to, message] = match;
      try {
        await waControllerRef.sendTextMessage(sessionId, to, message);
        instance.sendMessage(msg.chat.id, `✅ Terkirim lewat sesi "${sessionId}" ke ${to}`);
      } catch (err) {
        instance.sendMessage(msg.chat.id, `❌ Gagal kirim: ${err.message}`);
      }
    });

    // Chat AI: pesan teks biasa (bukan command) dibalas otomatis, sama
    // alurnya kayak chatbot WA (keyword rules dulu, fallback Claude Haiku).
    // Riwayat dipisah per bot+chat lewat prefix "telegram:<botId>:<chatId>".
    instance.on('message', async (msg) => {
      const text = msg.text;
      if (!text || text.startsWith('/')) return;
      if (!entry.aiEnabled) return;

      const historyKey = `telegram:${id}:${msg.chat.id}`;
      try {
        instance.sendChatAction(msg.chat.id, 'typing').catch(() => {});
        const reply = await runAutoReply(text, historyKey);
        if (reply) await instance.sendMessage(msg.chat.id, reply);
      } catch (err) {
        console.error(`[telegram:${id}] gagal proses AI chat:`, err.message);
      }
    });

    entry.running = true;
  } catch (err) {
    entry.lastError = err.message;
    console.error(`[telegram:${id}] gagal start:`, err.message);
  }
}

// Dipanggil dari server.js saat start: nyalain semua bot yang tokennya
// udah pernah disimpan lewat panel.
async function initTelegramBot() {
  const rows = await listBotRows();
  for (const row of rows) {
    await startBot(row.id);
  }
}

function slugify(label) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'bot'
  );
}

// Bikin bot baru. Kalau token dikosongkan, tersimpan sebagai draft
// (belum polling) sampai token diisi lewat updateBot().
async function createBot({ label, token, chatId, forwardMessages, aiEnabled }) {
  const finalLabel = (label || '').trim() || 'Bot Baru';
  let id = slugify(finalLabel);
  let n = 1;
  const existingIds = new Set((await listBotRows()).map((r) => r.id));
  while (existingIds.has(id)) id = `${slugify(finalLabel)}-${++n}`;

  await upsertBotRow({ id, label: finalLabel, token: token || '', chatId, forwardMessages, aiEnabled });
  await startBot(id);
  return id;
}

// Update config bot yang sudah ada. token kosong/undefined berarti tidak diganti.
async function updateBot(id, { label, token, chatId, forwardMessages, aiEnabled }) {
  const rows = await listBotRows();
  const existing = rows.find((r) => r.id === id);
  if (!existing) throw new Error(`Bot "${id}" tidak ditemukan`);

  await upsertBotRow({
    id,
    label: label !== undefined && label !== '' ? label : existing.label,
    token: token || existing.token,
    chatId: chatId !== undefined ? chatId : existing.chat_id,
    forwardMessages: forwardMessages !== undefined ? forwardMessages : existing.forward_messages,
    aiEnabled: aiEnabled !== undefined ? aiEnabled : existing.ai_enabled,
  });
  await startBot(id);
}

async function deleteBot(id) {
  await stopBotInstance(id);
  bots.delete(id);
  await query(`DELETE FROM telegram_bots WHERE id = $1`, [id]);
}

function getAllBotStatuses() {
  const list = [];
  for (const [id, entry] of bots.entries()) {
    list.push({
      id,
      label: entry.label,
      chatId: entry.chatId,
      forwardMessages: entry.forwardMessages,
      aiEnabled: entry.aiEnabled,
      running: entry.running,
      hasToken: !!entry.token,
      tokenPreview: entry.token ? `${entry.token.slice(0, 6)}...${entry.token.slice(-4)}` : '',
      lastError: entry.lastError,
    });
  }
  return list;
}

// Kirim notifikasi ke SEMUA bot yang punya chatId terkonfigurasi
// (status koneksi WA, QR baru, dsb). Aman dipanggil walau belum ada bot sama sekali.
async function notifyTelegram(text) {
  const tasks = [];
  for (const entry of bots.values()) {
    if (entry.instance && entry.chatId) {
      tasks.push(
        entry.instance.sendMessage(entry.chatId, text).catch((err) => {
          console.error('[telegram] gagal kirim notifikasi:', err.message);
        })
      );
    }
  }
  await Promise.all(tasks);
}

// Forward pesan WA masuk ke semua bot yang forwardMessages-nya aktif.
async function forwardIncomingMessage({ sessionId, chatId, body }) {
  const text = `📩 [${sessionId}] ${chatId}\n${body || '(non-teks)'}`;
  const tasks = [];
  for (const entry of bots.values()) {
    if (entry.instance && entry.chatId && entry.forwardMessages) {
      tasks.push(
        entry.instance.sendMessage(entry.chatId, text).catch((err) => {
          console.error('[telegram] gagal forward pesan:', err.message);
        })
      );
    }
  }
  await Promise.all(tasks);
}

async function sendTestMessage(id) {
  const entry = bots.get(id);
  if (!entry?.instance) throw new Error('Bot Telegram ini belum aktif — simpan token dulu.');
  if (!entry.chatId) throw new Error('Chat ID admin belum diisi.');
  await entry.instance.sendMessage(entry.chatId, `✅ Tes koneksi berhasil dari panel (${entry.label}).`);
}

module.exports = {
  registerWaController,
  initTelegramBot,
  createBot,
  updateBot,
  deleteBot,
  getAllBotStatuses,
  notifyTelegram,
  forwardIncomingMessage,
  sendTestMessage,
};
