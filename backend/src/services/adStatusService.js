/**
 * Gerenciar: ver e ligar/desligar campanhas, conjuntos (grupos de anúncios) e
 * anúncios que já existem nas contas de cada cliente, na Meta e no Google Ads.
 *
 * Regras fixas:
 *  - Com USE_MOCK_DATA=true nada sai do servidor: a árvore é fictícia e as
 *    alterações ficam só na memória (somem quando o servidor reinicia).
 *  - Fora do mock, LER a árvore só precisa das credenciais que o painel já usa.
 *    ALTERAR status (pausar ou ativar) também exige CAMPAIGNS_PUBLISH_ENABLED=true,
 *    a mesma trava da publicação de campanhas.
 *  - Antes de alterar, confere que o item é mesmo da conta deste cliente.
 *  - Depois de alterar, relê o status na plataforma e devolve o valor real.
 */
const config = require('../config');
const metaService = require('./metaService');
const googleService = require('./googleService');
const publisher = require('./campaignPublisher');
const metrics = require('./adStatusMetrics');

const LEVELS = ['campaign', 'adset', 'ad'];
const STATUSES = ['ACTIVE', 'PAUSED'];

function fail(message, status = 400, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

const cleanCid = (id) => String(id || '').replace(/\D/g, '');

// O que falta para cada plataforma. read = consultar a árvore; write = pausar/ativar.
function capabilities(account, platform) {
  const mode = config.useMockData ? 'mock' : 'real';
  const linked = platform === 'meta'
    ? !!(account.meta && account.meta.adAccountId)
    : !!(account.google && account.google.customerId);
  const readMissing = [];
  if (!linked) readMissing.push(platform === 'meta' ? 'conta de anúncios da Meta na aba Integrações' : 'conta do Google Ads na aba Integrações');
  if (mode === 'real') {
    if (platform === 'meta' && !config.meta.systemUserToken) readMissing.push('META_SYSTEM_USER_TOKEN');
    if (platform === 'google') {
      if (!googleService.hasRealCredentials()) readMissing.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_DEVELOPER_TOKEN');
      if (!config.google.loginCustomerId) readMissing.push('GOOGLE_LOGIN_CUSTOMER_ID');
    }
  }
  const writeMissing = [...readMissing];
  if (mode === 'real' && !config.campaigns.publishEnabled) writeMissing.push('CAMPAIGNS_PUBLISH_ENABLED=true');
  return { mode, platform, linked, canRead: readMissing.length === 0, canWrite: writeMissing.length === 0, readMissing, writeMissing };
}

/* ===================== Modo de teste (mock) ===================== */

const mockState = new Map(); // `${clientId}:${platform}` -> árvore

function seedMock(platform) {
  const mk = (id, name, status, extra = {}) => ({ id, name, status, ...extra });
  const cr = (format, title, body, cards) => ({ mockCreative: { format, title: `[TESTE] ${title}`, body: `[TESTE] ${body}`, cards: cards || null } });
  if (platform === 'meta') {
    const msg = { optimizationGoal: 'CONVERSATIONS', destinationType: 'WHATSAPP' };
    return [
      mk('900000000000001', '[TESTE] Mensagens WhatsApp', 'ACTIVE', { objective: 'OUTCOME_ENGAGEMENT', children: [
        mk('900000000000011', '[TESTE] Conjunto 25 a 45 anos', 'ACTIVE', { ...msg, children: [
          mk('900000000000111', '[TESTE] Anúncio vídeo depoimento', 'ACTIVE', cr('video', 'Veja o que nossos clientes dizem', 'Atendimento rápido pelo WhatsApp. Chame agora e tire suas dúvidas sem compromisso.')),
          mk('900000000000112', '[TESTE] Anúncio carrossel', 'PAUSED', cr('carousel', 'Conheça nossos serviços', 'Arraste para o lado e veja todas as opções. Fale com a gente pelo WhatsApp.', 4)),
        ] }),
        mk('900000000000012', '[TESTE] Conjunto público aberto', 'ACTIVE', { ...msg, children: [
          mk('900000000000121', '[TESTE] Anúncio imagem oferta', 'ACTIVE', cr('image', 'Oferta da semana', 'Condição especial só até sexta. Mande uma mensagem e garanta a sua.')),
        ] }),
      ] }),
      mk('900000000000002', '[TESTE] Tráfego para o site', 'PAUSED', { objective: 'OUTCOME_TRAFFIC', children: [
        mk('900000000000021', '[TESTE] Conjunto remarketing', 'ACTIVE', { optimizationGoal: 'LANDING_PAGE_VIEWS', children: [
          mk('900000000000211', '[TESTE] Anúncio stories', 'ACTIVE', cr('image', 'Visite nosso site', 'Tudo o que você precisa em um só lugar.')),
        ] }),
      ] }),
      mk('900000000000003', '[TESTE] Vendas loja online', 'ACTIVE', { objective: 'OUTCOME_SALES', children: [
        mk('900000000000031', '[TESTE] Conjunto compradores', 'ACTIVE', { optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObject: { custom_event_type: 'PURCHASE' }, children: [
          mk('900000000000311', '[TESTE] Anúncio catálogo', 'ACTIVE', cr('image', 'Frete grátis hoje', 'Compre online e receba em casa. Parcelamos em até 6x.')),
        ] }),
      ] }),
    ];
  }
  const rsa = (h, d) => ({ mockAd: { type: 'RESPONSIVE_SEARCH_AD', headlines: h.map((x) => `[TESTE] ${x}`), descriptions: d.map((x) => `[TESTE] ${x}`), finalUrl: 'https://exemplo.com.br' } });
  return [
    mk('700000001', '[TESTE] Pesquisa institucional', 'ENABLED', { channel: 'SEARCH', children: [
      mk('710000001', '[TESTE] Grupo marca', 'ENABLED', { children: [
        mk('720000001', '[TESTE] Anúncio responsivo 1', 'ENABLED', { parent: '710000001', ...rsa(['Instinto Digital', 'Marketing que dá resultado', 'Fale com um especialista'], ['Campanhas no Google e na Meta com acompanhamento semanal.', 'Peça um diagnóstico gratuito hoje.']) }),
        mk('720000002', '[TESTE] Anúncio responsivo 2', 'PAUSED', { parent: '710000001', ...rsa(['Agência de tráfego pago', 'Mais clientes pelo Google'], ['Planejamento, criação e gestão de anúncios.']) }),
      ] }),
      mk('710000002', '[TESTE] Grupo serviços', 'PAUSED', { children: [
        mk('720000003', '[TESTE] Anúncio responsivo 3', 'ENABLED', { parent: '710000002', ...rsa(['Gestão de anúncios', 'Resultados mensuráveis'], ['Relatórios claros todo mês.']) }),
      ] }),
    ] }),
    mk('700000002', '[TESTE] Display remarketing', 'ENABLED', { channel: 'DISPLAY', children: [
      mk('710000003', '[TESTE] Grupo visitantes do site', 'ENABLED', { children: [
        mk('720000004', '[TESTE] Anúncio de imagem', 'ENABLED', { parent: '710000003', mockAd: { type: 'RESPONSIVE_DISPLAY_AD', headlines: ['[TESTE] Volte e aproveite'], descriptions: ['[TESTE] Condição especial para quem já visitou o site.'], image: true, finalUrl: 'https://exemplo.com.br' } }),
      ] }),
    ] }),
  ];
}

function mockTree(clientId, platform) {
  const key = `${clientId}:${platform}`;
  if (!mockState.has(key)) mockState.set(key, seedMock(platform));
  return mockState.get(key);
}

function findInTree(tree, level, id) {
  for (const c of tree) {
    if (level === 'campaign' && c.id === id) return c;
    for (const s of c.children || []) {
      if (level === 'adset' && s.id === id) return s;
      for (const a of s.children || []) if (level === 'ad' && a.id === id) return a;
    }
  }
  return null;
}

/* ===================== Formato comum ===================== */

// Status efetivo: o que realmente acontece, levando em conta o item "pai".
// metrics: null quando não deu para ler (o painel mostra "-").
// creative: prévia do anúncio (imagem, título e texto), quando existe.
function decorate(platform, tree) {
  const on = platform === 'meta' ? 'ACTIVE' : 'ENABLED';
  const m = (n) => (n.metrics === undefined ? null : n.metrics);
  return tree.map((c) => ({
    id: c.id, name: c.name, status: c.status, effectiveStatus: c.effectiveStatus || c.status,
    channel: c.channel || null, objective: c.objective || null, level: 'campaign', metrics: m(c),
    children: (c.children || []).map((s) => {
      const sEff = s.effectiveStatus || (c.status !== on ? 'CAMPAIGN_PAUSED' : s.status);
      return {
        id: s.id, name: s.name, status: s.status, effectiveStatus: sEff, level: 'adset', optimizationGoal: s.optimizationGoal || null, metrics: m(s),
        children: (s.children || []).map((a) => ({
          id: a.id, name: a.name, status: a.status, level: 'ad', metrics: m(a), creative: a.creative || null,
          effectiveStatus: a.effectiveStatus || (c.status !== on ? 'CAMPAIGN_PAUSED' : s.status !== on ? 'ADSET_PAUSED' : a.status),
          ...(a.review ? { review: a.review } : {}),
        })),
      };
    }),
  }));
}

/* ===================== Meta ===================== */

const META_LIVE = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'];

async function metaAll(path, params, maxPages = 5) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i += 1) {
    const r = await publisher.metaRequest('GET', path, { ...params, limit: 200, ...(after ? { after } : {}) });
    out.push(...(r.data || []));
    after = r.paging && r.paging.next && r.paging.cursors ? r.paging.cursors.after : null;
    if (!after) break;
  }
  return out;
}

