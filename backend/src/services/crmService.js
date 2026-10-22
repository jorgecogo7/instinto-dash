const crypto = require('crypto');
const crmStore = require('../data/crmStore');

// Funil padrão de todo cliente novo. O cliente/agência pode renomear,
// reordenar, criar e remover etapas depois.
const DEFAULT_STAGES = [
  { id: 'novo', name: 'Novo lead', kind: 'open' },
  { id: 'em_contato', name: 'Em contato', kind: 'open' },
  { id: 'proposta', name: 'Proposta', kind: 'open' },
  { id: 'negociacao', name: 'Negociação', kind: 'open' },
  { id: 'ganho', name: 'Ganho', kind: 'won' },
  { id: 'perdido', name: 'Perdido', kind: 'lost' },
];
const SOURCES = ['form', 'manual', 'campaign'];
const KINDS = ['open', 'won', 'lost'];
const MAX_STAGES = 12;
const MAX_HISTORY = 300;

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '');
const nowIso = () => new Date().toISOString();

class CrmError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function getPipeline(clientId) {
  const saved = await crmStore.getPipeline(clientId);
  if (saved && Array.isArray(saved.stages) && saved.stages.length) return saved;
  return { stages: DEFAULT_STAGES.map((s) => ({ ...s })), updatedAt: null };
}

// "R$ 1.500,50", "1500.5", 1500 -> 1500.5. Vazio -> null.
function parseValue(v) {
  if (v === null || v === undefined || v === '') return null;
  let n = typeof v === 'number' ? v : NaN;
  if (typeof v === 'string') {
    let s = v.replace(/[^\d,.-]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new CrmError(400, 'Valor inválido.');
  return Math.round(n * 100) / 100;
}

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((t) => {
    const s = str(t, 30);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  });
  return out.slice(0, 10);
}

// Campos editáveis de um negócio (create e patch). Só o que veio no input.
function cleanFields(input, { creating }) {
  const b = input || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (creating || has('name')) {
    out.name = str(b.name, 120);
    if (!out.name) throw new CrmError(400, 'Informe o nome do lead.');
  }
  if (has('phone')) out.phone = str(b.phone, 40) || null;
  if (has('email')) {
    out.email = str(b.email, 160).toLowerCase() || null;
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new CrmError(400, 'E-mail inválido.');
  }
  if (has('company')) out.company = str(b.company, 120) || null;
  if (has('source')) {
    if (!SOURCES.includes(b.source)) throw new CrmError(400, 'Origem inválida.');
    out.source = b.source;
  }
  if (has('sourceDetail')) out.sourceDetail = str(b.sourceDetail, 160) || null;
  if (has('value')) out.value = parseValue(b.value);
  if (has('owner')) out.owner = str(b.owner, 80) || null;
  if (has('tags')) out.tags = cleanTags(b.tags);
  if (has('notes')) out.notes = str(b.notes, 5000) || null;
  return out;
}

function pushHistory(deal, entry) {
  deal.history = [...(deal.history || []), { id: uid(5), at: nowIso(), ...entry }].slice(-MAX_HISTORY);
}

function stageName(pipeline, id) {
  return (pipeline.stages.find((s) => s.id === id) || {}).name || id;
}

async function getBoard(clientId) {
  const [pipeline, deals] = await Promise.all([getPipeline(clientId), crmStore.listDeals(clientId)]);
  return { pipeline, deals };
}

async function createDeal(clientId, input, actor) {
  const pipeline = await getPipeline(clientId);
  const fields = cleanFields(input, { creating: true });
  const stageId = input && input.stageId && pipeline.stages.some((s) => s.id === input.stageId)
    ? input.stageId : pipeline.stages[0].id;
  const ts = nowIso();
  const deal = {
    id: uid(), clientId,
    name: fields.name, phone: null, email: null, company: null,
    source: 'manual', sourceDetail: null, value: null, owner: null, tags: [], notes: null,
    ...fields,
    stageId, stageChangedAt: ts, createdAt: ts, updatedAt: ts, history: [],
  };
  pushHistory(deal, { type: 'created', by: actor, to: stageId, text: `Criado em "${stageName(pipeline, stageId)}"` });
  await crmStore.addDeal(clientId, deal);
  return deal;
}

async function updateDeal(clientId, id, input, actor) {
  const deal = await crmStore.getDeal(clientId, id);
  if (!deal) throw new CrmError(404, 'Lead não encontrado.');
  const pipeline = await getPipeline(clientId);
  const fields = cleanFields(input, { creating: false });
  const changed = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(deal[k] ?? null));
  Object.assign(deal, fields);
  if (input && input.stageId !== undefined && input.stageId !== deal.stageId) {
    if (!pipeline.stages.some((s) => s.id === input.stageId)) throw new CrmError(400, 'Etapa inválida.');
    pushHistory(deal, {
      type: 'stage', by: actor, from: deal.stageId, to: input.stageId,
      text: `Movido de "${stageName(pipeline, deal.stageId)}" para "${stageName(pipeline, input.stageId)}"`,
    });
    deal.stageId = input.stageId;
    deal.stageChangedAt = nowIso();
  }
  const labels = { name: 'nome', phone: 'telefone', email: 'e-mail', company: 'empresa', source: 'origem', sourceDetail: 'detalhe da origem', value: 'valor', owner: 'responsável', tags: 'tags', notes: 'notas' };
  if (changed.length) pushHistory(deal, { type: 'edit', by: actor, text: `Editou ${changed.map((k) => labels[k] || k).join(', ')}` });
  deal.updatedAt = nowIso();
  await crmStore.saveDeal(clientId, deal);
  return deal;
}

