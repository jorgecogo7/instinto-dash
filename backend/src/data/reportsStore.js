const db = require('./db');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function list(limit = 300) {
  await db.ensureReportsTable();
  const [rows] = await db.getPool().query('SELECT data FROM reports ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map((r) => parse(r.data));
}

async function getById(id) {
  await db.ensureReportsTable();
  const [rows] = await db.getPool().query('SELECT data FROM reports WHERE id = ?', [id]);
  return rows.length ? parse(rows[0].data) : null;
}

async function exists(clientId, periodKey) {
  await db.ensureReportsTable();
  const [rows] = await db.getPool().query('SELECT id FROM reports WHERE client_id = ? AND period_key = ?', [clientId, periodKey]);
  return rows.length > 0;
}

// Se já existe relatório desse cliente/período, substitui (gerar de novo).
async function upsert(report) {
  await db.ensureReportsTable();
  await db.getPool().query(
    `INSERT INTO reports (id, client_id, period_key, created_at, data) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = VALUES(id), created_at = VALUES(created_at), data = VALUES(data)`,
    [report.id, report.clientId, report.periodKey, new Date(report.createdAt), JSON.stringify(report)],
  );
  return report;
}

async function update(id, changes) {
  const current = await getById(id);
  if (!current) return null;
  const updated = { ...current, ...changes, updatedAt: new Date().toISOString() };
  await db.getPool().query('UPDATE reports SET data = ? WHERE id = ?', [JSON.stringify(updated), id]);
  return updated;
}

async function remove(id) {
  await db.ensureReportsTable();
  const [r] = await db.getPool().query('DELETE FROM reports WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

module.exports = { list, getById, exists, upsert, update, remove };
