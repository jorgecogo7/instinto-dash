const config = require('../config');
const mockGoogle = require('../data/mockGoogle');
const cache = require('../lib/cache');

const API_VERSION = 'v25'; // Google Ads API — atualizar quando o Google anunciar sunset desta versão

function hasRealCredentials() {
  return !!(
    config.google.clientId &&
    config.google.clientSecret &&
    config.google.refreshToken &&
    config.google.developerToken
  );
}

// Troca o Refresh Token por um Access Token novo. Eles valem por ~1h, então
// guardamos por 50 min (cache.js) em vez de pedir um novo em toda consulta —
// isso é o mesmo token pra qualquer cliente (é da MCC), então economiza uma
// chamada de rede inteira em cada carregamento de dashboard.
async function getAccessToken() {
  const cached = cache.get('google:accessToken');
  if (cached) return cached;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: config.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Não foi possível renovar o token do Google: ' + JSON.stringify(json));
  cache.set('google:accessToken', json.access_token, 50 * 60);
  return json.access_token;
}

// Roda uma consulta GAQL (a linguagem de busca da Google Ads API) numa conta de cliente.
// `label` só serve pra identificar, nas mensagens de erro, qual das várias consultas falhou.
async function runGAQL(customerId, query, accessToken, label) {
  const cleanId = customerId.replace(/-/g, '');
  const cleanLoginId = config.google.loginCustomerId.replace(/-/g, '');

  const res = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cleanId}/googleAds:search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': config.google.developerToken,
      'login-customer-id': cleanLoginId,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.error) {
    // O corpo padrão só traz uma mensagem genérica ("Request contains an
    // invalid argument"); o motivo específico vem em error.details, num
    // formato aninhado (GoogleAdsFailure). Extraímos aqui pra facilitar o diagnóstico.
    let detail = '';
    try {
      const failures = (json.error.details || [])
        .flatMap((d) => d.errors || [])
        .map((e) => `${e.errorCode ? JSON.stringify(e.errorCode) : ''} ${e.message || ''}`.trim());
      if (failures.length) detail = ' — ' + failures.join(' | ');
    } catch (_) { /* ignore */ }
    const prefix = label ? `[${label}] ` : '';
    throw new Error(`Google Ads API: ${prefix}${json.error.message}${detail}`);
  }
  return json.results || [];
}

/* ---------- Datas: período pedido + período anterior equivalente ---------- */

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Sem período informado, mantém o comportamento de antes: últimos 30 dias.
function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: toISODate(from), to: toISODate(to) };
}

function normalizeRange(from, to) {
  const validFrom = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : null;
  const validTo = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : null;
  if (!validFrom || !validTo || validFrom > validTo) return defaultRange();
  return { from: validFrom, to: validTo };
}

// Período imediatamente anterior, com a mesma quantidade de dias — usado
// pra calcular a variação percentual ("vs período anterior").
function previousRange({ from, to }) {
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  const days = Math.round((toD - fromD) / 86400000) + 1;
  const prevTo = new Date(fromD);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  return { from: toISODate(prevFrom), to: toISODate(prevTo) };
}

function pctDelta(curr, prev) {
  if (!prev) return curr > 0 ? 100 : null;
  return ((curr - prev) / prev) * 100;
}

// Normaliza um valor de metrics.* pra número seguro (a API às vezes omite
// o campo quando o valor é zero, o que virava NaN e quebrava o front).
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const DEVICE_LABELS = {
  MOBILE: 'Celular',
  DESKTOP: 'Computador',
  TABLET: 'Tablet',
  CONNECTED_TV: 'TV conectada',
  OTHER: 'Outro',
  UNSPECIFIED: 'Não especificado',
  UNKNOWN: 'Desconhecido',
};

const GENDER_LABELS = {
  MALE: 'Masculino',
  FEMALE: 'Feminino',
  UNDETERMINED: 'Não determinado',
  UNSPECIFIED: 'Não especificado',
  UNKNOWN: 'Desconhecido',
};

const AGE_RANGE_LABELS = {
  AGE_RANGE_18_24: '18–24',
  AGE_RANGE_25_34: '25–34',
  AGE_RANGE_35_44: '35–44',
  AGE_RANGE_45_54: '45–54',
  AGE_RANGE_55_64: '55–64',
  AGE_RANGE_65_UP: '65+',
  AGE_RANGE_UNDETERMINED: 'Não determinado',
  UNSPECIFIED: 'Não especificado',
  UNKNOWN: 'Desconhecido',
};

