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

/* ---------- Configurações (etiquetas, WhatsApp) ---------- */
async function getSettings(clientId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT data FROM crm_settings WHERE client_id = ?', [need(clientId)]);
  return rows.length ? parse(rows[0].data) : null;
}

async function saveSettings(clientId, settings) {
  await db.ensureCrmTables();
  await db.getPool().query(
    'INSERT INTO crm_settings (client_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
    [need(clientId), JSON.stringify(settings)],
  );
  return settings;
}

/* ---------- Contatos ---------- */
const phoneKey = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? d.slice(-32) : null;
};

async function listContacts(clientId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_contacts WHERE client_id = ? ORDER BY created_at DESC LIMIT 10000', [need(clientId)],
  );
  return rows.map((r) => parse(r.data));
}

async function getContact(clientId, id) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT data FROM crm_contacts WHERE client_id = ? AND id = ?', [need(clientId), String(id)]);
  return rows.length ? parse(rows[0].data) : null;
}

// Procura pelo telefone (só dígitos). Aceita com ou sem o 55 / nono dígito
// comparando o final do número: o WhatsApp manda "5511987654321".
async function findContactByPhone(clientId, phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 8) return null;
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_contacts WHERE client_id = ? AND phone_key = ? LIMIT 1', [need(clientId), key],
  );
  if (rows.length) return parse(rows[0].data);
  const tail = key.slice(-8);
  const [like] = await db.getPool().query(
    'SELECT data, phone_key FROM crm_contacts WHERE client_id = ? AND phone_key LIKE ? LIMIT 20', [need(clientId), `%${tail}`],
  );
  const norm = (k) => { let d = k; if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3); return d; };
  const hit = like.find((r) => norm(r.phone_key) === norm(key));
  return hit ? parse(hit.data) : null;
}

async function addContact(clientId, contact) {
  await db.ensureCrmTables();
  await db.getPool().query(
    'INSERT INTO crm_contacts (id, client_id, phone_key, created_at, data) VALUES (?, ?, ?, ?, ?)',
    [contact.id, need(clientId), phoneKey(contact.phone), new Date(contact.createdAt), JSON.stringify({ ...contact, clientId })],
  );
  return contact;
}

async function saveContact(clientId, contact) {
  await db.ensureCrmTables();
  const [result] = await db.getPool().query(
    'UPDATE crm_contacts SET data = ?, phone_key = ? WHERE client_id = ? AND id = ?',
    [JSON.stringify({ ...contact, clientId }), phoneKey(contact.phone), need(clientId), contact.id],
  );
  return result.affectedRows > 0 ? contact : null;
}

async function removeContact(clientId, id) {
  await db.ensureCrmTables();
  const pool = db.getPool();
  const [result] = await pool.query('DELETE FROM crm_contacts WHERE client_id = ? AND id = ?', [need(clientId), String(id)]);
  const [convs] = await pool.query('SELECT id FROM crm_conversations WHERE client_id = ? AND contact_id = ?', [clientId, String(id)]);
  for (const c of convs) await pool.query('DELETE FROM crm_messages WHERE client_id = ? AND conversation_id = ?', [clientId, c.id]);
  await pool.query('DELETE FROM crm_conversations WHERE client_id = ? AND contact_id = ?', [clientId, String(id)]);
  return result.affectedRows > 0;
}

/* ---------- Conversas e mensagens ---------- */
async function listConversations(clientId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_conversations WHERE client_id = ? ORDER BY last_at DESC LIMIT 2000', [need(clientId)],
  );
  return rows.map((r) => parse(r.data));
}

async function getConversation(clientId, id) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT data FROM crm_conversations WHERE client_id = ? AND id = ?', [need(clientId), String(id)]);
  return rows.length ? parse(rows[0].data) : null;
}

async function getConversationByContact(clientId, contactId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_conversations WHERE client_id = ? AND contact_id = ? LIMIT 1', [need(clientId), String(contactId)],
  );
  return rows.length ? parse(rows[0].data) : null;
}

async function saveConversation(clientId, conv) {
  await db.ensureCrmTables();
  await db.getPool().query(
    `INSERT INTO crm_conversations (id, client_id, contact_id, last_at, data) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_at = VALUES(last_at), data = VALUES(data), contact_id = VALUES(contact_id)`,
    [conv.id, need(clientId), conv.contactId, new Date(conv.lastAt || conv.createdAt), JSON.stringify({ ...conv, clientId })],
  );
  return conv;
}

async function listMessages(clientId, conversationId, limit = 300) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM crm_messages WHERE client_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [need(clientId), String(conversationId), limit],
  );
  return rows.map((r) => parse(r.data)).reverse();
}

// Retorna false se a mensagem (mesmo wa_id) já tinha sido gravada: a Meta
// reenvia o webhook quando não recebe 200 a tempo.
async function addMessage(clientId, msg) {
  await db.ensureCrmTables();
  try {
    await db.getPool().query(
      'INSERT INTO crm_messages (id, client_id, conversation_id, wa_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
      [msg.id, need(clientId), msg.conversationId, msg.waId || null, new Date(msg.at), JSON.stringify({ ...msg, clientId })],
    );
    return true;
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

async function updateMessageStatusByWaId(clientId, waId, status) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT id, data FROM crm_messages WHERE client_id = ? AND wa_id = ?', [need(clientId), String(waId)]);
  if (!rows.length) return false;
  const msg = parse(rows[0].data);
  msg.status = status;
  await db.getPool().query('UPDATE crm_messages SET data = ? WHERE client_id = ? AND id = ?', [JSON.stringify(msg), clientId, rows[0].id]);
  return true;
}

/* ---------- Número de WhatsApp -> cliente ---------- */
async function clientIdForPhoneNumber(phoneNumberId) {
  await db.ensureCrmTables();
  const [rows] = await db.getPool().query('SELECT client_id FROM crm_wa_numbers WHERE phone_number_id = ?', [String(phoneNumberId)]);
  return rows.length ? rows[0].client_id : null;
}

// Liga o número ao cliente. Recusa se o número já for de outro cliente.
async function setPhoneNumber(clientId, phoneNumberId) {
  await db.ensureCrmTables();
  const pool = db.getPool();
  if (phoneNumberId) {
    const owner = await clientIdForPhoneNumber(phoneNumberId);
    if (owner && owner !== clientId) return false;
  }
  await pool.query('DELETE FROM crm_wa_numbers WHERE client_id = ?', [need(clientId)]);
  if (phoneNumberId) await pool.query('INSERT INTO crm_wa_numbers (phone_number_id, client_id) VALUES (?, ?)', [String(phoneNumberId), clientId]);
  return true;
}

// Usado quando o cliente é excluído (não deixa CRM órfão para um cliente novo com o mesmo id).
async function removeAllForClient(clientId) {
  await db.ensureCrmTables();
  const pool = db.getPool();
  for (const t of ['crm_deals', 'crm_pipelines', 'crm_settings', 'crm_contacts', 'crm_conversations', 'crm_messages', 'crm_wa_numbers']) {
    await pool.query(`DELETE FROM ${t} WHERE client_id = ?`, [need(clientId)]);
  }
}

module.exports = {
  getPipeline, savePipeline, listDeals, getDeal, addDeal, saveDeal, removeDeal, removeAllForClient,
  getSettings, saveSettings, phoneKey,
  listContacts, getContact, findContactByPhone, addContact, saveContact, removeContact,
  listConversations, getConversation, getConversationByContact, saveConversation,
  listMessages, addMessage, updateMessageStatusByWaId,
  clientIdForPhoneNumber, setPhoneNumber,
};
