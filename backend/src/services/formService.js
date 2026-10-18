const crypto = require('crypto');
const config = require('../config');

/**
 * Regras dos formulários próprios:
 * - normaliza/valida o que vem do editor (nada de HTML, limites de tamanho);
 * - monta a versão pública (sem pontos, sem token da API de Conversões);
 * - calcula pontuação e qualificação NO SERVIDOR (o navegador não decide se o
 *   lead é qualificado — senão daria pra "burlar" mandando a resposta certa);
 * - dispara a API de Conversões da Meta e o webhook, se configurados.
 */

const FIELD_TYPES = new Set([
  'short_text', 'long_text', 'email', 'phone', 'number', 'date',
  'choice', 'multi_choice', 'yes_no', 'rating', 'statement',
]);
const QUALIFICATIONS = new Set(['neutral', 'qualifies', 'disqualifies']);
const MAP_TO = new Set(['name', 'email', 'phone', 'company', 'city', 'instagram', '']);

const str = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const bool = (v) => v === true;
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const id = () => crypto.randomBytes(5).toString('hex');

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function safeUrl(v) {
  const s = str(v, 600);
  if (!s) return '';
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : '';
  } catch (e) {
    return '';
  }
}

function normalizeOption(o) {
  return {
    id: str(o.id, 20) || id(),
    label: str(o.label, 200),
    points: Math.max(-1000, Math.min(1000, num(o.points))),
    qualification: QUALIFICATIONS.has(o.qualification) ? o.qualification : 'neutral',
    // 'next' | 'end' | 'end_disqualified' | id de outra pergunta
    goTo: str(o.goTo, 30) || 'next',
    metaEvent: str(o.metaEvent, 50).replace(/[^A-Za-z0-9_]/g, ''),
  };
}

function normalizeField(f) {
  const type = FIELD_TYPES.has(f.type) ? f.type : 'short_text';
  const field = {
    id: str(f.id, 20) || id(),
    type,
    label: str(f.label, 300),
    description: str(f.description, 600),
    required: type === 'statement' ? false : bool(f.required),
    placeholder: str(f.placeholder, 120),
    mapTo: MAP_TO.has(f.mapTo) ? f.mapTo : '',
    goTo: str(f.goTo, 30) || 'next', // pra perguntas sem opções
  };
  if (type === 'choice' || type === 'multi_choice') {
    field.options = (Array.isArray(f.options) ? f.options : []).slice(0, 30).map(normalizeOption);
  }
  if (type === 'yes_no') {
    const opts = Array.isArray(f.options) && f.options.length === 2 ? f.options : [{ label: 'Sim' }, { label: 'Não' }];
    field.options = opts.map((o, i) => normalizeOption({ ...o, label: str(o.label, 40) || (i ? 'Não' : 'Sim') }));
  }
  if (type === 'rating') field.max = Math.max(3, Math.min(10, num(f.max, 5)));
  return field;
}

