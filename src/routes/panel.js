const express = require('express');
const router = express.Router();
const requirePanelLogin = require('../middleware/panelAuth');
const wa = require('../services/whatsapp');
const telegram = require('../services/telegram');
const { clearHistory } = require('../services/chatbot');
const { query } = require('../db');

// POST /panel/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return req.session.save((err) => {
      if (err) {
        console.error('Gagal simpan sesi:', err);
        return res.status(500).json({ error: 'Gagal menyimpan sesi' });
      }
      res.json({ ok: true });
    });
  }
  res.status(401).json({ error: 'Username atau password salah' });
});

// POST /panel/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /panel/check-session
router.get('/check-session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

// Semua route di bawah ini butuh login
router.use(requirePanelLogin);

// GET /panel/dashboard  -> ringkasan statistik global (semua sesi)
router.get('/dashboard', async (req, res) => {
  const msgCount = await query(`SELECT COUNT(*) FROM messages`);
  const inCount = await query(`SELECT COUNT(*) FROM messages WHERE direction = 'in'`);
  const outCount = await query(`SELECT COUNT(*) FROM messages WHERE direction = 'out'`);
  const ruleCount = await query(`SELECT COUNT(*) FROM autoreply_rules WHERE enabled = true`);
  const sessions = wa.getAllStatuses();

  res.json({
    totalMessages: parseInt(msgCount.rows[0].count),
    totalIn: parseInt(inCount.rows[0].count),
    totalOut: parseInt(outCount.rows[0].count),
    activeRules: parseInt(ruleCount.rows[0].count),
    totalSessions: sessions.length,
    connectedSessions: sessions.filter((s) => s.status === 'connected').length,
  });
});

// ===================== Multi-session WhatsApp =====================

// GET /panel/sessions -> daftar semua sesi + status realtime
router.get('/sessions', (req, res) => {
  res.json({ sessions: wa.getAllStatuses() });
});

// POST /panel/sessions  { label }  -> buat sesi baru, langsung mulai pairing
router.post('/sessions', async (req, res) => {
  const label = (req.body?.label || '').trim() || 'Sesi Baru';
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'sesi';
  let sessionId = base;
  let n = 1;
  while (wa.sessions.has(sessionId)) {
    sessionId = `${base}-${++n}`;
  }

  try {
    await wa.startSocket(sessionId, label);
    res.json({ ok: true, id: sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /panel/sessions/:id/restart
router.post('/sessions/:id/restart', async (req, res) => {
  try {
    await wa.startSocket(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /panel/sessions/:id/logout  -> putus tapi record tetap ada (bisa pairing ulang)
router.post('/sessions/:id/logout', async (req, res) => {
  await wa.logout(req.params.id);
  res.json({ ok: true });
});

// DELETE /panel/sessions/:id  -> hapus total (creds + metadata)
router.delete('/sessions/:id', async (req, res) => {
  await wa.deleteSession(req.params.id);
  res.json({ ok: true });
});

// Alias lama (single-session) tetap didukung, default ke sesi "default"
router.post('/session/restart', async (req, res) => {
  await wa.startSocket('default');
  res.json({ ok: true });
});
router.post('/session/logout', async (req, res) => {
  await wa.logout('default');
  res.json({ ok: true });
});

// ===================== Telegram integration =====================

// GET /panel/telegram -> config saat ini (token tidak dikirim balik utuh, cuma ditandai ada/tidak)
router.get('/telegram', async (req, res) => {
  const cfg = await telegram.getTelegramConfig();
  const runtime = telegram.getBotRuntimeStatus();
  res.json({
    hasToken: !!cfg.token,
    tokenPreview: cfg.token ? `${cfg.token.slice(0, 6)}...${cfg.token.slice(-4)}` : '',
    chatId: cfg.chatId,
    forwardMessages: cfg.forwardMessages,
    aiEnabled: cfg.aiEnabled,
    running: runtime.running,
  });
});

// POST /panel/telegram  { token, chatId, forwardMessages, aiEnabled }
// token dikosongkan dari form berarti "jangan diganti" -> di-merge sama config lama.
router.post('/telegram', async (req, res) => {
  const { token, chatId, forwardMessages, aiEnabled } = req.body;
  try {
    const existing = await telegram.getTelegramConfig();
    await telegram.saveTelegramConfig({
      token: token || existing.token,
      chatId: chatId !== undefined ? chatId : existing.chatId,
      forwardMessages: forwardMessages !== undefined ? forwardMessages : existing.forwardMessages,
      aiEnabled: aiEnabled !== undefined ? aiEnabled : existing.aiEnabled,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /panel/telegram/test -> kirim pesan tes ke chat admin
router.post('/telegram/test', async (req, res) => {
  try {
    await telegram.sendTestMessage();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===================== Auto-reply rules =====================

router.get('/rules', async (req, res) => {
  const result = await query(`SELECT * FROM autoreply_rules ORDER BY id DESC`);
  res.json({ rules: result.rows });
});

router.post('/rules', async (req, res) => {
  const { keyword, match_type = 'contains', reply } = req.body;
  const result = await query(
    `INSERT INTO autoreply_rules (keyword, match_type, reply) VALUES ($1, $2, $3) RETURNING *`,
    [keyword, match_type, reply]
  );
  res.json({ ok: true, rule: result.rows[0] });
});

router.delete('/rules/:id', async (req, res) => {
  await query(`DELETE FROM autoreply_rules WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.patch('/rules/:id/toggle', async (req, res) => {
  await query(`UPDATE autoreply_rules SET enabled = NOT enabled WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// DELETE /panel/chatbot/history/:chatId  -> hapus riwayat percakapan AI satu kontak
router.delete('/chatbot/history/:chatId', (req, res) => {
  clearHistory(decodeURIComponent(req.params.chatId));
  res.json({ ok: true });
});

// ===================== Pesan =====================

// messages list untuk panel, bisa difilter per sesi
router.get('/messages', async (req, res) => {
  const { sessionId } = req.query;
  const result = sessionId
    ? await query(
        `SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [sessionId]
      )
    : await query(`SELECT * FROM messages ORDER BY created_at DESC LIMIT 100`);
  res.json({ messages: result.rows });
});

// POST /panel/send-message  { sessionId, to, message }
router.post('/send-message', async (req, res) => {
  const { sessionId, to, message } = req.body;
  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: 'Field "sessionId", "to", dan "message" wajib diisi' });
  }
  try {
    const result = await wa.sendTextMessage(sessionId, to, message);
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
