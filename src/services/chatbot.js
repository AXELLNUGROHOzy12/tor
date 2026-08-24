const axios = require('axios');
const { query } = require('../db');

// Cek pesan masuk terhadap rules keyword yang disimpan admin di panel.
async function matchKeywordRule(body) {
  const res = await query(
    `SELECT keyword, match_type, reply FROM autoreply_rules WHERE enabled = true`
  );
  const text = (body || '').toLowerCase().trim();

  for (const rule of res.rows) {
    const kw = rule.keyword.toLowerCase();
    if (
      (rule.match_type === 'contains' && text.includes(kw)) ||
      (rule.match_type === 'exact' && text === kw) ||
      (rule.match_type === 'startswith' && text.startsWith(kw))
    ) {
      return rule.reply;
    }
  }
  return null;
}

// Placeholder untuk API chatbot eksternal (gratis) yang belum ditentukan.
// Tinggal isi CHATBOT_API_URL & CHATBOT_API_KEY di .env, dan sesuaikan
// bentuk request/response di sini begitu API-nya sudah dipilih.
async function callChatbotAPI(body) {
  if (process.env.CHATBOT_ENABLED !== 'true' || !process.env.CHATBOT_API_URL) {
    return null;
  }

  try {
    const res = await axios.post(
      process.env.CHATBOT_API_URL,
      { message: body }, // TODO: sesuaikan payload dengan API yang dipakai
      {
        headers: process.env.CHATBOT_API_KEY
          ? { Authorization: `Bearer ${process.env.CHATBOT_API_KEY}` }
          : {},
        timeout: 10000,
      }
    );
    // TODO: sesuaikan field response dengan API yang dipakai
    return res.data?.reply || res.data?.message || null;
  } catch (err) {
    console.error('[chatbot] gagal memanggil chatbot API:', err.message);
    return null;
  }
}

async function runAutoReply(body) {
  const keywordReply = await matchKeywordRule(body);
  if (keywordReply) return keywordReply;

  return callChatbotAPI(body);
}

module.exports = { runAutoReply, callChatbotAPI };
