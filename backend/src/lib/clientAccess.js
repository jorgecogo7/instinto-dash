const crypto = require('crypto');

// O que o cliente pode ver no painel dele. Tudo ligado por padrão,
// menos o que é mais "interno" (formulários).
const VISIBILITY_DEFAULTS = {
  ads: true,             // Anúncios (resultados)
  ads_meta: true,        //   Meta Ads
  ads_google: true,      //   Google Ads
  ads_creatives: true,   //   Melhores criativos e tabela de anúncios
  ads_audience: true,    //   Público, posicionamentos, regiões, dia da semana
  ads_campaigns: true,   //   Tabelas de campanhas e palavras-chave
  ads_goals: true,       //   Metas do mês (investimento, custo por resultado)
  social: true,          // Redes Sociais (Instagram)
  forms: false,          // Formulários e respostas
  crm: false,            // CRM (funil de leads do próprio cliente)
};

function visibilityOf(account) {
  const v = account.clientVisibility || {};
  const out = {};
  Object.keys(VISIBILITY_DEFAULTS).forEach((k) => { out[k] = typeof v[k] === 'boolean' ? v[k] : VISIBILITY_DEFAULTS[k]; });
  return out;
}

function sanitizeVisibility(input) {
  const out = {};
  Object.keys(VISIBILITY_DEFAULTS).forEach((k) => { if (typeof (input || {})[k] === 'boolean') out[k] = input[k]; });
  return out;
}

// Metas por plataforma: orçamento mensal, custo por resultado alvo,
// resultados por mês e ROAS alvo. Valores vazios/zero = sem meta.
function sanitizeGoals(input) {
  const out = {};
  ['meta', 'google'].forEach((p) => {
    const g = (input || {})[p] || {};
    const o = {};
    ['monthlyBudget', 'costPerResultTarget', 'resultsTarget', 'roasTarget'].forEach((k) => {
      const n = Number(String(g[k] ?? '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) o[k] = Math.round(n * 100) / 100;
    });
    if (Object.keys(o).length) out[p] = o;
  });
  return out;
}

function slugUser(name) {
  return String(name || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')
    .slice(0, 40) || 'cliente';
}

// Senha diferente pra cada cliente: iniciais + números + letras,
// ex.: "BN4829-1736-QX". Sem letras/números que confundem (O/0, I/1, L).
function generatePassword(name) {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const pick = (alphabet) => alphabet[crypto.randomInt(alphabet.length)];
  const initials = String(name || '').normalize('NFD').replace(/[^A-Za-z ]/g, '')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
    .replace(/[OIL]/g, () => pick(letters)) || pick(letters) + pick(letters);
  const digits = (n) => Array.from({ length: n }, () => '23456789'[crypto.randomInt(8)]).join('');
  return `${initials.padEnd(2, pick(letters))}${digits(4)}-${digits(4)}-${pick(letters)}${pick(letters)}`;
}

module.exports = {
  sanitizeGoals, VISIBILITY_DEFAULTS, visibilityOf, sanitizeVisibility, slugUser, generatePassword };
