const axios = require('axios');
const { query } = require('../db');

async function fireWebhooks(event, payload) {
  const res = await query(
    `SELECT url FROM webhooks WHERE enabled = true AND $1 = ANY(events)`,
    [event]
  );

  const tasks = res.rows.map((row) =>
    axios
      .post(row.url, { event, payload, timestamp: new Date().toISOString() }, { timeout: 8000 })
      .catch((err) => console.error(`[webhook] gagal kirim ke ${row.url}:`, err.message))
  );

  await Promise.all(tasks);
}

module.exports = { fireWebhooks };
