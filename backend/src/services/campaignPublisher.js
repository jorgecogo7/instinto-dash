/**
 * Publica um rascunho aprovado na Meta ou no Google Ads.
 *
 * Regras fixas:
 *  - Tudo é criado PAUSADO (campanha, conjunto e anúncio na Meta; campanha no Google).
 *    Ninguém gasta um centavo até alguém ativar de propósito no gerenciador.
 *  - Com USE_MOCK_DATA=true nada sai do servidor: simulamos a publicação e
 *    devolvemos as requisições exatas que seriam feitas (sem token).
 *  - Fora do mock, só publica com CAMPAIGNS_PUBLISH_ENABLED=true.
 *  - Se a Meta falhar no meio, o que já foi criado fica PAUSADO e os IDs são
 *    registrados no histórico. Não apagamos nada automaticamente.
 */
const crypto = require('crypto');
const config = require('../config');
const metaService = require('./metaService');
const googleService = require('./googleService');
const spec = require('../lib/campaignSpec');

const META_BASE = `https://graph.facebook.com/${config.campaigns.metaApiVersion}`;
const GOOGLE_API = 'v25';
const TIMEOUT_MS = 30000;
// Moedas sem centavos na Meta (o orçamento vai em unidade inteira).
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'PYG', 'VND', 'ISK', 'HUF', 'TWD', 'COP', 'IDR']);

const OBJECTIVES = {
  mensagens: { objective: 'OUTCOME_ENGAGEMENT', optimization: 'CONVERSATIONS', destination: 'WHATSAPP' },
  trafego: { objective: 'OUTCOME_TRAFFIC', optimization: 'LINK_CLICKS', destination: 'WEBSITE' },
  cadastros: { objective: 'OUTCOME_LEADS', optimization: 'OFFSITE_CONVERSIONS', destination: 'WEBSITE', event: 'LEAD' },
  vendas: { objective: 'OUTCOME_SALES', optimization: 'OFFSITE_CONVERSIONS', destination: 'WEBSITE', event: 'PURCHASE' },
  alcance: { objective: 'OUTCOME_AWARENESS', optimization: 'REACH' },
};
const POSITION_MAP = {
  facebook_feed: ['facebook', 'feed'], facebook_stories: ['facebook', 'story'], facebook_reels: ['facebook', 'facebook_reels'],
  instagram_feed: ['instagram', 'stream'], instagram_stories: ['instagram', 'story'], instagram_reels: ['instagram', 'reels'],
  instagram_explore: ['instagram', 'explore'],
};

function publishError(message, extra = {}) {
  const e = new Error(message);
  Object.assign(e, extra);
  return e;
}

// Qual modo vale agora e o que falta pra publicar de verdade.
function readiness(platform) {
  if (config.useMockData) return { mode: 'mock', ok: true, missing: [] };
  const missing = [];
  if (!config.campaigns.publishEnabled) missing.push('CAMPAIGNS_PUBLISH_ENABLED=true');
  if (platform === 'meta' && !config.meta.systemUserToken) missing.push('META_SYSTEM_USER_TOKEN');
  if (platform === 'google') {
    if (!googleService.hasRealCredentials()) missing.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_DEVELOPER_TOKEN');
    if (!config.google.loginCustomerId) missing.push('GOOGLE_LOGIN_CUSTOMER_ID');
  }
  return { mode: 'real', ok: missing.length === 0, missing };
}

/* ===================== Meta ===================== */

