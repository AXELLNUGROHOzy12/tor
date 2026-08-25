const baileys = require('@whiskeysockets/baileys');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = baileys;
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const { useDBAuthState, clearDBAuthState } = require('./pgAuthState');
const { query } = require('../db');
const { runAutoReply } = require('./chatbot');
const { fireWebhooks } = require('./webhooks');
const { getGotagMode, setGotagMode } = require('./groupSettings');
const telegram = require('./telegram');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// =============================================================
// Multi-session: setiap nomor WA yang ditambahkan lewat panel punya
// socket Baileys sendiri. Semua di-index di Map `sessions`, key-nya
// session_id (string bebas, dibuat panel saat "Tambah Sesi").
// =============================================================

const sessions = new Map();
// bentuk tiap entry:
// { sock, status, qr, lastError, label, phoneNumber }

function ensureEntry(sessionId, label) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sock: null,
      status: 'disconnected',
      qr: null,
      lastError: null,
      label: label || sessionId,
      phoneNumber: null,
    });
  }
  return sessions.get(sessionId);
}

// --- Mode ".gotag" (khusus grup) -------------------------------
// Kalau aktif untuk suatu grup, bot hanya membalas pesan yang
// nge-tag (@mention) bot atau reply ke pesan bot itu sendiri.
//
// Catatan: WhatsApp sekarang bisa ngirim JID mention pakai domain
// @lid (linked id) atau @s.whatsapp.net, tergantung akun. Makanya
// perbandingannya cuma pakai bagian ID mentahnya aja (nomor/id di
// depan "@"), domain-nya diabaikan supaya tetap match.
function rawId(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

// Kumpulin semua kemungkinan identitas bot sendiri (id utama + lid kalau ada)
function getSelfIds(sock) {
  const ids = [rawId(sock?.user?.id), rawId(sock?.user?.lid)];
  return ids.filter(Boolean);
}

function isBotMentioned(msg, sock) {
  const selfIds = getSelfIds(sock);
  if (selfIds.length === 0) return false;

  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo;

  const mentionedJid = ctx?.mentionedJid || [];
  const mentioned = mentionedJid.some((jid) => selfIds.includes(rawId(jid)));

  // Reply langsung ke pesan bot juga dihitung sebagai "tag"
  const repliedToBot = !!(ctx?.participant && selfIds.includes(rawId(ctx.participant)));

  if (process.env.DEBUG_GOTAG === 'true') {
    console.log('[gotag debug]', {
      selfIds,
      mentionedJid,
      quotedParticipant: ctx?.participant,
      mentioned,
      repliedToBot,
    });
  }

  return mentioned || repliedToBot;
}

async function startSocket(sessionId = 'default', label) {
  const entry = ensureEntry(sessionId, label);
  if (label) entry.label = label;

  entry.status = 'connecting';
  entry.qr = null;
  entry.lastError = null;

  await query(
    `INSERT INTO bot_sessions (id, label) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET label = COALESCE(EXCLUDED.label, bot_sessions.label)`,
    [sessionId, entry.label]
  );

  const { state: authState, saveCreds } = await useDBAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    browser: ['Nova C2', 'Chrome', '1.0.0'],
  });

  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.status = 'qr_pending';
      entry.qr = await QRCode.toDataURL(qr);
      telegram.notifyTelegram(`📷 Sesi "${entry.label}" (${sessionId}) minta scan QR baru di panel.`);
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.phoneNumber = sock.user?.id ? rawId(sock.user.id) : null;
      await query(`UPDATE bot_sessions SET phone_number = $1 WHERE id = $2`, [
        entry.phoneNumber,
        sessionId,
      ]);
      await fireWebhooks('connection.update', { sessionId, status: 'connected' });
      telegram.notifyTelegram(`✅ Sesi "${entry.label}" (${sessionId}) terhubung${entry.phoneNumber ? ' — ' + entry.phoneNumber : ''}.`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        entry.status = 'logged_out';
        entry.qr = null;
        await clearDBAuthState(sessionId);
        await fireWebhooks('session.logout', { sessionId });
        telegram.notifyTelegram(`🚪 Sesi "${entry.label}" (${sessionId}) logout.`);
      } else {
        entry.status = 'connecting';
        // auto-reconnect untuk semua penyebab lain (termasuk cold start Railway)
        startSocket(sessionId, entry.label).catch((err) => {
          entry.lastError = err.message;
          entry.status = 'disconnected';
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
        `INSERT INTO messages (wa_message_id, session_id, chat_id, sender, direction, body, status)
         VALUES ($1, $2, $3, $4, 'in', $5, 'received')`,
        [msg.key.id, sessionId, chatId, chatId, body]
      );

      await fireWebhooks('message.received', { sessionId, chatId, body, messageId: msg.key.id });
      telegram.forwardIncomingMessage({ sessionId, chatId, body });

      const isGroup = chatId.endsWith('@g.us');
      const command = body.trim().toLowerCase();

      // Command: .gotag on / .gotag off -> toggle mode "hanya balas kalau di-tag" (khusus grup)
      if (command === '.gotag on' || command === '.gotag off') {
        if (!isGroup) {
          await sendTextMessage(sessionId, chatId, 'Perintah .gotag cuma berlaku di dalam grup.');
          continue;
        }
        const enabled = command === '.gotag on';
        await setGotagMode(chatId, enabled);
        await sendTextMessage(
          sessionId,
          chatId,
          enabled
            ? '✅ Mode gotag diaktifkan. Bot cuma akan merespon kalau di-tag/reply di grup ini.'
            : '✅ Mode gotag dimatikan. Bot akan merespon seperti biasa di grup ini.'
        );
        continue;
      }

      // Kalau mode gotag aktif untuk grup ini, skip auto-reply kecuali bot di-tag/di-reply
      if (isGroup) {
        const gotagEnabled = await getGotagMode(chatId);
        if (gotagEnabled && !isBotMentioned(msg, entry.sock)) {
          continue;
        }
      }

      // Auto-reply: cek keyword rules dulu, lalu fallback ke Claude Haiku kalau diaktifkan
      const replyText = await runAutoReply(body, chatId);
      if (replyText) {
        await sendTextMessage(sessionId, chatId, replyText);
      }
    }
  });

  return sock;
}

