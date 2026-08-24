'use strict';
const crypto = require('node:crypto');
const { query } = require('../db');

// =============================================================
// ClaudeHaiku via overchat.ai
// Terintegrasi dengan sistem keyword rules yang sudah ada.
// Aktifkan dengan CHATBOT_ENABLED=true di environment variables.
// =============================================================

const OVERCHAT_API  = 'https://api.overchat.ai/v1/chat/completions';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';

// --- Manajemen histori percakapan per chatId (in-memory) -----
// Setiap chatId WhatsApp punya riwayat sendiri.
// Maksimal 20 pasang (user+assistant) sebelum yang lama dihapus.
const MAX_PAIRS = 20;
const chatHistories = new Map();

function getHistory(chatId) {
  return chatHistories.get(chatId) || [];
}

function pushHistory(chatId, role, content) {
  const hist = getHistory(chatId);
  hist.push({ role, content });
  // Buang pasang terlama kalau sudah melewati batas
  while (hist.length > MAX_PAIRS * 2) hist.splice(0, 2);
  chatHistories.set(chatId, hist);
}

function clearHistory(chatId) {
  chatHistories.delete(chatId);
}

// --- Keyword rules (tetap diprioritaskan) --------------------
async function matchKeywordRule(body) {
  const res = await query(
    `SELECT keyword, match_type, reply FROM autoreply_rules WHERE enabled = true`
  );
  const text = (body || '').toLowerCase().trim();

  for (const rule of res.rows) {
    const kw = rule.keyword.toLowerCase();
    if (
      (rule.match_type === 'contains'   && text.includes(kw))   ||
      (rule.match_type === 'exact'      && text === kw)          ||
      (rule.match_type === 'startswith' && text.startsWith(kw))
    ) {
      return rule.reply;
    }
  }
  return null;
}

// --- Integrasi overchat.ai -----------------------------------
async function callClaudeHaiku(prompt, chatId) {
  const sessionChatId = crypto.randomUUID();
  const deviceId      = crypto.randomUUID();
  const model         = 'claude-haiku-4-5-20251001';
  const history       = getHistory(chatId);

  // Susun pesan: riwayat dulu, lalu pesan user baru, lalu system prompt
  const messages = [
    ...history.map((item) => ({
      id:      crypto.randomUUID(),
      role:    item.role,
      content: item.content,
    })),
    {
      id:      crypto.randomUUID(),
      role:    'user',
      content: prompt,
    },
    {
      id:      crypto.randomUUID(),
      role:    'system',
      content: process.env.CHATBOT_SYSTEM_PROMPT ||
               'Ikuti bahasa user dan jawab dengan gaya natural, singkat, dan jelas.',
    },
  ];

  const body = {
    chatId:            sessionChatId,
    model,
    messages,
    personaId:         'claude-haiku-4-5-landing',
    frequency_penalty: 0,
    max_tokens:        4000,
    presence_penalty:  0,
    stream:            true,
    temperature:       0.5,
    top_p:             0.95,
  };

  const headers = {
    'sec-ch-ua-platform': '"Android"',
    'x-device-uuid':      deviceId,
    'sec-ch-ua':          '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile':   '?1',
    'x-device-language':  'id-ID',
    'x-device-platform':  'web',
    'x-device-version':   '1.0.44',
    'user-agent':         UA,
    accept:               '*/*',
    'content-type':       'application/json',
    origin:               'https://overchat.ai',
    referer:              'https://overchat.ai/',
    'accept-language':    'id-ID,id;q=0.9',
    priority:             'u=1, i',
  };

  const response = await fetch(OVERCHAT_API, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`overchat.ai error ${response.status}: ${text}`);
  }

  // Baca streaming SSE dan gabungkan semua chunk delta
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const json    = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content;
        if (typeof content === 'string') answer += content;
      } catch (_) { /* abaikan baris JSON rusak */ }
    }
  }

  return answer.trim();
}

// --- Entry point yang dipanggil dari whatsapp.js -------------
// chatId = JID WhatsApp (cth: "6281234567890@s.whatsapp.net")
async function runAutoReply(body, chatId) {
  // 1. Keyword rules selalu diutamakan (setting admin panel)
  const keywordReply = await matchKeywordRule(body);
  if (keywordReply) return keywordReply;

  // 2. Fallback ke Claude Haiku kalau CHATBOT_ENABLED=true
  if (process.env.CHATBOT_ENABLED !== 'true') return null;

  try {
    const answer = await callClaudeHaiku(body, chatId);
    if (!answer) return null;

    // Simpan ke histori setelah dapat respons
    pushHistory(chatId, 'user',      body);
    pushHistory(chatId, 'assistant', answer);

    return answer;
  } catch (err) {
    console.error('[chatbot] gagal memanggil overchat.ai:', err.message);
    return null;
  }
}

module.exports = { runAutoReply, clearHistory };
