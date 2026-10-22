const crypto = require('crypto');
const crmStore = require('../data/crmStore');

// Funil padrão de todo cliente novo. O cliente/agência pode renomear,
// reordenar, criar e remover etapas depois, e criar outros funis.
const DEFAULT_STAGES = [
  { id: 'novo', name: 'Novo lead', kind: 'open', color: 'blue' },
  { id: 'em_contato', name: 'Em contato', kind: 'open', color: 'amber' },
  { id: 'proposta', name: 'Proposta', kind: 'open', color: 'purple' },
  { id: 'negociacao', name: 'Negociação', kind: 'open', color: 'teal' },
  { id: 'ganho', name: 'Ganho', kind: 'won', color: 'green' },
  { id: 'perdido', name: 'Perdido', kind: 'lost', color: 'red' },
];
const DEFAULT_FUNNEL_ID = 'principal';
const COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'];
const SOURCES = ['form', 'manual', 'campaign', 'whatsapp', 'import'];
const KINDS = ['open', 'won', 'lost'];
const TAG_MEANINGS = ['common', 'qualified', 'disqualified'];
const DEFAULT_TAGS = [
  { id: 'qualificado', name: 'Qualificado', color: 'green', meaning: 'qualified', system: true },
  { id: 'desqualificado', name: 'Desqualificado', color: 'red', meaning: 'disqualified', system: true },
];
const MAX_STAGES = 12;
const MAX_FUNNELS = 10;
const MAX_TAGS = 100;
const MAX_HISTORY = 300;
const MAX_IMPORT = 300; // por requisição (o navegador manda em lotes)

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '');
const nowIso = () => new Date().toISOString();
const lower = (s) => String(s || '').toLowerCase();

class CrmError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ===================== Funis e etapas ===================== */

function cleanColor(c, fallback) { return COLORS.includes(c) ? c : fallback; }
function defaultFunnel() {
  return { id: DEFAULT_FUNNEL_ID, name: 'Funil principal', stages: DEFAULT_STAGES.map((s) => ({ ...s })) };
}
function stageDefaultColor(kind, i) {
  if (kind === 'won') return 'green';
  if (kind === 'lost') return 'red';
  return ['blue', 'amber', 'purple', 'teal', 'pink', 'orange', 'gray'][i % 7];
}

// Formato salvo: { funnels: [{ id, name, stages }] }. O formato antigo (PR do CRM
// v1) era { stages } com um funil só: vira o "Funil principal".
async function getPipeline(clientId) {
  const saved = await crmStore.getPipeline(clientId);
  let funnels = null;
  if (saved && Array.isArray(saved.funnels) && saved.funnels.length) funnels = saved.funnels;
  else if (saved && Array.isArray(saved.stages) && saved.stages.length) funnels = [{ id: DEFAULT_FUNNEL_ID, name: 'Funil principal', stages: saved.stages }];
  if (!funnels) funnels = [defaultFunnel()];
  funnels = funnels.map((f) => ({
    ...f,
    stages: f.stages.map((s, i) => ({ ...s, color: cleanColor(s.color, stageDefaultColor(s.kind, i)) })),
  }));
  return { funnels, updatedAt: (saved && saved.updatedAt) || null };
}

function funnelOf(pipeline, funnelId) {
  return pipeline.funnels.find((f) => f.id === funnelId) || pipeline.funnels[0];
}
function stageName(pipeline, id) {
  for (const f of pipeline.funnels) {
    const s = f.stages.find((x) => x.id === id);
    if (s) return s.name;
  }
  return id;
}
// Negócio antigo (sem funnelId) pertence ao primeiro funil.
function normalizeDeal(pipeline, deal) {
  if (!deal.funnelId || !pipeline.funnels.some((f) => f.id === deal.funnelId)) deal.funnelId = pipeline.funnels[0].id;
  return deal;
}

/* ===================== Configurações: etiquetas e WhatsApp ===================== */

async function getSettings(clientId) {
  const saved = (await crmStore.getSettings(clientId)) || {};
  const tags = Array.isArray(saved.tags) ? saved.tags.map((t) => ({ ...t })) : [];
  DEFAULT_TAGS.forEach((d) => { if (!tags.some((t) => t.id === d.id)) tags.push({ ...d }); });
  return { tags, whatsapp: saved.whatsapp || null };
}

