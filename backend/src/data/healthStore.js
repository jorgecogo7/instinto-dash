const db = require('./db');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function getAll() {
  await db.ensureHealthTable();
  const [rows] = await db.getPool().query('SELECT data FROM account_health');
  return rows.map((r) => parse(r.data));
}

async function get(clientId) {
  await db.ensureHealthTable();
  const [rows] = await db.getPool().query('SELECT data FROM account_health WHERE client_id = ?', [clientId]);
  return rows.length ? parse(rows[0].data) : null;
}

async function save(record) {
  await db.ensureHealthTable();
  await db.getPool().query(
    `INSERT INTO account_health (client_id, checked_at, data) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE checked_at = VALUES(checked_at), data = VALUES(data)`,
    [record.clientId, new Date(record.checkedAt), JSON.stringify(record)],
  );
  return record;
}

async function remove(clientId) {
  await db.ensureHealthTable();
  await db.getPool().query('DELETE FROM account_health WHERE client_id = ?', [clientId]);
}

module.exports = { getAll, get, save, remove };
