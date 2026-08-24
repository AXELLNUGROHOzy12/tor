const express = require('express');
const router = express.Router();
const requirePanelLogin = require('../middleware/panelAuth');
const wa = require('../services/whatsapp');
const { clearHistory } = require('../services/chatbot');
const { query } = require('../db');

// POST /panel/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    // Simpan sesi secara eksplisit sebelum membalas response. Tanpa ini,
    // frontend bisa langsung fetch /panel/dashboard sepersekian detik
    // setelah login sukses, sebelum sesi selesai ditulis ke store -> balik
    // ke halaman login walau password benar.
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

// GET /panel/dashboard  -> ringkasan status + statistik
router.get('/dashboard', async (req, res) => {
  const status = wa.getStatus();
  const msgCount = await query(`SELECT COUNT(*) FROM messages`);
  const inCount = await query(`SELECT COUNT(*) FROM messages WHERE direction = 'in'`);
  const outCount = await query(`SELECT COUNT(*) FROM messages WHERE direction = 'out'`);
  const ruleCount = await query(`SELECT COUNT(*) FROM autoreply_rules WHERE enabled = true`);

  res.json({
    status: status.status,
    qr: status.qr,
    totalMessages: parseInt(msgCount.rows[0].count),
    totalIn: parseInt(inCount.rows[0].count),
    totalOut: parseInt(outCount.rows[0].count),
    activeRules: parseInt(ruleCount.rows[0].count),
  });
});

// POST /panel/session/restart
router.post('/session/restart', async (req, res) => {
  await wa.startSocket();
  res.json({ ok: true });
});

// POST /panel/session/logout
router.post('/session/logout', async (req, res) => {
  await wa.logout();
  res.json({ ok: true });
});

// autoreply rules CRUD ringkas untuk panel
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

// messages list untuk panel
router.get('/messages', async (req, res) => {
  const result = await query(`SELECT * FROM messages ORDER BY created_at DESC LIMIT 100`);
  res.json({ messages: result.rows });
});

module.exports = router;
