// Formato pensado para espelhar o retorno da Google Ads API (GAQL):
// campaigns, ad_group_criterion (palavras-chave), segments.device
// (dispositivo), gender_view e age_range_view (demografia), agregados
// aqui num único objeto por conta — usado só quando USE_MOCK_DATA=true
// ou antes das credenciais reais estarem configuradas.

const campaigns = [
  { id: '111', name: 'Pesquisa · Marca', type: 'SEARCH', spend: 2180, impressions: 32000, clicks: 1240, ctr: 6.8, cpc: 1.76, conversions: 98, costPerConv: 2180 / 98, allConversions: 121, topImpressionShare: 78.4 },
  { id: '112', name: 'Pesquisa · Genérica concorrência', type: 'SEARCH', spend: 1860, impressions: 26700, clicks: 640, ctr: 2.4, cpc: 2.91, conversions: 31, costPerConv: 1860 / 31, allConversions: 40, topImpressionShare: 52.1 },
  { id: '113', name: 'Display · Remarketing', type: 'DISPLAY', spend: 940, impressions: 233000, clicks: 2100, ctr: 0.9, cpc: 0.45, conversions: 19, costPerConv: 940 / 19, allConversions: 24, topImpressionShare: 12.6 },
  { id: '114', name: 'Performance Max · Catálogo', type: 'PERFORMANCE_MAX', spend: 2200, impressions: 49400, clicks: 1580, ctr: 3.2, cpc: 1.39, conversions: 8, costPerConv: 2200 / 8, allConversions: 15, topImpressionShare: 44.9 },
];

const keywords = [
  { keyword: 'clínica odontológica perto de mim', matchType: 'PHRASE', qualityScore: 9, impressions: 12400, clicks: 840, ctr: 6.8, cpc: 1.52, conversions: 61, spend: 1277, costPerConv: 1277 / 61 },
  { keyword: 'implante dentário preço', matchType: 'BROAD', qualityScore: 7, impressions: 8900, clicks: 410, ctr: 4.6, cpc: 2.10, conversions: 22, spend: 861, costPerConv: 861 / 22 },
  { keyword: '[marca] odonto', matchType: 'EXACT', qualityScore: 10, impressions: 3100, clicks: 390, ctr: 12.6, cpc: 0.88, conversions: 34, spend: 343, costPerConv: 343 / 34 },
  { keyword: 'ortodontista', matchType: 'BROAD', qualityScore: 5, impressions: 21000, clicks: 520, ctr: 2.5, cpc: 2.64, conversions: 9, spend: 1373, costPerConv: 1373 / 9 },
];

const deviceBreakdown = [
  { device: 'MOBILE', label: 'Celular', impressions: 28400, clicks: 2960, spend: 4380, conversions: 112 },
  { device: 'DESKTOP', label: 'Computador', impressions: 9100, clicks: 480, spend: 1560, conversions: 34 },
  { device: 'TABLET', label: 'Tablet', impressions: 1200, clicks: 40, spend: 240, conversions: 2 },
];

const genderBreakdown = [
  { key: 'FEMALE', label: 'Feminino', impressions: 24200, clicks: 2380, spend: 3620, conversions: 96 },
  { key: 'MALE', label: 'Masculino', impressions: 12800, clicks: 980, spend: 2140, conversions: 44 },
  { key: 'UNDETERMINED', label: 'Não determinado', impressions: 1700, clicks: 120, spend: 420, conversions: 8 },
];

const ageBreakdown = [
  { key: 'AGE_RANGE_25_34', label: '25–34', impressions: 11200, clicks: 1120, spend: 1780, conversions: 52 },
  { key: 'AGE_RANGE_35_44', label: '35–44', impressions: 9800, clicks: 940, spend: 1540, conversions: 41 },
  { key: 'AGE_RANGE_45_54', label: '45–54', impressions: 7100, clicks: 610, spend: 1080, conversions: 26 },
  { key: 'AGE_RANGE_18_24', label: '18–24', impressions: 4900, clicks: 480, spend: 620, conversions: 14 },
  { key: 'AGE_RANGE_55_64', label: '55–64', impressions: 3600, clicks: 260, spend: 400, conversions: 11 },
  { key: 'AGE_RANGE_65_UP', label: '65+', impressions: 2100, clicks: 130, spend: 160, conversions: 4 },
];

// Enriquecemos cada dia com os mesmos campos derivados usados no resumo
// geral (ctr, cpc, cpm, convRate, costPerConv, allConversions,
// topImpressionShare), pra bater com o formato real e permitir plotar
// qualquer métrica no gráfico em modo mock.
const dailySpend = Array.from({ length: 30 }, (_, i) => {
  const spend = Math.round(150 + Math.random() * 140);
  const clicks = Math.round(30 + Math.random() * 40);
  const impressions = Math.round(clicks * (12 + Math.random() * 6));
  const conversions = Math.round(clicks * (0.03 + Math.random() * 0.03));
  return {
    date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
    spend, clicks, impressions, conversions,
    allConversions: Math.round(conversions * 1.3),
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    convRate: clicks > 0 ? (conversions / clicks) * 100 : 0,
    costPerConv: conversions > 0 ? spend / conversions : 0,
    topImpressionShare: 40 + Math.random() * 30,
  };
});

const totals = campaigns.reduce(
  (acc, c) => ({
    spend: acc.spend + c.spend,
    clicks: acc.clicks + c.clicks,
    conversions: acc.conversions + c.conversions,
    impressions: acc.impressions + c.impressions,
    allConversions: acc.allConversions + c.allConversions,
    topImprWeighted: acc.topImprWeighted + c.topImpressionShare * c.impressions,
  }),
  { spend: 0, clicks: 0, conversions: 0, impressions: 0, allConversions: 0, topImprWeighted: 0 }
);
totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
totals.convRate = totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0;
totals.costPerConv = totals.conversions > 0 ? totals.spend / totals.conversions : 0;
totals.topImpressionShare = totals.impressions > 0 ? totals.topImprWeighted / totals.impressions : 0;
delete totals.topImprWeighted;

const previousTotals = {
  spend: totals.spend * 0.91,
  clicks: Math.round(totals.clicks * 0.94),
  conversions: Math.round(totals.conversions * 0.87),
  impressions: Math.round(totals.impressions * 0.95),
  allConversions: Math.round(totals.allConversions * 0.89),
  topImpressionShare: totals.topImpressionShare * 0.93,
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
  deviceBreakdown,
  dailySpend,
  genderBreakdown,
  ageBreakdown,
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
    allConversions: pct(totals.allConversions, previousTotals.allConversions),
    topImpressionShare: pct(totals.topImpressionShare, previousTotals.topImpressionShare),
  },
};
