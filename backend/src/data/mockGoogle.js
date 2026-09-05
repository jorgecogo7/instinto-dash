// Formato pensado para espelhar o retorno da Google Ads API (GAQL):
// campaigns, ad_group_criterion (palavras-chave) e o relatório
// de auction_insight, agregados aqui num único objeto por conta.

module.exports = {
  campaigns: [
    { id: '111', name: 'Pesquisa · Marca', type: 'SEARCH', spend: 2180, clicks: 1240, ctr: 6.8, cpc: 1.76, conversions: 98 },
    { id: '112', name: 'Pesquisa · Genérica concorrência', type: 'SEARCH', spend: 1860, clicks: 640, ctr: 2.4, cpc: 2.91, conversions: 31 },
    { id: '113', name: 'Display · Remarketing', type: 'DISPLAY', spend: 940, clicks: 2100, ctr: 0.9, cpc: 0.45, conversions: 19 },
    { id: '114', name: 'Performance Max · Catálogo', type: 'PERFORMANCE_MAX', spend: 2200, clicks: 1580, ctr: 3.2, cpc: 1.39, conversions: 8 },
  ],

  keywords: [
    { keyword: 'clínica odontológica perto de mim', matchType: 'PHRASE', qualityScore: 9, impressions: 12400, clicks: 840, ctr: 6.8, cpc: 1.52, conversions: 61 },
    { keyword: 'implante dentário preço', matchType: 'BROAD', qualityScore: 7, impressions: 8900, clicks: 410, ctr: 4.6, cpc: 2.10, conversions: 22 },
    { keyword: '[marca] odonto', matchType: 'EXACT', qualityScore: 10, impressions: 3100, clicks: 390, ctr: 12.6, cpc: 0.88, conversions: 34 },
    { keyword: 'ortodontista', matchType: 'BROAD', qualityScore: 5, impressions: 21000, clicks: 520, ctr: 2.5, cpc: 2.64, conversions: 9 },
  ],

  // Google Ads chama isso de "Auction Insights" — só existe agregado
  // (não por conta específica de cada concorrente identificado).
  auctionInsights: [
    { domain: 'concorrente-a.com.br', impressionShare: 68, overlapRate: 41, positionAboveRate: 22, topOfPageRate: 74 },
    { domain: 'concorrente-b.com.br', impressionShare: 54, overlapRate: 33, positionAboveRate: 38, topOfPageRate: 59 },
    { domain: 'concorrente-c.com.br', impressionShare: 29, overlapRate: 18, positionAboveRate: 15, topOfPageRate: 31 },
    { domain: 'sua_conta', impressionShare: 61, overlapRate: null, positionAboveRate: null, topOfPageRate: 66 },
  ],
};
