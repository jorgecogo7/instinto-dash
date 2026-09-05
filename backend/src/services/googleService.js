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

async function fetchRealReport(customerId) {
  const accessToken = await getAccessToken();

  const campaignRows = await runGAQL(customerId, `
    SELECT campaign.name, campaign.advertising_channel_type,
           metrics.cost_micros, metrics.clicks, metrics.ctr,
           metrics.average_cpc, metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'
  `, accessToken);

  const keywordRows = await runGAQL(customerId, `
    SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
           ad_group_criterion.quality_info.quality_score,
           metrics.impressions, metrics.clicks, metrics.ctr,
           metrics.average_cpc, metrics.conversions
    FROM keyword_view
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.cost_micros DESC
    LIMIT 20
  `, accessToken);

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

  // Auction Insights ainda não está implementado com dados reais — é um
  // relatório mais avançado da API. Por enquanto mantemos o exemplo aqui,
  // deixando campanhas e palavras-chave (o que já ativamos) 100% reais.
  return { campaigns, keywords, auctionInsights: mockGoogle.auctionInsights };
}

/**
 * Campanhas, palavras-chave e auction insights para uma conta de
 * cliente (customerId, formato XXX-XXX-XXXX) vinculada à sua MCC.
 */
async function getAccountReport(customerId) {
  const cacheKey = `google:report:${customerId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = hasRealCredentials() ? await fetchRealReport(customerId) : mockGoogle;

  cache.set(cacheKey, result, 60 * 5);
  return result;
}

module.exports = { getAccountReport };
