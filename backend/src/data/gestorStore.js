const crypto = require('crypto');
const db = require('./db');

/**
 * Análises do gestor + chaves de API dos gestores (IA).
 * Uso exclusivo da agência: nada aqui é lido pelas rotas do cliente,
 * pelo link público, pelos relatórios automáticos ou pelos PDFs.
 */

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ---------- Análises ----------
async function listAnalyses(clientId, limit = 50) {
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM gestor_analyses WHERE client_id = ? ORDER BY created_at DESC LIMIT ?',
    [clientId, Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return rows.map((r) => parse(r.data));
}

async function getAnalysis(clientId, id) {
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query('SELECT data FROM gestor_analyses WHERE client_id = ? AND id = ?', [clientId, id]);
  return rows.length ? parse(rows[0].data) : null;
}

async function saveAnalysis(a) {
  await db.ensureGestorTables();
  await db.getPool().query(
    `INSERT INTO gestor_analyses (id, client_id, created_at, data) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [a.id, a.clientId, new Date(a.createdAt), JSON.stringify(a)],
  );
  return a;
}

async function removeAnalysis(clientId, id) {
  await db.ensureGestorTables();
  const [r] = await db.getPool().query('DELETE FROM gestor_analyses WHERE client_id = ? AND id = ?', [clientId, id]);
  return r.affectedRows > 0;
}

// ---------- Chaves ----------
const KEY_PREFIX = 'igk_';
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

// Cria uma chave nova. Devolve o valor em texto UMA vez (não fica guardado).
async function createKey(label) {
  await db.ensureGestorTables();
  const secret = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const rec = {
    id: 'gk_' + crypto.randomBytes(8).toString('hex'),
    label,
    hint: secret.slice(0, 8) + '…' + secret.slice(-4),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await db.getPool().query(
    'INSERT INTO gestor_keys (id, key_hash, created_at, data) VALUES (?, ?, ?, ?)',
    [rec.id, hashKey(secret), new Date(rec.createdAt), JSON.stringify(rec)],
  );
  return { ...rec, key: secret };
}

async function listKeys() {
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query('SELECT data FROM gestor_keys ORDER BY created_at DESC');
  return rows.map((r) => parse(r.data));
}

async function countActiveKeys() {
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query('SELECT COUNT(*) AS n FROM gestor_keys WHERE revoked_at IS NULL');
  return Number(rows[0].n) || 0;
}

async function revokeKey(id) {
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query('SELECT data FROM gestor_keys WHERE id = ?', [id]);
  if (!rows.length) return null;
  const rec = { ...parse(rows[0].data), revokedAt: new Date().toISOString() };
  await db.getPool().query('UPDATE gestor_keys SET revoked_at = ?, data = ? WHERE id = ?', [new Date(rec.revokedAt), JSON.stringify(rec), id]);
  return rec;
}

// Confere a chave (pelo hash). Só chaves não revogadas valem.
async function findActiveKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX) || secret.length > 200) return null;
  await db.ensureGestorTables();
  const [rows] = await db.getPool().query('SELECT data FROM gestor_keys WHERE key_hash = ? AND revoked_at IS NULL', [hashKey(secret)]);
  return rows.length ? parse(rows[0].data) : null;
}

const lastTouch = new Map();
async function touchKey(rec) {
  // Grava "último uso" no máximo a cada 5 min por chave.
  const now = Date.now();
  if (now - (lastTouch.get(rec.id) || 0) < 5 * 60 * 1000) return;
  lastTouch.set(rec.id, now);
  const upd = { ...rec, lastUsedAt: new Date(now).toISOString() };
  await db.getPool().query('UPDATE gestor_keys SET data = ? WHERE id = ? AND revoked_at IS NULL', [JSON.stringify(upd), rec.id]);
}

module.exports = {
  listAnalyses, getAnalysis, saveAnalysis, removeAnalysis,
  createKey, listKeys, countActiveKeys, revokeKey, findActiveKey, touchKey,
};
