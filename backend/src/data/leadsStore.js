const db = require('./db');

/**
 * Mesmo padrão do accountsStore: cada lead é uma linha no banco (coluna
 * JSON), sobrevive a deploy/reinício. Tabela separada de "accounts"
 * porque um lead ainda não é cliente — é alguém que entrou pelo
 * formulário público (ou foi cadastrado manualmente) e está em algum
 * ponto do funil (Novo → Contatado → Qualificado → Proposta → Fechado/Perdido).
 */

async function getAll() {
  await db.ensureLeadsTable();
  const [rows] = await db.getPool().query('SELECT data FROM leads ORDER BY id DESC');
  return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
}

async function getById(id) {
  await db.ensureLeadsTable();
  const [rows] = await db.getPool().query('SELECT data FROM leads WHERE id = ?', [id]);
  if (!rows.length) return null;
  return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
}

async function add(lead) {
  await db.ensureLeadsTable();
  await db.getPool().query('INSERT INTO leads (id, data) VALUES (?, ?)', [lead.id, JSON.stringify(lead)]);
  return lead;
}

async function update(id, changes) {
  await db.ensureLeadsTable();
  const [rows] = await db.getPool().query('SELECT data FROM leads WHERE id = ?', [id]);
  if (!rows.length) return null;
  const current = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  const updated = Object.assign(current, changes, { updatedAt: new Date().toISOString() });
  await db.getPool().query('UPDATE leads SET data = ? WHERE id = ?', [JSON.stringify(updated), id]);
  return updated;
}

async function remove(id) {
  await db.ensureLeadsTable();
  const [result] = await db.getPool().query('DELETE FROM leads WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = { getAll, getById, add, update, remove };