async function metaTree(account) {
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  const filtering = [{ field: 'effective_status', operator: 'IN', value: META_LIVE }];
  const [campaigns, adsets, ads] = await Promise.all([
    metaAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,objective', filtering }),
    metaAll(`${act}/adsets`, { fields: 'id,name,status,effective_status,campaign_id,optimization_goal,promoted_object,destination_type', filtering }),
    metaAll(`${act}/ads`, { fields: 'id,name,status,effective_status,adset_id', filtering }),
  ]);
  const byAdset = new Map();
  ads.forEach((a) => {
    if (!byAdset.has(a.adset_id)) byAdset.set(a.adset_id, []);
    byAdset.get(a.adset_id).push({ id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status });
  });
  const byCampaign = new Map();
  adsets.forEach((s) => {
    if (!byCampaign.has(s.campaign_id)) byCampaign.set(s.campaign_id, []);
    byCampaign.get(s.campaign_id).push({
      id: s.id, name: s.name, status: s.status, effectiveStatus: s.effective_status,
      optimizationGoal: s.optimization_goal || null, promotedObject: s.promoted_object || null, destinationType: s.destination_type || null,
      children: byAdset.get(s.id) || [],
    });
  });
  return campaigns.map((c) => ({
    id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status, objective: c.objective || null, children: byCampaign.get(c.id) || [],
  }));
}

