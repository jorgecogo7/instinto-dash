const crypto = require('crypto');
const db = require('./db');

/**
 * Histórico do Google Tag Manager: quem criou tag, criou versão ou publicou, e quando.
 * Toda consulta filtra por client_id. Só rotas da agência usam este arquivo.
 */
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function add(clientId, entry) {
  if (!clientId) throw new Error('clientId obrigatório no histórico do Tag Manager.');
  await db.ensureGtmLogTable();
  const row = { id: crypto.randomUUID(), clientId, ...entry };
  await db.getPool().query(
    'INSERT INTO gtm_log (id, client_id, created_at, data) VALUES (?, ?, ?, ?)',
    [row.id, clientId, new Date(row.at), JSON.stringify(row)],
  );
  return row;
}

async function list(clientId, limit = 50) {
  await db.ensureGtmLogTable();
  const [rows] = await db.getPool().query(
    'SELECT data FROM gtm_log WHERE client_id = ? ORDER BY created_at DESC LIMIT ?',
    [String(clientId), Math.min(Number(limit) || 50, 200)],
  );
  return rows.map((r) => parse(r.data)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

module.exports = { add, list };