function minorUnits(amount, currency) {
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

function tzSuffix(offsetHours) {
  const h = Number(offsetHours) || 0;
  const sign = h < 0 ? '-' : '+';
  const abs = Math.abs(h);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
  return `${sign}${hh}${mm}`;
}

// Advantage+ creative (Marketing API v22+ / v25): cada recurso é individual
// em degrees_of_freedom_spec.creative_features_spec, com enroll_status OPT_OUT.
// `standard_enhancements` saiu na v22 e a Meta recusa o criativo se ele vier.
// Fora desta lista, o padrão da API liga só `adapt_to_placement`; o rascunho
// pede o opt-out explícito de todos estes quando creativeEnhancements = opt_out.
const ADVANTAGE_CREATIVE_FEATURES = [
  'adapt_to_placement',
  'add_text_overlay',
  'creative_stickers',
  'description_automation',
  'enhance_cta',
  'generate_cta',
  'image_animation',
  'image_background_gen',
  'image_brightness_and_contrast',
  'image_templates',
  'image_touchups',
  'image_uncrop',
  'inline_comment',
  'media_type_automation',
  'music_generation',
  'pac_relaxation',
  'product_extensions',
  'profile_card',
  'reveal_details_over_time',
  'show_destination_blurbs',
  'site_extensions',
  'text_optimizations',
  'text_overlay_translation',
  'text_translation',
];

function creativeOptOutSpec() {
  const features = {};
  for (const name of ADVANTAGE_CREATIVE_FEATURES) features[name] = { enroll_status: 'OPT_OUT' };
  return { creative_features_spec: features };
}

function imageHashOf(response) {
  return Object.values(response.images || {})[0]?.hash;
}

/**
 * Monta, em ordem, as chamadas de criação na Meta. `ctx` traz o que depende de
 * consulta prévia (fuso da conta, chaves de cidade, interesses).
 * Valores como {campaign_id} são trocados pelo ID real durante a execução.
 *
 * Tudo que tem status sai PAUSED. Rascunho sem adSets continua com um conjunto
 * chamado "<campanha> | Conjunto" e um anúncio "<campanha> | Anúncio".
 */
function buildMetaRequests(draft, account, ctx) {
  const s = draft.spec;
  const m = account.meta || {};
  const act = metaService.normalizeAdAccountId(m.adAccountId || '');
  const obj = OBJECTIVES[s.objective];
  const name = draft.name;
  const budgetKey = s.budgetType === 'lifetime' ? 'lifetime_budget' : 'daily_budget';
  const today = spec.todaySP();
  const plan = spec.expandMetaPlan(s, name);
  const single = plan.adSets.length === 1 && plan.adSets[0].ads.length === 1;
  const assetIds = [];
  for (const set of plan.adSets) {
    for (const ad of set.ads) {
      const id = ad.creative.assetId;
      if (id && !assetIds.includes(id)) assetIds.push(id);
    }
  }
  const assetIndex = new Map(assetIds.map((id, i) => [id, i]));

  const requests = assetIds.map((id, i) => {
    const token = single ? 'image_base64' : `imgb64_${i}`;
    const sets = single ? 'image_hash' : `imghash_${i}`;
    return {
      key: single ? 'image' : `image_${i + 1}`,
      label: single ? 'Imagem do anúncio' : `Imagem ${i + 1}`,
      method: 'POST',
      path: `${act}/adimages`,
      params: { bytes: `{${token}}` },
      pick: imageHashOf,
      sets,
      assetId: id,
    };
  });

  requests.push({
    key: 'campaign',
    label: 'Campanha',
    method: 'POST',
    path: `${act}/campaigns`,
    params: {
      name,
      objective: obj.objective,
      status: 'PAUSED',
      buying_type: 'AUCTION',
      special_ad_categories: s.specialAdCategory === 'NONE' ? [] : [s.specialAdCategory],
      [budgetKey]: minorUnits(s.budget, draft.currency),
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    },
    pick: (r) => r.id,
    sets: 'campaign_id',
    record: { key: 'campaign', type: 'campaign', name },
  });

  plan.adSets.forEach((set, si) => {
    const adsetToken = single ? 'adset_id' : `adset_${si}`;
    const targeting = targetingFor(set, ctx);
    const adset = {
      name: set.name,
      campaign_id: '{campaign_id}',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: obj.optimization,
      targeting,
    };
    if (obj.destination) adset.destination_type = obj.destination;
    if (obj.event) adset.promoted_object = { pixel_id: s.pixelId, custom_event_type: obj.event };
    if (s.objective === 'mensagens') adset.promoted_object = { page_id: m.pageId };
    if (s.startDate > today) adset.start_time = `${s.startDate}T00:00:00${ctx.tz}`;
    if (s.endDate) adset.end_time = `${s.endDate}T23:59:00${ctx.tz}`;
    if (set.audience.countries.some((c) => spec.EU.includes(c))) {
      adset.dsa_beneficiary = s.dsa.beneficiary;
      adset.dsa_payor = s.dsa.payor;
    }
    requests.push({
      key: single ? 'adset' : `adset_${si + 1}`,
      label: plan.legacy ? 'Conjunto de anúncios' : `Conjunto: ${set.name}`,
      method: 'POST',
      path: `${act}/adsets`,
      params: adset,
      pick: (r) => r.id,
      sets: adsetToken,
      record: { key: single ? 'adset' : `adset_${si + 1}`, type: 'adset', name: set.name },
    });

    set.ads.forEach((ad, ai) => {
      const imgIdx = assetIndex.has(ad.creative.assetId) ? assetIndex.get(ad.creative.assetId) : 0;
      const hashToken = single ? 'image_hash' : `imghash_${imgIdx}`;
      const creativeToken = single ? 'creative_id' : `creative_${si}_${ai}`;
      const adToken = single ? 'ad_id' : `ad_${si}_${ai}`;
      const storySpec = storyFor(m, s.objective, ad.creative, `{${hashToken}}`);
      const creativeParams = {
        name: (plan.legacy ? `${name} | Criativo` : `${ad.name} | Criativo`).slice(0, 255),
        object_story_spec: storySpec,
      };
      if (ad.optOutCreative) creativeParams.degrees_of_freedom_spec = creativeOptOutSpec();
      const oneKey = single;
      requests.push({
        key: oneKey ? 'creative' : `creative_${si + 1}_${ai + 1}`,
        label: plan.legacy ? 'Criativo' : `Criativo: ${ad.name}`,
        method: 'POST',
        path: `${act}/adcreatives`,
        params: creativeParams,
        pick: (r) => r.id,
        sets: creativeToken,
        record: { key: oneKey ? 'creative' : `creative_${si + 1}_${ai + 1}`, type: 'creative', name: plan.legacy ? `${name} | Criativo` : ad.name },
        optOutCreative: !!ad.optOutCreative,
      });
      requests.push({
        key: oneKey ? 'ad' : `ad_${si + 1}_${ai + 1}`,
        label: plan.legacy ? 'Anúncio' : `Anúncio: ${ad.name}`,
        method: 'POST',
        path: `${act}/ads`,
        params: {
          name: ad.name,
          adset_id: `{${adsetToken}}`,
          creative: { creative_id: `{${creativeToken}}` },
          status: 'PAUSED',
        },
        pick: (r) => r.id,
        sets: adToken,
        record: { key: oneKey ? 'ad' : `ad_${si + 1}_${ai + 1}`, type: 'ad', name: ad.name },
      });
    });
  });

  assertCreatesPaused(requests);
  return requests;
}

function targetingFor(set, ctx) {
  const a = set.audience;
  const cityKeys = ctx.cityKeys || {};
  const interestMap = ctx.interests || {};
  const targeting = {
    geo_locations: a.cities.length
      ? {
        cities: a.cities.map((city) => {
          const key = cityKeys[city];
          if (!key) throw publishError(`A Meta não encontrou a cidade "${city}". Confira o nome no rascunho.`);
          return { key };
        }),
      }
      : { countries: a.countries },
    age_min: a.ageMin,
    age_max: a.ageMax,
    targeting_automation: { advantage_audience: a.advantage ? 1 : 0 },
  };
  if (a.gender === 'male') targeting.genders = [1];
  if (a.gender === 'female') targeting.genders = [2];
  const found = (a.interests || []).map((term) => interestMap[term]).filter(Boolean);
  if (found.length) targeting.flexible_spec = [{ interests: found }];
  if (set.placements.mode === 'manual') {
    const platforms = new Set();
    const fb = []; const ig = [];
    set.placements.positions.forEach((p) => {
      const mapped = POSITION_MAP[p];
      if (!mapped) return;
      const [plat, pos] = mapped;
      platforms.add(plat);
      (plat === 'facebook' ? fb : ig).push(pos);
    });
    targeting.publisher_platforms = [...platforms];
    if (fb.length) targeting.facebook_positions = fb;
    if (ig.length) targeting.instagram_positions = ig;
  }
  return targeting;
}

function storyFor(meta, objective, creative, hashToken) {
  const linkData = {
    image_hash: hashToken,
    message: creative.primaryText,
    name: creative.headline,
  };
  if (creative.description) linkData.description = creative.description;
  if (objective === 'mensagens') {
    linkData.link = 'https://api.whatsapp.com/send';
    linkData.call_to_action = { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } };
  } else {
    linkData.link = creative.link;
    if (creative.cta) linkData.call_to_action = { type: creative.cta, value: { link: creative.link } };
  }
  const storySpec = { page_id: meta.pageId, link_data: linkData };
  if (meta.igBusinessId) storySpec.instagram_user_id = meta.igBusinessId;
  return storySpec;
}