async function metaReadOne(id) {
  const r = await publisher.metaRequest('GET', id, { fields: 'id,name,status,effective_status,account_id' });
  return { id: r.id, name: r.name, status: r.status, effectiveStatus: r.effective_status, accountId: r.account_id };
}

async function metaSetStatus(account, level, id, status) {
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  const before = await metaReadOne(id);
  if (`act_${String(before.accountId || '').replace(/\D/g, '')}` !== act) {
    throw fail('Esse item não pertence à conta de anúncios deste cliente.', 403);
  }
  if (before.status === status) return { before, after: before, unchanged: true };
  try {
    await publisher.metaRequest('POST', id, { status });
  } catch (err) {
    let msg = err.message;
    if ([10, 200, 294].includes(err.code)) msg = 'Meta: o token não tem permissão de alterar esse item. Confira se o usuário do sistema tem "gerenciar campanhas" nessa conta e a permissão ads_management.';
    throw fail(msg, 502);
  }
  const after = await metaReadOne(id);
  return { before, after };
}

/* ===================== Google Ads ===================== */

async function googleTree(account) {
  const cid = cleanCid(account.google.customerId);
  const token = await googleService.getAccessToken();
  const AD_FIELDS = [
    'ad_group_ad.ad.id', 'ad_group_ad.ad.name', 'ad_group_ad.ad.type', 'ad_group_ad.status', 'ad_group_ad.policy_summary.approval_status',
    'ad_group_ad.ad.final_urls', 'ad_group_ad.ad.responsive_search_ad.headlines', 'ad_group_ad.ad.responsive_search_ad.descriptions',
    'ad_group_ad.ad.expanded_text_ad.headline_part1', 'ad_group_ad.ad.expanded_text_ad.headline_part2', 'ad_group_ad.ad.expanded_text_ad.description',
    'ad_group_ad.ad.image_ad.image_url', 'ad_group_ad.ad.responsive_display_ad.headlines', 'ad_group_ad.ad.responsive_display_ad.descriptions',
    'ad_group_ad.ad.responsive_display_ad.marketing_images', 'ad_group.id',
  ].join(', ');
  const [campaigns, groups, ads, cur] = await Promise.all([
    googleService.runGAQL(cid, "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT 500", token, 'campanhas'),
    googleService.runGAQL(cid, "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 2000", token, 'grupos de anúncios'),
    googleService.runGAQL(cid, `SELECT ${AD_FIELDS} FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 5000`, token, 'anúncios'),
    googleService.runGAQL(cid, 'SELECT customer.currency_code FROM customer LIMIT 1', token, 'moeda').catch(() => []),
  ]);
  // Imagens dos anúncios de display responsivos vêm como asset: uma consulta só para todas.
  const assetNames = [...new Set(ads.map((r) => r.adGroupAd.ad?.responsiveDisplayAd?.marketingImages?.[0]?.asset).filter(Boolean))].slice(0, 500);
  const assetUrl = {};
  if (assetNames.length) {
    try {
      const rows = await googleService.runGAQL(cid, `SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset WHERE asset.resource_name IN (${assetNames.map((n) => `'${n.replace(/'/g, '')}'`).join(', ')})`, token, 'imagens');
      rows.forEach((r) => { if (r.asset?.imageAsset?.fullSize?.url) assetUrl[r.asset.resourceName] = r.asset.imageAsset.fullSize.url; });
    } catch (e) { console.warn('Gerenciar Google: imagens dos anúncios:', e.message); }
  }
  const byGroup = new Map();
  ads.forEach((r) => {
    const g = String(r.adGroup.id);
    const ad = r.adGroupAd.ad || {};
    const first = ad.responsiveSearchAd?.headlines?.[0]?.text;
    const name = ad.name || (first ? `Anúncio: ${first}` : `Anúncio ${String(ad.type || '').toLowerCase().replace(/_/g, ' ')} ${ad.id}`);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push({ id: String(ad.id), parent: g, name, status: r.adGroupAd.status, review: r.adGroupAd.policySummary?.approvalStatus || null, creative: googleCreative(ad, assetUrl) });
  });
  const byCampaign = new Map();
  groups.forEach((r) => {
    const c = String(r.campaign.id);
    if (!byCampaign.has(c)) byCampaign.set(c, []);
    byCampaign.get(c).push({ id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status, children: byGroup.get(String(r.adGroup.id)) || [] });
  });
  const tree = campaigns.map((r) => ({
    id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status, channel: r.campaign.advertisingChannelType,
    servingStatus: r.campaign.servingStatus, children: byCampaign.get(String(r.campaign.id)) || [],
  }));
  tree.currency = cur[0]?.customer?.currencyCode || null;
  return tree;
}

