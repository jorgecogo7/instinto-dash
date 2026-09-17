// Formato pensado para espelhar o retorno da Google Ads API (GAQL):
// campaigns, ad_group_criterion (palavras-chave), search_term_view
// (termos de pesquisa) e segments.device (dispositivo), agregados aqui
// num único objeto por conta — usado só quando USE_MOCK_DATA=true ou
// antes das credenciais reais estarem configuradas.

const campaigns = [
  { id: '111', name: 'Pesquisa · Marca', type: 'SEARCH', spend: 2180, impressions: 32000, clicks: 1240, ctr: 6.8, cpc: 1.76, conversions: 98, costPerConv: 2180 / 98 },
  { id: '112', name: 'Pesquisa · Genérica concorrência', type: 'SEARCH', spend: 1860, impressions: 26700, clicks: 640, ctr: 2.4, cpc: 2.91, conversions: 31, costPerConv: 1860 / 31 },
  { id: '113', name: 'Display · Remarketing', type: 'DISPLAY', spend: 940, impressions: 233000, clicks: 2100, ctr: 0.9, cpc: 0.45, conversions: 19, costPerConv: 940 / 19 },
  { id: '114', name: 'Performance Max · Catálogo', type: 'PERFORMANCE_MAX', spend: 2200, impressions: 49400, clicks: 1580, ctr: 3.2, cpc: 1.39, conversions: 8, costPerConv: 2200 / 8 },
];

const keywords = [
  { keyword: 'clínica odontológica perto de mim', matchType: 'PHRASE', qualityScore: 9, impressions: 12400, clicks: 840, ctr: 6.8, cpc: 1.52, conversions: 61, spend: 1277, costPerConv: 1277 / 61 },
  { keyword: 'implante dentário preço', matchType: 'BROAD', qualityScore: 7, impressions: 8900, clicks: 410, ctr: 4.6, cpc: 2.10, conversions: 22, spend: 861, costPerConv: 861 / 22 },
  { keyword: '[marca] odonto', matchType: 'EXACT', qualityScore: 10, impressions: 3100, clicks: 390, ctr: 12.6, cpc: 0.88, conversions: 34, spend: 343, costPerConv: 343 / 34 },
  { keyword: 'ortodontista', matchType: 'BROAD', qualityScore: 5, impressions: 21000, clicks: 520, ctr: 2.5, cpc: 2.64, conversions: 9, spend: 1373, costPerConv: 1373 / 9 },
];

// "Auction Insights" foi trocado por termos de pesquisa e dispositivo —
// são dados que a API do Google Ads realmente libera pra qualquer conta
// (leilão é bloqueado pelo Google numa lista de espera fechada).
const searchTerms = [
  { term: 'clinica odontologica perto de mim', impressions: 3200, clicks: 410, conversions: 38, spend: 690 },
  { term: 'valor implante dentario', impressions: 2100, clicks: 260, conversions: 15, spend: 480 },
  { term: 'clareamento a laser preço', impressions: 1400, clicks: 150, conversions: 9, spend: 260 },
  { term: 'ortodontista particular', impressions: 4800, clicks: 190, conversions: 4, spend: 410 },
  { term: 'melhor dentista da cidade', impressions: 900, clicks: 120, conversions: 11, spend: 190 },
];

const deviceBreakdown = [
  { device: 'MOBILE', label: 'Celular', impressions: 28400, clicks: 2960, spend: 4380, conversions: 112 },
  { device: 'DESKTOP', label: 'Computador', impressions: 9100, clicks: 480, spend: 1560, conversions: 34 },
  { device: 'TABLET', label: 'Tablet', impressions: 1200, clicks: 40, spend: 240, conversions: 2 },
];

const dailySpend = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
  spend: Math.round(150 + Math.random() * 140),
  clicks: Math.round(30 + Math.random() * 40),
}));

const totals = campaigns.reduce(
  (acc, c) => ({
    spend: acc.spend + c.spend,
    clicks: acc.clicks + c.clicks,
    conversions: acc.conversions + c.conversions,
    impressions: acc.impressions + c.impressions,
  }),
  { spend: 0, clicks: 0, conversions: 0, impressions: 0 }
);
totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
totals.convRate = totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0;
totals.costPerConv = totals.conversions > 0 ? totals.spend / totals.conversions : 0;

const previousTotals = {
  spend: totals.spend * 0.91,
  clicks: Math.round(totals.clicks * 0.94),
  conversions: Math.round(totals.conversions * 0.87),
  impressions: Math.round(totals.impressions * 0.95),
};
previousTotals.ctr = previousTotals.impressions > 0 ? (previousTotals.clicks / previousTotals.impressions) * 100 : 0;
previousTotals.cpc = previousTotals.clicks > 0 ? previousTotals.spend / previousTotals.clicks : 0;
previousTotals.cpm = previousTotals.impressions > 0 ? (previousTotals.spend / previousTotals.impressions) * 1000 : 0;
previousTotals.convRate = previousTotals.clicks > 0 ? (previousTotals.conversions / previousTotals.clicks) * 100 : 0;
previousTotals.costPerConv = previousTotals.conversions > 0 ? previousTotals.spend / previousTotals.conversions : 0;

const pct = (curr, prev) => (prev ? ((curr - prev) / prev) * 100 : null);

module.exports = {
  range: { from: dailySpend[0].date, to: dailySpend[dailySpend.length - 1].date },
  previousRange: null,
  campaigns,
  keywords,
  searchTerms,
  deviceBreakdown,
  dailySpend,
  totals,
  previousTotals,
  deltas: {
    spend: pct(totals.spend, previousTotals.spend),
    clicks: pct(totals.clicks, previousTotals.clicks),
    conversions: pct(totals.conversions, previousTotals.conversions),
    impressions: pct(totals.impressions, previousTotals.impressions),
    ctr: pct(totals.ctr, previousTotals.ctr),
    cpc: pct(totals.cpc, previousTotals.cpc),
    cpm: pct(totals.cpm, previousTotals.cpm),
    convRate: pct(totals.convRate, previousTotals.convRate),
    costPerConv: pct(totals.costPerConv, previousTotals.costPerConv),
  },
};