// Calcula, a partir dos totais brutos de um período (dia, campanha, etc.),
// o mesmo conjunto de métricas derivadas usado no resumo geral — assim
// cada dia do gráfico tem os mesmos campos que os cards de KPI, e qualquer
// métrica (inclusive uma personalizada) pode ser plotada.
function deriveMetrics(raw) {
  const spend = raw.spend || 0;
  const clicks = raw.clicks || 0;
  const impressions = raw.impressions || 0;
  const conversions = raw.conversions || 0;
  const allConversions = raw.allConversions || 0;
  const topImpressionShare = impressions > 0 ? (raw.topImprWeighted || 0) / impressions : 0;
  return {
    spend, clicks, impressions, conversions, allConversions, topImpressionShare,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    convRate: clicks > 0 ? (conversions / clicks) * 100 : 0,
    costPerConv: conversions > 0 ? spend / conversions : 0,
  };
}

async function fetchRealReport(customerId, range) {
  const accessToken = await getAccessToken();
  const prev = previousRange(range);
  const dateFilter = (r) => `segments.date BETWEEN '${r.from}' AND '${r.to}'`;

  const [campaignRows, prevCampaignRows, keywordRows, deviceRows, dailyRows, genderRows, ageRangeRows] = await Promise.all([
    runGAQL(customerId, `
      SELECT campaign.name, campaign.advertising_channel_type,
             metrics.cost_micros, metrics.clicks, metrics.ctr, metrics.impressions,
             metrics.average_cpc, metrics.conversions, metrics.all_conversions,
             metrics.absolute_top_impression_percentage
      FROM campaign
      WHERE ${dateFilter(range)} AND campaign.status = 'ENABLED'
    `, accessToken, 'campanhas'),

    runGAQL(customerId, `
      SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.impressions,
             metrics.all_conversions, metrics.absolute_top_impression_percentage
      FROM campaign
      WHERE ${dateFilter(prev)} AND campaign.status = 'ENABLED'
    `, accessToken, 'campanhas (período anterior)'),

    runGAQL(customerId, `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,
             metrics.impressions, metrics.clicks, metrics.ctr,
             metrics.average_cpc, metrics.conversions, metrics.cost_micros
      FROM keyword_view
      WHERE ${dateFilter(range)}
      ORDER BY metrics.clicks DESC
      LIMIT 10
    `, accessToken, 'palavras-chave'),

    runGAQL(customerId, `
      SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE ${dateFilter(range)}
    `, accessToken, 'dispositivo'),

    runGAQL(customerId, `
      SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions,
             metrics.conversions, metrics.all_conversions, metrics.absolute_top_impression_percentage
      FROM campaign
      WHERE ${dateFilter(range)}
    `, accessToken, 'investimento diário'),

    runGAQL(customerId, `
      SELECT ad_group_criterion.gender.type,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM gender_view
      WHERE ${dateFilter(range)}
    `, accessToken, 'gênero'),

    runGAQL(customerId, `
      SELECT ad_group_criterion.age_range.type,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM age_range_view
      WHERE ${dateFilter(range)}
    `, accessToken, 'faixa etária'),
  ]);

  const campaigns = campaignRows.map((r) => {
    const spend = num(r.metrics.costMicros) / 1_000_000;
    const conv = num(r.metrics.conversions);
    return {
      id: r.campaign.id,
      name: r.campaign.name,
      type: r.campaign.advertisingChannelType,
      spend,
      impressions: num(r.metrics.impressions),
      clicks: num(r.metrics.clicks),
      ctr: num(r.metrics.ctr) * 100,
      cpc: num(r.metrics.averageCpc) / 1_000_000,
      conv,
      costPerConv: conv > 0 ? spend / conv : 0,
      allConversions: num(r.metrics.allConversions),
      topImpressionShare: num(r.metrics.absoluteTopImpressionPercentage) * 100,
    };
  });

  const keywords = keywordRows.map((r) => {
    const spend = num(r.metrics.costMicros) / 1_000_000;
    const conversions = num(r.metrics.conversions);
    return {
      keyword: r.adGroupCriterion.keyword.text,
      matchType: r.adGroupCriterion.keyword.matchType,
      qualityScore: r.adGroupCriterion.qualityInfo?.qualityScore ?? null,
      impressions: num(r.metrics.impressions),
      clicks: num(r.metrics.clicks),
      ctr: num(r.metrics.ctr) * 100,
      cpc: num(r.metrics.averageCpc) / 1_000_000,
      conversions,
      spend,
      costPerConv: conversions > 0 ? spend / conversions : 0,
    };
  });

  // Agrega por dispositivo (a API devolve uma linha por campanha x dispositivo).
  const deviceMap = new Map();
  for (const r of deviceRows) {
    const key = r.segments.device;
    const entry = deviceMap.get(key) || { device: key, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
    entry.impressions += num(r.metrics.impressions);
    entry.clicks += num(r.metrics.clicks);
    entry.spend += num(r.metrics.costMicros) / 1_000_000;
    entry.conversions += num(r.metrics.conversions);
    deviceMap.set(key, entry);
  }
  const deviceBreakdown = [...deviceMap.values()]
    .map((d) => ({ ...d, label: DEVICE_LABELS[d.device] || d.device }))
    .sort((a, b) => b.spend - a.spend);

  // Agrega por dia (a API devolve uma linha por campanha x dia). Guardamos os
  // mesmos campos brutos dos totais gerais pra poder derivar QUALQUER métrica
  // (inclusive uma personalizada) dia a dia — é o que alimenta o gráfico
  // quando o usuário clica pra plotar uma métrica além de investimento/cliques.
  const dailyMap = new Map();
  for (const r of dailyRows) {
    const day = r.segments.date;
    const impressions = num(r.metrics.impressions);
    const entry = dailyMap.get(day) || { spend: 0, clicks: 0, impressions: 0, conversions: 0, allConversions: 0, topImprWeighted: 0 };
    entry.spend += num(r.metrics.costMicros) / 1_000_000;
    entry.clicks += num(r.metrics.clicks);
    entry.impressions += impressions;
    entry.conversions += num(r.metrics.conversions);
    entry.allConversions += num(r.metrics.allConversions);
    entry.topImprWeighted += num(r.metrics.absoluteTopImpressionPercentage) * 100 * impressions;
    dailyMap.set(day, entry);
  }
  const dailySpend = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, ...deriveMetrics(v) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Agrega por gênero e faixa etária (Google Ads só libera esse detalhamento
  // no nível de ad group / conta via gender_view e age_range_view).
  const aggregateBy = (rows, keyFn) => {
    const map = new Map();
    for (const r of rows) {
      const key = keyFn(r);
      const entry = map.get(key) || { key, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
      entry.impressions += num(r.metrics.impressions);
      entry.clicks += num(r.metrics.clicks);
      entry.spend += num(r.metrics.costMicros) / 1_000_000;
      entry.conversions += num(r.metrics.conversions);
      map.set(key, entry);
    }
    return [...map.values()];
  };
  const genderBreakdown = aggregateBy(genderRows, (r) => r.adGroupCriterion.gender.type)
    .map((d) => ({ ...d, label: GENDER_LABELS[d.key] || d.key }))
    .sort((a, b) => b.spend - a.spend);
  const ageBreakdown = aggregateBy(ageRangeRows, (r) => r.adGroupCriterion.ageRange.type)
    .map((d) => ({ ...d, label: AGE_RANGE_LABELS[d.key] || d.key }))
    .sort((a, b) => b.spend - a.spend);

  const totals = campaigns.reduce(
    (acc, c) => ({
      spend: acc.spend + c.spend,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conv,
      impressions: acc.impressions + c.impressions,
      allConversions: acc.allConversions + c.allConversions,
      topImprWeighted: acc.topImprWeighted + c.topImpressionShare * c.impressions,
    }),
    { spend: 0, clicks: 0, conversions: 0, impressions: 0, allConversions: 0, topImprWeighted: 0 }
  );
  // Métricas derivadas — sempre calculadas a partir dos totais (nunca média
  // de médias por campanha, que distorce quando as campanhas têm volumes bem diferentes).
  totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  totals.convRate = totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0;
  totals.costPerConv = totals.conversions > 0 ? totals.spend / totals.conversions : 0;
  // Média ponderada por impressões (não é uma média simples das campanhas,
  // senão uma campanha pequena pesaria igual a uma grande).
  totals.topImpressionShare = totals.impressions > 0 ? totals.topImprWeighted / totals.impressions : 0;
  delete totals.topImprWeighted;

  const previousTotals = prevCampaignRows.reduce(
    (acc, r) => {
      const impressions = num(r.metrics.impressions);
      return {
        spend: acc.spend + num(r.metrics.costMicros) / 1_000_000,
        clicks: acc.clicks + num(r.metrics.clicks),
        conversions: acc.conversions + num(r.metrics.conversions),
        impressions: acc.impressions + impressions,
        allConversions: acc.allConversions + num(r.metrics.allConversions),
        topImprWeighted: acc.topImprWeighted + num(r.metrics.absoluteTopImpressionPercentage) * 100 * impressions,
      };
    },
    { spend: 0, clicks: 0, conversions: 0, impressions: 0, allConversions: 0, topImprWeighted: 0 }
  );
  previousTotals.ctr = previousTotals.impressions > 0 ? (previousTotals.clicks / previousTotals.impressions) * 100 : 0;
  previousTotals.cpc = previousTotals.clicks > 0 ? previousTotals.spend / previousTotals.clicks : 0;
  previousTotals.cpm = previousTotals.impressions > 0 ? (previousTotals.spend / previousTotals.impressions) * 1000 : 0;
  previousTotals.convRate = previousTotals.clicks > 0 ? (previousTotals.conversions / previousTotals.clicks) * 100 : 0;
  previousTotals.costPerConv = previousTotals.conversions > 0 ? previousTotals.spend / previousTotals.conversions : 0;
  previousTotals.topImpressionShare = previousTotals.impressions > 0 ? previousTotals.topImprWeighted / previousTotals.impressions : 0;
  delete previousTotals.topImprWeighted;

  const deltas = {
    spend: pctDelta(totals.spend, previousTotals.spend),
    clicks: pctDelta(totals.clicks, previousTotals.clicks),
    conversions: pctDelta(totals.conversions, previousTotals.conversions),
    impressions: pctDelta(totals.impressions, previousTotals.impressions),
    ctr: pctDelta(totals.ctr, previousTotals.ctr),
    cpc: pctDelta(totals.cpc, previousTotals.cpc),
    cpm: pctDelta(totals.cpm, previousTotals.cpm),
    convRate: pctDelta(totals.convRate, previousTotals.convRate),
    costPerConv: pctDelta(totals.costPerConv, previousTotals.costPerConv),
    allConversions: pctDelta(totals.allConversions, previousTotals.allConversions),
    topImpressionShare: pctDelta(totals.topImpressionShare, previousTotals.topImpressionShare),
  };

  return {
    range, previousRange: prev,
    campaigns, keywords, deviceBreakdown, dailySpend, genderBreakdown, ageBreakdown,
    totals, previousTotals, deltas,
  };
}

/**
 * Campanhas, palavras-chave, termos de pesquisa, dispositivo e evolução
 * diária para uma conta de cliente (customerId, formato XXX-XXX-XXXX)
 * vinculada à sua MCC, num período (from/to, formato YYYY-MM-DD). Sem
 * período informado, usa os últimos 30 dias — mesmo comportamento de antes.
 */
// 20 min: dado de performance de anúncio não precisa ser em tempo real pra
// esse painel, e cada carregamento "frio" custa vários segundos (token +
// 5 consultas à API do Google Ads). Combinado com a sincronização automática
// em background (ver server.js), a maioria dos acessos já encontra o cache quente.
const REPORT_CACHE_TTL_SECONDS = 60 * 20;

async function getAccountReport(customerId, options = {}) {
  const range = normalizeRange(options.from, options.to);
  const cacheKey = `google:report:${customerId}:${range.from}:${range.to}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = hasRealCredentials() ? await fetchRealReport(customerId, range) : mockGoogle;

  cache.set(cacheKey, result, REPORT_CACHE_TTL_SECONDS);
  return result;
}

/**
 * Confirma que o customerId informado (ID do cliente já vinculado à sua
 * MCC) realmente responde pela API do Google Ads, antes de marcar a
 * conta como conectada. Usado pelo botão "Conectar Google Ads".
 *
 * Lança erro com a mensagem que veio da API do Google (ex: conta ainda
 * não vinculada à MCC, developer token sem acesso a essa conta, etc.),
 * pra rota devolver algo útil em vez de "não deu certo".
 */
async function verifyCustomerAccess(customerId) {
  if (!hasRealCredentials()) {
    throw new Error(
      'Credenciais reais do Google Ads ainda não configuradas (GOOGLE_CLIENT_ID/SECRET, ' +
      'GOOGLE_REFRESH_TOKEN e GOOGLE_DEVELOPER_TOKEN precisam estar preenchidos nas variáveis de ambiente).'
    );
  }

  const accessToken = await getAccessToken();
  const rows = await runGAQL(customerId, `SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1`, accessToken, 'verificação da conta');

  if (!rows.length) throw new Error('A conta respondeu, mas sem dados de cliente — verifique o ID informado.');

  return {
    id: rows[0].customer.id,
    name: rows[0].customer.descriptiveName || null,
  };
}

module.exports = { getAccountReport, verifyCustomerAccess };
