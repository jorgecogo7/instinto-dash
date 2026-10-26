/**
 * Métricas e prévia do criativo para a árvore do Gerenciar.
 *
 * Só leitura. Uma consulta por nível (campanha, conjunto, anúncio) no período
 * pedido, em vez de uma por item. Resultado em cache por alguns minutos; o
 * status (ligado/pausado) continua vindo sempre fresco da árvore.
 *
 * Nada é inventado: sem linha de insights no período, metrics fica null e o
 * painel mostra "-".
 */
const cache = require('../lib/cache');
const period = require('../lib/period');
const metaService = require('./metaService');
const googleService = require('./googleService');
const { PURCHASE_TYPES } = require('../lib/metaExtras');
const { CREATIVE_FIELDS, pickCreativeMedia, pendingLookups } = require('../lib/metaCreative');

const TTL = 5 * 60;
const MAX_DAYS = 400;

/* ===================== Período ===================== */

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
}

// Padrão: últimos 7 dias completos (termina ontem), no fuso de São Paulo.
function resolveRange(from, to) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
  if (!from && !to) {
    const range = period.defaultRange(7);
    return { from: range.from, to: range.to, days: 7, isDefault: true };
  }
  if (!ok(from) || !ok(to) || from > to) {
    const e = new Error('Período inválido. Use from e to no formato AAAA-MM-DD, com from antes de to.');
    e.status = 400;
    throw e;
  }
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) {
    const e = new Error(`Período longo demais (máximo ${MAX_DAYS} dias).`);
    e.status = 400;
    throw e;
  }
  return { from, to, days, isDefault: false };
}

/* ===================== Meta: qual é o "resultado" de cada item ===================== */

