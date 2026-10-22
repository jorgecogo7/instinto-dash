const db = require('./db');

/**
 * Rascunhos de campanha de cada cliente. Toda função recebe o clientId e toda
 * consulta filtra por ele (WHERE client_id = ?): um rascunho de um cliente
 * nunca aparece, nem é alterado, pelo endereço de outro cliente.
 */

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const need = (clientId) => {
  if (!clientId || typeof clientId !== 'string') throw new Error('clientId obrigatório em Campanhas.');
  return clientId;
};

async function list(clientId) {
  await db.ensureCampaignTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM campaign_drafts WHERE client_id = ? ORDER BY created_at DESC LIMIT 500', [need(clientId)],
  );
  return rows.map((r) => parse(r.data));
}

async function get(clientId, id) {
  await db.ensureCampaignTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM campaign_drafts WHERE client_id = ? AND id = ?', [need(clientId), String(id)],
  );
  return rows.length ? parse(rows[0].data) : null;
}

async function add(clientId, draft) {
  await db.ensureCampaignTables();
  const row = { ...draft, clientId: need(clientId) };
  await db.getPool().query(
    'INSERT INTO campaign_drafts (id, client_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)',
    [row.id, clientId, row.status, new Date(row.createdAt), JSON.stringify(row)],
  );
  return row;
}

// Salva só se o status no banco ainda for um dos esperados (null = qualquer um).
// Devolve null se o rascunho mudou de status no meio do caminho.
async function save(clientId, draft, expectedStatuses = null) {
  await db.ensureCampaignTables();
  const row = { ...draft, clientId: need(clientId) };
  let sql = 'UPDATE campaign_drafts SET status = ?, data = ? WHERE client_id = ? AND id = ?';
  const params = [row.status, JSON.stringify(row), clientId, row.id];
  if (expectedStatuses && expectedStatuses.length) {
    sql += ` AND status IN (${expectedStatuses.map(() => '?').join(',')})`;
    params.push(...expectedStatuses);
  }
  const [result] = await db.getPool().query(sql, params);
  return result.affectedRows > 0 ? row : null;
}

async function remove(clientId, id) {
  await db.ensureCampaignTables();
  const [result] = await db.getPool().query(
    "DELETE FROM campaign_drafts WHERE client_id = ? AND id = ? AND status NOT IN ('publishing','published')",
    [need(clientId), String(id)],
  );
  return result.affectedRows > 0;
}

/* ---------- Imagens dos criativos ---------- */

async function addAsset(clientId, asset) {
  await db.ensureCampaignTables();
  await db.getPool().query(
    'INSERT INTO campaign_assets (id, client_id, created_at, mime, name, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [asset.id, need(clientId), new Date(), asset.mime, asset.name || null, asset.data.length, asset.data],
  );
  return { id: asset.id, mime: asset.mime, name: asset.name || null, size: asset.data.length };
}

async function getAsset(clientId, id) {
  await db.ensureCampaignTables();
  const [rows] = await db.getPool().query(
    'SELECT id, mime, name, size, data FROM campaign_assets WHERE client_id = ? AND id = ?', [need(clientId), String(id)],
  );
  return rows.length ? rows[0] : null;
}

// Usado quando o cliente é excluído.
async function removeAllForClient(clientId) {
  await db.ensureCampaignTables();
  await db.getPool().query('DELETE FROM campaign_drafts WHERE client_id = ?', [need(clientId)]);
  await db.getPool().query('DELETE FROM campaign_assets WHERE client_id = ?', [need(clientId)]);
}

module.exports = { list, get, add, save, remove, addAsset, getAsset, removeAllForClient };
