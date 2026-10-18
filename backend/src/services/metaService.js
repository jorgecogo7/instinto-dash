const config = require('../config');
const mockMeta = require('../data/mockMeta');
const cache = require('../lib/cache');
const period = require('../lib/period');
const mockMetaReport = require('../data/mockMetaReport');

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

// Miniaturas dos criativos (imagem/vídeo do anúncio). Vem de uma consulta à
// parte e é "melhor esforço": se a Meta recusar ou falhar, o relatório continua
// funcionando, só que sem as imagens.
async function fetchCreativeThumbs(accountId) {
  const cacheKey = `meta:thumbs:${accountId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const statuses = JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED']);
  const attempts = [
    'effective_status,creative.thumbnail_width(480).thumbnail_height(480){thumbnail_url,image_url}',
    'effective_status,creative{thumbnail_url,image_url}',
  ];
  let ads = null;
  for (const creativeField of attempts) {
    try {
      ads = await graphGetAll(`${accountId}/ads`, { fields: creativeField, limit: '100', effective_status: statuses }, 10);
      break;
    } catch (e) {
      console.warn('Meta: não consegui buscar miniaturas dos criativos:', e.message);
    }
  }
  const map = {};
  const statusMap = {};
  (ads || []).forEach((a) => {
    const c = a.creative || {};
    const url = c.image_url || c.thumbnail_url;
    if (a.id && url) map[a.id] = url;
    if (a.id && a.effective_status) statusMap[a.id] = a.effective_status;
  });
  // O mapa de status vai "pendurado" no de miniaturas pra não quebrar quem
  // já usa fetchCreativeThumbs só pelas imagens.
  Object.defineProperty(map, '__status', { value: statusMap, enumerable: false });
  cache.set(cacheKey, map, ads ? 60 * 30 : 120);
  return map;
}

function attachThumbs(campaigns, thumbs) {
  campaigns.forEach((c) => c.adsets.forEach((s) => s.ads.forEach((a) => {
    if (thumbs[a.id]) a.thumbnailUrl = thumbs[a.id];
  })));
  return campaigns;
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
    attachThumbs(result, await fetchCreativeThumbs(accountId));
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


/* ===================== Relatório completo da conta ===================== */

// Nome amigável do tipo de resultado (o que aparece embaixo do número).
const RESULT_LABELS = {
  purchase: 'Compras',
  omni_purchase: 'Compras',
  'offsite_conversion.fb_pixel_purchase': 'Compras',
  lead: 'Leads',
  'offsite_conversion.fb_pixel_lead': 'Leads no site',
  'onsite_conversion.lead_grouped': 'Leads (formulário)',
  'onsite_conversion.messaging_conversation_started_7d': 'Conversas iniciadas',
  omni_complete_registration: 'Cadastros',
};

function pickResult(actions) {
  if (!Array.isArray(actions)) return { type: null, value: 0 };
  for (const type of RESULT_ACTIONS) {
    const found = actions.find((a) => a.action_type === type);
    if (found) return { type, value: Math.round(num(found.value)) };
  }
  return { type: null, value: 0 };
}

function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find((a) => a.action_type === type);
  return found ? num(found.value) : 0;
}

function sumActions(list) {
  return Array.isArray(list) ? list.reduce((s, a) => s + num(a.value), 0) : 0;
}

// Métricas derivadas a partir dos números absolutos (nunca média de médias).
function derive(t) {
  return {
    ...t,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
    cpc: t.clicks > 0 ? t.spend / t.clicks : 0,
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0,
    frequency: t.reach > 0 ? t.impressions / t.reach : 0,
    costPerResult: t.results > 0 ? t.spend / t.results : 0,
  };
}

const AD_FIELDS = [
  'ad_id', 'ad_name', 'adset_name', 'campaign_name', 'campaign_id',
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks',
  'ctr', 'cpc', 'cpm', 'actions', 'video_p25_watched_actions',
].join(',');
const ACCOUNT_FIELDS = 'spend,impressions,reach,frequency,clicks,inline_link_clicks,actions';

function insightsParams(range, extra = {}) {
  return {
    time_range: JSON.stringify({ since: range.from, until: range.to }),
    limit: '500',
    ...extra,
  };
}

function mapAdRow(r) {
  const res = pickResult(r.actions);
  const spend = num(r.spend);
  const impressions = num(r.impressions);
  const clicks = num(r.clicks);
  return {
    id: r.ad_id,
    name: r.ad_name,
    adset: r.adset_name,
    campaign: r.campaign_name,
    campaignId: r.campaign_id,
    spend,
    impressions,
    reach: num(r.reach),
    frequency: num(r.frequency),
    clicks,
    linkClicks: num(r.inline_link_clicks),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    cpm: num(r.cpm),
    results: res.value,
    resultType: res.type,
    resultLabel: res.type ? RESULT_LABELS[res.type] : null,
    costPerResult: res.value > 0 ? spend / res.value : 0,
    engagement: Math.round(actionValue(r.actions, 'post_engagement')),
    video25: Math.round(sumActions(r.video_p25_watched_actions)),
  };
}

function totalsFrom(accountRow, adRows) {
  const a = accountRow || {};
  return derive({
    spend: num(a.spend),
    impressions: num(a.impressions),
    reach: num(a.reach),
    clicks: num(a.clicks),
    linkClicks: num(a.inline_link_clicks),
    // Resultados = soma do resultado de cada anúncio (cada um no seu tipo),
    // pra bater com a tabela de anúncios.
    results: adRows.reduce((s, r) => s + r.results, 0),
    engagement: Math.round(actionValue(a.actions, 'post_engagement')),
  });
}

// Rótulo do resultado da conta: se todos os anúncios usam o mesmo tipo,
// usa o nome dele (ex: "Conversas iniciadas"); se mistura, "Resultados".
function accountResultLabel(adRows) {
  const labels = new Set(adRows.filter((r) => r.results > 0).map((r) => r.resultLabel));
  return labels.size === 1 ? [...labels][0] : 'Resultados';
}

async function fetchRealReport(accountId, range) {
  const prev = period.previousRange(range);
  const [accCur, accPrev, adsCur, adsPrev, adsDaily, thumbs] = await Promise.all([
    graphGetAll(`${accountId}/insights`, insightsParams(range, { fields: ACCOUNT_FIELDS })),
    graphGetAll(`${accountId}/insights`, insightsParams(prev, { fields: ACCOUNT_FIELDS })),
    graphGetAll(`${accountId}/insights`, insightsParams(range, { level: 'ad', fields: AD_FIELDS }), 10),
    graphGetAll(`${accountId}/insights`, insightsParams(prev, { level: 'ad', fields: 'ad_id,spend,actions' }), 10),
    graphGetAll(`${accountId}/insights`, insightsParams(range, {
      level: 'ad', time_increment: '1', fields: 'ad_id,spend,impressions,clicks,actions',
    }), 20),
    fetchCreativeThumbs(accountId),
  ]);

  const ads = adsCur.map(mapAdRow).filter((a) => a.spend > 0);
  const statusMap = thumbs.__status || {};
  ads.forEach((a) => {
    if (thumbs[a.id]) a.thumbnailUrl = thumbs[a.id];
    if (statusMap[a.id]) a.status = statusMap[a.id];
  });
  ads.sort((x, y) => (y.results - x.results) || (y.spend - x.spend));

  const prevAds = adsPrev.map(mapAdRow);
  const totals = totalsFrom(accCur[0], ads);
  const previousTotals = totalsFrom(accPrev[0], prevAds);

  // Série diária: soma das linhas anúncio×dia (resultado de cada anúncio no
  // tipo dele), preenchendo com zero os dias sem veiculação.
  const byDay = {};
  period.eachDay(range).forEach((d) => { byDay[d] = { date: d, spend: 0, impressions: 0, clicks: 0, results: 0 }; });
  adsDaily.forEach((r) => {
    const d = byDay[r.date_start];
    if (!d) return;
    d.spend += num(r.spend);
    d.impressions += num(r.impressions);
    d.clicks += num(r.clicks);
    d.results += pickResult(r.actions).value;
  });
  const daily = Object.values(byDay).map((d) => ({
    ...d,
    ctr: d.impressions > 0 ? (d.clicks / d.impressions) * 100 : 0,
    cpc: d.clicks > 0 ? d.spend / d.clicks : 0,
    costPerResult: d.results > 0 ? d.spend / d.results : 0,
  }));

  // Campanhas (agregadas a partir dos anúncios do período).
  const campMap = {};
  ads.forEach((a) => {
    const c = campMap[a.campaignId] || (campMap[a.campaignId] = {
      id: a.campaignId, name: a.campaign, spend: 0, impressions: 0, clicks: 0, results: 0, reach: 0,
    });
    c.spend += a.spend; c.impressions += a.impressions; c.clicks += a.clicks; c.results += a.results;
  });
  const campaigns = Object.values(campMap).map((c) => derive(c)).sort((x, y) => y.spend - x.spend);

  return { range, previousRange: prev, resultLabel: accountResultLabel(ads), totals, previousTotals, daily, campaigns, ads };
}

function withDeltas(report) {
  const t = report.totals;
  const p = report.previousTotals;
  const keys = ['spend', 'impressions', 'reach', 'clicks', 'linkClicks', 'results', 'engagement', 'ctr', 'cpc', 'cpm', 'frequency', 'costPerResult'];
  const deltas = {};
  keys.forEach((k) => { deltas[k] = period.pctDelta(t[k] || 0, p[k] || 0); });
  return { ...report, deltas };
}

/**
 * Relatório completo de Meta Ads de uma conta num período (from/to):
 * totais + período anterior + variação, evolução diária, campanhas e
 * todos os anúncios com investimento (com miniatura do criativo).
 */
async function getAccountReport(adAccountId, options = {}) {
  const range = period.normalizeRange(options.from, options.to);
  const accountId = normalizeAdAccountId(adAccountId);
  const cacheKey = `meta:report:${accountId || 'mock'}:${range.from}:${range.to}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let result;
  if (!hasRealCredentials()) {
    result = withDeltas(mockMetaReport.build(range));
  } else {
    if (!accountId) throw new Error('Este cliente ainda não tem um ID de conta de anúncios da Meta.');
    result = withDeltas(await fetchRealReport(accountId, range));
  }
  cache.set(cacheKey, result, 60 * 20);
  return result;
}

/**
 * Descobre o Instagram Business vinculado a uma Página do Facebook.
 * Melhor esforço: devolve null se não houver ou se a Meta recusar.
 */
async function findInstagramForPage(pageId) {
  if (!hasRealCredentials() || !pageId) return null;
  try {
    const json = await graphGet(String(pageId).trim(), { fields: 'instagram_business_account{id,username}' });
    return json.instagram_business_account || null;
  } catch (e) {
    console.warn('Meta: não consegui achar o Instagram da Página:', e.message);
    return null;
  }
}

module.exports = {
  getCampaignsWithAds, getAccountReport, verifyAdAccount, findInstagramForPage,
  hasRealCredentials, normalizeAdAccountId, mapMetaResponse, graphGet, graphGetAll,
};