const META_KINDS = {
  messages: { label: 'Conversas iniciadas', costLabel: 'Custo por conversa', actions: ['onsite_conversion.messaging_conversation_started_7d'] },
  leads: { label: 'Leads', costLabel: 'Custo por lead', actions: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'] },
  purchases: { label: 'Compras', costLabel: 'Custo por compra', actions: PURCHASE_TYPES },
  registrations: { label: 'Cadastros', costLabel: 'Custo por cadastro', actions: ['omni_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration'] },
  landing_page_views: { label: 'Visualizações da página', costLabel: 'Custo por visualização', actions: ['landing_page_view', 'omni_landing_page_view'] },
  link_clicks: { label: 'Cliques no link', costLabel: 'Custo por clique', field: 'linkClicks' },
  reach: { label: 'Alcance', costLabel: 'Custo por mil pessoas', field: 'reach', perMille: true },
  impressions: { label: 'Impressões', costLabel: 'CPM', field: 'impressions', perMille: true },
  video_views: { label: 'ThruPlays', costLabel: 'Custo por ThruPlay', field: 'thruplays' },
  engagement: { label: 'Engajamentos', costLabel: 'Custo por engajamento', actions: ['post_engagement'] },
  app_installs: { label: 'Instalações', costLabel: 'Custo por instalação', actions: ['mobile_app_install', 'omni_app_install'] },
};

const GOAL_KIND = {
  CONVERSATIONS: 'messages', REPLIES: 'messages', MESSAGING_APPOINTMENT_CONVERSION: 'messages',
  MESSAGING_PURCHASE_CONVERSION: 'purchases',
  LEAD_GENERATION: 'leads', QUALITY_LEAD: 'leads', QUALITY_CALL: 'leads',
  LANDING_PAGE_VIEWS: 'landing_page_views', LINK_CLICKS: 'link_clicks',
  REACH: 'reach', IMPRESSIONS: 'impressions', AD_RECALL_LIFT: 'impressions',
  THRUPLAY: 'video_views', TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: 'video_views',
  POST_ENGAGEMENT: 'engagement', EVENT_RESPONSES: 'engagement',
  APP_INSTALLS: 'app_installs',
};
const EVENT_KIND = { PURCHASE: 'purchases', LEAD: 'leads', COMPLETE_REGISTRATION: 'registrations' };
const OBJECTIVE_KIND = {
  OUTCOME_SALES: 'purchases', OUTCOME_LEADS: 'leads', OUTCOME_TRAFFIC: 'link_clicks', OUTCOME_AWARENESS: 'reach',
  OUTCOME_APP_PROMOTION: 'app_installs', MESSAGES: 'messages', LEAD_GENERATION: 'leads', LINK_CLICKS: 'link_clicks',
  REACH: 'reach', BRAND_AWARENESS: 'reach', VIDEO_VIEWS: 'video_views', POST_ENGAGEMENT: 'engagement', APP_INSTALLS: 'app_installs',
};
const MSG_DESTINATIONS = ['WHATSAPP', 'MESSENGER', 'INSTAGRAM_DIRECT', 'MESSAGING_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP'];

// Conjunto: pela meta de otimização (o que a Meta conta como "resultado").
function metaAdsetKind(adset, campaignObjective) {
  const goal = String(adset.optimizationGoal || '').toUpperCase();
  const event = String((adset.promotedObject && adset.promotedObject.custom_event_type) || '').toUpperCase();
  if (['OFFSITE_CONVERSIONS', 'VALUE', 'CONVERSIONS'].includes(goal) && EVENT_KIND[event]) return EVENT_KIND[event];
  if (GOAL_KIND[goal]) return GOAL_KIND[goal];
  if (MSG_DESTINATIONS.includes(String(adset.destinationType || '').toUpperCase())) return 'messages';
  return OBJECTIVE_KIND[String(campaignObjective || '').toUpperCase()] || null;
}

function firstAction(map, types) {
  for (const t of types) if (map[t] != null) return map[t];
  return null;
}

// Normaliza uma linha de insights da Meta (números absolutos, sem médias).
function metaRow(r) {
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const toMap = (list) => {
    const m = {};
    (Array.isArray(list) ? list : []).forEach((a) => { const v = n(a.value); if (a.action_type && v != null) m[a.action_type] = v; });
    return m;
  };
  const thru = Array.isArray(r.video_thruplay_watched_actions) ? r.video_thruplay_watched_actions.reduce((s, a) => s + (n(a.value) || 0), 0) : null;
  return {
    spend: n(r.spend), impressions: n(r.impressions), reach: n(r.reach),
    linkClicks: n(r.inline_link_clicks), thruplays: thru,
    actions: toMap(r.actions), values: toMap(r.action_values),
  };
}

const NO_DELIVERY = { noDelivery: true };

function metaMetrics(row, kind) {
  if (!row) return NO_DELIVERY; // a Meta não devolveu linha: sem veiculação no período
  const k = META_KINDS[kind];
  let results = null;
  let label = 'Resultados';
  let costLabel = 'Custo por resultado';
  let resultKind = kind || null;
  if (k) {
    label = k.label; costLabel = k.costLabel;
    results = k.field ? row[k.field] : firstAction(row.actions, k.actions);
    if (results == null && row.spend != null) results = 0; // teve entrega mas nenhum resultado desse tipo
  } else {
    // Sem meta conhecida: mesma regra do painel (prioridade de RESULT_ACTIONS).
    const pr = metaService.pickResult(Object.entries(row.actions).map(([action_type, value]) => ({ action_type, value })));
    if (pr.type) { results = pr.value; label = metaService.RESULT_LABELS[pr.type] || label; resultKind = 'generic'; }
  }
  const spend = row.spend;
  const costPerResult = spend != null && results > 0 ? (k && k.perMille ? (spend / results) * 1000 : spend / results) : null;
  const ctr = row.impressions > 0 && row.linkClicks != null ? (row.linkClicks / row.impressions) * 100 : null;
  let roas = null;
  let purchaseValue = null;
  if (kind === 'purchases') {
    purchaseValue = firstAction(row.values, PURCHASE_TYPES);
    if (purchaseValue != null && spend > 0) roas = purchaseValue / spend;
  }
  return {
    spend, impressions: row.impressions, reach: row.reach, clicks: row.linkClicks, ctr,
    results: results == null ? null : Math.round(results * 100) / 100, resultKind, resultLabel: label, costLabel, costPerResult, roas, purchaseValue,
  };
}

// Soma de conjuntos com tipos de resultado diferentes: não dá para somar
// "conversa" com "clique", então a campanha mostra só investimento e alcance.
function metaCampaignKind(adsetKinds) {
  const set = new Set(adsetKinds.filter(Boolean));
  return set.size === 1 ? [...set][0] : (set.size > 1 ? 'mixed' : null);
}

/* ===================== Meta: leitura ===================== */

async function metaAllInsights(publisher, act, level, range) {
  const idField = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }[level];
  const fields = `${idField},spend,impressions,reach,inline_link_clicks,actions,action_values,video_thruplay_watched_actions`;
  const out = [];
  let after = null;
  for (let i = 0; i < 10; i += 1) {
    const r = await publisher.metaRequest('GET', `${act}/insights`, {
      level, fields, time_range: { since: range.from, until: range.to }, limit: 500, ...(after ? { after } : {}),
    });
    out.push(...(r.data || []));
    after = r.paging && r.paging.next && r.paging.cursors ? r.paging.cursors.after : null;
    if (!after) break;
  }
  const map = {};
  out.forEach((r) => { if (r[idField]) map[r[idField]] = metaRow(r); });
  return map;
}

