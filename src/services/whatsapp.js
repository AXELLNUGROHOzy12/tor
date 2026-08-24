const baileys = require('@whiskeysockets/baileys');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = baileys;
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const { useDBAuthState, clearDBAuthState } = require('./pgAuthState');
const { query } = require('../db');
const { runAutoReply } = require('./chatbot');
const { fireWebhooks } = require('./webhooks');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// State global yang dipakai routes/panel untuk baca status terkini
const state = {
  sock: null,
  status: 'disconnected', // disconnected | connecting | qr_pending | connected | logged_out
  qr: null, // data URL QR terbaru (base64 PNG)
  lastError: null,
};

async function startSocket() {
  state.status = 'connecting';
  state.qr = null;
  state.lastError = null;

  const { state: authState, saveCreds } = await useDBAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    browser: ['Nova C2', 'Chrome', '1.0.0'],
  });

  state.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.status = 'qr_pending';
      state.qr = await QRCode.toDataURL(qr);
    }

    if (connection === 'open') {
      state.status = 'connected';
      state.qr = null;
      await fireWebhooks('connection.update', { status: 'connected' });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        state.status = 'logged_out';
        state.qr = null;
        await clearDBAuthState();
        await fireWebhooks('session.logout', {});
      } else {
        state.status = 'connecting';
        // auto-reconnect untuk semua penyebab lain (termasuk cold start Railway)
        startSocket().catch((err) => {
          state.lastError = err.message;
          state.status = 'disconnected';
        });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      await query(
        `INSERT INTO messages (wa_message_id, chat_id, sender, direction, body, status)
         VALUES ($1, $2, $3, 'in', $4, 'received')`,
        [msg.key.id, chatId, chatId, body]
      );

      await fireWebhooks('message.received', { chatId, body, messageId: msg.key.id });

      // Auto-reply: cek keyword rules dulu, lalu fallback ke chatbot API kalau diaktifkan
      const replyText = await runAutoReply(body);
      if (replyText) {
        await sendTextMessage(chatId, replyText);
      }
    }
  });

  return sock;
}

async function sendTextMessage(jid, text) {
  if (!state.sock || state.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung');
  }
  const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const result = await state.sock.sendMessage(targetJid, { text });

  await query(
    `INSERT INTO messages (wa_message_id, chat_id, sender, direction, body, status)
     VALUES ($1, $2, 'me', 'out', $3, 'sent')`,
    [result?.key?.id || null, targetJid, text]
  );

  await fireWebhooks('message.sent', { chatId: targetJid, body: text });
  return result;
}

async function logout() {
  if (state.sock) {
    try {
      await state.sock.logout();
    } catch (e) {
      // sudah terputus, abaikan
    }
  }
  await clearDBAuthState();
  state.status = 'logged_out';
  state.qr = null;
}

function getStatus() {
  return {
    status: state.status,
    qr: state.status === 'qr_pending' ? state.qr : null,
    lastError: state.lastError,
  };
}

module.exports = { startSocket, sendTextMessage, logout, getStatus, state };
