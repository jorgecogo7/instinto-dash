const config = require('../config');
const mockInstagram = require('../data/mockInstagram');
const cache = require('../lib/cache');

const GRAPH_BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;

// 20 min — mesmo raciocínio do cache do relatório do Google/Meta Ads:
// dado orgânico do Instagram não muda a cada segundo, e cada carregamento
// "frio" bateria várias vezes na Graph API.
const REPORT_CACHE_TTL_SECONDS = 60 * 20;

function hasRealCredentials() {
  return Boolean(config.meta.systemUserToken);
}

/**
 * Alcance, seguidores, visitas ao perfil e cliques no link de uma conta
 * Instagram Business/Creator vinculada à Página do cliente no Meta.
 *
 * Hoje (sem token do Meta configurado, ou USE_MOCK_DATA=true): devolve os
 * dados de exemplo, já no formato certo pra tela funcionar de ponta a
 * ponta. Quando o App do Meta for Developers estiver liberado, troque o
 * bloco `if` abaixo pela chamada real — o formato de retorno já está
 * pronto pra isso, então a tela não precisa mudar.
 */
async function getOrganicReport(igUserId) {
  const cacheKey = `instagram:report:${igUserId || 'mock'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let result;

  if (config.useMockData || !hasRealCredentials() || !igUserId) {
    result = mockInstagram;
  } else {
    // Exemplo de como ficaria a chamada real (comentado até haver token):
    //
    // const fields = 'followers_count,media_count,username,biography,name';
    // const profileUrl = `${GRAPH_BASE}/${igUserId}?fields=${fields}&access_token=${config.meta.systemUserToken}`;
    // const insightsUrl = `${GRAPH_BASE}/${igUserId}/insights` +
    //   `?metric=reach,profile_views,website_clicks,follower_count` +
    //   `&period=day&since=...&until=...&access_token=${config.meta.systemUserToken}`;
    // const [profileRes, insightsRes] = await Promise.all([fetch(profileUrl), fetch(insightsUrl)]);
    // result = mapInstagramResponse(await profileRes.json(), await insightsRes.json());

    throw new Error('Integração real do Instagram ainda não configurada.');
  }

  cache.set(cacheKey, result, REPORT_CACHE_TTL_SECONDS);
  return result;
}

module.exports = { getOrganicReport };