/** Normaliza o formulário vindo do editor (preserva id, slug e datas). */
function normalizeForm(input, existing = {}) {
  const w = input.welcome || {};
  const e = input.ending || {};
  const ed = input.endingDisqualified || {};
  const t = input.tracking || {};
  const th = input.theme || {};
  const sc = input.scoring || {};
  const it = input.integrations || {};
  const fields = (Array.isArray(input.fields) ? input.fields : []).slice(0, 60).map(normalizeField);
  return {
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    name: str(input.name, 120) || 'Formulário sem nome',
    clientId: str(input.clientId, 60) || null,
    status: input.status === 'published' ? 'published' : 'draft',
    welcome: {
      enabled: bool(w.enabled),
      title: str(w.title, 200),
      text: str(w.text, 1200),
      imageUrl: safeUrl(w.imageUrl),
      buttonText: str(w.buttonText, 40) || 'Começar',
    },
    theme: {
      mode: th.mode === 'light' ? 'light' : 'dark',
      accent: /^#[0-9a-fA-F]{6}$/.test(th.accent || '') ? th.accent : '#FF5A1E',
      logoUrl: safeUrl(th.logoUrl),
    },
    fields,
    scoring: {
      enabled: bool(sc.enabled),
      minScore: num(sc.minScore),
    },
    ending: {
      title: str(e.title, 200) || 'Obrigado! Recebemos suas respostas.',
      text: str(e.text, 1200),
      buttonText: str(e.buttonText, 40),
      buttonUrl: safeUrl(e.buttonUrl),
      redirectUrl: safeUrl(e.redirectUrl),
      whatsapp: str(e.whatsapp, 20).replace(/\D/g, ''),
      whatsappText: str(e.whatsappText, 300),
    },
    endingDisqualified: {
      title: str(ed.title, 200) || 'Obrigado pelo interesse!',
      text: str(ed.text, 1200),
      redirectUrl: safeUrl(ed.redirectUrl),
    },
    tracking: {
      metaPixelId: str(t.metaPixelId, 25).replace(/\D/g, ''),
      // Token da API de Conversões: fica só no servidor, nunca vai pro navegador.
      capiToken: t.capiToken === '__keep__' ? (existing.tracking?.capiToken || '') : str(t.capiToken, 400),
      capiTestCode: str(t.capiTestCode, 30),
      ga4Id: str(t.ga4Id, 20).replace(/[^A-Za-z0-9-]/g, ''),
      gtmId: str(t.gtmId, 20).replace(/[^A-Za-z0-9-]/g, ''),
      startEvent: str(t.startEvent, 50).replace(/[^A-Za-z0-9_]/g, '') || 'IniciouFormulario',
      leadEvent: str(t.leadEvent, 50).replace(/[^A-Za-z0-9_]/g, '') || 'Lead',
      qualifiedEvent: str(t.qualifiedEvent, 50).replace(/[^A-Za-z0-9_]/g, '') || 'LeadQualificado',
      disqualifiedEvent: str(t.disqualifiedEvent, 50).replace(/[^A-Za-z0-9_]/g, '') || 'LeadDesqualificado',
      stepEvents: bool(t.stepEvents),
    },
    integrations: {
      createCrmLead: bool(it.createCrmLead),
      webhookUrl: safeUrl(it.webhookUrl),
    },
    privacyUrl: safeUrl(input.privacyUrl),
  };
}

/** Versão que vai pro navegador do lead: sem pontos, sem qualificação, sem token. */
function publicForm(form) {
  return {
    slug: form.slug,
    welcome: form.welcome,
    theme: form.theme,
    privacyUrl: form.privacyUrl,
    fields: form.fields.map((f) => ({
      id: f.id, type: f.type, label: f.label, description: f.description, required: f.required,
      placeholder: f.placeholder, goTo: f.goTo, max: f.max, mapTo: f.mapTo,
      options: f.options && f.options.map((o) => ({ id: o.id, label: o.label, goTo: o.goTo, metaEvent: o.metaEvent })),
    })),
    ending: form.ending,
    endingDisqualified: { title: form.endingDisqualified.title, text: form.endingDisqualified.text, redirectUrl: form.endingDisqualified.redirectUrl },
    tracking: {
      metaPixelId: form.tracking.metaPixelId,
      ga4Id: form.tracking.ga4Id,
      gtmId: form.tracking.gtmId,
      startEvent: form.tracking.startEvent,
      leadEvent: form.tracking.leadEvent,
      qualifiedEvent: form.tracking.qualifiedEvent,
      disqualifiedEvent: form.tracking.disqualifiedEvent,
      stepEvents: form.tracking.stepEvents,
    },
  };
}

/** Limpa as respostas recebidas: só perguntas que existem, valores do tipo certo. */
function cleanAnswers(form, raw) {
  const out = {};
  const answers = raw && typeof raw === 'object' ? raw : {};
  form.fields.forEach((f) => {
    const v = answers[f.id];
    if (v === undefined || v === null || f.type === 'statement') return;
    if (f.type === 'multi_choice') {
      const ids = (Array.isArray(v) ? v : []).map((x) => str(x, 20)).filter((x) => f.options.some((o) => o.id === x));
      if (ids.length) out[f.id] = ids;
    } else if (f.type === 'choice' || f.type === 'yes_no') {
      const x = str(v, 20);
      if (f.options.some((o) => o.id === x)) out[f.id] = x;
    } else if (f.type === 'rating' || f.type === 'number') {
      if (Number.isFinite(Number(v))) out[f.id] = Number(v);
    } else {
      const x = str(String(v), f.type === 'long_text' ? 4000 : 400);
      if (x) out[f.id] = x;
    }
  });
  return out;
}