// O cliente vê só se o WhatsApp está ligado e o número de exibição. IDs da
// conta (phone_number_id, WABA) são internos da agência.
function whatsappView(settings, role) {
  const wa = settings.whatsapp || {};
  const out = { connected: !!wa.phoneNumberId, displayPhone: wa.displayPhone || null };
  if (role === 'admin') { out.phoneNumberId = wa.phoneNumberId || null; out.wabaId = wa.wabaId || null; }
  return out;
}

async function saveWhatsappConfig(clientId, input) {
  const b = input || {};
  const phoneNumberId = str(b.phoneNumberId, 64).replace(/\D/g, '') || null;
  const wabaId = str(b.wabaId, 64).replace(/\D/g, '') || null;
  const displayPhone = str(b.displayPhone, 40) || null;
  if (str(b.phoneNumberId, 64) && !phoneNumberId) throw new CrmError(400, 'O ID do número tem só números.');
  const ok = await crmStore.setPhoneNumber(clientId, phoneNumberId);
  if (!ok) throw new CrmError(409, 'Este número de WhatsApp já está ligado a outro cliente.');
  const saved = (await crmStore.getSettings(clientId)) || {};
  saved.whatsapp = phoneNumberId ? { phoneNumberId, wabaId, displayPhone, updatedAt: nowIso() } : null;
  await crmStore.saveSettings(clientId, saved);
  return whatsappView({ whatsapp: saved.whatsapp }, 'admin');
}

function cleanTagNames(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((t) => {
    const s = str(t, 30);
    if (s && !out.some((o) => lower(o) === lower(s))) out.push(s);
  });
  return out.slice(0, 10);
}

// Etiqueta usada num negócio/contato que ainda não existe vira etiqueta comum.
// Devolve os nomes com a grafia da etiqueta já cadastrada.
async function ensureTags(clientId, names) {
  if (!names || !names.length) return names || [];
  const settings = await getSettings(clientId);
  let changed = false;
  const out = names.map((n) => {
    const hit = settings.tags.find((t) => lower(t.name) === lower(n));
    if (hit) return hit.name;
    if (settings.tags.length < MAX_TAGS) {
      settings.tags.push({ id: `tag_${uid(4)}`, name: n, color: COLORS[(settings.tags.length + 3) % COLORS.length], meaning: 'common' });
      changed = true;
    }
    return n;
  });
  if (changed) await saveSettingsTags(clientId, settings.tags);
  return out;
}

async function saveSettingsTags(clientId, tags) {
  const saved = (await crmStore.getSettings(clientId)) || {};
  saved.tags = tags;
  await crmStore.saveSettings(clientId, saved);
}

async function listTags(clientId) {
  const [settings, deals, contacts] = await Promise.all([getSettings(clientId), crmStore.listDeals(clientId), crmStore.listContacts(clientId)]);
  return settings.tags.map((t) => {
    const has = (x) => (x.tags || []).some((n) => lower(n) === lower(t.name));
    return { ...t, usage: { deals: deals.filter(has).length, contacts: contacts.filter(has).length } };
  });
}

function cleanTagInput(b, current) {
  const out = {};
  if (b.name !== undefined || !current) {
    out.name = str(b.name, 30);
    if (!out.name) throw new CrmError(400, 'Dê um nome para a etiqueta.');
  }
  if (b.color !== undefined) out.color = cleanColor(b.color, (current && current.color) || 'gray');
  if (b.meaning !== undefined) {
    if (!TAG_MEANINGS.includes(b.meaning)) throw new CrmError(400, 'Significado inválido.');
    out.meaning = b.meaning;
  }
  return out;
}

async function createTag(clientId, input) {
  const settings = await getSettings(clientId);
  if (settings.tags.length >= MAX_TAGS) throw new CrmError(400, `Máximo de ${MAX_TAGS} etiquetas.`);
  const f = cleanTagInput(input || {}, null);
  if (settings.tags.some((t) => lower(t.name) === lower(f.name))) throw new CrmError(409, 'Já existe uma etiqueta com esse nome.');
  const tag = { id: `tag_${uid(4)}`, name: f.name, color: f.color || 'gray', meaning: f.meaning || 'common' };
  settings.tags.push(tag);
  await saveSettingsTags(clientId, settings.tags);
  return tag;
}