async function metaLookups(publisher, act, creatives) {
  const need = { hashes: new Set(), videos: new Set(), posts: new Set() };
  creatives.forEach((c) => {
    const p = pendingLookups(c);
    p.hashes.forEach((h) => need.hashes.add(h));
    p.videos.forEach((v) => need.videos.add(v));
    p.posts.forEach((x) => need.posts.add(x));
  });
  const out = { hashes: {}, videos: {}, posts: {} };
  const chunks = (set, n = 50) => { const a = [...set]; const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r.slice(0, 6); };
  const safe = async (fn) => { try { await fn(); } catch (e) { console.warn('Gerenciar: prévia do criativo incompleta:', e.message); } };
  await Promise.all([
    safe(async () => {
      for (const part of chunks(need.hashes)) {
        const r = await publisher.metaRequest('GET', `${act}/adimages`, { hashes: part, fields: 'hash,url' });
        (r.data || []).forEach((im) => { if (im.hash && im.url) out.hashes[im.hash] = im.url; });
      }
    }),
    safe(async () => {
      for (const part of chunks(need.videos)) {
        const r = await publisher.metaRequest('GET', '', { ids: part.join(','), fields: 'picture,thumbnails{uri,is_preferred,width}' });
        Object.entries(r || {}).forEach(([id, v]) => {
          const th = (v && v.thumbnails && v.thumbnails.data) || [];
          const best = th.find((t) => t.is_preferred) || th.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
          const url = (best && best.uri) || (v && v.picture);
          if (url) out.videos[id] = url;
        });
      }
    }),
    safe(async () => {
      for (const part of chunks(need.posts)) {
        const r = await publisher.metaRequest('GET', '', { ids: part.join(','), fields: 'full_picture' });
        Object.entries(r || {}).forEach(([id, v]) => { if (v && v.full_picture) out.posts[id] = v.full_picture; });
      }
    }),
  ]);
  return out;
}

async function metaCreatives(publisher, act, adIds) {
  if (!adIds.length) return {};
  const attempts = [`id,creative.thumbnail_width(600).thumbnail_height(600){${CREATIVE_FIELDS}}`, `id,creative{${CREATIVE_FIELDS}}`];
  let ads = null;
  let lastErr = null;
  for (const fields of attempts) {
    try {
      ads = [];
      // Busca pelos IDs da árvore (no máximo 50 por chamada), sem varrer a conta inteira.
      for (let i = 0; i < adIds.length && i < 500; i += 50) {
        const r = await publisher.metaRequest('GET', '', { ids: adIds.slice(i, i + 50).join(','), fields });
        Object.values(r || {}).forEach((a) => ads.push(a));
      }
      break;
    } catch (e) { lastErr = e; ads = null; }
  }
  if (!ads) throw lastErr || new Error('Não consegui ler os criativos.');
  const creatives = ads.map((a) => a.creative).filter(Boolean);
  const lookups = await metaLookups(publisher, act, creatives);
  const map = {};
  ads.forEach((a) => { if (a.id && a.creative) map[a.id] = pickCreativeMedia(a.creative, lookups); });
  return map;
}