// Prévia do anúncio do Google: títulos e descrições (pesquisa) e imagem quando existe.
function googleCreative(ad, assetUrl = {}) {
  const texts = (list) => (Array.isArray(list) ? list.map((x) => x && x.text).filter(Boolean) : []);
  const rsa = ad.responsiveSearchAd || {};
  const eta = ad.expandedTextAd || {};
  const rda = ad.responsiveDisplayAd || {};
  const headlines = [...texts(rsa.headlines), ...[eta.headlinePart1, eta.headlinePart2].filter(Boolean), ...texts(rda.headlines)].slice(0, 5);
  const descriptions = [...texts(rsa.descriptions), ...[eta.description].filter(Boolean), ...texts(rda.descriptions)].slice(0, 3);
  const imageUrl = ad.imageAd?.imageUrl || assetUrl[rda.marketingImages?.[0]?.asset] || null;
  if (!headlines.length && !descriptions.length && !imageUrl) return null;
  return {
    format: imageUrl ? 'image' : 'text', imageUrl, title: headlines.join(' | ') || null, body: descriptions.join(' ') || null,
    headlines, descriptions, finalUrl: (ad.finalUrls || [])[0] || null, adType: ad.type || null,
  };
}

function mockGoogleCreative(a) {
  const m = a.mockAd;
  if (!m) return null;
  const imageUrl = m.image ? metrics.mockImage('Imagem do anúncio', 200, 'image') : null;
  return { format: imageUrl ? 'image' : 'text', imageUrl, title: m.headlines.join(' | '), body: m.descriptions.join(' '), headlines: m.headlines, descriptions: m.descriptions, finalUrl: m.finalUrl, adType: m.type };
}