/** Pontuação e qualificação. */
function evaluate(form, answers) {
  let score = 0;
  const reasons = [];
  let disqualified = false;
  let qualifiedByOption = false;
  form.fields.forEach((f) => {
    if (!f.options) return;
    const picked = Array.isArray(answers[f.id]) ? answers[f.id] : (answers[f.id] ? [answers[f.id]] : []);
    picked.forEach((oid) => {
      const o = f.options.find((x) => x.id === oid);
      if (!o) return;
      score += o.points || 0;
      if (o.qualification === 'disqualifies') { disqualified = true; reasons.push(`"${f.label}": ${o.label}`); }
      if (o.qualification === 'qualifies') qualifiedByOption = true;
      if (o.goTo === 'end_disqualified') { disqualified = true; reasons.push(`"${f.label}": ${o.label}`); }
    });
  });
  if (form.scoring.enabled && score < form.scoring.minScore) {
    disqualified = true;
    reasons.push(`pontuação ${score} abaixo do mínimo (${form.scoring.minScore})`);
  }
  const usesQualification = form.scoring.enabled || form.fields.some((f) => (f.options || []).some((o) => o.qualification !== 'neutral' || o.goTo === 'end_disqualified'));
  return {
    score,
    qualified: !disqualified && (usesQualification || qualifiedByOption),
    disqualified,
    usesQualification,
    reasons,
  };
}

/** Texto legível das respostas (pro CRM, webhook e CSV). */
function answersReadable(form, answers) {
  return form.fields.filter((f) => answers[f.id] !== undefined).map((f) => {
    let value = answers[f.id];
    if (f.options) {
      const ids = Array.isArray(value) ? value : [value];
      value = ids.map((x) => (f.options.find((o) => o.id === x) || {}).label || x).join(', ');
    }
    return { fieldId: f.id, question: f.label, answer: String(value) };
  });
}

function contactFrom(form, answers) {
  const c = {};
  form.fields.forEach((f) => {
    if (f.mapTo && answers[f.id] !== undefined && !c[f.mapTo]) c[f.mapTo] = String(answers[f.id]);
    if (!f.mapTo && f.type === 'email' && !c.email && answers[f.id]) c.email = String(answers[f.id]);
    if (!f.mapTo && f.type === 'phone' && !c.phone && answers[f.id]) c.phone = String(answers[f.id]);
  });
  return c;
}

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

/** API de Conversões da Meta (servidor → Meta), deduplicada com o pixel pelo event_id. */
async function sendCapi(form, { eventName, eventId, contact, meta, url }) {
  const t = form.tracking;
  if (!t.metaPixelId || !t.capiToken) return;
  const user = {};
  if (contact.email) user.em = [sha(contact.email)];
  if (contact.phone) {
    let p = contact.phone.replace(/\D/g, '');
    if (p.length <= 11) p = `55${p}`;
    user.ph = [sha(p)];
  }
  if (contact.name) {
    const parts = contact.name.trim().split(/\s+/);
    user.fn = [sha(parts[0])];
    if (parts.length > 1) user.ln = [sha(parts[parts.length - 1])];
  }
  if (meta.fbp) user.fbp = meta.fbp;
  if (meta.fbc) user.fbc = meta.fbc;
  if (meta.ip) user.client_ip_address = meta.ip;
  if (meta.userAgent) user.client_user_agent = meta.userAgent;
  const body = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: url,
      user_data: user,
    }],
  };
  if (t.capiTestCode) body.test_event_code = t.capiTestCode;
  try {
    const res = await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/${t.metaPixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.capiToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn('API de Conversões recusou o evento:', res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.warn('API de Conversões falhou:', e.message);
  }
}

function isPrivateHost(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname.endsWith('.local') || hostname.endsWith('.internal');
}

async function sendWebhook(form, payload) {
  const url = form.integrations.webhookUrl;
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn('Webhook do formulário falhou:', e.message);
  }
}

module.exports = {
  slugify, normalizeForm, publicForm, cleanAnswers, evaluate, answersReadable, contactFrom, sendCapi, sendWebhook, newId: id,
};