/**
 * Pendura metrics em cada nó (e creative nos anúncios) da árvore crua da Meta.
 * tree: [{ id, objective, children:[{ id, optimizationGoal, promotedObject, destinationType, children:[{ id }] }] }]
 */
async function enrichMeta(publisher, account, tree, range) {
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  const key = `adstatus:meta:${act}:${range.from}:${range.to}`;
  let data = cache.get(key);
  if (!data) {
    const errors = [];
    const adIds = tree.flatMap((c) => (c.children || []).flatMap((s) => (s.children || []).map((a) => a.id)));
    const [campaign, adset, ad, creatives] = await Promise.all([
      metaAllInsights(publisher, act, 'campaign', range).catch((e) => { errors.push(e); return null; }),
      metaAllInsights(publisher, act, 'adset', range).catch((e) => { errors.push(e); return null; }),
      metaAllInsights(publisher, act, 'ad', range).catch((e) => { errors.push(e); return null; }),
      metaCreatives(publisher, act, adIds).catch((e) => { console.warn('Gerenciar: criativos:', e.message); return null; }),
    ]);
    data = { campaign, adset, ad, creatives, metricsError: errors.length ? (errors[0].code ? metaService.friendlyError(errors[0]) : errors[0].message) : null };
    if (!errors.length) cache.set(key, data, TTL);
  }
  applyMeta(tree, data);
  return { metricsError: data.metricsError, creativesOk: !!data.creatives };
}

function applyMeta(tree, data) {
  const pick = (lvl, id) => (data[lvl] ? data[lvl][id] || null : undefined);
  tree.forEach((c) => {
    const kinds = [];
    (c.children || []).forEach((s) => {
      s.resultKind = metaAdsetKind(s, c.objective);
      kinds.push(s.resultKind);
      const sRow = pick('adset', s.id);
      s.metrics = sRow === undefined ? undefined : metaMetrics(sRow, s.resultKind);
      (s.children || []).forEach((a) => {
        const aRow = pick('ad', a.id);
        a.metrics = aRow === undefined ? undefined : metaMetrics(aRow, s.resultKind);
        if (data.creatives) a.creative = data.creatives[a.id] || null;
      });
    });
    const cKind = metaCampaignKind(kinds) || OBJECTIVE_KIND[String(c.objective || '').toUpperCase()] || null;
    const cRow = pick('campaign', c.id);
    if (cRow === undefined) c.metrics = undefined;
    else if (cKind === 'mixed') {
      const m = metaMetrics(cRow, 'reach');
      c.metrics = m.noDelivery ? m : { ...m, results: null, resultKind: 'mixed', resultLabel: 'Resultados (tipos diferentes por conjunto)', costPerResult: null, costLabel: 'Custo por resultado' };
    } else c.metrics = metaMetrics(cRow, cKind);
  });
}

/* ===================== Google Ads ===================== */

function googleRow(m) {
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  return { cost: n(m.costMicros) / 1e6, conversions: n(m.conversions), value: n(m.conversionsValue), clicks: n(m.clicks), impressions: n(m.impressions) };
}
function addG(map, id, row) {
  const cur = map[id];
  if (!cur) { map[id] = row; return; }
  ['cost', 'conversions', 'value', 'clicks', 'impressions'].forEach((k) => { cur[k] += row[k]; });
}
function googleMetrics(row) {
  if (!row || (!row.impressions && !row.cost && !row.clicks)) return NO_DELIVERY;
  const spend = Math.round(row.cost * 100) / 100;
  return {
    spend, impressions: row.impressions, clicks: row.clicks,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null,
    results: Math.round(row.conversions * 100) / 100, resultKind: 'conversions', resultLabel: 'Conversões', costLabel: 'Custo por conversão',
    costPerResult: row.conversions > 0 ? row.cost / row.conversions : null,
    roas: row.value > 0 && row.cost > 0 ? row.value / row.cost : null,
    purchaseValue: row.value > 0 ? row.value : null,
  };
}

