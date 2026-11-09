const config = require('../config');
const activeCreatives = require('../lib/activeCreatives');
const activeKeywords = require('../lib/activeKeywords');
const mockGoogle = require('../data/mockGoogle');
const cache = require('../lib/cache');
const period = require('../lib/period');
const quota = require('../lib/googleQuota');

// Uma busca pode voltar várias páginas. Cada página é uma operação da cota.
// Três páginas cobrem dezenas de milhares de linhas; além disso a gente para
// para não queimar a cota numa conta fora do comum.
const MAX_SEARCH_PAGES = 3;

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

function googleFailureText(json) {
  // O corpo padrão só traz uma mensagem genérica ("Request contains an
  // invalid argument"); o motivo específico vem em error.details, num
  // formato aninhado (GoogleAdsFailure). Extraímos aqui pra facilitar o diagnóstico.
  let detail = '';
  try {
    const failures = (json.error.details || [])
      .flatMap((d) => d.errors || [])
      .map((e) => `${e.errorCode ? JSON.stringify(e.errorCode) : ''} ${e.message || ''}`.trim());
    if (failures.length) detail = ': ' + failures.join(' | ');
  } catch (_) { /* ignore */ }
  return `${json.error.message || ''}${detail}`;
}

function isQuotaPayload(json) {
  const text = googleFailureText(json);
  if (/RESOURCE_EXHAUSTED/i.test(text)) return true;
  try {
    return (json.error.details || []).some((d) => (d.errors || []).some((e) => e.errorCode && e.errorCode.quotaError === 'RESOURCE_EXHAUSTED'));
  } catch (_) {
    return false;
  }
}

// Roda uma consulta GAQL numa conta de cliente. `label` identifica, na
// mensagem de erro, qual consulta falhou. Consultas iguais em voo viram uma
// só. Com a cota estourada, nem chega a sair daqui.
async function runGAQL(customerId, query, accessToken, label) {
  await quota.hydrate();
  if (quota.isOpen()) throw new quota.GoogleQuotaError(quota.openUntil());
  const cleanId = String(customerId || '').replace(/-/g, '');
  return quota.dedupe(`gaql:${cleanId}:${query}`, () => searchPages(cleanId, query, accessToken, label));
}

async function searchPages(cleanId, query, accessToken, label) {
  const cleanLoginId = String(config.google.loginCustomerId || '').replace(/-/g, '');
  const all = [];
  let pageToken = '';
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    if (page > 0 && quota.isOpen()) break;
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cleanId}/googleAds:search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'developer-token': config.google.developerToken,
        'login-customer-id': cleanLoginId,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) {
      const text = googleFailureText(json);
      if (isQuotaPayload(json)) {
        quota.trip(quota.parseRetryMs(text));
        const err = new quota.GoogleQuotaError(quota.openUntil());
        err.raw = text;
        throw err;
      }
      const prefix = label ? `[${label}] ` : '';
      throw new Error(`Google Ads API: ${prefix}${text}`);
    }
    all.push(...(json.results || []));
    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }
  return all;
}

/* ---------- Datas: período pedido + período anterior equivalente ---------- */

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Sem período informado: últimos 30 dias completos, até ontem (America/Sao_Paulo).
function defaultRange() {
  return period.defaultRange(30);
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
  const conversionsValue = raw.conversionsValue || 0;
  return {
    spend, clicks, impressions, conversions, allConversions, topImpressionShare, conversionsValue,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    convRate: clicks > 0 ? (conversions / clicks) * 100 : 0,
    costPerConv: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionsValue / spend : 0,
  };
}

function blankRaw() {
  return { spend: 0, clicks: 0, impressions: 0, conversions: 0, allConversions: 0, topImprWeighted: 0, conversionsValue: 0 };
}

function addRaw(acc, raw) {
  acc.spend += raw.spend;
  acc.clicks += raw.clicks;
  acc.impressions += raw.impressions;
  acc.conversions += raw.conversions;
  acc.allConversions += raw.allConversions;
  acc.topImprWeighted += raw.topImprWeighted;
  acc.conversionsValue += raw.conversionsValue;
  return acc;
}

