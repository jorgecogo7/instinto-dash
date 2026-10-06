const config = require('../config');
const mockMeta = require('../data/mockMeta');
const cache = require('../lib/cache');

// META_GRAPH_BASE existe só pra testes locais (servidor falso da Graph API).
// Em produção fica vazio e usa o endereço oficial da Meta.
const GRAPH_BASE = process.env.META_GRAPH_BASE || `https://graph.facebook.com/${config.meta.apiVersion}`;

const REQUEST_TIMEOUT_MS = 20000;
const DATE_PRESETS = new Set(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month']);

// Ações que contam como "resultado" para o cliente, em ordem de prioridade.
// Pega a primeira que existir na campanha — assim uma campanha de WhatsApp
// mostra conversas iniciadas e uma de loja mostra compras, sem somar as
// duas coisas diferentes no mesmo número.
const RESULT_ACTIONS = [
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.messaging_conversation_started_7d',
  'omni_complete_registration',
];

// Aceita {from, to} no formato AAAA-MM-DD (from <= to). Qualquer outra coisa
// vira null e a consulta cai no período pronto.
function validRange(range) {
  if (!range || !range.from || !range.to) return null;
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  if (!ok(range.from) || !ok(range.to) || range.from > range.to) return null;
  return { since: range.from, until: range.to };
}

function hasRealCredentials() {
  return !config.useMockData && Boolean(config.meta.systemUserToken);
}

function normalizeAdAccountId(id) {
  const clean = String(id || '').trim();
  if (!clean) return '';
  return clean.startsWith('act_') ? clean : `act_${clean.replace(/\D/g, '')}`;
}

// Traduz os erros mais comuns da Graph API pra algo que o dono da agência
// entende e sabe o que fazer — em vez de despejar o JSON cru da Meta.
function friendlyError(err) {
  const code = err.code;
  if (code === 190) return 'O token da Meta é inválido ou expirou. Gere um novo token do usuário do sistema e atualize META_SYSTEM_USER_TOKEN.';
  if (code === 100 && /does not exist|cannot be loaded|nonexisting field/i.test(err.message)) {
    return 'A Meta não encontrou essa conta de anúncios (ou ela não foi atribuída ao usuário do sistema). Confira o ID e as permissões no Gerenciador de Negócios.';
  }
  if (code === 10 || code === 200 || code === 294) {
    return 'O usuário do sistema não tem permissão nessa conta de anúncios. Atribua a conta a ele no Gerenciador de Negócios (acesso ao ativo).';
  }
  if ([4, 17, 32, 613, 80000, 80004].includes(code)) {
    return 'A Meta limitou as consultas por excesso de requisições. Tente de novo em alguns minutos.';
  }
  return err.message;
}

async function graphGet(path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  // O token vai no cabeçalho, nunca na URL — URL costuma parar em logs.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.meta.systemUserToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`A Meta respondeu algo inesperado (HTTP ${res.status}).`);
  }

  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(e.message || `Erro ${res.status} na Graph API.`);
    err.code = e.code;
    throw new Error(friendlyError(err));
  }
  return json;
}

// Percorre as páginas de uma lista da Graph API (até um teto de segurança).
async function graphGetAll(path, params = {}, maxPages = 5) {
  let json = await graphGet(path, params);
  const items = [...(json.data || [])];
  let pages = 1;
  while (json.paging && json.paging.next && pages < maxPages) {
    json = await graphGet(json.paging.next);
    items.push(...(json.data || []));
    pages += 1;
  }
  return items;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function pickResults(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const type of RESULT_ACTIONS) {
    const found = actions.find((a) => a.action_type === type);
    if (found) return Math.round(num(found.value));
  }
  return 0;
}

function mapInsights(node) {
  const row = node && node.insights && node.insights.data && node.insights.data[0];
  if (!row) return { spend: 0, ctr: 0, cpc: 0, conversions: 0 };
  return {
    spend: num(row.spend),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    conversions: pickResults(row.actions),
  };
}

// Converte a resposta da Graph API (campaigns > adsets > ads, insights em
// `insights.data[0]`) pro formato que a tela já espera (o mesmo do mockMeta).
function mapMetaResponse(campaigns) {
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.effective_status || c.status,
    insights: mapInsights(c),
    adsets: ((c.adsets && c.adsets.data) || []).map((s) => ({
      id: s.id,
      name: s.name,
      ads: ((s.ads && s.ads.data) || []).map((a) => ({
        id: a.id,
        name: a.name,
        insights: mapInsights(a),
      })),
    })),
  }));
}

/**
 * Retorna campanhas > conjuntos de anúncios > anúncios com insights,
 * para uma conta de anúncios (act_...) específica de um cliente.
 *
 * Sem token (ou com USE_MOCK_DATA=true): devolve os dados de exemplo.
 * Com token: consulta a Graph API de verdade. `datePreset` aceita
 * today, yesterday, last_7d, last_14d, last_30d (padrão), this_month, last_month.
 * Se `range` ({from, to} em AAAA-MM-DD) vier, ele tem prioridade sobre o período pronto.
 */
async function getCampaignsWithAds(adAccountId, datePreset = 'last_30d', range = null) {
  const preset = DATE_PRESETS.has(datePreset) ? datePreset : 'last_30d';
  const customRange = validRange(range);
  const periodKey = customRange ? `${customRange.since}_${customRange.until}` : preset;
  const accountId = normalizeAdAccountId(adAccountId);
  const cacheKey = `meta:campaigns:${accountId || 'mock'}:${periodKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let result;

  if (!hasRealCredentials()) {
    result = mockMeta.campaigns;
  } else {
    if (!accountId) throw new Error('Este cliente ainda não tem um ID de conta de anúncios da Meta.');

    // Período: datas exatas (from/to) quando informadas; senão um período pronto.
    const period = customRange
      ? `time_range(${JSON.stringify(customRange)})`
      : `date_preset(${preset})`;
    const insightFields = `insights.${period}{spend,ctr,cpc,actions}`;
    const fields = [
      'name', 'objective', 'status', 'effective_status',
      insightFields,
      `adsets.limit(50){name,${insightFields},ads.limit(50){name,${insightFields}}}`,
    ].join(',');

    const campaigns = await graphGetAll(`${accountId}/campaigns`, {
      fields,
      limit: '50',
      // Só campanhas que ainda importam pro relatório (não arquivadas/apagadas).
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES']),
    });
    result = mapMetaResponse(campaigns);
  }

  cache.set(cacheKey, result, 60 * 5); // 5 min — evita bater na API a cada refresh de tela
  return result;
}

/**
 * Confirma de verdade que o usuário do sistema enxerga essa conta de
 * anúncios. Devolve nome, moeda e se a conta está ativa. Sem token
 * configurado, devolve null (quem chama decide marcar como "pendente").
 */
async function verifyAdAccount(adAccountId) {
  if (!hasRealCredentials()) return null;
  const accountId = normalizeAdAccountId(adAccountId);
  if (!accountId) throw new Error('Informe o ID da conta de anúncios.');

  const json = await graphGet(accountId, { fields: 'name,account_status,currency,business_name' });
  return {
    id: json.id || accountId,
    name: json.name || json.business_name || accountId,
    currency: json.currency || 'BRL',
    active: json.account_status === 1,
  };
}

module.exports = { getCampaignsWithAds, verifyAdAccount, hasRealCredentials, normalizeAdAccountId, mapMetaResponse };
