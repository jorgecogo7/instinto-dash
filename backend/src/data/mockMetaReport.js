// Relatório de exemplo do Meta Ads (mesmo formato do getAccountReport real),
// usado só sem token da Meta ou com USE_MOCK_DATA=true. Os números são
// gerados de forma determinística a partir do período, pra tela não
// "pular" a cada recarga.
const period = require('../lib/period');

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const ADS = [
  { name: 'video_depoimento_cliente', adset: 'mensagem_quente', campaign: 'Mensagens · Remarketing', w: 1.6, conv: 0.050 },
  { name: 'carrossel_servicos', adset: 'mensagem_frio', campaign: 'Mensagens · Público frio', w: 1.2, conv: 0.030 },
  { name: 'estatico_oferta_semana', adset: 'mensagem_frio', campaign: 'Mensagens · Público frio', w: 0.9, conv: 0.022 },
  { name: 'reels_bastidores', adset: 'mensagem_quente', campaign: 'Mensagens · Remarketing', w: 0.8, conv: 0.041 },
  { name: 'video_explicativo', adset: 'trafego_perfil', campaign: 'Tráfego · Perfil', w: 0.6, conv: 0 },
  { name: 'estatico_antes_depois', adset: 'mensagem_frio', campaign: 'Mensagens · Público frio', w: 0.5, conv: 0.015 },
  { name: 'post_impulsionado', adset: 'alcance_local', campaign: 'Reconhecimento · Região', w: 0.4, conv: 0 },
];

function build(range) {
  const prev = period.previousRange(range);
  const days = period.eachDay(range);
  const seed = Number(range.from.replace(/-/g, '')) % 100000;

  function series(r, rand) {
    return period.eachDay(r).map((date, i) => {
      const base = 120 + Math.sin(i / 3) * 35 + rand() * 40;
      return { date, factor: Math.max(0.15, base / 140) };
    });
  }

  function adsFor(r, rand, scale) {
    const s = series(r, rand);
    return ADS.map((a, idx) => {
      const spend = s.reduce((acc, d) => acc + d.factor * 18 * a.w, 0) * scale;
      const impressions = spend * (28 + rand() * 12);
      const clicks = impressions * (0.012 + rand() * 0.03);
      const reach = impressions / (1.05 + rand() * 0.2);
      const results = Math.round(clicks * a.conv * (3 + rand()));
      return {
        id: `ad_mock_${idx + 1}`,
        name: a.name,
        adset: a.adset,
        campaign: a.campaign,
        campaignId: `cmp_${a.campaign}`,
        status: idx === 6 ? 'PAUSED' : 'ACTIVE',
        spend,
        impressions,
        reach,
        frequency: impressions / reach,
        clicks,
        linkClicks: clicks * 0.7,
        ctr: (clicks / impressions) * 100,
        cpc: spend / clicks,
        cpm: (spend / impressions) * 1000,
        results,
        resultType: results ? 'onsite_conversion.messaging_conversation_started_7d' : null,
        resultLabel: results ? 'Conversas iniciadas' : null,
        costPerResult: results ? spend / results : 0,
        engagement: Math.round(clicks * (2 + rand() * 2)),
        video25: Math.round(impressions * 0.06),
        thumbnailUrl: null,
      };
    });
  }

  function totals(ads) {
    const t = ads.reduce((acc, a) => ({
      spend: acc.spend + a.spend,
      impressions: acc.impressions + a.impressions,
      reach: acc.reach + a.reach * 0.82,
      clicks: acc.clicks + a.clicks,
      linkClicks: acc.linkClicks + a.linkClicks,
      results: acc.results + a.results,
      engagement: acc.engagement + a.engagement,
    }), { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, results: 0, engagement: 0 });
    return {
      ...t,
      ctr: (t.clicks / t.impressions) * 100,
      cpc: t.spend / t.clicks,
      cpm: (t.spend / t.impressions) * 1000,
      frequency: t.impressions / t.reach,
      costPerResult: t.results ? t.spend / t.results : 0,
    };
  }

  const ads = adsFor(range, rng(seed), 1).sort((x, y) => (y.results - x.results) || (y.spend - x.spend));
  const prevAds = adsFor(prev, rng(seed + 7), 0.88);
  const t = totals(ads);

  const s = series(range, rng(seed + 3));
  const sumF = s.reduce((acc, d) => acc + d.factor, 0);
  const daily = days.map((date, i) => {
    const f = s[i].factor / sumF;
    const spend = t.spend * f;
    const impressions = t.impressions * f;
    const clicks = t.clicks * f * (0.9 + (i % 5) * 0.05);
    const results = Math.round(t.results * f * (0.8 + (i % 4) * 0.12));
    return {
      date, spend, impressions, clicks, results,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cpc: clicks ? spend / clicks : 0,
      costPerResult: results ? spend / results : 0,
    };
  });

  const campMap = {};
  ads.forEach((a) => {
    const c = campMap[a.campaignId] || (campMap[a.campaignId] = { id: a.campaignId, name: a.campaign, spend: 0, impressions: 0, clicks: 0, results: 0, reach: 0 });
    c.spend += a.spend; c.impressions += a.impressions; c.clicks += a.clicks; c.results += a.results;
  });
  const campaigns = Object.values(campMap).map((c) => ({
    ...c,
    ctr: (c.clicks / c.impressions) * 100,
    cpc: c.spend / c.clicks,
    cpm: (c.spend / c.impressions) * 1000,
    frequency: 0,
    costPerResult: c.results ? c.spend / c.results : 0,
  })).sort((x, y) => y.spend - x.spend);

  return {
    mock: true,
    range,
    previousRange: prev,
    resultLabel: 'Conversas iniciadas',
    totals: t,
    previousTotals: totals(prevAds),
    daily,
    campaigns,
    ads,
  };
}

module.exports = { build };
