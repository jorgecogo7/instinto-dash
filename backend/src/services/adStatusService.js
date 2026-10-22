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
  if (platform === 'meta') {
    return [
      mk('900000000000001', '[TESTE] Mensagens WhatsApp', 'ACTIVE', { spend7d: 412.37, children: [
        mk('900000000000011', '[TESTE] Conjunto 25 a 45 anos', 'ACTIVE', { children: [
          mk('900000000000111', '[TESTE] Anúncio vídeo depoimento', 'ACTIVE'),
          mk('900000000000112', '[TESTE] Anúncio carrossel', 'PAUSED'),
        ] }),
        mk('900000000000012', '[TESTE] Conjunto público aberto', 'ACTIVE', { children: [
          mk('900000000000121', '[TESTE] Anúncio imagem oferta', 'ACTIVE'),
        ] }),
      ] }),
      mk('900000000000002', '[TESTE] Tráfego para o site', 'PAUSED', { spend7d: 0, children: [
        mk('900000000000021', '[TESTE] Conjunto remarketing', 'ACTIVE', { children: [
          mk('900000000000211', '[TESTE] Anúncio stories', 'ACTIVE'),
        ] }),
      ] }),
    ];
  }
  return [
    mk('700000001', '[TESTE] Pesquisa institucional', 'ENABLED', { spend7d: 289.9, channel: 'SEARCH', children: [
      mk('710000001', '[TESTE] Grupo marca', 'ENABLED', { children: [
        mk('720000001', '[TESTE] Anúncio responsivo 1', 'ENABLED', { parent: '710000001' }),
        mk('720000002', '[TESTE] Anúncio responsivo 2', 'PAUSED', { parent: '710000001' }),
      ] }),
      mk('710000002', '[TESTE] Grupo serviços', 'PAUSED', { children: [
        mk('720000003', '[TESTE] Anúncio responsivo 3', 'ENABLED', { parent: '710000002' }),
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
function decorate(platform, tree) {
  const on = platform === 'meta' ? 'ACTIVE' : 'ENABLED';
  return tree.map((c) => ({
    id: c.id, name: c.name, status: c.status, effectiveStatus: c.effectiveStatus || c.status, spend7d: c.spend7d ?? null,
    channel: c.channel || null, level: 'campaign',
    children: (c.children || []).map((s) => {
      const sEff = s.effectiveStatus || (c.status !== on ? 'CAMPAIGN_PAUSED' : s.status);
      return {
        id: s.id, name: s.name, status: s.status, effectiveStatus: sEff, level: 'adset',
        children: (s.children || []).map((a) => ({
          id: a.id, name: a.name, status: a.status, level: 'ad',
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
    metaAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,insights.date_preset(last_7d){spend}', filtering }),
    metaAll(`${act}/adsets`, { fields: 'id,name,status,effective_status,campaign_id', filtering }),
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
    byCampaign.get(s.campaign_id).push({ id: s.id, name: s.name, status: s.status, effectiveStatus: s.effective_status, children: byAdset.get(s.id) || [] });
  });
  return campaigns.map((c) => {
    const spend = c.insights && c.insights.data && c.insights.data[0] ? Number(c.insights.data[0].spend) : 0;
    return { id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status, spend7d: spend, children: byCampaign.get(c.id) || [] };
  });
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
  const [campaigns, cost, groups, ads] = await Promise.all([
    googleService.runGAQL(cid, "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT 500", token, 'campanhas'),
    googleService.runGAQL(cid, "SELECT campaign.id, metrics.cost_micros FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_7_DAYS", token, 'gasto 7 dias'),
    googleService.runGAQL(cid, "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 2000", token, 'grupos de anúncios'),
    googleService.runGAQL(cid, "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.responsive_search_ad.headlines, ad_group.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 5000", token, 'anúncios'),
  ]);
  const spend = new Map();
  cost.forEach((r) => {
    const id = String(r.campaign.id);
    spend.set(id, (spend.get(id) || 0) + Number(r.metrics?.costMicros || 0) / 1e6);
  });
  const byGroup = new Map();
  ads.forEach((r) => {
    const g = String(r.adGroup.id);
    const ad = r.adGroupAd.ad || {};
    const first = ad.responsiveSearchAd?.headlines?.[0]?.text;
    const name = ad.name || (first ? `Anúncio: ${first}` : `Anúncio ${String(ad.type || '').toLowerCase().replace(/_/g, ' ')} ${ad.id}`);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push({ id: String(ad.id), parent: g, name, status: r.adGroupAd.status, review: r.adGroupAd.policySummary?.approvalStatus || null });
  });
  const byCampaign = new Map();
  groups.forEach((r) => {
    const c = String(r.campaign.id);
    if (!byCampaign.has(c)) byCampaign.set(c, []);
    byCampaign.get(c).push({ id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status, children: byGroup.get(String(r.adGroup.id)) || [] });
  });
  return campaigns.map((r) => ({
    id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status, channel: r.campaign.advertisingChannelType,
    servingStatus: r.campaign.servingStatus, spend7d: Math.round((spend.get(String(r.campaign.id)) || 0) * 100) / 100,
    children: byCampaign.get(String(r.campaign.id)) || [],
  }));
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

async function getTree(account, platform) {
  const cap = capabilities(account, platform);
  if (!cap.canRead) throw fail(`Não dá para listar ainda. Falta: ${cap.readMissing.join(', ')}.`, 409, { capabilities: cap });
  let raw;
  if (cap.mode === 'mock') raw = mockTree(account.id, platform);
  else {
    try {
      raw = platform === 'meta' ? await metaTree(account) : await googleTree(account);
    } catch (err) {
      const msg = platform === 'meta' && err.code ? metaService.friendlyError(err) : err.message;
      throw fail(msg, 502);
    }
  }
  return { capabilities: cap, campaigns: decorate(platform, raw) };
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
