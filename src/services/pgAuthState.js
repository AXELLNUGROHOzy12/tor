const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { query } = require('../db');

// Implementasi auth state Baileys yang menyimpan creds & signal keys
// ke PostgreSQL, bukan ke filesystem lokal. Ini WAJIB untuk Railway,
// karena filesystem container tidak persisten antar-deploy/restart.

async function useDBAuthState(sessionId = 'default') {
  const readCreds = async () => {
    const res = await query('SELECT creds FROM wa_sessions WHERE id = $1', [sessionId]);
    if (res.rows.length === 0) return initAuthCreds();
    return JSON.parse(JSON.stringify(res.rows[0].creds), BufferJSON.reviver);
  };

  const writeCreds = async (creds) => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await query(
      `INSERT INTO wa_sessions (id, creds, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET creds = $2, updated_at = now()`,
      [sessionId, serialized]
    );
  };

  let creds = await readCreds();

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const res = await query(
        `SELECT key_id, value FROM wa_session_keys
         WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [sessionId, type, ids]
      );
      for (const row of res.rows) {
        let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[row.key_id] = value;
      }
      return data;
    },
    set: async (data) => {
      const tasks = [];
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          if (value) {
            const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            tasks.push(
              query(
                `INSERT INTO wa_session_keys (session_id, key_type, key_id, value, updated_at)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (session_id, key_type, key_id) DO UPDATE SET value = $4, updated_at = now()`,
                [sessionId, type, id, serialized]
              )
            );
          } else {
            tasks.push(
              query(
                `DELETE FROM wa_session_keys WHERE session_id = $1 AND key_type = $2 AND key_id = $3`,
                [sessionId, type, id]
              )
            );
          }
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await writeCreds(creds);
    },
  };
}

async function clearDBAuthState(sessionId = 'default') {
  await query('DELETE FROM wa_sessions WHERE id = $1', [sessionId]);
  await query('DELETE FROM wa_session_keys WHERE session_id = $1', [sessionId]);
}

module.exports = { useDBAuthState, clearDBAuthState };
