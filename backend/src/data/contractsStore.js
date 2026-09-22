const db = require('./db');

/**
 * Contratos — vigência, renovação automática e histórico. Mesmo padrão de
 * armazenamento das outras tabelas (linha por contrato, coluna JSON).
 */

async function getAll() {
  await db.ensureContractsTable();
  const [rows] = await db.getPool().query('SELECT data FROM contracts');
  return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
}

async function getById(id) {
  await db.ensureContractsTable();
  const [rows] = await db.getPool().query('SELECT data FROM contracts WHERE id = ?', [id]);
  if (!rows.length) return null;
  return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
}

async function add(contract) {
  await db.ensureContractsTable();
  await db.getPool().query('INSERT INTO contracts (id, data) VALUES (?, ?)', [contract.id, JSON.stringify(contract)]);
  return contract;
}

async function update(id, changes) {
  await db.ensureContractsTable();
  const [rows] = await db.getPool().query('SELECT data FROM contracts WHERE id = ?', [id]);
  if (!rows.length) return null;
  const current = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  const updated = Object.assign(current, changes);
  await db.getPool().query('UPDATE contracts SET data = ? WHERE id = ?', [JSON.stringify(updated), id]);
  return updated;
}

async function remove(id) {
  await db.ensureContractsTable();
  const [result] = await db.getPool().query('DELETE FROM contracts WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = { getAll, getById, add, update, remove };