const G_RESOURCE = { campaign: 'campaigns', adset: 'adGroups', ad: 'adGroupAds' };

function googleResourceName(cid, level, id, parent) {
  if (!/^\d+$/.test(id) || (level === 'ad' && !/^\d+$/.test(String(parent || '')))) throw fail('ID inválido.', 400);
  return `customers/${cid}/${G_RESOURCE[level]}/${level === 'ad' ? `${parent}~${id}` : id}`;
}

async function googleReadOne(cid, level, id, parent, token) {
  const q = {
    campaign: `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${id}`,
    adset: `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = ${id}`,
    ad: `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status FROM ad_group_ad WHERE ad_group.id = ${parent} AND ad_group_ad.ad.id = ${id}`,
  }[level];
  const rows = await googleService.runGAQL(cid, q, token, 'status');
  const r = rows[0];
  if (!r) return null;
  if (level === 'campaign') return { id, name: r.campaign.name, status: r.campaign.status };
  if (level === 'adset') return { id, name: r.adGroup.name, status: r.adGroup.status };
  return { id, name: r.adGroupAd.ad?.name || `Anúncio ${id}`, status: r.adGroupAd.status };
}

async function googleSetStatus(account, level, id, status, parent) {
  const cid = cleanCid(account.google.customerId);
  const resourceName = googleResourceName(cid, level, id, parent);
  const token = await googleService.getAccessToken();
  // A consulta roda na conta do cliente: se o ID não é dessa conta, não acha nada.
  const before = await googleReadOne(cid, level, id, parent, token);
  if (!before) throw fail('Esse item não foi encontrado na conta do Google Ads deste cliente.', 404);
  const gStatus = status === 'ACTIVE' ? 'ENABLED' : 'PAUSED';
  if (before.status === gStatus) return { before, after: before, unchanged: true };
  const url = `https://googleads.googleapis.com/${publisher.GOOGLE_API}/customers/${cid}/${G_RESOURCE[level]}:mutate`;
  try {
    await publisher.googlePost(url, { operations: [{ update: { resourceName, status: gStatus }, updateMask: 'status' }] }, token);
  } catch (err) {
    throw fail(err.message, 502);
  }
  const after = await googleReadOne(cid, level, id, parent, token);
  return { before, after: after || before };
}