async function enrichGoogle(account, tree, range, extras = {}) {
  const cid = String(account.google.customerId || '').replace(/\D/g, '');
  const key = `adstatus:google:${cid}:${range.from}:${range.to}`;
  let data = cache.get(key);
  if (!data) {
    const token = await googleService.getAccessToken();
    const between = `segments.date BETWEEN '${range.from}' AND '${range.to}'`;
    const M = 'metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions';
    const errors = [];
    const run = (q, label) => googleService.runGAQL(cid, q, token, label).catch((e) => { errors.push(e); return null; });
    const [c, g, a] = await Promise.all([
      run(`SELECT campaign.id, ${M} FROM campaign WHERE campaign.status != 'REMOVED' AND ${between}`, 'métricas campanhas'),
      run(`SELECT ad_group.id, ${M} FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ${between}`, 'métricas grupos'),
      run(`SELECT ad_group.id, ad_group_ad.ad.id, ${M} FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ${between}`, 'métricas anúncios'),
    ]);
    const map = (rows, idOf) => {
      if (!rows) return null;
      const out = {};
      rows.forEach((r) => addG(out, idOf(r), googleRow(r.metrics || {})));
      return out;
    };
    data = {
      campaign: map(c, (r) => String(r.campaign.id)),
      adset: map(g, (r) => String(r.adGroup.id)),
      ad: map(a, (r) => `${r.adGroup.id}~${r.adGroupAd.ad.id}`),
      metricsError: errors.length ? errors[0].message : null,
    };
    if (!errors.length) cache.set(key, data, TTL);
  }
  // Sem linha no período = não teve impressão nesse período: tudo zero, que é o dado real.
  const pick = (lvl, id) => (data[lvl] ? googleMetrics(data[lvl][id] || { cost: 0, conversions: 0, value: 0, clicks: 0, impressions: 0 }) : undefined);
  tree.forEach((cpn) => {
    cpn.metrics = pick('campaign', cpn.id);
    (cpn.children || []).forEach((s) => {
      s.metrics = pick('adset', s.id);
      (s.children || []).forEach((ad) => { ad.metrics = pick('ad', `${s.id}~${ad.id}`); });
    });
  });
  return { metricsError: data.metricsError, ...extras };
}

