const config = require('../config');
const cache = require('../lib/cache');
const accountsStore = require('../data/accountsStore');
const crmService = require('../services/crmService');
const metaService = require('../services/metaService');

/**
 * Número de WhatsApp da tela final do formulário.
 *
 * Ordem, da mais confiável para a reserva:
 * 1. Número digitado no formulário (substitui o do cliente).
 * 2. Número exibido já salvo no CRM do cliente (Conversas / WhatsApp Cloud API).
 * 3. Se o CRM tem phone_number_id e não tem o número exibido, a Graph API
 *    devolve display_phone_number (token do WhatsApp, ou o do usuário do sistema).
 * 4. Campo whatsapp_number da Página do Facebook do cliente, com o token
 *    do usuário do sistema que o backend já usa.
 */

function normalizeWhatsappDigits(raw) {
  let digits = String(raw == null ? '' : raw).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  // DDI 55 + DDD + número (fixo 8 ou celular 9).
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  // Só DDD + número: a operação é no Brasil.
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  // Outro país, já com DDI (E.164, sem o +).
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return '';
}

function formatWhatsappDisplay(digits) {
  const d = normalizeWhatsappDigits(digits);
  if (!d) return '';
  if (d.startsWith('55') && d.length === 13) {
    return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  }
  if (d.startsWith('55') && d.length === 12) {
    return `+55 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  }
  return `+${d}`;
}

function applyWhatsappPlaceholders(template, name) {
  const full = String(name || '').replace(/\s+/g, ' ').trim();
  const first = full.split(' ')[0] || '';
  return String(template || '')
    .replace(/\{nome\}/gi, first)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([!?,.:;])/g, '$1')
    .trim();
}

function waMeUrl(digits, text) {
  const d = normalizeWhatsappDigits(digits);
  if (!d) return '';
  const base = `https://wa.me/${d}`;
  const t = String(text || '').trim();
  return t ? `${base}?text=${encodeURIComponent(t)}` : base;
}

function emptyResult(reason) {
  return { found: false, digits: '', display: '', source: null, reason };
}

function foundResult(digits, source) {
  return { found: true, digits, display: formatWhatsappDisplay(digits), source, reason: null };
}

/**
 * Qual número a tela final usa.
 * Sem redirecionamento automático, o número do cliente NÃO entra no lugar
 * do botão antigo: formulário já publicado continua só com o número digitado.
 */
function endingWhatsappPlan(ending, client) {
  const end = ending || {};
  const manual = normalizeWhatsappDigits(end.whatsapp);
  const redirectWanted = end.whatsappRedirect === true;
  const clientDigits = client && client.found ? normalizeWhatsappDigits(client.digits) : '';
  const digits = manual || (redirectWanted ? clientDigits : '');
  let source = null;
  if (manual) source = 'manual';
  else if (digits) source = (client && client.source) || 'client';
  return {
    digits,
    source,
    redirect: redirectWanted && !!digits,
    showButton: !!digits,
  };
}

function defaultDeps() {
  return {
    getAccount: (id) => accountsStore.getById(id),
    getSettings: (id) => crmService.getSettings(id),
    fetchPhoneDisplay: fetchWhatsappDisplayPhone,
    fetchPageWhatsapp: (pageId) => metaService.getPageWhatsappNumber(pageId),
  };
}

async function fetchWhatsappDisplayPhone(phoneNumberId) {
  const id = String(phoneNumberId || '').replace(/\D/g, '');
  const token = config.whatsapp.token || config.meta.systemUserToken;
  if (!id || !token || config.useMockData) return null;
  const version = config.whatsapp.apiVersion || config.meta.apiVersion || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=display_phone_number`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      console.warn('WhatsApp: não consegui ler o número exibido:', json.error && json.error.message);
      return null;
    }
    return json.display_phone_number || null;
  } catch (e) {
    console.warn('WhatsApp: falha ao ler o número exibido:', e.message);
    return null;
  }
}

async function resolveClientWhatsapp(clientId, deps) {
  if (!clientId) return emptyResult('no_client');
  const d = deps || defaultDeps();
  const account = await d.getAccount(clientId);
  if (!account) return emptyResult('missing_client');

  let settings = null;
  try {
    settings = await d.getSettings(clientId);
  } catch (e) {
    console.warn('WhatsApp do cliente: não consegui ler o CRM:', e.message);
  }
  const wa = (settings && settings.whatsapp) || {};
  const stored = normalizeWhatsappDigits(wa.displayPhone);
  if (stored) return foundResult(stored, 'crm');

  if (wa.phoneNumberId && d.fetchPhoneDisplay) {
    try {
      const fromGraph = normalizeWhatsappDigits(await d.fetchPhoneDisplay(wa.phoneNumberId));
      if (fromGraph) return foundResult(fromGraph, 'crm');
    } catch (e) {
      console.warn('WhatsApp do cliente: número da Cloud API indisponível:', e.message);
    }
  }

  const pageId = account.meta && account.meta.pageId;
  if (pageId && d.fetchPageWhatsapp) {
    try {
      const fromPage = normalizeWhatsappDigits(await d.fetchPageWhatsapp(pageId));
      if (fromPage) return foundResult(fromPage, 'page');
    } catch (e) {
      console.warn('WhatsApp do cliente: Página sem número legível:', e.message);
    }
  }
  return emptyResult('not_found');
}

async function lookupClientWhatsapp(clientId) {
  if (!clientId) return emptyResult('no_client');
  const key = `form:client-wa:${clientId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await resolveClientWhatsapp(clientId);
  cache.set(key, result, result.found ? 180 : 60);
  return result;
}

/** Ending que vai para o navegador do lead, com o número já resolvido. */
async function withResolvedWhatsapp(form, ending) {
  const base = { ...(ending || {}) };
  let client = null;
  const manual = normalizeWhatsappDigits(base.whatsapp);
  if (base.whatsappRedirect === true && !manual && form && form.clientId) {
    try {
      client = await lookupClientWhatsapp(form.clientId);
    } catch (e) {
      console.warn('WhatsApp do cliente indisponível:', e.message);
    }
  }
  const plan = endingWhatsappPlan(base, client);
  return {
    ...base,
    whatsapp: manual,
    whatsappRedirect: plan.redirect,
    whatsappNumber: plan.digits,
  };
}

module.exports = {
  normalizeWhatsappDigits,
  formatWhatsappDisplay,
  applyWhatsappPlaceholders,
  waMeUrl,
  endingWhatsappPlan,
  resolveClientWhatsapp,
  lookupClientWhatsapp,
  withResolvedWhatsapp,
  fetchWhatsappDisplayPhone,
};