/* ===================== Entrada ===================== */

// Cópia rasa da árvore do mock, para as métricas não ficarem gravadas no estado.
const cloneTree = (tree) => tree.map((c) => ({ ...c, children: (c.children || []).map((s) => ({ ...s, children: (s.children || []).map((a) => ({ ...a })) })) }));

async function getTree(account, platform, { from, to } = {}) {
  const range = metrics.resolveRange(from, to);
  const cap = capabilities(account, platform);
  if (!cap.canRead) throw fail(`Não dá para listar ainda. Falta: ${cap.readMissing.join(', ')}.`, 409, { capabilities: cap });
  let raw;
  let info;
  if (cap.mode === 'mock') {
    raw = cloneTree(mockTree(account.id, platform));
    if (platform === 'meta') info = metrics.mockEnrichMeta(raw, range);
    else {
      raw.forEach((c) => c.children.forEach((s) => s.children.forEach((a) => { a.creative = mockGoogleCreative(a); })));
      info = metrics.mockEnrichGoogle(raw, range);
    }
  } else {
    try {
      raw = platform === 'meta' ? await metaTree(account) : await googleTree(account);
    } catch (err) {
      const msg = platform === 'meta' && err.code ? metaService.friendlyError(err) : err.message;
      throw fail(msg, 502);
    }
    // Métricas e prévias são extras: se falharem, a árvore (e o liga/desliga) continua.
    try {
      info = platform === 'meta' ? await metrics.enrichMeta(publisher, account, raw, range) : await metrics.enrichGoogle(account, raw, range);
    } catch (err) {
      info = { metricsError: err.message };
    }
  }
  return {
    capabilities: cap, campaigns: decorate(platform, raw),
    period: { from: range.from, to: range.to, days: range.days },
    metricsError: (info && info.metricsError) || null,
    ...(raw.currency ? { currency: raw.currency } : {}),
  };
}

// status: 'ACTIVE' | 'PAUSED' (no Google vira ENABLED | PAUSED).
async function setStatus(account, platform, level, id, status, { parent } = {}) {
  if (!LEVELS.includes(level)) throw fail('Nível inválido.', 400);
  if (!STATUSES.includes(status)) throw fail('Status inválido. Use ACTIVE ou PAUSED.', 400);
  id = String(id || '');
  if (!/^\d{1,30}$/.test(id)) throw fail('ID inválido.', 400);
  const cap = capabilities(account, platform);
  if (!cap.canWrite) throw fail(`Alteração real desligada. Falta: ${cap.writeMissing.join(', ')}.`, 409, { capabilities: cap });

  if (cap.mode === 'mock') {
    const node = findInTree(mockTree(account.id, platform), level, id);
    if (!node) throw fail('Item não encontrado nesta conta.', 404);
    const target = platform === 'google' ? (status === 'ACTIVE' ? 'ENABLED' : 'PAUSED') : status;
    const before = { id, name: node.name, status: node.status };
    node.status = target;
    return { mock: true, before, after: { id, name: node.name, status: node.status }, unchanged: before.status === target };
  }
  const r = platform === 'meta'
    ? await metaSetStatus(account, level, id, status)
    : await googleSetStatus(account, level, id, status, parent);
  return { mock: false, ...r };
}

module.exports = { capabilities, getTree, setStatus, LEVELS };
