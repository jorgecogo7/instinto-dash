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

// Troca o Refresh Token por um Access Token novo (eles expiram em ~1h, então
// pedimos um novo a cada chamada em vez de guardar um que pode ter vencido).
async function getAccessToken() {
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
  return json.access_token;
}

// Roda uma consulta GAQL (a linguagem de busca da Google Ads API) numa conta de cliente.
async function runGAQL(customerId, query, accessToken) {
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
  if (json.error) throw new Error(`Google Ads API: ${json.error.message}`);
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

const DEVICE_LABELS = {
  MOBILE: 'Celular',
  DESKTOP: 'Computador',
  TABLET: 'Tablet',
  CONNECTED_TV: 'TV conectada',
  OTHER: 'Outro',
  UNSPECIFIED: 'Não especificado',
  UNKNOWN: 'Desconhecido',
};

async function fetchRealReport(customerId, range) {
  const accessToken = await getAccessToken();
  const prev = previousRange(range);
  const dateFilter = (r) => `segments.date BETWEEN '${r.from}' AND '${r.to}'`;

  const [campaignRows, prevCampaignRows, keywordRows, searchTermRows, deviceRows, dailyRows] = await Promise.all([
    runGAQL(customerId, `
      SELECT campaign.name, campaign.advertising_channel_type,
             metrics.cost_micros, metrics.clicks, metrics.ctr,
             metrics.average_cpc, metrics.conversions
      FROM campaign
      WHERE ${dateFilter(range)} AND campaign.status = 'ENABLED'
    `, accessToken),

    runGAQL(customerId, `
      SELECT metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM campaign
      WHERE ${dateFilter(prev)} AND campaign.status = 'ENABLED'
    `, accessToken),

    runGAQL(customerId, `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,
             metrics.impressions, metrics.clicks, metrics.ctr,
             metrics.average_cpc, metrics.conversions
      FROM keyword_view
      WHERE ${dateFilter(range)}
      ORDER BY metrics.cost_micros DESC
      LIMIT 20
    `, accessToken),

    runGAQL(customerId, `
      SELECT search_term_view.search_term,
             metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM search_term_view
      WHERE ${dateFilter(range)}
      ORDER BY metrics.clicks DESC
      LIMIT 15
    `, accessToken),

    runGAQL(customerId, `
      SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE ${dateFilter(range)}
    `, accessToken),

    runGAQL(customerId, `
      SELECT segments.date, metrics.cost_micros
      FROM campaign
      WHERE ${dateFilter(range)}
    `, accessToken),
  ]);

  const campaigns = campaignRows.map((r) => ({
    id: r.campaign.id,
    name: r.campaign.name,
    type: r.campaign.advertisingChannelType,
    spend: Number(r.metrics.costMicros) / 1_000_000,
    clicks: Number(r.metrics.clicks),
    ctr: Number(r.metrics.ctr) * 100,
    cpc: Number(r.metrics.averageCpc) / 1_000_000,
    conv: Number(r.metrics.conversions),
  }));

  const keywords = keywordRows.map((r) => ({
    keyword: r.adGroupCriterion.keyword.text,
    matchType: r.adGroupCriterion.keyword.matchType,
    qualityScore: r.adGroupCriterion.qualityInfo?.qualityScore ?? null,
    impressions: Number(r.metrics.impressions),
    clicks: Number(r.metrics.clicks),
    ctr: Number(r.metrics.ctr) * 100,
    cpc: Number(r.metrics.averageCpc) / 1_000_000,
    conversions: Number(r.metrics.conversions),
  }));

  // "Termos de pesquisa" — o que as pessoas de fato digitaram no Google
  // antes de clicar no anúncio. Dado 100% real (a Auction Insights não é
  // liberada pela API pra contas normais — ver nota no serviço).
  const searchTerms = searchTermRows.map((r) => ({
    term: r.searchTermView.searchTerm,
    impressions: Number(r.metrics.impressions),
    clicks: Number(r.metrics.clicks),
    conversions: Number(r.metrics.conversions),
    spend: Number(r.metrics.costMicros) / 1_000_000,
  })).sort((a, b) => b.clicks - a.clicks);

  // Agrega por dispositivo (a API devolve uma linha por campanha x dispositivo).
  const deviceMap = new Map();
  for (const r of deviceRows) {
    const key = r.segments.device;
    const entry = deviceMap.get(key) || { device: key, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
    entry.impressions += Number(r.metrics.impressions);
    entry.clicks += Number(r.metrics.clicks);
    entry.spend += Number(r.metrics.costMicros) / 1_000_000;
    entry.conversions += Number(r.metrics.conversions);
    deviceMap.set(key, entry);
  }
  const deviceBreakdown = [...deviceMap.values()]
    .map((d) => ({ ...d, label: DEVICE_LABELS[d.device] || d.device }))
    .sort((a, b) => b.spend - a.spend);

  // Agrega investimento por dia (a API devolve uma linha por campanha x dia).
  const dailyMap = new Map();
  for (const r of dailyRows) {
    const day = r.segments.date;
    dailyMap.set(day, (dailyMap.get(day) || 0) + Number(r.metrics.costMicros) / 1_000_000);
  }
  const dailySpend = [...dailyMap.entries()]
    .map(([date, spend]) => ({ date, spend }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = campaigns.reduce(
    (acc, c) => ({
      spend: acc.spend + c.spend,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conv,
    }),
    { spend: 0, clicks: 0, conversions: 0 }
  );
  totals.ctr = totals.clicks > 0 && campaigns.length
    ? (campaigns.reduce((s, c) => s + c.ctr, 0) / campaigns.length)
    : 0;
  totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;

  const previousTotals = prevCampaignRows.reduce(
    (acc, r) => ({
      spend: acc.spend + Number(r.metrics.costMicros) / 1_000_000,
      clicks: acc.clicks + Number(r.metrics.clicks),
      conversions: acc.conversions + Number(r.metrics.conversions),
    }),
    { spend: 0, clicks: 0, conversions: 0 }
  );

  const deltas = {
    spend: pctDelta(totals.spend, previousTotals.spend),
    clicks: pctDelta(totals.clicks, previousTotals.clicks),
    conversions: pctDelta(totals.conversions, previousTotals.conversions),
    cpc: pctDelta(totals.cpc, previousTotals.clicks > 0 ? previousTotals.spend / previousTotals.clicks : 0),
  };

  return {
    range, previousRange: prev,
    campaigns, keywords, searchTerms, deviceBreakdown, dailySpend,
    totals, previousTotals, deltas,
  };
}

/**
 * Campanhas, palavras-chave, termos de pesquisa, dispositivo e evolução
 * diária para uma conta de cliente (customerId, formato XXX-XXX-XXXX)
 * vinculada à sua MCC, num período (from/to, formato YYYY-MM-DD). Sem
 * período informado, usa os últimos 30 dias — mesmo comportamento de antes.
 */
async function getAccountReport(customerId, options = {}) {
  const range = normalizeRange(options.from, options.to);
  const cacheKey = `google:report:${customerId}:${range.from}:${range.to}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = hasRealCredentials() ? await fetchRealReport(customerId, range) : mockGoogle;

  cache.set(cacheKey, result, 60 * 5);
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
  const rows = await runGAQL(customerId, `SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1`, accessToken);

  if (!rows.length) throw new Error('A conta respondeu, mas sem dados de cliente — verifique o ID informado.');

  return {
    id: rows[0].customer.id,
    name: rows[0].customer.descriptiveName || null,
  };
}

module.exports = { getAccountReport, verifyCustomerAccess };