async function sendTextMessage(sessionId, jid, text) {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.sock || entry.status !== 'connected') {
    throw new Error(`Sesi "${sessionId}" belum terhubung`);
  }
  const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const result = await entry.sock.sendMessage(targetJid, { text });

  await query(
    `INSERT INTO messages (wa_message_id, session_id, chat_id, sender, direction, body, status)
     VALUES ($1, $2, $3, 'me', 'out', $4, 'sent')`,
    [result?.key?.id || null, sessionId, targetJid, text]
  );

  await fireWebhooks('message.sent', { sessionId, chatId: targetJid, body: text });
  return result;
}

async function logout(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry?.sock) {
    try {
      await entry.sock.logout();
    } catch (e) {
      // sudah terputus, abaikan
    }
  }
  await clearDBAuthState(sessionId);
  if (entry) {
    entry.status = 'logged_out';
    entry.qr = null;
  }
}

// Hapus total sesi: logout + hapus creds + hapus metadata dari panel.
// Beda dengan logout() yang cuma memutus tapi record-nya tetap ada
// (masih bisa pairing ulang lewat "Restart Sesi").
async function deleteSession(sessionId) {
  await logout(sessionId);
  sessions.delete(sessionId);
  await query(`DELETE FROM bot_sessions WHERE id = $1`, [sessionId]);
}

function getStatus(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  return {
    id: sessionId,
    label: entry.label,
    status: entry.status,
    qr: entry.status === 'qr_pending' ? entry.qr : null,
    lastError: entry.lastError,
    phoneNumber: entry.phoneNumber,
  };
}

function getAllStatuses() {
  return Array.from(sessions.keys()).map((id) => getStatus(id));
}

// Dipanggil sekali saat server start: baca semua sesi yang pernah
// dibuat lewat panel dari DB, lalu sambungkan lagi satu-satu.
async function restoreSessions() {
  const res = await query(`SELECT id, label FROM bot_sessions ORDER BY created_at ASC`);
  for (const row of res.rows) {
    ensureEntry(row.id, row.label);
    startSocket(row.id, row.label).catch((err) => {
      const entry = sessions.get(row.id);
      if (entry) {
        entry.lastError = err.message;
        entry.status = 'disconnected';
      }
      console.error(`[whatsapp] gagal restore sesi ${row.id}:`, err.message);
    });
  }
}

module.exports = {
  startSocket,
  sendTextMessage,
  logout,
  deleteSession,
  getStatus,
  getAllStatuses,
  restoreSessions,
  sessions,
};

telegram.registerWaController(module.exports);
