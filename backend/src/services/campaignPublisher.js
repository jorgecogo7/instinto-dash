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

/**
 * Monta, em ordem, as chamadas de criação na Meta. `ctx` traz o que depende de
 * consulta prévia (fuso da conta, chaves de cidade, interesses, hash da imagem).
 * Valores como {campaign_id} são trocados pelo ID real durante a execução.
 */
function buildMetaRequests(draft, account, ctx) {
  const s = draft.spec;
  const m = account.meta || {};
  const act = metaService.normalizeAdAccountId(m.adAccountId || '');
  const obj = OBJECTIVES[s.objective];
  const name = draft.name;
  const budgetKey = s.budgetType === 'lifetime' ? 'lifetime_budget' : 'daily_budget';
  const today = spec.todaySP();

  const targeting = {
    geo_locations: ctx.cityKeys.length
      ? { cities: ctx.cityKeys.map((key) => ({ key })) }
      : { countries: s.audience.countries },
    age_min: s.audience.ageMin,
    age_max: s.audience.ageMax,
    targeting_automation: { advantage_audience: s.audience.advantage ? 1 : 0 },
  };
  if (s.audience.gender === 'male') targeting.genders = [1];
  if (s.audience.gender === 'female') targeting.genders = [2];
  if (ctx.interests.length) targeting.flexible_spec = [{ interests: ctx.interests }];
  if (s.placements.mode === 'manual') {
    const platforms = new Set();
    const fb = []; const ig = [];
    s.placements.positions.forEach((p) => {
      const [plat, pos] = POSITION_MAP[p];
      platforms.add(plat);
      (plat === 'facebook' ? fb : ig).push(pos);
    });
    targeting.publisher_platforms = [...platforms];
    if (fb.length) targeting.facebook_positions = fb;
    if (ig.length) targeting.instagram_positions = ig;
  }

  const adset = {
    name: `${name} | Conjunto`,
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
  if (s.audience.countries.some((c) => spec.EU.includes(c))) {
    adset.dsa_beneficiary = s.dsa.beneficiary;
    adset.dsa_payor = s.dsa.payor;
  }

  const linkData = {
    image_hash: '{image_hash}',
    message: s.creative.primaryText,
    name: s.creative.headline,
  };
  if (s.creative.description) linkData.description = s.creative.description;
  if (s.objective === 'mensagens') {
    linkData.link = 'https://api.whatsapp.com/send';
    linkData.call_to_action = { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } };
  } else {
    linkData.link = s.creative.link;
    if (s.creative.cta) linkData.call_to_action = { type: s.creative.cta, value: { link: s.creative.link } };
  }
  const storySpec = { page_id: m.pageId, link_data: linkData };
  if (m.igBusinessId) storySpec.instagram_user_id = m.igBusinessId;

  return [
    {
      key: 'image', label: 'Imagem do anúncio', method: 'POST', path: `${act}/adimages`,
      params: { bytes: '{image_base64}' }, pick: (r) => Object.values(r.images || {})[0]?.hash, sets: 'image_hash',
    },
    {
      key: 'campaign', label: 'Campanha', method: 'POST', path: `${act}/campaigns`,
      params: {
        name,
        objective: obj.objective,
        status: 'PAUSED',
        buying_type: 'AUCTION',
        special_ad_categories: s.specialAdCategory === 'NONE' ? [] : [s.specialAdCategory],
        [budgetKey]: minorUnits(s.budget, draft.currency),
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      },
      pick: (r) => r.id, sets: 'campaign_id',
    },
    { key: 'adset', label: 'Conjunto de anúncios', method: 'POST', path: `${act}/adsets`, params: adset, pick: (r) => r.id, sets: 'adset_id' },
    {
      key: 'creative', label: 'Criativo', method: 'POST', path: `${act}/adcreatives`,
      params: { name: `${name} | Criativo`, object_story_spec: storySpec }, pick: (r) => r.id, sets: 'creative_id',
    },
    {
      key: 'ad', label: 'Anúncio', method: 'POST', path: `${act}/ads`,
      params: { name: `${name} | Anúncio`, adset_id: '{adset_id}', creative: { creative_id: '{creative_id}' }, status: 'PAUSED' },
      pick: (r) => r.id, sets: 'ad_id',
    },
  ];
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

async function resolveMetaContext(draft, account, live) {
  const s = draft.spec;
  const warnings = [];
  if (!live) {
    return {
      tz: '-0300',
      cityKeys: s.audience.cities.map((c) => `<chave da cidade "${c}">`),
      interests: s.audience.interests.map((i) => ({ id: `<id do interesse "${i}">`, name: i })),
      warnings,
    };
  }
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  const info = await metaRequest('GET', act, { fields: 'currency,timezone_offset_hours_utc,account_status' });
  if (info.currency && info.currency !== draft.currency) {
    throw publishError(`A conta da Meta está em ${info.currency}, mas o rascunho foi feito em ${draft.currency}. Ajuste o orçamento antes de publicar.`);
  }
  const cityKeys = [];
  for (const city of s.audience.cities) {
    const r = await metaRequest('GET', 'search', {
      type: 'adgeolocation', q: city, location_types: ['city'], country_code: s.audience.countries[0], limit: 1,
    });
    const hit = (r.data || [])[0];
    if (!hit) throw publishError(`A Meta não encontrou a cidade "${city}". Confira o nome no rascunho.`);
    cityKeys.push(hit.key);
  }
  const interests = [];
  for (const term of s.audience.interests) {
    const r = await metaRequest('GET', 'search', { type: 'adinterest', q: term, limit: 1 });
    const hit = (r.data || [])[0];
    if (hit) interests.push({ id: hit.id, name: hit.name });
    else warnings.push(`Interesse "${term}" não encontrado na Meta e ficou de fora.`);
  }
  if (!account.meta.igBusinessId) warnings.push('Cliente sem Instagram vinculado: o anúncio usa a identidade da Página no Instagram.');
  return { tz: tzSuffix(info.timezone_offset_hours_utc), cityKeys, interests, warnings };
}

function previewOf(requests, vars, base) {
  return requests.map((r) => ({
    label: r.label, method: r.method, url: `${base}/${r.path}`,
    params: fill(r.params, { ...vars, image_base64: `<imagem em base64, ${vars.image_kb} KB>` }),
  }));
}

async function publishMeta(draft, account, image, live) {
  const ctx = await resolveMetaContext(draft, account, live);
  const requests = buildMetaRequests(draft, account, ctx);
  const imageKb = Math.round(image.size / 1024);
  if (!live) {
    const ids = {};
    const vars = { image_kb: imageKb };
    requests.forEach((r) => {
      const fake = r.key === 'image' ? `SIMULADO-${crypto.randomBytes(8).toString('hex')}` : `SIMULADO-${r.key}-${crypto.randomBytes(4).toString('hex')}`;
      vars[r.sets] = fake;
      if (r.key !== 'image') ids[r.key] = fake;
    });
    return { mock: true, platform: 'meta', ids, warnings: ctx.warnings, requests: previewOf(requests, { ...vars, image_hash: '{image_hash}', campaign_id: '{campaign_id}', adset_id: '{adset_id}', creative_id: '{creative_id}' }, META_BASE) };
  }

  const vars = { image_base64: Buffer.from(image.data).toString('base64') };
  const ids = {};
  try {
    for (const r of requests) {
      const out = await metaRequest('POST', r.path, fill(r.params, vars));
      const value = r.pick(out);
      if (!value) throw publishError(`Meta: resposta sem ID ao criar ${r.label.toLowerCase()}.`);
      vars[r.sets] = value;
      if (r.key !== 'image') ids[r.key] = value;
    }
  } catch (err) {
    err.partial = ids; // o que já foi criado (tudo PAUSADO)
    throw err;
  }
  return { mock: false, platform: 'meta', ids, warnings: ctx.warnings };
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

async function publish(draft, account, { image } = {}) {
  const r = readiness(draft.platform);
  if (!r.ok) throw publishError(`Publicação real desligada. Falta configurar: ${r.missing.join(', ')}.`, { status: 409 });
  const live = r.mode === 'real';
  if (draft.platform === 'meta') {
    if (!image) throw publishError('Imagem do anúncio não encontrada. Envie a imagem de novo.', { status: 400 });
    return publishMeta(draft, account, image, live);
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

module.exports = { publish, readiness, metaWriteCheck, buildMetaRequests, buildGoogleMutate, minorUnits, tzSuffix };
