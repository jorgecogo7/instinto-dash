const db = require('./db');

/**
 * Mesmo "formato" de antes (cada conta é um objeto), só que agora
 * guardado como uma linha de banco (coluna JSON) em vez de um arquivo.
 * Isso sobrevive a qualquer deploy, reinício ou republicação.
 */

async function getAll() {
  await db.ensureTable();
  const [rows] = await db.getPool().query('SELECT data FROM accounts');
  return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
}

async function add(account) {
  await db.ensureTable();
  await db.getPool().query('INSERT INTO accounts (id, data) VALUES (?, ?)', [account.id, JSON.stringify(account)]);
  return account;
}

async function update(id, changes) {
  await db.ensureTable();
  const [rows] = await db.getPool().query('SELECT data FROM accounts WHERE id = ?', [id]);
  if (!rows.length) return null;
  const current = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  const updated = Object.assign(current, changes);
  await db.getPool().query('UPDATE accounts SET data = ? WHERE id = ?', [JSON.stringify(updated), id]);
  return updated;
}

async function remove(id) {
  await db.ensureTable();
  const [result] = await db.getPool().query('DELETE FROM accounts WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// Usado pelo link de compartilhamento (visualização do cliente, sem login).
async function getByShareToken(token) {
  await db.ensureTable();
  const [rows] = await db.getPool().query("SELECT data FROM accounts WHERE data->>'$.shareToken' = ?", [token]);
  if (!rows.length) return null;
  return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
}

module.exports = { getAll, add, update, remove, getByShareToken };