// Renomear uma etiqueta troca o nome em todos os negócios e contatos.
async function renameTagEverywhere(clientId, from, to) {
  const swap = (list) => (list || []).map((n) => (lower(n) === lower(from) ? to : n));
  const drop = (list) => (list || []).filter((n) => lower(n) !== lower(from));
  const fn = to ? swap : drop;
  for (const d of await crmStore.listDeals(clientId)) {
    if ((d.tags || []).some((n) => lower(n) === lower(from))) { d.tags = cleanTagNames(fn(d.tags)); await crmStore.saveDeal(clientId, d); }
  }
  for (const c of await crmStore.listContacts(clientId)) {
    if ((c.tags || []).some((n) => lower(n) === lower(from))) { c.tags = cleanTagNames(fn(c.tags)); await crmStore.saveContact(clientId, c); }
  }
}

async function updateTag(clientId, id, input) {
  const settings = await getSettings(clientId);
  const tag = settings.tags.find((t) => t.id === id);
  if (!tag) throw new CrmError(404, 'Etiqueta não encontrada.');
  const f = cleanTagInput(input || {}, tag);
  if (f.name && lower(f.name) !== lower(tag.name) && settings.tags.some((t) => t.id !== id && lower(t.name) === lower(f.name))) {
    throw new CrmError(409, 'Já existe uma etiqueta com esse nome.');
  }
  const oldName = tag.name;
  Object.assign(tag, f);
  await saveSettingsTags(clientId, settings.tags);
  if (f.name && f.name !== oldName) await renameTagEverywhere(clientId, oldName, f.name);
  return tag;
}

async function deleteTag(clientId, id) {
  const settings = await getSettings(clientId);
  const tag = settings.tags.find((t) => t.id === id);
  if (!tag) throw new CrmError(404, 'Etiqueta não encontrada.');
  if (tag.system) throw new CrmError(400, 'Etiquetas padrão não podem ser excluídas. Você pode renomear ou trocar a cor.');
  await saveSettingsTags(clientId, settings.tags.filter((t) => t.id !== id));
  await renameTagEverywhere(clientId, tag.name, null);
}

/* ===================== Negócios ===================== */