async function addComment(clientId, id, text, actor) {
  const t = str(text, 2000);
  if (!t) throw new CrmError(400, 'Escreva o comentário.');
  const deal = await crmStore.getDeal(clientId, id);
  if (!deal) throw new CrmError(404, 'Lead não encontrado.');
  pushHistory(deal, { type: 'comment', by: actor, text: t });
  deal.updatedAt = nowIso();
  await crmStore.saveDeal(clientId, deal);
  return deal;
}

async function removeDeal(clientId, id) {
  const ok = await crmStore.removeDeal(clientId, id);
  if (!ok) throw new CrmError(404, 'Lead não encontrado.');
}

// Salva as etapas. Ids existentes são mantidos (os negócios apontam pra eles);
// etapa nova ganha id novo. Negócios de uma etapa removida vão pra primeira etapa.
async function saveStages(clientId, input, actor) {
  if (!Array.isArray(input) || !input.length) throw new CrmError(400, 'O funil precisa de pelo menos uma etapa.');
  if (input.length > MAX_STAGES) throw new CrmError(400, `Máximo de ${MAX_STAGES} etapas.`);
  const current = await getPipeline(clientId);
  const seen = new Set();
  const stages = input.map((s) => {
    const name = str(s && s.name, 40);
    if (!name) throw new CrmError(400, 'Toda etapa precisa de um nome.');
    let id = s && typeof s.id === 'string' && /^[a-z0-9_-]{1,40}$/.test(s.id) ? s.id : null;
    if (!id || seen.has(id)) id = `etapa_${uid(4)}`;
    seen.add(id);
    return { id, name, kind: KINDS.includes(s && s.kind) ? s.kind : 'open' };
  });
  const pipeline = { stages, updatedAt: nowIso() };
  await crmStore.savePipeline(clientId, pipeline);

  const valid = new Set(stages.map((s) => s.id));
  const deals = await crmStore.listDeals(clientId);
  let moved = 0;
  for (const deal of deals) {
    if (valid.has(deal.stageId)) continue;
    pushHistory(deal, {
      type: 'stage', by: actor, from: deal.stageId, to: stages[0].id,
      text: `Etapa "${stageName(current, deal.stageId)}" foi removida. Movido para "${stages[0].name}"`,
    });
    deal.stageId = stages[0].id;
    deal.stageChangedAt = nowIso();
    deal.updatedAt = nowIso();
    await crmStore.saveDeal(clientId, deal);
    moved += 1;
  }
  return { pipeline, moved };
}

// Lead que chegou por um formulário nativo do cliente: entra na primeira etapa.
async function addFromForm(clientId, { form, contact, readable, meta }) {
  const pipeline = await getPipeline(clientId);
  const ts = nowIso();
  const campaign = meta && meta.utm_campaign ? str(meta.utm_campaign, 120) : null;
  const deal = {
    id: uid(), clientId,
    name: str(contact.name, 120) || 'Sem nome',
    phone: str(contact.phone, 40) || null,
    email: str(contact.email, 160).toLowerCase() || null,
    company: str(contact.company, 120) || null,
    source: 'form', sourceDetail: str(form.name, 160) || form.slug, campaign,
    formId: form.id,
    formAnswers: (readable || []).slice(0, 40).map((x) => ({ question: str(x.question, 200), answer: str(x.answer, 1000) })),
    value: null, owner: null, tags: [], notes: null,
    stageId: pipeline.stages[0].id, stageChangedAt: ts, createdAt: ts, updatedAt: ts, history: [],
  };
  pushHistory(deal, {
    type: 'created', by: { role: 'system', name: 'Formulário' }, to: deal.stageId,
    text: `Chegou pelo formulário "${deal.sourceDetail}"${campaign ? ` (campanha ${campaign})` : ''}`,
  });
  await crmStore.addDeal(clientId, deal);
  return deal;
}

module.exports = {
  DEFAULT_STAGES, CrmError, getPipeline, getBoard, createDeal, updateDeal, addComment, removeDeal, saveStages, addFromForm,
};
