/**
 * Diagnóstico de campanhas para os gestores (somente leitura).
 *
 * Responde "por que os leads chegam desqualificados ou em pouca quantidade":
 * junta num lugar só como cada campanha está montada (objetivo, otimização,
 * lance, orçamento, público, posicionamentos, criativo, formulário) e o que
 * cada anúncio entregou no período.
 *
 * Regras:
 * - Só consultas GET na Meta e SELECT (GAQL) no Google. Nada aqui cria,
 *   edita, pausa ou publica.
 * - Cada consulta é tolerante: se a API recusar uma parte, ela volta em
 *   `errors` e o resto do diagnóstico segue.
 * - Sem credenciais reais (modo demonstração), não inventa nada: devolve
 *   available=false com testMode=true.
 */
const metaService = require('./metaService');
const googleService = require('./googleService');
const { CREATIVE_FIELDS, pickCreativeMedia } = require('../lib/metaCreative');
const cache = require('../lib/cache');

const CACHE_TTL_S = 300;
const MAX_ITEMS = 150; // teto por lista pra resposta não explodir

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
const names = (list) => (Array.isArray(list) ? list.map((x) => x && (x.name || x.id || x.key)).filter(Boolean) : []);
const errMsg = (e) => String((e && e.message) || e || 'erro desconhecido').slice(0, 400);

/* ============================== META ============================== */

// Orçamento da Meta vem na menor unidade da moeda (centavos).
const minorToMajor = (v) => (v === undefined || v === null || v === '' ? null : round(num(v) / 100));

const GENDERS = { 1: 'masculino', 2: 'feminino' };

// Resume o targeting do conjunto num formato fácil de ler. O objeto cru
// também vai junto (targetingRaw) pra quem quiser o detalhe completo.
function summarizeTargeting(t) {
  if (!t || typeof t !== 'object') return null;
  const geo = t.geo_locations || {};
  const exGeo = t.excluded_geo_locations || {};
  const geoSummary = (g) => ({
    countries: g.countries || [],
    regions: names(g.regions),
    cities: (g.cities || []).map((c) => (c.radius ? `${c.name || c.key} (+${c.radius} ${c.distance_unit || 'km'})` : (c.name || c.key))).filter(Boolean),
    zips: names(g.zips),
    customLocations: (g.custom_locations || []).map((c) => (c.name || c.address_string || `${c.latitude},${c.longitude}`) + (c.radius ? ` (+${c.radius} ${c.distance_unit || 'km'})` : '')),
    locationTypes: g.location_types || [],
  });
  const flex = Array.isArray(t.flexible_spec) ? t.flexible_spec : [];
  const pick = (key) => flex.flatMap((f) => names(f[key])).concat(names(t[key]));
  const exclusions = t.exclusions || {};
  const automation = t.targeting_automation || {};
  const placementsAuto = !t.publisher_platforms;
  return {
    ageMin: t.age_min ?? null,
    ageMax: t.age_max ?? null,
    genders: Array.isArray(t.genders) && t.genders.length ? t.genders.map((g) => GENDERS[g] || String(g)) : ['todos'],
    geo: geoSummary(geo),
    excludedGeo: geoSummary(exGeo),
    interests: pick('interests'),
    behaviors: pick('behaviors'),
    lifeEvents: pick('life_events'),
    workPositions: pick('work_positions'),
    educationStatuses: flex.flatMap((f) => f.education_statuses || []),
    excludedInterests: names(exclusions.interests).concat(names(exclusions.behaviors)),
    customAudiences: names(t.custom_audiences),
    excludedCustomAudiences: names(t.excluded_custom_audiences),
    advantageAudience: automation.advantage_audience === undefined ? null : automation.advantage_audience === 1,
    locales: t.locales || [],
    placements: placementsAuto
      ? { automatic: true }
      : {
        automatic: false,
        publisherPlatforms: t.publisher_platforms || [],
        facebook: t.facebook_positions || [],
        instagram: t.instagram_positions || [],
        messenger: t.messenger_positions || [],
        audienceNetwork: t.audience_network_positions || [],
        devicePlatforms: t.device_platforms || [],
      },
  };
}

