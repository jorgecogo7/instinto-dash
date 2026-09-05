const config = require('../config');
const mockMeta = require('../data/mockMeta');
const cache = require('../lib/cache');

const GRAPH_BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;

/**
 * Retorna campanhas > conjuntos de anúncios > anúncios com insights,
 * para uma conta de anúncios (act_...) específica de um cliente.
 *
 * Hoje (USE_MOCK_DATA=true): devolve os dados de exemplo.
 * Quando as credenciais existirem, troque o bloco `if` abaixo pela
 * chamada real — a estrutura de retorno já está pronta para isso.
 */
async function getCampaignsWithAds(adAccountId) {
  const cacheKey = `meta:campaigns:${adAccountId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let result;

  if (config.useMockData || !config.meta.systemUserToken) {
    result = mockMeta.campaigns;
  } else {
    // Exemplo de como ficaria a chamada real (comentado até haver token):
    //
    // const fields = 'name,objective,status,insights{spend,ctr,cpc,actions},' +
    //   'adsets{name,ads{name,insights{spend,ctr,cpc,actions}}}';
    // const url = `${GRAPH_BASE}/${adAccountId}/campaigns?fields=${fields}` +
    //   `&access_token=${config.meta.systemUserToken}`;
    // const res = await fetch(url);
    // const json = await res.json();
    // result = mapMetaResponse(json); // normaliza pro formato usado no frontend

    throw new Error('Integração real do Meta Ads ainda não configurada.');
  }

  cache.set(cacheKey, result, 60 * 5); // 5 min — evita bater na API a cada refresh de tela
  return result;
}

module.exports = { getCampaignsWithAds };
