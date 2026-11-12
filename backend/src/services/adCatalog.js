/**
 * Nomes, miniaturas e investimento dos anúncios para a origem do CRM.
 *
 * Não abre consulta nova no Google: ou lê o relatório que o painel já
 * deixou em cache (a cota diária continua valendo), ou, em modo de teste,
 * usa o relatório de exemplo. Na Meta, o relatório também sai do cache;
 * um id de anúncio ainda sem nome faz no máximo uma leitura, guardada
 * por 6 horas.
 */

const config = require('../config');
const cache = require('../lib/cache');
const attribution = require('../lib/attribution');
const metaService = require('./metaService');
const googleService = require('./googleService');
const mockMetaReport = require('../data/mockMetaReport');
const mockGoogle = require('../data/mockGoogle');

const CATALOG_TTL = 6 * 60 * 60;
const LOOKUP_TTL = 6 * 60 * 60;
const MISS_TTL = 15 * 60;

let mockMetaRowsCache = null;

// Relatório de exemplo só no modo de teste. Em produção, sem token, o CRM
// não inventa investimento: mostra os leads e deixa o custo em branco.
function metaMock() {
  return !!config.useMockData;
}

function googleMock() {
  return !!config.useMockData;
}

function rowsFromMetaAds(ads) {
  return (ads || []).map((a) => ({
    platform: 'meta',
    adId: a.id != null ? String(a.id) : null,
    adName: a.name || null,
    adsetId: a.adsetId || null,
    adsetName: a.adset || a.adsetName || null,
    campaignId: a.campaignId != null ? String(a.campaignId) : null,
    campaignName: a.campaign || a.campaignName || null,
    thumbnailUrl: a.thumbnailUrl || (a.creative && a.creative.imageUrl) || null,
    spend: Number(a.spend) || 0,
  })).filter((r) => r.adId || r.adName);
}

function rowsFromGoogleCampaigns(campaigns) {
  return (campaigns || []).map((c) => ({
    platform: 'google',
    adId: null,
    adName: null,
    adsetId: null,
    adsetName: null,
    campaignId: c.id != null ? String(c.id) : null,
    campaignName: c.name || null,
    thumbnailUrl: null,
    spend: Number(c.spend) || 0,
  })).filter((r) => r.campaignId || r.campaignName);
}

function rememberMetaCatalog(adAccountId, report) {
  if (!report || !Array.isArray(report.ads)) return;
  const id = metaService.normalizeAdAccountId(adAccountId) || 'mock';
  cache.set(`ads:catalog:meta:${id}`, rowsFromMetaAds(report.ads), CATALOG_TTL);
}

function rememberGoogleCatalog(customerId, report) {
  if (!report || !Array.isArray(report.campaigns)) return;
  cache.set(`ads:catalog:google:${String(customerId || 'mock')}`, rowsFromGoogleCampaigns(report.campaigns), CATALOG_TTL);
}

function mockMetaRows() {
  if (!mockMetaRowsCache) {
    const report = mockMetaReport.build({ from: '2026-01-01', to: '2026-01-07' }, 'crm-origem');
    mockMetaRowsCache = rowsFromMetaAds(report.ads);
  }
  return mockMetaRowsCache;
}

function catalogFor(account) {
  const rows = [];
  if (metaMock()) rows.push(...mockMetaRows());
  else if (account && account.meta && account.meta.adAccountId && metaService.hasRealCredentials()) {
    const id = metaService.normalizeAdAccountId(account.meta.adAccountId);
    rows.push(...(cache.get(`ads:catalog:meta:${id}`) || []));
  }
  if (googleMock()) rows.push(...rowsFromGoogleCampaigns(mockGoogle.campaigns));
  else if (account && account.google && account.google.customerId && googleService.hasRealCredentials()) {
    rows.push(...(cache.get(`ads:catalog:google:${account.google.customerId}`) || []));
  }
  return rows;
}

function lookupKey(adId) {
  return `meta:adlook:${adId}`;
}

async function lookupMetaAd(adId) {
  const id = String(adId || '').trim();
  if (!id || !metaService.hasRealCredentials()) return null;
  const hit = cache.get(lookupKey(id));
  if (hit) return hit.miss ? null : hit;
  const fields = [
    'id,name,campaign_id,adset_id,campaign{id,name},adset{id,name},creative{thumbnail_url,image_url}',
    'id,name,campaign_id,adset_id',
  ];
  let json = null;
  for (const field of fields) {
    try {
      json = await metaService.graphGet(id, { fields: field });
      break;
    } catch (e) {
      json = null;
    }
  }
  if (!json || !json.id) {
    cache.set(lookupKey(id), { miss: true }, MISS_TTL);
    return null;
  }
  const creative = json.creative || {};
  const row = {
    platform: 'meta',
    adId: String(json.id),
    adName: json.name || null,
    adsetId: (json.adset && json.adset.id) || json.adset_id || null,
    adsetName: (json.adset && json.adset.name) || null,
    campaignId: (json.campaign && json.campaign.id) || json.campaign_id || null,
    campaignName: (json.campaign && json.campaign.name) || null,
    thumbnailUrl: creative.image_url || creative.thumbnail_url || null,
  };
  cache.set(lookupKey(id), row, LOOKUP_TTL);
  return row;
}

function needsLookup(touch) {
  return !!(touch && touch.platform === 'meta' && touch.adId && !touch.thumbnailUrl && metaService.hasRealCredentials());
}

async function enrichTouch(account, touch) {
  if (!touch) return null;
  let next = attribution.enrichWithCatalog(touch, catalogFor(account));
  if (!needsLookup(next)) return next;
  const cached = cache.get(lookupKey(next.adId));
  if (cached && !cached.miss) return attribution.enrichWithCatalog(next, [cached]);
  if (cached && cached.miss) return next;
  try {
    const row = await lookupMetaAd(next.adId);
    if (row) next = attribution.enrichWithCatalog(next, [row]);
  } catch (e) {
    console.warn('CRM: não consegui ler o anúncio na Meta:', e.message);
  }
  return next;
}

async function spendFor(account, range) {
  const rows = [];
  const notices = [];
  if (metaMock()) {
    const report = mockMetaReport.build(range, (account && account.meta && account.meta.adAccountId) || 'mock');
    rows.push(...rowsFromMetaAds(report.ads));
  } else if (account && account.meta && account.meta.status === 'connected' && account.meta.adAccountId && metaService.hasRealCredentials()) {
    try {
      const report = await metaService.getAccountReport(account.meta.adAccountId, range);
      rows.push(...rowsFromMetaAds(report.ads));
    } catch (e) {
      console.warn('CRM: investimento da Meta indisponível:', e.message);
      notices.push('Não foi possível ler o investimento da Meta neste período.');
    }
  }
  if (googleMock()) {
    rows.push(...rowsFromGoogleCampaigns(mockGoogle.campaigns));
  } else if (account && account.google && account.google.status === 'connected' && account.google.customerId && googleService.hasRealCredentials()) {
    try {
      const report = await googleService.getAccountReport(account.google.customerId, range);
      rows.push(...rowsFromGoogleCampaigns(report.campaigns));
    } catch (e) {
      console.warn('CRM: investimento do Google indisponível:', e.message);
      notices.push(e && e.message ? e.message : 'Não foi possível ler o investimento do Google neste período.');
    }
  }
  return { rows, notice: notices.join(' ') || null };
}

module.exports = {
  rememberMetaCatalog, rememberGoogleCatalog, catalogFor, enrichTouch, spendFor, lookupMetaAd,
};
