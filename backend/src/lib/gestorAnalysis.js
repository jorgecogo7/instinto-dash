const crypto = require('crypto');

// Formato de uma análise do gestor. Tudo texto (markdown simples), com
// tamanho máximo, pra nada de estranho entrar no banco.

const PRIORITIES = new Set(['alta', 'media', 'baixa']);
const AREAS = new Set(['copy', 'criativo', 'publico', 'objetivo', 'lance', 'orcamento', 'posicionamento', 'formulario', 'pagina', 'palavras-chave', 'rastreamento', 'outro']);
const STATUSES = new Set(['pendente', 'aprovada', 'descartada']);
const PLATFORMS = new Set(['meta', 'google']);

const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const normPriority = (p) => {
  const v = String(p || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return PRIORITIES.has(v) ? v : 'media';
};

/**
 * Valida o corpo enviado (pelo gestor IA ou pelo Jorge) e devolve
 * { analysis } ou { error }.
 */
function buildAnalysis(body, { clientId, author, source }) {
  body = body && typeof body === 'object' ? body : {};
  const period = body.period && typeof body.period === 'object' ? body.period : {};
  const from = isDate(period.from) ? period.from : null;
  const to = isDate(period.to) ? period.to : null;
  if ((from && !to) || (!from && to) || (from && to && from > to)) {
    return { error: 'period inválido: use { "from": "AAAA-MM-DD", "to": "AAAA-MM-DD" } com from <= to.' };
  }
  const suggestionsIn = Array.isArray(body.suggestions) ? body.suggestions.slice(0, 30) : [];
  const suggestions = suggestionsIn.map((s) => ({
    id: newId('sg'),
    title: str(s && s.title, 200),
    detail: str(s && s.detail, 4000),
    priority: normPriority(s && s.priority),
    area: AREAS.has(String(s && s.area || '').toLowerCase()) ? String(s.area).toLowerCase() : 'outro',
    expectedImpact: str(s && s.expectedImpact, 300),
    status: 'pendente',
    decidedAt: null,
  })).filter((s) => s.title);

  const analysis = {
    id: newId('an'),
    clientId,
    createdAt: new Date().toISOString(),
    author: str(body.author, 80) || author,
    source,
    period: from ? { from, to } : null,
    platforms: (Array.isArray(body.platforms) ? body.platforms : []).map((p) => String(p).toLowerCase()).filter((p) => PLATFORMS.has(p)),
    title: str(body.title, 160),
    summary: str(body.summary, 8000),
    worked: str(body.worked, 8000),
    notWorked: str(body.notWorked, 8000),
    leadDiagnosis: str(body.leadDiagnosis, 8000),
    nextSteps: str(body.nextSteps, 8000),
    suggestions,
  };
  if (!analysis.summary && !suggestions.length) {
    return { error: 'Envie pelo menos "summary" (resumo) ou uma sugestão em "suggestions".' };
  }
  return { analysis };
}

module.exports = { buildAnalysis, STATUSES, AREAS };