// Todos os lugares onde o criativo pode guardar o CTA.
function creativeCtas(c) {
  if (!c) return [];
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  return [
    oss.link_data && oss.link_data.call_to_action,
    oss.video_data && oss.video_data.call_to_action,
    oss.template_data && oss.template_data.call_to_action,
    ...(Array.isArray(afs.call_to_actions) ? afs.call_to_actions : []),
    c.call_to_action,
  ].filter(Boolean);
}

function formIdsFromCreative(c) {
  const ids = creativeCtas(c).map((cta) => cta.value && cta.value.lead_gen_form_id).filter(Boolean);
  return [...new Set(ids.map(String))];
}

const WA_RE = /(wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i;

// Para onde o anúncio leva: formulário, WhatsApp, Messenger, Direct ou site.
function adDestination(creative, adset) {
  const dt = String((adset && adset.destination_type) || '').toUpperCase();
  const ctas = creativeCtas(creative);
  const ctaTypes = ctas.map((x) => x.type).filter(Boolean);
  const oss = (creative && creative.object_story_spec) || {};
  const afs = (creative && creative.asset_feed_spec) || {};
  const links = [
    creative && creative.link_url,
    creative && creative.object_url,
    oss.link_data && oss.link_data.link,
    ...ctas.map((x) => x.value && x.value.link),
    ...(Array.isArray(afs.link_urls) ? afs.link_urls.map((l) => l.website_url) : []),
  ].filter((l) => typeof l === 'string' && l);
  const formIds = formIdsFromCreative(creative);
  let type = 'site';
  if (formIds.length || dt === 'ON_AD') type = 'formulario';
  else if (dt.includes('WHATSAPP') || ctaTypes.includes('WHATSAPP_MESSAGE') || links.some((l) => WA_RE.test(l))) type = 'whatsapp';
  else if (dt.includes('INSTAGRAM_DIRECT')) type = 'instagram_direct';
  else if (dt.includes('MESSENGER') || ctaTypes.includes('MESSAGE_PAGE')) type = 'messenger';
  else if (dt === 'ON_POST' || dt === 'ON_PAGE' || dt === 'ON_VIDEO') type = 'engajamento';
  else if (!links.length && !dt) type = 'desconhecido';
  return { type, destinationType: dt || null, ctaTypes: [...new Set(ctaTypes)], urls: [...new Set(links)].slice(0, 5), leadFormIds: formIds };
}

// Textos do criativo, incluindo variações do Advantage+ (asset_feed_spec).
function creativeTexts(c) {
  if (!c) return null;
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const afs = c.asset_feed_spec || {};
  const texts = (list) => (Array.isArray(list) ? list.map((x) => clean(x && x.text)).filter(Boolean) : []);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const media = pickCreativeMedia(c) || {};
  return {
    primaryTexts: uniq([clean(ld.message), clean(vd.message), clean(c.body), ...texts(afs.bodies)]),
    headlines: uniq([clean(ld.name), clean(vd.title), clean(c.title), ...texts(afs.titles)]),
    descriptions: uniq([clean(ld.description), clean(vd.link_description), ...texts(afs.descriptions)]),
    format: media.format || null,
    dynamic: Boolean(media.dynamic),
    thumbnailUrl: c.thumbnail_url || null,
    imageUrl: media.imageUrl || c.image_url || null,
  };
}

const RELEVANT_ACTIONS = /^(lead|onsite_conversion\.lead_grouped|offsite_conversion\.fb_pixel_lead|onsite_conversion\.messaging_conversation_started_7d|onsite_conversion\.messaging_first_reply|onsite_conversion\.total_messaging_connection|link_click|landing_page_view|omni_complete_registration|purchase|omni_purchase|offsite_conversion\.fb_pixel_purchase|contact_total|onsite_conversion\.flow_complete)$/;

function insightMetrics(row) {
  if (!row) return null;
  const spend = num(row.spend);
  const result = metaService.pickResult(row.actions);
  const actions = {};
  (row.actions || []).forEach((a) => { if (RELEVANT_ACTIONS.test(a.action_type)) actions[a.action_type] = num(a.value); });
  return {
    spend: round(spend),
    impressions: Math.round(num(row.impressions)),
    reach: Math.round(num(row.reach)),
    clicks: Math.round(num(row.clicks)),
    ctr: round(row.ctr),
    cpc: round(row.cpc),
    cpm: round(row.cpm),
    frequency: round(row.frequency),
    resultType: result.type,
    resultLabel: result.type ? (metaService.RESULT_LABELS && metaService.RESULT_LABELS[result.type]) || result.type : null,
    results: result.value,
    costPerResult: result.value ? round(spend / result.value) : null,
    actions,
  };
}

function sumMetrics(list) {
  const t = { spend: 0, impressions: 0, clicks: 0, results: 0 };
  list.forEach((m) => { if (!m) return; t.spend += m.spend; t.impressions += m.impressions; t.clicks += m.clicks; t.results += m.results; });
  return {
    spend: round(t.spend),
    impressions: t.impressions,
    clicks: t.clicks,
    ctr: t.impressions ? round((t.clicks / t.impressions) * 100) : 0,
    cpc: t.clicks ? round(t.spend / t.clicks) : 0,
    results: t.results,
    costPerResult: t.results ? round(t.spend / t.results) : null,
  };
}

function summarizeForm(f) {
  if (!f) return null;
  const questions = (f.questions || []).map((q) => ({
    key: q.key || null,
    type: q.type || null,
    label: q.label || null,
    options: Array.isArray(q.options) ? q.options.map((o) => o.value || o.key).filter(Boolean) : [],
    conditional: Boolean(q.conditional_questions_group_id || q.dependent_conditional_questions),
  }));
  const custom = questions.filter((q) => q.type === 'CUSTOM' || q.options.length);
  return {
    id: String(f.id),
    name: f.name || null,
    status: f.status || null,
    locale: f.locale || null,
    // true = "Maior intenção" (tela de revisão antes de enviar); false = "Mais volume".
    higherIntent: f.is_optimized_for_quality === undefined ? null : Boolean(f.is_optimized_for_quality),
    leadsCount: f.leads_count === undefined ? null : num(f.leads_count),
    questions,
    customQuestionsCount: custom.length,
    contextCard: f.context_card ? { title: f.context_card.title || null, style: f.context_card.style || null, content: f.context_card.content || [] } : null,
    thankYouPage: f.thank_you_page ? { title: f.thank_you_page.title || null, body: f.thank_you_page.body || null, buttonType: f.thank_you_page.button_type || null } : null,
    privacyPolicyUrl: (f.privacy_policy_url) || null,
    blockNonTargeted: f.block_display_for_non_targeted_viewer === undefined ? null : Boolean(f.block_display_for_non_targeted_viewer),
  };
}

// Sinais automáticos: regras fixas e explícitas sobre os dados acima. Não
// são opinião do sistema; servem de ponto de partida pro gestor investigar.
function metaSignals(d) {
  const out = [];
  const add = (level, scope, rule, message) => out.push({ level, scope, rule, message });
  d.leadForms.forEach((f) => {
    if (f.higherIntent === false) add('atencao', `formulario ${f.name || f.id}`, 'form_more_volume', 'Formulário em "Mais volume" (sem tela de revisão). Costuma trazer mais lead desqualificado; avalie "Maior intenção".');
    if (f.customQuestionsCount === 0) add('info', `formulario ${f.name || f.id}`, 'form_no_qualifying_question', 'Formulário sem pergunta personalizada de qualificação; só dados pré-preenchidos.');
  });
  d.adSets.forEach((s) => {
    const scope = `conjunto ${s.name}`;
    const t = s.targeting || {};
    if (t.advantageAudience === true) add('info', scope, 'advantage_audience_on', 'Público Advantage+ ligado: a Meta pode entregar fora da idade/interesses definidos (viram sugestão).');
    if (t.placements && t.placements.automatic) add('info', scope, 'placements_auto', 'Posicionamentos automáticos (inclui Audience Network e outros de menor intenção).');
    else if (t.placements && (t.placements.publisherPlatforms || []).includes('audience_network')) add('atencao', scope, 'audience_network', 'Audience Network ativo; costuma gerar clique/lead de baixa qualidade.');
    if (s.metrics && s.metrics.frequency > 3.5) add('atencao', scope, 'high_frequency', `Frequência ${s.metrics.frequency} no período: público saturado.`);
    if (s.metrics && s.metrics.spend > 0 && !s.metrics.results) add('atencao', scope, 'spend_no_results', 'Gastou no período e não gerou resultado.');
    if (/LINK_CLICKS|IMPRESSIONS|REACH|LANDING_PAGE_VIEWS|POST_ENGAGEMENT/.test(s.optimizationGoal || '') && d.campaigns.some((c) => c.id === s.campaignId && /LEADS|MESSAGES|CONVERSIONS|OUTCOME_LEADS/.test(c.objective || ''))) {
      add('atencao', scope, 'optimization_mismatch', `Otimização ${s.optimizationGoal} numa campanha de ${d.campaigns.find((c) => c.id === s.campaignId).objective}: a Meta busca cliques/alcance, não leads.`);
    }
  });
  d.ads.forEach((a) => {
    if (a.metrics && a.metrics.impressions > 1000 && a.metrics.ctr < 0.8) add('info', `anúncio ${a.name}`, 'low_ctr', `CTR ${a.metrics.ctr}% com ${a.metrics.impressions} impressões.`);
  });
  return out;
}

const timeRange = (range) => JSON.stringify({ since: range.from, until: range.to });

const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,destination_type,promoted_object,targeting,attribution_spec,start_time,end_time';
const ADSET_FIELDS_MIN = 'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,destination_type,targeting';
const FORM_FIELDS = 'id,name,status,locale,questions,is_optimized_for_quality,leads_count,context_card,thank_you_page,privacy_policy_url,block_display_for_non_targeted_viewer';
const FORM_FIELDS_MIN = 'id,name,status,questions';

async function fetchMetaDiagnostics(adAccountId, range, deps = {}) {
  const graphGet = deps.graphGet || metaService.graphGet;
  const graphGetAll = deps.graphGetAll || metaService.graphGetAll;
  const act = metaService.normalizeAdAccountId(adAccountId);
  const errors = {};
  const safe = async (key, fn, fallback) => {
    try { return await fn(); } catch (e) {
      if (fallback) { try { return await fallback(); } catch (e2) { errors[key] = errMsg(e2); return null; } }
      errors[key] = errMsg(e); return null;
    }
  };
  const live = (x) => /ACTIVE|IN_PROCESS|WITH_ISSUES|PENDING/.test(x.effective_status || '');

  const [account, insightRows, campaignsRaw, adsetsRaw, adsRaw] = await Promise.all([
    safe('account', () => graphGet(act, { fields: 'id,name,currency,timezone_name,account_status' })),
    safe('insights', () => graphGetAll(`${act}/insights`, {
      level: 'ad', time_range: timeRange(range), limit: 500,
      fields: 'campaign_id,adset_id,ad_id,ad_name,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type',
    }, 10)),
    safe('campaigns', () => graphGetAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,start_time,stop_time', limit: 200 }, 5)),
    safe('adsets', () => graphGetAll(`${act}/adsets`, { fields: ADSET_FIELDS, limit: 200 }, 5),
      () => graphGetAll(`${act}/adsets`, { fields: ADSET_FIELDS_MIN, limit: 200 }, 5)),
    safe('ads', () => graphGetAll(`${act}/ads`, { fields: `id,name,adset_id,campaign_id,status,effective_status,creative{${CREATIVE_FIELDS},call_to_action_type,link_url,object_url}`, limit: 200 }, 5)),
  ]);

  const byAd = new Map();
  (insightRows || []).forEach((r) => byAd.set(String(r.ad_id), insightMetrics(r)));
  const spentAd = (id) => { const m = byAd.get(String(id)); return m && (m.spend > 0 || m.impressions > 0); };

  // Só o que rodou no período ou está ativo agora.
  const ads = (adsRaw || []).filter((a) => live(a) || spentAd(a.id)).slice(0, MAX_ITEMS);
  const adsetIds = new Set(ads.map((a) => String(a.adset_id)));
  (insightRows || []).forEach((r) => adsetIds.add(String(r.adset_id)));
  const adsetsList = (adsetsRaw || []).filter((s) => adsetIds.has(String(s.id)) || live(s)).slice(0, MAX_ITEMS);
  const adsetById = new Map(adsetsList.map((s) => [String(s.id), s]));
  const campaignIds = new Set(adsetsList.map((s) => String(s.campaign_id)));
  (insightRows || []).forEach((r) => campaignIds.add(String(r.campaign_id)));
  const campaignsList = (campaignsRaw || []).filter((c) => campaignIds.has(String(c.id)) || live(c)).slice(0, MAX_ITEMS);

  const adsOut = ads.map((a) => {
    const adset = adsetById.get(String(a.adset_id));
    return {
      id: String(a.id), name: a.name || null, campaignId: String(a.campaign_id), adSetId: String(a.adset_id),
      status: a.effective_status || a.status || null,
      creative: creativeTexts(a.creative),
      destination: adDestination(a.creative, adset),
      metrics: byAd.get(String(a.id)) || null,
    };
  });

  const adSets = adsetsList.map((s) => {
    const mine = adsOut.filter((a) => a.adSetId === String(s.id));
    const rows = (insightRows || []).filter((r) => String(r.adset_id) === String(s.id));
    const m = sumMetrics(rows.map(insightMetrics));
    const freq = rows.length ? round(Math.max(...rows.map((r) => num(r.frequency)))) : 0;
    return {
      id: String(s.id), name: s.name || null, campaignId: String(s.campaign_id), status: s.effective_status || s.status || null,
      optimizationGoal: s.optimization_goal || null, billingEvent: s.billing_event || null,
      bidStrategy: s.bid_strategy || null, bidAmount: minorToMajor(s.bid_amount),
      dailyBudget: minorToMajor(s.daily_budget), lifetimeBudget: minorToMajor(s.lifetime_budget),
      destinationType: s.destination_type || null, promotedObject: s.promoted_object || null,
      attribution: s.attribution_spec || null,
      targeting: summarizeTargeting(s.targeting), targetingRaw: s.targeting || null,
      metrics: { ...m, frequency: freq, adsCount: mine.length },
    };
  });

  const campaigns = campaignsList.map((c) => {
    const rows = (insightRows || []).filter((r) => String(r.campaign_id) === String(c.id));
    return {
      id: String(c.id), name: c.name || null, status: c.effective_status || c.status || null,
      objective: c.objective || null, buyingType: c.buying_type || null, bidStrategy: c.bid_strategy || null,
      dailyBudget: minorToMajor(c.daily_budget), lifetimeBudget: minorToMajor(c.lifetime_budget),
      budgetLevel: c.daily_budget || c.lifetime_budget ? 'campanha (CBO/Advantage+)' : 'conjunto',
      specialAdCategories: c.special_ad_categories || [],
      metrics: sumMetrics(rows.map(insightMetrics)),
    };
  });

  // Formulários de lead usados pelos anúncios.
  const formIds = [...new Set(adsOut.flatMap((a) => a.destination.leadFormIds))].slice(0, 20);
  const leadForms = (await Promise.all(formIds.map((id) => safe(`leadForm:${id}`,
    () => graphGet(id, { fields: FORM_FIELDS }),
    () => graphGet(id, { fields: FORM_FIELDS_MIN }))))).filter(Boolean).map(summarizeForm);

  const d = {
    account: account ? { id: account.id, name: account.name || null, currency: account.currency || null, timezone: account.timezone_name || null } : null,
    currencyNote: 'Valores de orçamento e gasto na moeda da conta (account.currency).',
    totals: sumMetrics([...byAd.values()]),
    campaigns, adSets, ads: adsOut, leadForms,
  };
  d.signals = metaSignals(d);
  d.errors = errors;
  return d;
}

/* ============================= GOOGLE ============================= */

const micros = (v) => (v === undefined || v === null ? null : round(num(v) / 1_000_000));

function gMetrics(m) {
  m = m || {};
  const cost = num(m.costMicros) / 1_000_000;
  const conv = num(m.conversions);
  return {
    spend: round(cost), impressions: Math.round(num(m.impressions)), clicks: Math.round(num(m.clicks)),
    ctr: round(num(m.ctr) * 100), cpc: micros(m.averageCpc) || 0, conversions: round(conv),
    costPerConversion: conv ? round(cost / conv) : null,
  };
}

function googleSignals(d) {
  const out = [];
  const add = (level, scope, rule, message) => out.push({ level, scope, rule, message });
  d.campaigns.forEach((c) => {
    if (c.channelType === 'SEARCH' && c.network && c.network.contentNetwork) add('atencao', `campanha ${c.name}`, 'search_with_display', 'Campanha de pesquisa com Rede de Display ligada: tráfego de menor intenção.');
    if (c.channelType === 'SEARCH' && c.network && c.network.partnerNetwork) add('info', `campanha ${c.name}`, 'search_partners', 'Parceiros de pesquisa ligados.');
    if (c.metrics.spend > 0 && !c.metrics.conversions) add('atencao', `campanha ${c.name}`, 'spend_no_conversions', 'Gastou no período sem conversão.');
  });
  const broad = d.keywords.filter((k) => k.matchType === 'BROAD');
  if (broad.length) add('info', 'palavras-chave', 'broad_match', `${broad.length} palavra(s)-chave em correspondência ampla.`);
  const wasted = d.searchTerms.filter((s) => s.metrics.spend > 0 && !s.metrics.conversions && s.status !== 'EXCLUDED');
  if (wasted.length) add('info', 'termos de pesquisa', 'terms_without_conversion', `${wasted.length} termo(s) com gasto e sem conversão no período (candidatos a negativa).`);
  if (d.conversionActions && d.conversionActions.length) {
    const prim = d.conversionActions.filter((c) => c.primaryForGoal);
    if (prim.some((c) => /PAGE_VIEW|ENGAGEMENT|DEFAULT/.test(c.category || ''))) add('atencao', 'conversões', 'weak_primary_conversion', 'Há conversão primária de visualização/engajamento: o lance otimiza pra ela, não pra lead.');
  }
  return out;
}

async function fetchGoogleDiagnostics(customerId, range, deps = {}) {
  const runGAQL = deps.runGAQL || googleService.runGAQL;
  const getAccessToken = deps.getAccessToken || googleService.getAccessToken;
  const token = await getAccessToken();
  const errors = {};
  const dateFilter = `segments.date BETWEEN '${range.from}' AND '${range.to}'`;
  const q = async (key, query, fallback) => {
    try { return await runGAQL(customerId, query, token, key); } catch (e) {
      if (fallback) { try { return await runGAQL(customerId, fallback, token, key); } catch (e2) { errors[key] = errMsg(e2); return []; } }
      errors[key] = errMsg(e); return [];
    }
  };

  const [campRows, kwRows, negCampRows, negAgRows, termRows, adRows, convRows] = await Promise.all([
    q('campanhas', `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
             campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros,
             campaign.network_settings.target_search_network, campaign.network_settings.target_content_network,
             campaign.network_settings.target_partner_search_network,
             campaign_budget.amount_micros, campaign_budget.delivery_method,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions,
             metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
      FROM campaign WHERE ${dateFilter} AND campaign.status != 'REMOVED'`,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
             campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions
      FROM campaign WHERE ${dateFilter} AND campaign.status != 'REMOVED'`),
    q('palavras-chave', `
      SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.status, ad_group_criterion.quality_info.quality_score,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions
      FROM keyword_view WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT ${MAX_ITEMS}`),
    q('negativas (campanha)', `
      SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
      FROM campaign_criterion
      WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED'
      LIMIT 500`),
    q('negativas (grupo)', `
      SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
      FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE AND campaign.status != 'REMOVED'
      LIMIT 500`),
    q('termos de pesquisa', `
      SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, segments.search_term_match_type,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions
      FROM search_term_view WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT 200`,
    `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions
      FROM search_term_view WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT 200`),
    q('anúncios', `
      SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad_strength,
             ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
             ad_group_ad.policy_summary.approval_status,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions
      FROM ad_group_ad WHERE ${dateFilter} AND ad_group_ad.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC LIMIT 100`),
    q('ações de conversão', `
      SELECT conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.status,
             conversion_action.primary_for_goal, conversion_action.counting_type
      FROM conversion_action WHERE conversion_action.status = 'ENABLED'`),
  ]);

  // A consulta de campanha volta uma linha por campanha (sem segmentar por data).
  const campaigns = campRows.map((r) => {
    const c = r.campaign || {};
    const ns = c.networkSettings || {};
    const m = r.metrics || {};
    return {
      id: c.id ? String(c.id) : null, name: c.name || null, status: c.status || null,
      channelType: c.advertisingChannelType || null, channelSubType: c.advertisingChannelSubType || null,
      biddingStrategy: c.biddingStrategyType || null,
      targetCpa: micros((c.targetCpa || {}).targetCpaMicros) ?? micros((c.maximizeConversions || {}).targetCpaMicros),
      dailyBudget: micros((r.campaignBudget || {}).amountMicros),
      network: ns.targetSearchNetwork === undefined && ns.targetContentNetwork === undefined ? null
        : { search: Boolean(ns.targetSearchNetwork), contentNetwork: Boolean(ns.targetContentNetwork), partnerNetwork: Boolean(ns.targetPartnerSearchNetwork) },
      impressionShare: m.searchImpressionShare === undefined ? null : {
        share: round(num(m.searchImpressionShare) * 100), lostBudget: round(num(m.searchBudgetLostImpressionShare) * 100), lostRank: round(num(m.searchRankLostImpressionShare) * 100),
      },
      metrics: gMetrics(m),
    };
  });

  const keywords = kwRows.map((r) => {
    const k = (r.adGroupCriterion || {});
    return {
      campaign: (r.campaign || {}).name || null, adGroup: (r.adGroup || {}).name || null,
      text: (k.keyword || {}).text || null, matchType: (k.keyword || {}).matchType || null, status: k.status || null,
      qualityScore: (k.qualityInfo || {}).qualityScore ?? null, metrics: gMetrics(r.metrics),
    };
  });
  const negativeKeywords = [
    ...negCampRows.map((r) => ({ level: 'campanha', campaign: (r.campaign || {}).name || null, adGroup: null, text: ((r.campaignCriterion || {}).keyword || {}).text || null, matchType: ((r.campaignCriterion || {}).keyword || {}).matchType || null })),
    ...negAgRows.map((r) => ({ level: 'grupo', campaign: (r.campaign || {}).name || null, adGroup: (r.adGroup || {}).name || null, text: ((r.adGroupCriterion || {}).keyword || {}).text || null, matchType: ((r.adGroupCriterion || {}).keyword || {}).matchType || null })),
  ];
  const searchTerms = termRows.map((r) => ({
    term: (r.searchTermView || {}).searchTerm || null, status: (r.searchTermView || {}).status || null,
    campaign: (r.campaign || {}).name || null, adGroup: (r.adGroup || {}).name || null,
    matchType: (r.segments || {}).searchTermMatchType || null, metrics: gMetrics(r.metrics),
  }));
  const ads = adRows.map((r) => {
    const ga = r.adGroupAd || {};
    const ad = ga.ad || {};
    const rsa = ad.responsiveSearchAd || {};
    return {
      id: ad.id ? String(ad.id) : null, campaign: (r.campaign || {}).name || null, adGroup: (r.adGroup || {}).name || null,
      type: ad.type || null, status: ga.status || null, adStrength: ga.adStrength || null,
      approval: (ga.policySummary || {}).approvalStatus || null,
      headlines: (rsa.headlines || []).map((h) => h.text).filter(Boolean),
      descriptions: (rsa.descriptions || []).map((h) => h.text).filter(Boolean),
      finalUrls: ad.finalUrls || [],
      metrics: gMetrics(r.metrics),
    };
  });
  const conversionActions = convRows.map((r) => {
    const c = r.conversionAction || {};
    return { name: c.name || null, category: c.category || null, type: c.type || null, primaryForGoal: c.primaryForGoal === undefined ? null : Boolean(c.primaryForGoal), countingType: c.countingType || null };
  });

  const d = { campaigns, keywords, negativeKeywords, searchTerms, ads, conversionActions };
  d.signals = googleSignals(d);
  d.errors = errors;
  return d;
}

/* ============================ ENTRADA ============================ */

const DEMO_MSG = 'Servidor sem credenciais reais desta plataforma (modo demonstração). Diagnóstico indisponível; nenhum dado foi inventado.';

async function metaFor(account, range, deps) {
  if (account.meta?.status !== 'connected' || !account.meta.adAccountId) return { connected: false, available: false, error: 'Meta Ads não conectado para este cliente.' };
  const hasReal = deps && deps.metaReal !== undefined ? deps.metaReal : metaService.hasRealCredentials();
  if (!hasReal) return { connected: true, available: false, testMode: true, error: DEMO_MSG };
  const key = `diag:meta:${account.meta.adAccountId}:${range.from}:${range.to}`;
  const hit = !deps && cache.get(key);
  if (hit) return hit;
  try {
    const out = { connected: true, available: true, testMode: false, ...(await fetchMetaDiagnostics(account.meta.adAccountId, range, deps)) };
    if (!deps) cache.set(key, out, CACHE_TTL_S);
    return out;
  } catch (e) {
    return { connected: true, available: false, testMode: false, error: errMsg(e) };
  }
}

async function googleFor(account, range, deps) {
  if (account.google?.status !== 'connected' || !account.google.customerId) return { connected: false, available: false, error: 'Google Ads não conectado para este cliente.' };
  const hasReal = deps && deps.googleReal !== undefined ? deps.googleReal : googleService.hasRealCredentials();
  if (!hasReal) return { connected: true, available: false, testMode: true, error: DEMO_MSG };
  const key = `diag:google:${account.google.customerId}:${range.from}:${range.to}`;
  const hit = !deps && cache.get(key);
  if (hit) return hit;
  try {
    const out = { connected: true, available: true, testMode: false, ...(await fetchGoogleDiagnostics(account.google.customerId, range, deps)) };
    if (!deps) cache.set(key, out, CACHE_TTL_S);
    return out;
  } catch (e) {
    return { connected: true, available: false, testMode: false, error: errMsg(e) };
  }
}

module.exports = {
  metaFor, googleFor,
  fetchMetaDiagnostics, fetchGoogleDiagnostics,
  summarizeTargeting, adDestination, formIdsFromCreative, creativeTexts, summarizeForm, metaSignals, googleSignals,
};