// Campanha, conjunto e anúncio nascem pausados. Se algum status escapar, para aqui.
function assertCreatesPaused(requests) {
  for (const r of requests) {
    if (!r.params || !Object.prototype.hasOwnProperty.call(r.params, 'status')) continue;
    if (r.params.status !== 'PAUSED') {
      throw publishError('Publicação recusada: campanha, conjunto e anúncio só podem ser criados pausados.');
    }
  }
}

// Troca {placeholders} pelos valores já obtidos (em qualquer profundidade).
function fill(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{(\w+)\}$/);
    if (whole && vars[whole[1]] !== undefined) return vars[whole[1]];
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

async function metaRequest(method, path, params = {}) {
  const url = new URL(`${META_BASE}/${path}`);
  const opts = { method, headers: { Authorization: `Bearer ${config.meta.systemUserToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  const flat = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  if (method === 'GET') Object.entries(flat).forEach(([k, v]) => url.searchParams.set(k, v));
  else { opts.body = new URLSearchParams(flat); }
  const res = await fetch(url, opts);
  let json;
  try { json = await res.json(); } catch (_) { throw new Error(`A Meta respondeu algo inesperado (HTTP ${res.status}).`); }
  if (!res.ok || json.error) {
    const e = json.error || {};
    // error_user_msg costuma explicar o problema do jeito que o Gerenciador mostraria.
    const msg = [e.error_user_title, e.error_user_msg].filter(Boolean).join(': ') || e.message || `Erro ${res.status} na Meta.`;
    let hint = '';
    if (e.code === 190) hint = ' (token inválido ou expirado)';
    else if ([10, 200, 294].includes(e.code)) hint = ' (o token não tem permissão de criar anúncios: falta ads_management ou acesso de gerenciar campanhas nessa conta)';
    throw publishError(`Meta: ${msg}${hint}`, { code: e.code });
  }
  return json;
}

function planLookups(draft) {
  const plan = spec.expandMetaPlan(draft.spec, draft.name);
  const cities = [];
  const interests = [];
  for (const set of plan.adSets) {
    for (const city of set.audience.cities) if (!cities.includes(city)) cities.push(city);
    for (const term of set.audience.interests) if (!interests.includes(term)) interests.push(term);
  }
  const countryOf = (city) => {
    const set = plan.adSets.find((s) => s.audience.cities.includes(city));
    return (set && set.audience.countries && set.audience.countries[0]) || 'BR';
  };
  return { cities, interests, countryOf };
}

async function resolveMetaContext(draft, account, live) {
  const warnings = [];
  const { cities, interests, countryOf } = planLookups(draft);
  if (!live) {
    return {
      tz: '-0300',
      cityKeys: Object.fromEntries(cities.map((c) => [c, `<chave da cidade "${c}">`])),
      interests: Object.fromEntries(interests.map((i) => [i, { id: `<id do interesse "${i}">`, name: i }])),
      warnings,
    };
  }
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  const info = await metaRequest('GET', act, { fields: 'currency,timezone_offset_hours_utc,account_status' });
  if (info.currency && info.currency !== draft.currency) {
    throw publishError(`A conta da Meta está em ${info.currency}, mas o rascunho foi feito em ${draft.currency}. Ajuste o orçamento antes de publicar.`);
  }
  const cityKeys = {};
  for (const city of cities) {
    const r = await metaRequest('GET', 'search', {
      type: 'adgeolocation', q: city, location_types: ['city'], country_code: countryOf(city), limit: 1,
    });
    const hit = (r.data || [])[0];
    if (!hit) throw publishError(`A Meta não encontrou a cidade "${city}". Confira o nome no rascunho.`);
    cityKeys[city] = hit.key;
  }
  const interestMap = {};
  for (const term of interests) {
    const r = await metaRequest('GET', 'search', { type: 'adinterest', q: term, limit: 1 });
    const hit = (r.data || [])[0];
    if (hit) interestMap[term] = { id: hit.id, name: hit.name };
    else warnings.push(`Interesse "${term}" não encontrado na Meta e ficou de fora.`);
  }
  if (!account.meta.igBusinessId) warnings.push('Cliente sem Instagram vinculado: o anúncio usa a identidade da Página no Instagram.');
  return { tz: tzSuffix(info.timezone_offset_hours_utc), cityKeys, interests: interestMap, warnings };
}

function previewOf(requests, vars, base) {
  const shown = { ...vars };
  for (const r of requests) if (r.sets) shown[r.sets] = `{${r.sets}}`;
  return requests.map((r) => ({
    label: r.label, method: r.method, url: `${base}/${r.path}`,
    params: fill(r.params, shown),
  }));
}

function imagePlaceholders(draft, images) {
  const assetIds = spec.collectAssetIds(draft.spec, draft.name);
  const plan = spec.expandMetaPlan(draft.spec, draft.name);
  const single = plan.adSets.length === 1 && plan.adSets[0].ads.length === 1;
  const vars = {};
  assetIds.forEach((id, i) => {
    const token = single ? 'image_base64' : `imgb64_${i}`;
    const img = images && images[id];
    const kb = img && img.size ? Math.round(img.size / 1024) : 0;
    vars[token] = img && img.data ? Buffer.from(img.data).toString('base64') : `<imagem em base64, ${kb} KB>`;
  });
  return { vars, assetIds, single };
}

async function noteCreativeOptOut(creativeId, warnings) {
  try {
    const r = await metaRequest('GET', creativeId, { fields: 'degrees_of_freedom_spec' });
    const features = (r.degrees_of_freedom_spec && r.degrees_of_freedom_spec.creative_features_spec) || {};
    const on = Object.entries(features).filter(([, v]) => v && v.enroll_status === 'OPT_IN').map(([k]) => k);
    if (on.length) warnings.push(`A Meta manteve melhorias de criativo ligadas (${on.join(', ')}). Confira o anúncio no Gerenciador.`);
  } catch (_) {
    warnings.push('Não consegui conferir se as melhorias de criativo ficaram desligadas. Vale olhar o anúncio no Gerenciador.');
  }
}

async function publishMeta(draft, account, images, live) {
  const ctx = await resolveMetaContext(draft, account, live);
  const requests = buildMetaRequests(draft, account, ctx);
  const { vars: imageVars } = imagePlaceholders(draft, live ? images : null);
  if (!live) {
    const ids = {};
    const created = [];
    const vars = {};
    const assetIds = spec.collectAssetIds(draft.spec, draft.name);
    const plan = spec.expandMetaPlan(draft.spec, draft.name);
    const single = plan.adSets.length === 1 && plan.adSets[0].ads.length === 1;
    assetIds.forEach((id, i) => {
      const token = single ? 'image_base64' : `imgb64_${i}`;
      const img = images && images[id];
      const kb = img && img.size ? Math.round(img.size / 1024) : 0;
      vars[token] = `<imagem em base64, ${kb} KB>`;
    });
    requests.forEach((r) => {
      const fake = String(r.key).startsWith('image') ? `SIMULADO-${crypto.randomBytes(8).toString('hex')}` : `SIMULADO-${r.key}-${crypto.randomBytes(4).toString('hex')}`;
      vars[r.sets] = fake;
      if (r.record) {
        ids[r.record.key] = fake;
        created.push({ type: r.record.type, name: r.record.name, id: fake });
      }
    });
    return { mock: true, platform: 'meta', ids, created, warnings: ctx.warnings, requests: previewOf(requests, vars, META_BASE) };
  }

  const vars = { ...imageVars };
  const ids = {};
  const created = [];
  try {
    for (const r of requests) {
      const out = await metaRequest('POST', r.path, fill(r.params, vars));
      const value = r.pick(out);
      if (!value) throw publishError(`Meta: resposta sem ID ao criar ${r.label.toLowerCase()}.`);
      vars[r.sets] = value;
      if (r.record) {
        ids[r.record.key] = value;
        created.push({ type: r.record.type, name: r.record.name, id: value });
      }
      if (r.optOutCreative) await noteCreativeOptOut(value, ctx.warnings);
    }
  } catch (err) {
    err.partial = ids; // o que já foi criado (tudo PAUSADO)
    err.partialCreated = created;
    throw err;
  }
  return { mock: false, platform: 'meta', ids, created, warnings: ctx.warnings };
}

/* ===================== Google (Pesquisa) ===================== */

function cleanCid(id) { return String(id || '').replace(/\D/g, ''); }

function buildGoogleMutate(draft, account, ctx) {
  const s = draft.spec;
  const cid = cleanCid(account.google.customerId);
  const base = `customers/${cid}`;
  const budgetRn = `${base}/campaignBudgets/-1`;
  const campaignRn = `${base}/campaigns/-2`;
  const adGroupRn = `${base}/adGroups/-3`;
  const micros = (v) => String(Math.round(v * 100) * 10000);
  const today = spec.todaySP();

  const campaign = {
    resourceName: campaignRn,
    name: draft.name,
    status: 'PAUSED',
    advertisingChannelType: 'SEARCH',
    campaignBudget: budgetRn,
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: s.searchPartners,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    },
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  };
  if (s.bidding === 'maximize_clicks') campaign.targetSpend = s.cpcBid ? { cpcBidCeilingMicros: micros(s.cpcBid) } : {};
  if (s.bidding === 'maximize_conversions') campaign.maximizeConversions = {};
  if (s.bidding === 'manual_cpc') campaign.manualCpc = { enhancedCpcEnabled: false };
  if (s.startDate > today) campaign.startDateTime = `${s.startDate} 00:00:00`;
  if (s.endDate) campaign.endDateTime = `${s.endDate} 23:59:59`;

  const ops = [
    { campaignBudgetOperation: { create: { resourceName: budgetRn, name: `${draft.name} | Orçamento ${draft.id.slice(0, 6)}`, amountMicros: micros(s.budget), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: campaign } },
  ];
  const locations = ctx.cityGeo.length ? ctx.cityGeo : [`geoTargetConstants/${spec.GOOGLE_COUNTRIES[s.country]}`];
  locations.forEach((g) => ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, location: { geoTargetConstant: g } } } }));
  ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, language: { languageConstant: `languageConstants/${spec.LANGUAGES[s.language]}` } } } });
  s.negatives.forEach((text) => ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, negative: true, keyword: { text, matchType: 'BROAD' } } } }));

  const adGroup = { resourceName: adGroupRn, name: `${draft.name} | Grupo 1`, campaign: campaignRn, status: 'ENABLED', type: 'SEARCH_STANDARD' };
  if (s.bidding === 'manual_cpc') adGroup.cpcBidMicros = micros(s.cpcBid);
  ops.push({ adGroupOperation: { create: adGroup } });
  s.keywords.forEach((k) => ops.push({ adGroupCriterionOperation: { create: { adGroup: adGroupRn, status: 'ENABLED', keyword: { text: k.text, matchType: k.match } } } }));
  const rsa = { headlines: s.headlines.map((text) => ({ text })), descriptions: s.descriptions.map((text) => ({ text })) };
  if (s.path1) rsa.path1 = s.path1;
  if (s.path1 && s.path2) rsa.path2 = s.path2;
  ops.push({ adGroupAdOperation: { create: { adGroup: adGroupRn, status: 'ENABLED', ad: { finalUrls: [s.finalUrl], responsiveSearchAd: rsa } } } });

  return { url: `https://googleads.googleapis.com/${GOOGLE_API}/${base}/googleAds:mutate`, body: { mutateOperations: ops } };
}

async function googlePost(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'developer-token': config.google.developerToken,
      'login-customer-id': cleanCid(config.google.loginCustomerId),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (json.error) {
    const details = (json.error.details || []).flatMap((d) => d.errors || [])
      .map((e) => `${e.errorCode ? Object.values(e.errorCode).join('/') : ''} ${e.message || ''}`.trim());
    const all = `${json.error.message}${details.length ? ': ' + details.join(' | ') : ''}`;
    let hint = '';
    if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts/i.test(all)) hint = ' (o developer token ainda está em "Acesso de teste"; peça acesso Básico ou Standard no Centro de API da MCC)';
    else if (/USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/i.test(all)) hint = ' (a MCC não gerencia essa conta ou a conta não está ativa)';
    throw publishError(`Google Ads: ${all}${hint}`);
  }
  return json;
}

async function publishGoogle(draft, account, live) {
  const s = draft.spec;
  const warnings = [];
  if (s.bidding === 'maximize_conversions') warnings.push('Maximizar conversões só funciona bem com conversões configuradas na conta do Google Ads.');
  if (!live) {
    const cityGeo = s.cities.map((c) => `<geoTargetConstant da cidade "${c}">`);
    const { url, body } = buildGoogleMutate(draft, account, { cityGeo });
    const fake = `SIMULADO-${crypto.randomBytes(4).toString('hex')}`;
    return {
      mock: true, platform: 'google', ids: { campaign: `customers/${cleanCid(account.google.customerId)}/campaigns/${fake}` },
      warnings, requests: [{ label: 'Criação em lote (orçamento, campanha, segmentação, grupo, palavras-chave e anúncio)', method: 'POST', url, params: body }],
    };
  }
  const token = await googleService.getAccessToken();
  const cid = cleanCid(account.google.customerId);
  const info = await googleService.runGAQL(cid, 'SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1', token, 'conta');
  const currency = info[0]?.customer?.currencyCode;
  if (currency && currency !== draft.currency) {
    throw publishError(`A conta do Google Ads está em ${currency}, mas o rascunho foi feito em ${draft.currency}. Ajuste o orçamento antes de publicar.`);
  }
  const cityGeo = [];
  if (s.cities.length) {
    const r = await googlePost(`https://googleads.googleapis.com/${GOOGLE_API}/geoTargetConstants:suggest`, {
      locale: s.language, countryCode: s.country, locationNames: { names: s.cities },
    }, token);
    for (const city of s.cities) {
      const hit = (r.geoTargetConstantSuggestions || []).find((x) => x.searchString === city && x.geoTargetConstant?.targetType === 'City')
        || (r.geoTargetConstantSuggestions || []).find((x) => x.searchString === city);
      if (!hit) throw publishError(`O Google não encontrou a cidade "${city}". Confira o nome no rascunho.`);
      cityGeo.push(hit.geoTargetConstant.resourceName);
    }
  }
  const { url, body } = buildGoogleMutate(draft, account, { cityGeo });
  const out = await googlePost(url, body, token);
  const campaignRn = (out.mutateOperationResponses || []).map((x) => x.campaignResult?.resourceName).find(Boolean);
  return { mock: false, platform: 'google', ids: { campaign: campaignRn || null }, warnings };
}

/* ===================== Entrada ===================== */

async function publish(draft, account, { image, images } = {}) {
  const r = readiness(draft.platform);
  if (!r.ok) throw publishError(`Publicação real desligada. Falta configurar: ${r.missing.join(', ')}.`, { status: 409 });
  const live = r.mode === 'real';
  if (draft.platform === 'meta') {
    const ids = spec.collectAssetIds(draft.spec, draft.name);
    const map = { ...(images || {}) };
    if (image && ids.length === 1 && !map[ids[0]]) map[ids[0]] = image;
    if (!ids.length || ids.some((id) => !map[id])) {
      throw publishError('Imagem do anúncio não encontrada. Envie a imagem de novo.', { status: 400 });
    }
    return publishMeta(draft, account, map, live);
  }
  return publishGoogle(draft, account, live);
}

// Confere se o token da Meta tem ads_management (necessário pra criar anúncios).
async function metaWriteCheck() {
  if (config.useMockData || !config.meta.systemUserToken) return null;
  try {
    const r = await metaRequest('GET', 'me/permissions');
    const granted = (r.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    return granted.includes('ads_management');
  } catch (_) {
    return null;
  }
}

module.exports = {
  publish, readiness, metaWriteCheck, buildMetaRequests, buildGoogleMutate, minorUnits, tzSuffix, metaRequest, googlePost, GOOGLE_API,
  creativeOptOutSpec, ADVANTAGE_CREATIVE_FEATURES,
};