/* ===================== Mock ===================== */

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// Imagem de exemplo gerada na hora (SVG), sempre marcada [TESTE].
function mockImage(label, hue, kind) {
  const icon = kind === 'video' ? '<polygon points="270,250 270,350 355,300" fill="#fff" opacity=".9"/>' : kind === 'carousel' ? '<rect x="230" y="250" width="60" height="60" rx="8" fill="#fff" opacity=".6"/><rect x="310" y="250" width="60" height="60" rx="8" fill="#fff" opacity=".9"/>' : '<circle cx="300" cy="290" r="38" fill="#fff" opacity=".85"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},70%,38%)"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/>${icon}<text x="300" y="120" font-family="Arial" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">[TESTE]</text><text x="300" y="470" font-family="Arial" font-size="30" fill="#fff" text-anchor="middle">${label}</text><text x="300" y="520" font-family="Arial" font-size="22" fill="#fff" opacity=".8" text-anchor="middle">imagem de exemplo</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const MOCK_KIND_RATE = { messages: [9, 22], leads: [18, 45], purchases: [45, 120], landing_page_views: [0.6, 1.6], link_clicks: [0.4, 1.2] };

function mockMetaRow(id, kind, days, status) {
  const r = hash(id);
  if (status === 'PAUSED' && r < 0.5) return null; // pausado e sem entrega no período
  const spend = Math.round((15 + r * 70) * days * 100) / 100;
  const impressions = Math.round(spend * (55 + r * 60));
  const linkClicks = Math.round(impressions * (0.008 + r * 0.017));
  const [lo, hi] = MOCK_KIND_RATE[kind] || [5, 20];
  const cost = lo + (hi - lo) * hash(`${id}x`);
  const results = Math.max(0, Math.round(spend / cost));
  const actions = {};
  if (kind === 'messages') actions['onsite_conversion.messaging_conversation_started_7d'] = results;
  if (kind === 'leads') actions.lead = results;
  if (kind === 'purchases') actions.omni_purchase = results;
  if (kind === 'landing_page_views') actions.landing_page_view = results;
  const values = kind === 'purchases' ? { omni_purchase: Math.round(results * (120 + r * 180) * 100) / 100 } : {};
  return { spend, impressions, reach: Math.round(impressions * 0.62), linkClicks: kind === 'link_clicks' ? results : linkClicks, thruplays: null, actions, values };
}

function sumMeta(rows) {
  const ok = rows.filter(Boolean);
  if (!ok.length) return null;
  const out = { spend: 0, impressions: 0, reach: 0, linkClicks: 0, thruplays: null, actions: {}, values: {} };
  ok.forEach((r) => {
    ['spend', 'impressions', 'reach', 'linkClicks'].forEach((k) => { out[k] += r[k] || 0; });
    Object.entries(r.actions).forEach(([k, v]) => { out.actions[k] = (out.actions[k] || 0) + v; });
    Object.entries(r.values).forEach(([k, v]) => { out.values[k] = (out.values[k] || 0) + v; });
  });
  out.spend = Math.round(out.spend * 100) / 100;
  return out;
}

function mockEnrichMeta(tree, range) {
  const data = { campaign: {}, adset: {}, ad: {}, creatives: {} };
  tree.forEach((c) => {
    const sRows = [];
    (c.children || []).forEach((s) => {
      const kind = metaAdsetKind(s, c.objective);
      const aRows = (s.children || []).map((a) => {
        const row = mockMetaRow(a.id, kind, range.days, a.status === 'ACTIVE' && s.status === 'ACTIVE' && c.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED');
        if (row) data.ad[a.id] = row;
        const m = a.mockCreative || {};
        const hue = Math.round(hash(a.id) * 360);
        data.creatives[a.id] = {
          format: m.format || 'image', imageUrl: mockImage(m.format === 'video' ? 'Capa do vídeo' : m.format === 'carousel' ? 'Card 1 do carrossel' : 'Imagem do anúncio', hue, m.format),
          thumbUrl: null, source: 'imagem de exemplo', title: m.title || null, body: m.body || null, cards: m.cards || null, dynamic: false,
        };
        return row;
      });
      const sRow = sumMeta(aRows);
      if (sRow) data.adset[s.id] = sRow;
      sRows.push(sRow);
    });
    const cRow = sumMeta(sRows);
    if (cRow) data.campaign[c.id] = cRow;
  });
  applyMeta(tree, data);
  return { metricsError: null, creativesOk: true };
}

function mockEnrichGoogle(tree, range) {
  const row = (id, on) => {
    if (!on && hash(id) < 0.5) return { cost: 0, conversions: 0, value: 0, clicks: 0, impressions: 0 };
    const r = hash(id);
    const cost = (12 + r * 40) * range.days;
    const clicks = Math.round(cost / (1.2 + r * 2.5));
    return { cost, clicks, impressions: Math.round(clicks / (0.04 + r * 0.06)), conversions: Math.round(clicks * (0.03 + r * 0.06) * 10) / 10, value: 0 };
  };
  const sum = (rows) => rows.reduce((o, r) => { ['cost', 'conversions', 'value', 'clicks', 'impressions'].forEach((k) => { o[k] += r[k]; }); return o; }, { cost: 0, conversions: 0, value: 0, clicks: 0, impressions: 0 });
  tree.forEach((c) => {
    const gRows = (c.children || []).map((s) => {
      const aRows = (s.children || []).map((a) => {
        const r = row(a.id, a.status === 'ENABLED' && s.status === 'ENABLED' && c.status === 'ENABLED');
        a.metrics = googleMetrics(r);
        return r;
      });
      const sr = sum(aRows);
      s.metrics = googleMetrics(sr);
      return sr;
    });
    c.metrics = googleMetrics(sum(gRows));
  });
  return { metricsError: null };
}

module.exports = { resolveRange, enrichMeta, enrichGoogle, mockEnrichMeta, mockEnrichGoogle, metaAdsetKind, metaMetrics, mockImage, META_KINDS };