function rawFromMetrics(metrics) {
  const m = metrics || {};
  const impressions = num(m.impressions);
  return {
    spend: num(m.costMicros) / 1_000_000,
    clicks: num(m.clicks),
    impressions,
    conversions: num(m.conversions),
    allConversions: num(m.allConversions),
    topImprWeighted: num(m.absoluteTopImpressionPercentage) * 100 * impressions,
    conversionsValue: num(m.conversionsValue),
  };
}

function dateIn(date, range) {
  return !!date && date >= range.from && date <= range.to;
}

// Uma consulta só de campanha, com segments.date, cobre o período pedido e o
// anterior: lista de campanhas ativas, totais do período anterior e a série
// diária. Antes eram três consultas. Campanha pausada entra no gráfico do
// dia (como a consulta diária antiga, sem filtro de status) e fica de fora
// da lista e do "vs período anterior" (aquelas duas filtravam ENABLED).
function splitCampaignRows(rows, range, prev) {
  const byCampaign = new Map();
  const dailyMap = new Map();
  const previousRaw = blankRaw();
  for (const r of rows) {
    const date = r.segments && r.segments.date;
    const raw = rawFromMetrics(r.metrics);
    const enabled = r.campaign && r.campaign.status === 'ENABLED';
    if (dateIn(date, range)) {
      const day = dailyMap.get(date) || blankRaw();
      addRaw(day, raw);
      dailyMap.set(date, day);
      if (enabled) {
        const id = String((r.campaign && (r.campaign.id || r.campaign.name)) || 'campaign');
        const cur = byCampaign.get(id) || {
          meta: { id: r.campaign.id, name: r.campaign.name, type: r.campaign.advertisingChannelType },
          raw: blankRaw(),
        };
        addRaw(cur.raw, raw);
        byCampaign.set(id, cur);
      }
    } else if (dateIn(date, prev) && enabled) {
      addRaw(previousRaw, raw);
    }
  }
  const campaigns = [...byCampaign.values()].map((c) => {
    const spend = c.raw.spend;
    const conv = c.raw.conversions;
    const derived = deriveMetrics(c.raw);
    return {
      id: c.meta.id,
      name: c.meta.name,
      type: c.meta.type,
      spend,
      impressions: c.raw.impressions,
      clicks: c.raw.clicks,
      ctr: derived.ctr,
      cpc: derived.cpc,
      conv,
      costPerConv: conv > 0 ? spend / conv : 0,
      allConversions: c.raw.allConversions,
      topImpressionShare: derived.topImpressionShare,
      conversionsValue: c.raw.conversionsValue,
      roas: derived.roas,
    };
  });
  const dailySpend = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, ...deriveMetrics(v) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { campaigns, dailySpend, previousRaw };
}

function quotaPartial(report) {
  const err = new quota.GoogleQuotaError(quota.openUntil());
  err.partialReport = report;
  return err;
}

