const db = require('./db');

/**
 * Formulários próprios (estilo Typeform). Mesmo padrão dos outros stores:
 * a definição do formulário é um JSON por linha; respostas ficam numa
 * tabela à parte (podem ser milhares) e os contadores de visita/início/envio
 * numa tabela diária com incremento atômico.
 */

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function getAll() {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query('SELECT data FROM forms');
  return rows.map((r) => parse(r.data));
}

async function getById(id) {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query('SELECT data FROM forms WHERE id = ?', [id]);
  return rows.length ? parse(rows[0].data) : null;
}

async function getBySlug(slug) {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query('SELECT data FROM forms WHERE slug = ?', [slug]);
  return rows.length ? parse(rows[0].data) : null;
}

async function add(form) {
  await db.ensureFormsTables();
  await db.getPool().query('INSERT INTO forms (id, slug, data) VALUES (?, ?, ?)', [form.id, form.slug, JSON.stringify(form)]);
  return form;
}

async function save(form) {
  await db.ensureFormsTables();
  await db.getPool().query('UPDATE forms SET slug = ?, data = ? WHERE id = ?', [form.slug, JSON.stringify(form), form.id]);
  return form;
}

async function remove(id) {
  await db.ensureFormsTables();
  await db.getPool().query('DELETE FROM form_responses WHERE form_id = ?', [id]);
  await db.getPool().query('DELETE FROM form_stats WHERE form_id = ?', [id]);
  const [result] = await db.getPool().query('DELETE FROM forms WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function addResponse(formId, response) {
  await db.ensureFormsTables();
  await db.getPool().query(
    'INSERT INTO form_responses (id, form_id, created_at, data) VALUES (?, ?, ?, ?)',
    [response.id, formId, new Date(response.createdAt), JSON.stringify(response)],
  );
  return response;
}

async function getResponses(formId, limit = 2000) {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query(
    'SELECT data FROM form_responses WHERE form_id = ? ORDER BY created_at DESC LIMIT ?',
    [formId, limit],
  );
  return rows.map((r) => parse(r.data));
}

const STAT_COLUMNS = { view: 'views', start: 'starts', complete: 'completes', qualified: 'qualified' };

async function bumpStat(formId, kind) {
  const col = STAT_COLUMNS[kind];
  if (!col) return;
  await db.ensureFormsTables();
  await db.getPool().query(
    `INSERT INTO form_stats (form_id, day, ${col}) VALUES (?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE ${col} = ${col} + 1`,
    [formId],
  );
}

// Totais por formulário (opcionalmente só a partir de uma data).
async function getStats(sinceDate = null) {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query(
    `SELECT form_id, SUM(views) views, SUM(starts) starts, SUM(completes) completes, SUM(qualified) qualified
     FROM form_stats ${sinceDate ? 'WHERE day >= ?' : ''} GROUP BY form_id`,
    sinceDate ? [sinceDate] : [],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.form_id] = { views: Number(r.views) || 0, starts: Number(r.starts) || 0, completes: Number(r.completes) || 0, qualified: Number(r.qualified) || 0 };
  });
  return out;
}

async function getDailyStats(formId, sinceDate) {
  await db.ensureFormsTables();
  const [rows] = await db.getPool().query(
    'SELECT DATE_FORMAT(day, "%Y-%m-%d") day, views, starts, completes, qualified FROM form_stats WHERE form_id = ? AND day >= ? ORDER BY day',
    [formId, sinceDate],
  );
  return rows.map((r) => ({ date: r.day, views: Number(r.views), starts: Number(r.starts), completes: Number(r.completes), qualified: Number(r.qualified) }));
}

module.exports = { getAll, getById, getBySlug, add, save, remove, addResponse, getResponses, bumpStat, getStats, getDailyStats };