// "R$ 1.500,50", "1500.5", 1500 -> 1500.5. Vazio -> null.
function parseValue(v) {
  if (v === null || v === undefined || v === '') return null;
  let n = typeof v === 'number' ? v : NaN;
  if (typeof v === 'string') {
    let s = v.replace(/[^\d,.-]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "3.500" = três mil e quinhentos
    n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new CrmError(400, 'Valor inválido.');
  return Math.round(n * 100) / 100;
}

const cleanEmail = (v) => {
  const e = str(v, 160).toLowerCase() || null;
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new CrmError(400, 'E-mail inválido.');
  return e;
};

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
  if (has('email')) out.email = cleanEmail(b.email);
  if (has('company')) out.company = str(b.company, 120) || null;
  if (has('source')) {
    if (!SOURCES.includes(b.source)) throw new CrmError(400, 'Origem inválida.');
    out.source = b.source;
  }
  if (has('sourceDetail')) out.sourceDetail = str(b.sourceDetail, 160) || null;
  if (has('value')) out.value = parseValue(b.value);
  if (has('owner')) out.owner = str(b.owner, 80) || null;
  if (has('tags')) out.tags = cleanTagNames(b.tags);
  if (has('notes')) out.notes = str(b.notes, 5000) || null;
  return out;
}

function pushHistory(deal, entry) {
  deal.history = [...(deal.history || []), { id: uid(5), at: nowIso(), ...entry }].slice(-MAX_HISTORY);
}

async function getBoard(clientId) {
  const [pipeline, deals, settings, convs] = await Promise.all([
    getPipeline(clientId), crmStore.listDeals(clientId), getSettings(clientId), crmStore.listConversations(clientId),
  ]);
  const convByContact = new Map(convs.map((c) => [c.contactId, c]));
  deals.forEach((d) => {
    normalizeDeal(pipeline, d);
    const c = d.contactId && convByContact.get(d.contactId);
    if (c) { d.conversationId = c.id; d.unread = c.unread || 0; }
  });
  // "pipeline.stages" mantido para compatibilidade: são as etapas do primeiro funil.
  return { pipeline: { ...pipeline, stages: pipeline.funnels[0].stages }, deals, tags: settings.tags };
}

// Acha (pelo telefone ou e-mail) ou cria o contato de um negócio.
async function upsertContactFor(clientId, { name, phone, email, company, tags, source }) {
  if (!phone && !email) return null;
  let contact = phone ? await crmStore.findContactByPhone(clientId, phone) : null;
  if (!contact && email) contact = (await crmStore.listContacts(clientId)).find((c) => c.email && c.email === email) || null;
  if (contact) {
    let changed = false;
    if (!contact.phone && phone) { contact.phone = phone; changed = true; }
    if (!contact.email && email) { contact.email = email; changed = true; }
    if ((!contact.name || contact.name === contact.phone) && name) { contact.name = name; changed = true; }
    if (changed) { contact.updatedAt = nowIso(); await crmStore.saveContact(clientId, contact); }
    return contact;
  }
  const ts = nowIso();
  contact = {
    id: uid(), clientId, name: name || phone || email, phone: phone || null, email: email || null,
    company: company || null, tags: tags || [], notes: null, source: source || 'manual', createdAt: ts, updatedAt: ts,
  };
  await crmStore.addContact(clientId, contact);
  return contact;
}

async function createDeal(clientId, input, actor) {
  const pipeline = await getPipeline(clientId);
  const fields = cleanFields(input, { creating: true });
  if (fields.tags) fields.tags = await ensureTags(clientId, fields.tags);
  const funnel = funnelOf(pipeline, input && input.funnelId);
  const stageId = input && input.stageId && funnel.stages.some((s) => s.id === input.stageId)
    ? input.stageId : funnel.stages[0].id;
  let contactId = null;
  if (input && input.contactId) {
    const c = await crmStore.getContact(clientId, String(input.contactId));
    if (!c) throw new CrmError(400, 'Contato não encontrado.');
    contactId = c.id;
    if (fields.phone === undefined) fields.phone = c.phone || null;
    if (fields.email === undefined) fields.email = c.email || null;
  } else {
    const c = await upsertContactFor(clientId, { ...fields, source: fields.source });
    contactId = c ? c.id : null;
  }
  const ts = nowIso();
  const deal = {
    id: uid(), clientId, funnelId: funnel.id, contactId,
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
  normalizeDeal(pipeline, deal);
  const fields = cleanFields(input, { creating: false });
  if (fields.tags) fields.tags = await ensureTags(clientId, fields.tags);
  const changed = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(deal[k] ?? null));
  Object.assign(deal, fields);
  let funnel = funnelOf(pipeline, deal.funnelId);
  let targetStage = input && input.stageId !== undefined ? input.stageId : undefined;
  if (input && input.funnelId !== undefined && input.funnelId !== deal.funnelId) {
    const nf = pipeline.funnels.find((f) => f.id === input.funnelId);
    if (!nf) throw new CrmError(400, 'Funil inválido.');
    pushHistory(deal, { type: 'stage', by: actor, text: `Mudou para o funil "${nf.name}"` });
    deal.funnelId = nf.id;
    funnel = nf;
    if (targetStage === undefined || !nf.stages.some((s) => s.id === targetStage)) targetStage = nf.stages[0].id;
    if (targetStage === deal.stageId) deal.stageId = null;
  }
  if (targetStage !== undefined && targetStage !== deal.stageId) {
    if (!funnel.stages.some((s) => s.id === targetStage)) throw new CrmError(400, 'Etapa inválida.');
    pushHistory(deal, {
      type: 'stage', by: actor, from: deal.stageId, to: targetStage,
      text: deal.stageId ? `Movido de "${stageName(pipeline, deal.stageId)}" para "${stageName(pipeline, targetStage)}"` : `Entrou em "${stageName(pipeline, targetStage)}"`,
    });
    deal.stageId = targetStage;
    deal.stageChangedAt = nowIso();
  }
  const labels = { name: 'nome', phone: 'telefone', email: 'e-mail', company: 'empresa', source: 'origem', sourceDetail: 'detalhe da origem', value: 'valor', owner: 'responsável', tags: 'etiquetas', notes: 'notas' };
  if (changed.length) pushHistory(deal, { type: 'edit', by: actor, text: `Editou ${changed.map((k) => labels[k] || k).join(', ')}` });
  if (!deal.contactId && (deal.phone || deal.email)) {
    const c = await upsertContactFor(clientId, deal);
    if (c) deal.contactId = c.id;
  }
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

function cleanStages(input) {
  if (!Array.isArray(input) || !input.length) throw new CrmError(400, 'O funil precisa de pelo menos uma etapa.');
  if (input.length > MAX_STAGES) throw new CrmError(400, `Máximo de ${MAX_STAGES} etapas.`);
  const seen = new Set();
  return input.map((s, i) => {
    const name = str(s && s.name, 40);
    if (!name) throw new CrmError(400, 'Toda etapa precisa de um nome.');
    let id = s && typeof s.id === 'string' && /^[a-z0-9_-]{1,40}$/.test(s.id) ? s.id : null;
    if (!id || seen.has(id)) id = `etapa_${uid(4)}`;
    seen.add(id);
    const kind = KINDS.includes(s && s.kind) ? s.kind : 'open';
    return { id, name, kind, color: cleanColor(s && s.color, stageDefaultColor(kind, i)) };
  });
}

// Salva as etapas (e o nome) de um funil. Ids existentes são mantidos (os
// negócios apontam pra eles); etapa nova ganha id novo. Negócios de uma
// etapa removida vão pra primeira etapa do mesmo funil.
async function saveStages(clientId, input, actor, funnelId, funnelName) {
  const current = await getPipeline(clientId);
  const funnel = funnelOf(current, funnelId);
  const stages = cleanStages(input);
  // Id de etapa não pode repetir entre funis (o histórico guarda só o id).
  const otherIds = new Set(current.funnels.filter((f) => f.id !== funnel.id).flatMap((f) => f.stages.map((s) => s.id)));
  stages.forEach((s) => { if (otherIds.has(s.id)) s.id = `etapa_${uid(4)}`; });
  const name = funnelName !== undefined ? str(funnelName, 40) : funnel.name;
  if (!name) throw new CrmError(400, 'Dê um nome para o funil.');
  const updatedFunnel = { ...funnel, name, stages };
  const pipeline = { funnels: current.funnels.map((f) => (f.id === funnel.id ? updatedFunnel : f)), updatedAt: nowIso() };
  await crmStore.savePipeline(clientId, pipeline);

  const valid = new Set(stages.map((s) => s.id));
  const deals = await crmStore.listDeals(clientId);
  let moved = 0;
  for (const deal of deals) {
    normalizeDeal(current, deal);
    if (deal.funnelId !== funnel.id || valid.has(deal.stageId)) continue;
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
  return { pipeline: { ...pipeline, stages: pipeline.funnels[0].stages }, funnel: updatedFunnel, moved };
}

async function createFunnel(clientId, input) {
  const current = await getPipeline(clientId);
  if (current.funnels.length >= MAX_FUNNELS) throw new CrmError(400, `Máximo de ${MAX_FUNNELS} funis.`);
  const name = str(input && input.name, 40);
  if (!name) throw new CrmError(400, 'Dê um nome para o funil.');
  const funnel = {
    id: `funil_${uid(4)}`, name,
    stages: DEFAULT_STAGES.map((s) => ({ ...s, id: `etapa_${uid(4)}` })),
  };
  const pipeline = { funnels: [...current.funnels, funnel], updatedAt: nowIso() };
  await crmStore.savePipeline(clientId, pipeline);
  return funnel;
}

async function deleteFunnel(clientId, funnelId) {
  const current = await getPipeline(clientId);
  if (!current.funnels.some((f) => f.id === funnelId)) throw new CrmError(404, 'Funil não encontrado.');
  if (current.funnels.length <= 1) throw new CrmError(400, 'O CRM precisa de pelo menos um funil.');
  const deals = await crmStore.listDeals(clientId);
  const inIt = deals.filter((d) => normalizeDeal(current, d).funnelId === funnelId).length;
  if (inIt) throw new CrmError(400, `Este funil tem ${inIt} negócio(s). Mova ou exclua antes de apagar o funil.`);
  await crmStore.savePipeline(clientId, { funnels: current.funnels.filter((f) => f.id !== funnelId), updatedAt: nowIso() });
}

// Lead que chegou por um formulário nativo do cliente: entra na primeira etapa do primeiro funil.
async function addFromForm(clientId, { form, contact, readable, meta }) {
  const pipeline = await getPipeline(clientId);
  const funnel = pipeline.funnels[0];
  const ts = nowIso();
  const campaign = meta && meta.utm_campaign ? str(meta.utm_campaign, 120) : null;
  const deal = {
    id: uid(), clientId, funnelId: funnel.id, contactId: null,
    name: str(contact.name, 120) || 'Sem nome',
    phone: str(contact.phone, 40) || null,
    email: str(contact.email, 160).toLowerCase() || null,
    company: str(contact.company, 120) || null,
    source: 'form', sourceDetail: str(form.name, 160) || form.slug, campaign,
    formId: form.id,
    formAnswers: (readable || []).slice(0, 40).map((x) => ({ question: str(x.question, 200), answer: str(x.answer, 1000) })),
    value: null, owner: null, tags: [], notes: null,
    stageId: funnel.stages[0].id, stageChangedAt: ts, createdAt: ts, updatedAt: ts, history: [],
  };
  try {
    const c = await upsertContactFor(clientId, { ...deal, source: 'form' });
    deal.contactId = c ? c.id : null;
  } catch (e) { console.warn('CRM: contato do formulário não foi criado:', e.message); }
  pushHistory(deal, {
    type: 'created', by: { role: 'system', name: 'Formulário' }, to: deal.stageId,
    text: `Chegou pelo formulário "${deal.sourceDetail}"${campaign ? ` (campanha ${campaign})` : ''}`,
  });
  await crmStore.addDeal(clientId, deal);
  return deal;
}

/* ===================== Contatos ===================== */

function cleanContactFields(input, { creating }) {
  const b = input || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  if (creating || has('name')) out.name = str(b.name, 120);
  if (has('phone')) out.phone = str(b.phone, 40) || null;
  if (has('email')) out.email = cleanEmail(b.email);
  if (has('company')) out.company = str(b.company, 120) || null;
  if (has('tags')) out.tags = cleanTagNames(b.tags);
  if (has('notes')) out.notes = str(b.notes, 2000) || null;
  if (creating && !out.name && !out.phone) throw new CrmError(400, 'Informe pelo menos o nome ou o telefone.');
  if (has('name') && !out.name && !creating) throw new CrmError(400, 'Informe o nome do contato.');
  return out;
}

// Negócios antigos (do CRM v1) não tinham contato: cria na primeira leitura.
async function backfillContacts(clientId, deals) {
  for (const d of deals) {
    if (d.contactId || (!d.phone && !d.email)) continue;
    const c = await upsertContactFor(clientId, { name: d.name, phone: d.phone, email: d.email, company: d.company, source: d.source });
    if (c) { d.contactId = c.id; await crmStore.saveDeal(clientId, d); }
  }
}

async function listContacts(clientId) {
  const [pipeline, deals] = await Promise.all([getPipeline(clientId), crmStore.listDeals(clientId)]);
  await backfillContacts(clientId, deals);
  const [contacts, convs] = await Promise.all([crmStore.listContacts(clientId), crmStore.listConversations(clientId)]);
  const convByContact = new Map(convs.map((c) => [c.contactId, c]));
  const dealsByContact = new Map();
  deals.forEach((d) => {
    if (!d.contactId) return;
    normalizeDeal(pipeline, d);
    const list = dealsByContact.get(d.contactId) || [];
    list.push(d);
    dealsByContact.set(d.contactId, list);
  });
  return contacts.map((c) => {
    const ds = (dealsByContact.get(c.id) || []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const conv = convByContact.get(c.id);
    const d = ds[0];
    let stage = null;
    if (d) {
      const f = funnelOf(pipeline, d.funnelId);
      const s = f.stages.find((x) => x.id === d.stageId);
      stage = s ? { id: s.id, name: s.name, kind: s.kind, color: s.color, funnelName: f.name } : null;
    }
    return {
      ...c,
      deal: d ? { id: d.id, name: d.name, value: d.value, stage } : null,
      dealsCount: ds.length,
      conversationId: conv ? conv.id : null,
      lastConversationAt: conv ? conv.lastAt : null,
    };
  });
}

async function createContact(clientId, input) {
  const f = cleanContactFields(input, { creating: true });
  if (f.tags) f.tags = await ensureTags(clientId, f.tags);
  if (f.phone && await crmStore.findContactByPhone(clientId, f.phone)) throw new CrmError(409, 'Já existe um contato com esse telefone.');
  const ts = nowIso();
  const contact = {
    id: uid(), clientId, name: f.name || f.phone, phone: null, email: null, company: null, tags: [], notes: null,
    source: 'manual', ...f, createdAt: ts, updatedAt: ts,
  };
  await crmStore.addContact(clientId, contact);
  return contact;
}

async function updateContact(clientId, id, input) {
  const contact = await crmStore.getContact(clientId, id);
  if (!contact) throw new CrmError(404, 'Contato não encontrado.');
  const f = cleanContactFields(input, { creating: false });
  if (f.tags) f.tags = await ensureTags(clientId, f.tags);
  if (f.phone && crmStore.phoneKey(f.phone) !== crmStore.phoneKey(contact.phone)) {
    const other = await crmStore.findContactByPhone(clientId, f.phone);
    if (other && other.id !== id) throw new CrmError(409, 'Já existe um contato com esse telefone.');
  }
  Object.assign(contact, f, { updatedAt: nowIso() });
  await crmStore.saveContact(clientId, contact);
  return contact;
}

// Apaga o contato e as conversas dele. Os negócios ficam (sem contato ligado).
async function deleteContact(clientId, id) {
  const ok = await crmStore.removeContact(clientId, id);
  if (!ok) throw new CrmError(404, 'Contato não encontrado.');
  for (const d of await crmStore.listDeals(clientId)) {
    if (d.contactId === id) { d.contactId = null; await crmStore.saveDeal(clientId, d); }
  }
}

// Importação (CSV lido no navegador). Telefone já existente atualiza o contato.
async function importContacts(clientId, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new CrmError(400, 'Nenhuma linha para importar.');
  if (rows.length > MAX_IMPORT) throw new CrmError(400, `Máximo de ${MAX_IMPORT} contatos por importação.`);
  let created = 0; let updated = 0; const skipped = [];
  for (let i = 0; i < rows.length; i += 1) {
    try {
      const f = cleanContactFields(rows[i], { creating: true });
      if (f.tags) f.tags = await ensureTags(clientId, f.tags);
      const existing = f.phone ? await crmStore.findContactByPhone(clientId, f.phone) : null;
      if (existing) {
        Object.keys(f).forEach((k) => { if (f[k] && !(Array.isArray(f[k]) && !f[k].length)) existing[k] = k === 'tags' ? cleanTagNames([...(existing.tags || []), ...f.tags]) : f[k]; });
        existing.updatedAt = nowIso();
        await crmStore.saveContact(clientId, existing);
        updated += 1;
      } else {
        const ts = nowIso();
        await crmStore.addContact(clientId, {
          id: uid(), clientId, name: f.name || f.phone, phone: null, email: null, company: null, tags: [], notes: null,
          source: 'import', ...f, createdAt: ts, updatedAt: ts,
        });
        created += 1;
      }
    } catch (e) {
      skipped.push({ line: i + 2, reason: e instanceof CrmError ? e.message : 'erro' });
    }
  }
  return { created, updated, skipped: skipped.slice(0, 50), skippedCount: skipped.length };
}

/* ===================== Relatórios ===================== */

function parseDate(v, label) {
  const d = new Date(String(v || ''));
  if (Number.isNaN(d.getTime())) throw new CrmError(400, `Data ${label} inválida.`);
  return d;
}

async function report(clientId, q) {
  const from = parseDate(q.from, 'inicial');
  const to = parseDate(q.to, 'final');
  if (to <= from) throw new CrmError(400, 'A data final precisa ser depois da inicial.');
  if (to - from > 400 * 864e5) throw new CrmError(400, 'Período máximo de 400 dias.');
  const prevFrom = new Date(from.getTime() - (to - from));
  const [pipeline, allDeals, settings] = await Promise.all([getPipeline(clientId), crmStore.listDeals(clientId), getSettings(clientId)]);
  const funnel = funnelOf(pipeline, q.funnelId);
  const stages = funnel.stages;
  const idx = new Map(stages.map((s, i) => [s.id, i]));
  const kindOf = (id) => (stages.find((s) => s.id === id) || {}).kind || 'open';
  const deals = allDeals.map((d) => normalizeDeal(pipeline, d)).filter((d) => d.funnelId === funnel.id
    && (!q.owner || (d.owner || '') === q.owner) && (!q.source || d.source === q.source));
  const inRange = (iso, a, b) => { const t = new Date(iso).getTime(); return t >= a.getTime() && t < b.getTime(); };

  const wonAt = (d) => {
    if (kindOf(d.stageId) !== 'won') return null;
    const h = [...(d.history || [])].reverse().find((e) => (e.type === 'stage' || e.type === 'created') && e.to === d.stageId);
    return (h && h.at) || d.stageChangedAt || d.createdAt;
  };
  const block = (a, b) => {
    const leads = deals.filter((d) => inRange(d.createdAt, a, b));
    const sales = deals.filter((d) => { const w = wonAt(d); return w && inRange(w, a, b); });
    const revenue = sales.reduce((s, d) => s + (d.value || 0), 0);
    return { leads: leads.length, sales: sales.length, revenue: Math.round(revenue * 100) / 100, ticket: sales.length ? Math.round((revenue / sales.length) * 100) / 100 : 0, leadList: leads };
  };
  const cur = block(from, to);
  const prev = block(prevFrom, from);

  // Quantos leads do período passaram por cada etapa (etapas de perda ficam de fora).
  const visited = (d) => {
    const s = new Set([d.stageId]);
    (d.history || []).forEach((e) => { if (e.to) s.add(e.to); });
    return s;
  };
  const steps = stages.filter((s) => s.kind !== 'lost').map((s) => {
    const passed = cur.leadList.filter((d) => {
      const v = visited(d);
      if (v.has(s.id)) return true;
      if (s.kind === 'won') return false;
      const max = Math.max(...[...v].filter((id) => idx.has(id) && kindOf(id) !== 'lost').map((id) => idx.get(id)), -1);
      return max >= idx.get(s.id);
    }).length;
    return { id: s.id, name: s.name, kind: s.kind, color: s.color, passed };
  });
  const now = stages.map((s) => ({
    id: s.id, name: s.name, kind: s.kind, color: s.color,
    count: cur.leadList.filter((d) => d.stageId === s.id).length,
    passed: (steps.find((x) => x.id === s.id) || { passed: cur.leadList.filter((d) => visited(d).has(s.id)).length }).passed,
  }));

  const meaningOf = new Map(settings.tags.map((t) => [lower(t.name), t.meaning]));
  const qual = { qualified: 0, disqualified: 0, none: 0 };
  cur.leadList.forEach((d) => {
    const m = (d.tags || []).map((t) => meaningOf.get(lower(t)));
    if (m.includes('disqualified')) qual.disqualified += 1;
    else if (m.includes('qualified')) qual.qualified += 1;
    else qual.none += 1;
  });
  const bySource = {};
  cur.leadList.forEach((d) => {
    const k = d.source || 'manual';
    bySource[k] = bySource[k] || { source: k, leads: 0, won: 0 };
    bySource[k].leads += 1;
    if (kindOf(d.stageId) === 'won') bySource[k].won += 1;
  });
  const strip = ({ leadList, ...rest }) => rest;
  return {
    funnel: { id: funnel.id, name: funnel.name },
    period: { from: from.toISOString(), to: to.toISOString(), prevFrom: prevFrom.toISOString() },
    current: strip(cur), previous: strip(prev), steps, now, qualification: qual,
    bySource: Object.values(bySource).sort((a, b) => b.leads - a.leads),
    owners: [...new Set(allDeals.map((d) => d.owner).filter(Boolean))].sort(),
  };
}

module.exports = {
  DEFAULT_STAGES, COLORS, CrmError, uid, nowIso, str,
  getPipeline, funnelOf, getBoard, createDeal, updateDeal, addComment, removeDeal, saveStages, createFunnel, deleteFunnel, addFromForm,
  getSettings, whatsappView, saveWhatsappConfig, listTags, createTag, updateTag, deleteTag, ensureTags,
  listContacts, createContact, updateContact, deleteContact, importContacts, upsertContactFor, pushHistory,
  report,
};