async function fetchRealReport(customerId, range, opts = {}) {
  await quota.hydrate();
  if (quota.isOpen()) throw new quota.GoogleQuotaError(quota.openUntil());
  const accessToken = await getAccessToken();
  const prev = previousRange(range);
  const dateFilter = (r) => `segments.date BETWEEN '${r.from}' AND '${r.to}'`;

  // Campanhas do período, período anterior e série diária numa consulta só.
  const required = [
    ['campanhas', `
      SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status,
             segments.date,
             metrics.cost_micros, metrics.clicks, metrics.impressions,
             metrics.conversions, metrics.all_conversions,
             metrics.absolute_top_impression_percentage, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${prev.from}' AND '${range.to}'
    `],
    ['palavras-chave', keywordGaql(range, opts.activeKeywordsOnly === true)],
    ['dispositivo', `
      SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE ${dateFilter(range)}
    `],
    ['gênero', `
      SELECT ad_group_criterion.gender.type,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM gender_view
      WHERE ${dateFilter(range)}
    `],
    ['faixa etária', `
      SELECT ad_group_criterion.age_range.type,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM age_range_view
      WHERE ${dateFilter(range)}
    `],
  ];

  const settled = await Promise.all(required.map(async ([label, query]) => {
    try {
      return { ok: true, rows: await runGAQL(customerId, query, accessToken, label) };
    } catch (error) {
      return { ok: false, error, label };
    }
  }));

  const hard = settled.find((s) => !s.ok && !quota.isQuotaError(s.error));
  if (hard) throw hard.error;
  if (!settled[0].ok) throw settled[0].error;

  const campaignRows = settled[0].rows;
  const keywordRows = settled[1].ok ? settled[1].rows : [];
  const deviceRows = settled[2].ok ? settled[2].rows : [];
  const genderRows = settled[3].ok ? settled[3].rows : [];
  const ageRangeRows = settled[4].ok ? settled[4].rows : [];
  const quotaHit = settled.some((s) => !s.ok);

  const split = splitCampaignRows(campaignRows, range, prev);
  const campaigns = split.campaigns;

  const keywords = keywordRows.map((r) => {
    const spend = num(r.metrics.costMicros) / 1_000_000;
    const conversions = num(r.metrics.conversions);
    const criterion = r.adGroupCriterion || {};
    const row = {
      keyword: criterion.keyword.text,
      matchType: criterion.keyword.matchType,
      qualityScore: criterion.qualityInfo?.qualityScore ?? null,
      impressions: num(r.metrics.impressions),
      clicks: num(r.metrics.clicks),
      ctr: num(r.metrics.ctr) * 100,
      cpc: num(r.metrics.averageCpc) / 1_000_000,
      conversions,
      spend,
      costPerConv: conversions > 0 ? spend / conversions : 0,
    };
    // Status só vem na consulta de palavras ativas. Sem ele, o filtro
    // posterior não apaga a lista de quem não usa a opção.
    if (criterion.status) {
      row.criterionStatus = criterion.status;
      row.negative = criterion.negative === true;
      row.adGroupStatus = r.adGroup && r.adGroup.status;
      row.campaignStatus = r.campaign && r.campaign.status;
    }
    return row;
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

  // Série diária sai da mesma consulta das campanhas (uma linha por campanha
  // x dia, somada aqui). Os campos brutos são os mesmos dos totais, então
  // qualquer métrica — inclusive uma personalizada — pode ir pro gráfico.
  const dailySpend = split.dailySpend;

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

  // Totais e período anterior passam pelo mesmo deriveMetrics() do gráfico —
  // garante que o resumo geral, o "vs período anterior" e cada ponto do
  // gráfico calculem as métricas derivadas exatamente da mesma forma.
  const totals = deriveMetrics(campaigns.reduce(
    (acc, c) => ({
      spend: acc.spend + c.spend,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conv,
      impressions: acc.impressions + c.impressions,
      allConversions: acc.allConversions + c.allConversions,
      // Média ponderada por impressões (não é uma média simples das
      // campanhas, senão uma campanha pequena pesaria igual a uma grande).
      topImprWeighted: acc.topImprWeighted + c.topImpressionShare * c.impressions,
      conversionsValue: acc.conversionsValue + c.conversionsValue,
    }),
    { spend: 0, clicks: 0, conversions: 0, impressions: 0, allConversions: 0, topImprWeighted: 0, conversionsValue: 0 }
  ));

  const previousTotals = deriveMetrics(split.previousRaw);

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
    conversionsValue: pctDelta(totals.conversionsValue, previousTotals.conversionsValue),
    roas: pctDelta(totals.roas, previousTotals.roas),
  };

  const core = {
    range, previousRange: prev,
    campaigns, keywords, deviceBreakdown, dailySpend, genderBreakdown, ageBreakdown,
    totals, previousTotals, deltas,
  };
  // Cota estourou no meio: devolve o que já veio e não dispara o resto.
  if (quotaHit || quota.isOpen()) throw quotaPartial(core);

  // Extras "melhor esforço": se a API recusar por outro motivo, o relatório
  // principal segue normal. Cota estourada não é engolida — senão a próxima
  // tela manda de novo as mesmas consultas.
  const optional = (label, query) => runGAQL(customerId, query, accessToken, label).catch((e) => {
    if (quota.isQuotaError(e)) throw e;
    console.warn(e.message);
    return null;
  });
  let shareRows;
  let termRows;
  let strengthRows;
  try {
    [shareRows, termRows, strengthRows] = await Promise.all([
      optional('parcela de impressões', `
      SELECT campaign.name, metrics.impressions, metrics.search_impression_share,
             metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE ${dateFilter(range)} AND campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'
    `),
      opts.activeKeywordsOnly === true
        ? Promise.resolve(null)
        : optional('termos de pesquisa', `
      SELECT search_term_view.search_term, campaign.name,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM search_term_view
      WHERE ${dateFilter(range)}
      ORDER BY metrics.cost_micros DESC
      LIMIT 60
    `),
      // Força do anúncio (só existe pra anúncio responsivo de pesquisa).
      // Já exige campanha, grupo e anúncio ENABLED. Com "só criativos ativos",
      // também tira o reprovado (ele segue ENABLED, mas não veicula).
      optional('força do anúncio', `
      SELECT campaign.name, ad_group_ad.ad_strength
      FROM ad_group_ad
      WHERE ${activeCreatives.googleAdStrengthWhere(opts.activeCreativesOnly === true)}
    `),
    ]);
  } catch (err) {
    if (quota.isQuotaError(err)) throw quotaPartial(core);
    throw err;
  }

  return {
    ...core,
    impressionShare: shareRows ? aggregateImpressionShare(shareRows.map((r) => ({
      name: r.campaign.name,
      impressions: num(r.metrics.impressions),
      share: num(r.metrics.searchImpressionShare),
      lostBudget: num(r.metrics.searchBudgetLostImpressionShare),
      lostRank: num(r.metrics.searchRankLostImpressionShare),
    }))) : null,
    searchTerms: termRows ? termRows.map((r) => {
      const spend = num(r.metrics.costMicros) / 1_000_000;
      const conversions = num(r.metrics.conversions);
      const clicks = num(r.metrics.clicks);
      const impressions = num(r.metrics.impressions);
      return {
        term: r.searchTermView.searchTerm, campaign: r.campaign.name, impressions, clicks, spend, conversions,
        ctr: impressions ? (clicks / impressions) * 100 : 0, cpc: clicks ? spend / clicks : 0, costPerConv: conversions ? spend / conversions : 0,
      };
    }) : null,
    adStrength: strengthRows ? aggregateAdStrength(strengthRows) : null,
  };
}

/**
 * Conta, por campanha, quantos anúncios responsivos têm cada nível de força
 * (EXCELLENT, GOOD, AVERAGE, POOR, PENDING...). Só o que a API devolveu.
 */
function aggregateAdStrength(rows) {
  const out = {};
  for (const r of rows) {
    const name = r.campaign?.name;
    const level = r.adGroupAd?.adStrength;
    if (!name || !level) continue;
    out[name] = out[name] || {};
    out[name][level] = (out[name][level] || 0) + 1;
  }
  return out;
}

/**
 * Parcela de impressões da rede de pesquisa. Soma por "impressões possíveis"
 * (impressões ÷ parcela), que é a forma certa de juntar campanhas diferentes.
 */
function aggregateImpressionShare(rows) {
  const valid = rows.filter((r) => r.share > 0 && r.impressions > 0);
  if (!valid.length) return null;
  let impr = 0, eligible = 0, lostBudget = 0, lostRank = 0;
  const campaigns = valid.map((r) => {
    const el = r.impressions / r.share;
    impr += r.impressions; eligible += el; lostBudget += el * r.lostBudget; lostRank += el * r.lostRank;
    return { name: r.name, share: r.share * 100, lostBudget: r.lostBudget * 100, lostRank: r.lostRank * 100, impressions: r.impressions };
  }).sort((a, b) => b.impressions - a.impressions);
  return {
    share: (impr / eligible) * 100,
    lostBudget: (lostBudget / eligible) * 100,
    lostRank: (lostRank / eligible) * 100,
    campaigns,
  };
}

/**
 * Campanhas, palavras-chave, termos de pesquisa, dispositivo e evolução
 * diária para uma conta de cliente (customerId, formato XXX-XXX-XXXX)
 * vinculada à sua MCC, num período (from/to, formato YYYY-MM-DD). Sem
 * período informado, usa os últimos 30 dias completos até ontem (America/Sao_Paulo).
 *
 * O resultado fica em cache (memória e, se houver banco, MySQL): 45 min
 * quando o período inclui hoje, 6 h quando já fechou. O link público
 * recarrega a cada 20 min e a sincronização também, mas os dois leem o
 * cache e não batem na API de novo. Com a cota estourada, devolve o
 * último resultado guardado (até 36 h) com um aviso curto.
 */

// A consulta antiga (sem a opção) fica igual, inclusive o LIMIT 10 por cliques.
// Com a opção, o LIMIT vale só entre as palavras que ainda estão ligadas.
function keywordGaql(range, onlyActive) {
  const period = `segments.date BETWEEN '${range.from}' AND '${range.to}'`;
  const statusFields = onlyActive
    ? `
             ad_group_criterion.status, ad_group_criterion.negative,
             ad_group.status, campaign.status,`
    : '';
  const statusWhere = onlyActive ? ` AND ${activeKeywords.keywordStatusWhere()}` : '';
  return `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,${statusFields}
             metrics.impressions, metrics.clicks, metrics.ctr,
             metrics.average_cpc, metrics.conversions, metrics.cost_micros
      FROM keyword_view
      WHERE ${period}${statusWhere}
      ORDER BY metrics.clicks DESC
      LIMIT 10
    `;
}

function presentReport(report, activeKw, cachedAt) {
  const base = cachedAt ? quota.withNotice(report, cachedAt) : report;
  return activeKeywords.presentGoogleReport(base, activeKw);
}

async function getAccountReport(customerId, options = {}) {
  const range = normalizeRange(options.from, options.to);
  const onlyActive = options.activeCreativesOnly === true;
  const activeKw = options.activeKeywordsOnly === true;
  // Sem nenhuma opção, a chave continua a de antes. Cada opção muda um
  // pedaço da consulta, então não reaproveita o cache da outra.
  const cacheKey = `google:report:${customerId}:${range.from}:${range.to}${onlyActive ? ':activeAds' : ''}${activeKw ? ':activeKw' : ''}`;

  if (!hasRealCredentials()) return activeKeywords.presentGoogleReport(mockGoogle, activeKw);

  return quota.dedupe(cacheKey, () => loadReport(cacheKey, customerId, range, onlyActive, activeKw));
}

async function loadReport(cacheKey, customerId, range, onlyActive, activeKw) {
  await quota.hydrate();
  const fresh = await quota.read(cacheKey, false);
  if (fresh) return presentReport(fresh.value, activeKw);

  if (quota.isOpen()) {
    const stale = await quota.read(cacheKey, true);
    if (stale) return presentReport(stale.value, activeKw, stale.cachedAt);
    throw new quota.GoogleQuotaError(quota.openUntil());
  }

  try {
    const raw = await fetchRealReport(customerId, range, { activeCreativesOnly: onlyActive, activeKeywordsOnly: activeKw });
    const result = activeKeywords.presentGoogleReport(raw, activeKw);
    await quota.remember(cacheKey, result, quota.reportTtlSeconds(range));
    return result;
  } catch (err) {
    if (!quota.isQuotaError(err)) throw err;
    const stale = await quota.read(cacheKey, true);
    if (stale) return presentReport(stale.value, activeKw, stale.cachedAt);
    if (err.partialReport) {
      const partial = activeKeywords.presentGoogleReport(err.partialReport, activeKw);
      const saved = await quota.remember(cacheKey, partial, quota.reportTtlSeconds(range), { staleOnly: true });
      return presentReport(partial, activeKw, saved.cachedAt);
    }
    throw new quota.GoogleQuotaError(quota.openUntil() || err.retryAt);
  }
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

  if (!rows.length) throw new Error('A conta respondeu, mas sem dados de cliente. Verifique o ID informado.');

  return {
    id: rows[0].customer.id,
    name: rows[0].customer.descriptiveName || null,
  };
}

module.exports = { getAccountReport, verifyCustomerAccess, runGAQL, getAccessToken, hasRealCredentials };
