const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/apiKeyAuth');
const wa = require('../services/whatsapp');
const { query } = require('../db');

router.use(apiKeyAuth);

// GET /api/v1/sessions -> daftar semua sesi WA & statusnya
router.get('/sessions', (req, res) => {
  res.json({ sessions: wa.getAllStatuses() });
});

// GET /api/v1/qr?sessionId=default
router.get('/qr', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const status = wa.getStatus(sessionId);
  if (!status) return res.status(404).json({ error: `Sesi "${sessionId}" tidak ditemukan` });
  if (status.status !== 'qr_pending' || !status.qr) {
    return res.status(404).json({ error: 'QR tidak tersedia saat ini', status: status.status });
  }
  res.json({ qr: status.qr, status: status.status });
});

// GET /api/v1/session/status?sessionId=default
router.get('/session/status', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const status = wa.getStatus(sessionId);
  if (!status) return res.status(404).json({ error: `Sesi "${sessionId}" tidak ditemukan` });
  res.json({ status: status.status, lastError: status.lastError });
});

// POST /api/v1/session/logout  { sessionId }
router.post('/session/logout', async (req, res) => {
  const sessionId = req.body?.sessionId || 'default';
  await wa.logout(sessionId);
  res.json({ ok: true });
});

// POST /api/v1/session/restart  { sessionId, label }
router.post('/session/restart', async (req, res) => {
  const sessionId = req.body?.sessionId || 'default';
  await wa.startSocket(sessionId, req.body?.label);
  res.json({ ok: true });
});

// POST /api/v1/send-message  { sessionId, to, message }
router.post('/send-message', async (req, res) => {
  const { to, message } = req.body;
  const sessionId = req.body?.sessionId || 'default';
  if (!to || !message) {
    return res.status(400).json({ error: 'Field "to" dan "message" wajib diisi' });
  }
  try {
    const result = await wa.sendTextMessage(sessionId, to, message);
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/messages?chatId=&from=&to=&limit=&sessionId=
router.get('/messages', async (req, res) => {
  const { chatId, from, to, limit, sessionId } = req.query;
  const conditions = [];
  const params = [];

  if (sessionId) {
    params.push(sessionId);
    conditions.push(`session_id = $${params.length}`);
  }
  if (chatId) {
    params.push(chatId);
    conditions.push(`chat_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit) || 50, 200));

  const res_ = await query(
    `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ messages: res_.rows });
});

// POST /api/v1/chatbot/config  { keyword, match_type, reply }
router.post('/chatbot/config', async (req, res) => {
  const { keyword, match_type = 'contains', reply } = req.body;
  if (!keyword || !reply) {
    return res.status(400).json({ error: 'Field "keyword" dan "reply" wajib diisi' });
  }
  const result = await query(
    `INSERT INTO autoreply_rules (keyword, match_type, reply) VALUES ($1, $2, $3) RETURNING *`,
    [keyword, match_type, reply]
  );
  res.json({ ok: true, rule: result.rows[0] });
});

// GET /api/v1/chatbot/config
router.get('/chatbot/config', async (req, res) => {
  const result = await query(`SELECT * FROM autoreply_rules ORDER BY id DESC`);
  res.json({ rules: result.rows });
});

// PATCH /api/v1/chatbot/config/:id/toggle
router.patch('/chatbot/config/:id/toggle', async (req, res) => {
  const result = await query(
    `UPDATE autoreply_rules SET enabled = NOT enabled WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Rule tidak ditemukan' });
  res.json({ ok: true, rule: result.rows[0] });
});

// DELETE /api/v1/chatbot/config/:id
router.delete('/chatbot/config/:id', async (req, res) => {
  await query(`DELETE FROM autoreply_rules WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/v1/webhook  { url, events: [] }
router.post('/webhook', async (req, res) => {
  const { url, events = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'Field "url" wajib diisi' });
  const result = await query(
    `INSERT INTO webhooks (url, events) VALUES ($1, $2) RETURNING *`,
    [url, events]
  );
  res.json({ ok: true, webhook: result.rows[0] });
});

// GET /api/v1/webhook
router.get('/webhook', async (req, res) => {
  const result = await query(`SELECT * FROM webhooks ORDER BY id DESC`);
  res.json({ webhooks: result.rows });
});

module.exports = router;
