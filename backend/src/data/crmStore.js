const db = require('./db');

/**
 * CRM de cada cliente. Toda função recebe o clientId e toda consulta filtra
 * por ele (WHERE client_id = ?). Não existe função que lê negócios sem
 * clientId: é isso que garante que um cliente nunca veja o CRM de outro,
 * mesmo que alguém mande o id de um negócio alheio.
 */

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const need = (clientId) => {
  if (!clientId || typeof clientId !== 'string') throw new Error('clientId obrigatório no CRM.');
  return clientId;
};

async function getPipeline(clientId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT data FROM crm_pipelines WHERE client_id = ?', [need(clientId)]);
  return rows.length ? parse(rows[0].data) : null;
}

async function savePipeline(clientId, pipeline) {
  await db.ensureCrmTables();
  await db.getPool().query(
    'INSERT INTO crm_pipelines (client_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
    [need(clientId), JSON.stringify(pipeline)],
  );
  return pipeline;
}

async function listDeals(clientId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_deals WHERE client_id = ? ORDER BY created_at DESC LIMIT 5000', [need(clientId)],
  );
  return rows.map((r) => parse(r.data));
}

async function getDeal(clientId, id) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT data FROM crm_deals WHERE client_id = ? AND id = ?', [need(clientId), String(id)]);
  return rows.length ? parse(rows[0].data) : null;
}

async function addDeal(clientId, deal) {
  await db.ensureCrmTables();
  await db.getPool().query(
    'INSERT INTO crm_deals (id, client_id, created_at, data) VALUES (?, ?, ?, ?)',
    [deal.id, need(clientId), new Date(deal.createdAt), JSON.stringify({ ...deal, clientId })],
  );
  return deal;
}

async function saveDeal(clientId, deal) {
  await db.ensureCrmTables();
  const [result] = await db.getPool().query(
    'UPDATE crm_deals SET data = ? WHERE client_id = ? AND id = ?',
    [JSON.stringify({ ...deal, clientId }), need(clientId), deal.id],
  );
  return result.affectedRows > 0 ? deal : null;
}

async function removeDeal(clientId, id) {
  await db.ensureCrmTables();
  const [result] = await db.getPool().query('DELETE FROM crm_deals WHERE client_id = ? AND id = ?', [need(clientId), String(id)]);
  return result.affectedRows > 0;
}

// Usado quando o cliente é excluído (não deixa CRM órfão para um cliente novo com o mesmo id).
async function removeAllForClient(clientId) {
  await db.ensureCrmTables();
  await db.getPool().query('DELETE FROM crm_deals WHERE client_id = ?', [need(clientId)]);
  await db.getPool().query('DELETE FROM crm_pipelines WHERE client_id = ?', [need(clientId)]);
}

module.exports = { getPipeline, savePipeline, listDeals, getDeal, addDeal, saveDeal, removeDeal, removeAllForClient };
