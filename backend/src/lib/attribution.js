/**
 * Origem do lead no CRM: de qual anúncio a pessoa veio.
 *
 * O contato guarda o primeiro toque e, se um anúncio diferente aparecer
 * depois, o último. Negócio antigo sem esse bloco continua válido: a tela
 * mostra "Origem desconhecida". Formulário ou WhatsApp sem anúncio vira
 * "Orgânico". Nada aqui chama Meta ou Google.
 */

const PLATFORMS = ['meta', 'google', 'organic'];
const CHANNELS = ['form', 'whatsapp', 'instant_form'];

const clip = (v, max = 200) => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

const httpsUrl = (v) => {
  const s = clip(v, 800);
  return s && /^https:\/\//i.test(s) ? s : null;
};

function normName(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyTouch(extra) {
  return {
    platform: 'organic',
    channel: null,
    campaignId: null,
    campaignName: null,
    adsetId: null,
    adsetName: null,
    adId: null,
    adName: null,
    thumbnailUrl: null,
    headline: null,
    body: null,
    sourceType: null,
    sourceId: null,
    fbclid: null,
    gclid: null,
    ctwaClid: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
    at: null,
    ...extra,
  };
}

function utmOf(meta) {
  const pick = (k) => clip(meta && meta[k], 200);
  return {
    source: pick('utm_source'),
    medium: pick('utm_medium'),
    campaign: pick('utm_campaign'),
    content: pick('utm_content'),
    term: pick('utm_term'),
  };
}

function isPaid(touch) {
  if (!touch) return false;
  if (touch.platform === 'meta' || touch.platform === 'google') return true;
  return false;
}

function touchKey(touch) {
  if (!touch) return '';
  return [touch.platform, touch.adId, touch.campaignId, normName(touch.campaignName), normName(touch.adName), touch.gclid, touch.ctwaClid].join('|');
}

function cloneTouch(touch) {
  return touch ? JSON.parse(JSON.stringify(touch)) : null;
}

/**
 * UTMs que o formulário do SID já grava.
 * utm_campaign = nome da campanha, utm_content = nome do anúncio.
 * fbclid marca Meta; gclid marca Google. Sem nada disso, o toque é orgânico.
 */
function touchFromUtm(meta, { channel = 'form', at = null } = {}) {
  const utm = utmOf(meta);
  const fbclid = clip(meta && meta.fbclid, 500);
  const gclid = clip(meta && meta.gclid, 500);
  const src = (utm.source || '').toLowerCase();
  const metaSrc = !!fbclid || /^(facebook|fb|meta|instagram|ig)$/.test(src) || /\b(facebook|instagram)\b/.test(src);
  const googleSrc = !!gclid || /google|adwords|gads/.test(src);
  let platform = 'organic';
  if (googleSrc && !metaSrc) platform = 'google';
  else if (metaSrc && !googleSrc) platform = 'meta';
  else if (googleSrc && metaSrc) platform = /google|adwords|gads/.test(src) || (gclid && !fbclid) ? 'google' : 'meta';
  return emptyTouch({
    platform,
    channel: CHANNELS.includes(channel) ? channel : 'form',
    campaignName: utm.campaign,
    adName: utm.content,
    fbclid,
    gclid,
    utm,
    at: clip(at, 40),
  });
}

/**
 * Objeto referral da WhatsApp Cloud API, na primeira mensagem de um
 * anúncio Click-to-WhatsApp. source_id é o id do anúncio quando source_type
 * é "ad" (num post, é o id da publicação, não do anúncio).
 */
function parseWhatsappReferral(referral, at = null) {
  if (!referral || typeof referral !== 'object' || Array.isArray(referral)) return null;
  const sourceType = clip(referral.source_type, 40);
  const sourceId = clip(referral.source_id, 64);
  const adId = sourceId && sourceType !== 'post' ? sourceId : null;
  const thumb = httpsUrl(referral.thumbnail_url) || httpsUrl(referral.image_url);
  const headline = clip(referral.headline, 300);
  if (!sourceId && !headline && !clip(referral.ctwa_clid, 500) && !thumb) return null;
  return emptyTouch({
    platform: 'meta',
    channel: 'whatsapp',
    adId,
    adName: headline,
    thumbnailUrl: thumb,
    headline,
    body: clip(referral.body, 500),
    sourceType,
    sourceId,
    ctwaClid: clip(referral.ctwa_clid, 500),
    at: clip(at, 40),
  });
}

// Referral de exemplo para o modo de teste. O id bate com o anúncio
// ad_mock_1 do relatório de exemplo da Meta (vídeo de depoimento).
const MOCK_CTWA_REFERRAL = {
  source_url: 'https://fb.me/mock-ctwa',
  source_id: 'ad_mock_1',
  source_type: 'ad',
  headline: 'Depoimento de cliente',
  body: 'Toque para chamar no WhatsApp.',
  media_type: 'image',
  thumbnail_url: null,
  ctwa_clid: 'mock-ctwa-clid',
};

function fieldValue(lead, names) {
  const rows = Array.isArray(lead && lead.field_data) ? lead.field_data : [];
  const wanted = names.map((n) => n.toLowerCase());
  for (const row of rows) {
    const name = String(row && row.name || '').toLowerCase();
    if (!wanted.includes(name)) continue;
    const values = Array.isArray(row.values) ? row.values : [];
    const v = values.map((x) => (x == null ? '' : String(x))).join(' ').trim();
    if (v) return v.slice(0, 200);
  }
  return null;
}

function contactFromInstantLead(lead) {
  const first = fieldValue(lead, ['first_name']);
  const last = fieldValue(lead, ['last_name']);
  const full = fieldValue(lead, ['full_name', 'nome', 'name']) || [first, last].filter(Boolean).join(' ') || null;
  return {
    name: full ? full.slice(0, 120) : null,
    phone: fieldValue(lead, ['phone_number', 'phone', 'telefone', 'whatsapp', 'celular']),
    email: fieldValue(lead, ['email', 'e-mail']),
    company: fieldValue(lead, ['company_name', 'company', 'empresa']),
  };
}

function leadTime(lead) {
  const raw = lead && (lead.created_time || lead.createdTime);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Lead de Instant Form: ad_id, adset_id e campaign_id que a Meta manda no lead. */
function touchFromInstantLead(lead, at = null) {
  if (!lead || typeof lead !== 'object') return null;
  return emptyTouch({
    platform: 'meta',
    channel: 'instant_form',
    campaignId: clip(lead.campaign_id, 64),
    campaignName: clip(lead.campaign_name, 200),
    adsetId: clip(lead.adset_id || lead.adgroup_id, 64),
    adsetName: clip(lead.adset_name, 200),
    adId: clip(lead.ad_id, 64),
    adName: clip(lead.ad_name, 200),
    at: clip(at || leadTime(lead), 40),
  });
}

function organicTouch(channel, at) {
  return emptyTouch({ platform: 'organic', channel: CHANNELS.includes(channel) ? channel : null, at: clip(at, 40) });
}

/**
 * Primeiro toque fica. Um anúncio diferente depois vira o último.
 * Um toque orgânico não apaga nem substitui anúncio que já estava salvo.
 * Devolve true se o contato mudou.
 */
function applyTouch(contact, touch) {
  if (!contact || !touch) return false;
  const next = cloneTouch(touch);
  if (!contact.attribution || !contact.attribution.first) {
    contact.attribution = { first: next, last: null };
    return true;
  }
  if (!isPaid(next)) return false;
  if (touchKey(contact.attribution.first) === touchKey(next)) return false;
  if (contact.attribution.last && touchKey(contact.attribution.last) === touchKey(next)) return false;
  contact.attribution.last = next;
  return true;
}

function firstOf(attribution) {
  if (!attribution || typeof attribution !== 'object') return null;
  if (attribution.platform || attribution.utm || attribution.channel) return attribution;
  return attribution.first || null;
}

function lastOf(attribution) {
  if (!attribution || attribution.platform || !attribution.last) return null;
  return attribution.last;
}

/**
 * Completa nomes e miniatura com o catálogo que já está em cache
 * (relatório da Meta ou campanhas do Google). Não inventa anúncio:
 * só preenche o que bate com o id ou com o nome.
 */
function enrichWithCatalog(touch, catalog) {
  if (!touch) return null;
  const list = (Array.isArray(catalog) ? catalog : []).filter((row) => {
    if (!row) return false;
    if (!touch.platform || touch.platform === 'organic') return row.platform === 'meta' || row.platform === 'google';
    return row.platform === touch.platform;
  });
  if (!list.length) return touch;
  let hit = touch.adId ? list.find((row) => row.adId && String(row.adId) === String(touch.adId)) : null;
  if (!hit && touch.adName) {
    const name = normName(touch.adName);
    const named = list.filter((row) => row.adName && normName(row.adName) === name);
    if (named.length === 1) hit = named[0];
  }
  let camp = null;
  if (touch.campaignId) camp = list.find((row) => row.campaignId && String(row.campaignId) === String(touch.campaignId)) || null;
  if (!camp && touch.campaignName) {
    const name = normName(touch.campaignName);
    camp = list.find((row) => row.campaignName && normName(row.campaignName) === name) || null;
  }
  const src = hit || camp;
  if (!src) return touch;
  const platform = touch.platform === 'meta' || touch.platform === 'google' ? touch.platform : src.platform;
  return {
    ...touch,
    platform,
    campaignId: touch.campaignId || src.campaignId || null,
    campaignName: touch.campaignName || src.campaignName || null,
    adsetId: touch.adsetId || (hit && hit.adsetId) || null,
    adsetName: touch.adsetName || (hit && hit.adsetName) || null,
    adId: touch.adId || (hit && hit.adId) || null,
    adName: (hit && hit.adName) || touch.adName || null,
    thumbnailUrl: touch.thumbnailUrl || (hit && hit.thumbnailUrl) || null,
  };
}

const PLATFORM_LABEL = { meta: 'Meta Ads', google: 'Google Ads', organic: 'Orgânico' };
const CHANNEL_LABEL = { form: 'Formulário', whatsapp: 'WhatsApp', instant_form: 'Formulário instantâneo' };

function campaignKeyOf(touch) {
  if (!touch || !isPaid(touch)) return touch && touch.platform === 'organic' ? 'organic' : '';
  return `${touch.platform}|${touch.campaignId || normName(touch.campaignName) || 'sem-campanha'}`;
}

function adKeyOf(touch) {
  if (!touch || !isPaid(touch)) return '';
  return `${touch.platform}|${touch.adId || normName(touch.adName) || campaignKeyOf(touch)}`;
}

/**
 * O que a tela mostra. Anúncio ganha de orgânico: se o primeiro toque foi
 * orgânico e depois chegou um anúncio, o bloco mostra o anúncio.
 */
function present(attribution, catalog) {
  const first = firstOf(attribution) ? enrichWithCatalog(cloneTouch(firstOf(attribution)), catalog) : null;
  const lastRaw = lastOf(attribution);
  const last = lastRaw ? enrichWithCatalog(cloneTouch(lastRaw), catalog) : null;
  let shown = null;
  let previous = null;
  if (isPaid(first)) {
    shown = first;
    if (isPaid(last) && touchKey(last) !== touchKey(first)) previous = last;
  } else if (isPaid(last)) shown = last;
  else if (first && first.platform === 'organic') shown = first;

  if (!shown) {
    return {
      kind: 'unknown', label: 'Origem desconhecida', platform: null, platformLabel: null,
      channel: null, channelLabel: null,
      campaignId: null, campaignName: null, adsetId: null, adsetName: null, adId: null, adName: null,
      thumbnailUrl: null, headline: null, at: null, campaignKey: '', adKey: '', last: null,
    };
  }
  if (!isPaid(shown)) {
    return {
      kind: 'organic', label: 'Orgânico', platform: 'organic', platformLabel: 'Orgânico',
      channel: shown.channel || null, channelLabel: CHANNEL_LABEL[shown.channel] || null,
      campaignId: null, campaignName: shown.campaignName || null, adsetId: null, adsetName: null,
      adId: null, adName: null, thumbnailUrl: null, headline: null, at: shown.at || null,
      campaignKey: 'organic', adKey: '', last: null,
    };
  }
  const lastView = previous ? {
    platform: previous.platform,
    campaignName: previous.campaignName || null,
    adName: previous.adName || previous.headline || null,
    thumbnailUrl: previous.thumbnailUrl || null,
    at: previous.at || null,
  } : null;
  return {
    kind: 'ad',
    label: PLATFORM_LABEL[shown.platform] || 'Anúncio',
    platform: shown.platform,
    platformLabel: PLATFORM_LABEL[shown.platform] || 'Anúncio',
    channel: shown.channel || null,
    channelLabel: CHANNEL_LABEL[shown.channel] || null,
    campaignId: shown.campaignId || null,
    campaignName: shown.campaignName || null,
    adsetId: shown.adsetId || null,
    adsetName: shown.adsetName || null,
    adId: shown.adId || null,
    adName: shown.adName || shown.headline || null,
    thumbnailUrl: shown.thumbnailUrl || null,
    headline: shown.headline || null,
    at: shown.at || null,
    campaignKey: campaignKeyOf(shown),
    adKey: adKeyOf(shown),
    last: lastView,
  };
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function ratio(spend, count) {
  if (spend == null || !count) return null;
  return roundMoney(spend / count);
}

function addSpend(map, key, spend) {
  if (!key || spend == null || !Number.isFinite(Number(spend))) return;
  map.set(key, (map.get(key) || 0) + Number(spend));
}

/**
 * Tabela do relatório: um bloco por anúncio e outro por campanha.
 * Leads = negócios criados no período. Ganhos = vendas com data de ganho
 * no período (a mesma regra do restante do relatório). Investimento vem
 * das linhas de spend já resolvidas (cache da Meta/Google); esta função
 * não busca nada.
 */
function buildAdReport({ deals, stages, from, to, spendRows, notice = null }) {
  const stageList = Array.isArray(stages) ? stages : [];
  const kindOf = (id) => (stageList.find((s) => s.id === id) || {}).kind || 'open';
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const inRange = (iso) => {
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= fromMs && t < toMs;
  };
  const wonAt = (deal) => {
    if (kindOf(deal.stageId) !== 'won') return null;
    const h = [...(deal.history || [])].reverse().find((e) => (e.type === 'stage' || e.type === 'created') && e.to === deal.stageId);
    return (h && h.at) || deal.stageChangedAt || deal.createdAt;
  };

  const adSpendId = new Map();
  const adSpendName = new Map();
  const campSpendId = new Map();
  const campSpendName = new Map();
  const spendAds = [];
  (Array.isArray(spendRows) ? spendRows : []).forEach((row) => {
    if (!row) return;
    const platform = row.platform === 'google' ? 'google' : 'meta';
    const spend = Number(row.spend);
    if (!Number.isFinite(spend)) return;
    if (row.adId) {
      addSpend(adSpendId, `${platform}|${row.adId}`, spend);
      spendAds.push({ ...row, platform, spend });
    }
    if (row.adName) addSpend(adSpendName, `${platform}|${normName(row.adName)}`, row.adId ? spend : spend);
    if (row.campaignId) addSpend(campSpendId, `${platform}|${row.campaignId}`, spend);
    if (row.campaignName) addSpend(campSpendName, `${platform}|${normName(row.campaignName)}`, spend);
  });

  const buckets = new Map();
  const blank = (seed) => ({
    ...seed,
    leads: 0,
    won: 0,
    revenue: 0,
    stageCounts: {},
  });
  const ensure = (key, seed) => {
    if (!buckets.has(key)) buckets.set(key, blank(seed));
    return buckets.get(key);
  };

  const originOfDeal = (deal) => {
    if (deal && deal._origin) return deal._origin;
    return present(deal && deal.attribution, null);
  };

  const consider = (deal, asSale) => {
    const origin = originOfDeal(deal);
    const key = origin.kind === 'ad'
      ? `ad|${origin.adKey}`
      : origin.kind === 'organic' ? 'organic' : 'unknown';
    const bucket = ensure(key, {
      kind: origin.kind,
      platform: origin.platform,
      platformLabel: origin.platformLabel,
      channel: origin.channel,
      campaignId: origin.campaignId,
      campaignName: origin.campaignName,
      adsetId: origin.adsetId,
      adsetName: origin.adsetName,
      adId: origin.adId,
      adName: origin.adName,
      thumbnailUrl: origin.thumbnailUrl,
      campaignKey: origin.campaignKey,
      adKey: origin.adKey,
    });
    if (!asSale) {
      bucket.leads += 1;
      bucket.stageCounts[deal.stageId] = (bucket.stageCounts[deal.stageId] || 0) + 1;
      if (!bucket.thumbnailUrl && origin.thumbnailUrl) bucket.thumbnailUrl = origin.thumbnailUrl;
    } else {
      bucket.won += 1;
      bucket.revenue += Number(deal.value) || 0;
    }
  };

  (Array.isArray(deals) ? deals : []).forEach((deal) => {
    if (inRange(deal.createdAt)) consider(deal, false);
    const won = wonAt(deal);
    if (won && inRange(won)) consider(deal, true);
  });

  spendAds.forEach((row) => {
    const adKey = `${row.platform}|${row.adId}`;
    const key = `ad|${adKey}`;
    const nameKey = row.adName ? `ad|${row.platform}|${normName(row.adName)}` : null;
    const existing = buckets.get(key) || (nameKey && buckets.get(nameKey)) || null;
    if (existing) {
      if (!existing.thumbnailUrl && row.thumbnailUrl) existing.thumbnailUrl = row.thumbnailUrl;
      if (!existing.adId) existing.adId = String(row.adId);
      if (!existing.adName && row.adName) existing.adName = row.adName;
      if (!existing.campaignName && row.campaignName) existing.campaignName = row.campaignName;
      if (!existing.adsetName && row.adsetName) existing.adsetName = row.adsetName;
      return;
    }
    ensure(key, {
      kind: 'ad',
      platform: row.platform,
      platformLabel: PLATFORM_LABEL[row.platform],
      channel: null,
      campaignId: row.campaignId || null,
      campaignName: row.campaignName || null,
      adsetId: null,
      adsetName: row.adsetName || null,
      adId: String(row.adId),
      adName: row.adName || null,
      thumbnailUrl: row.thumbnailUrl || null,
      campaignKey: `${row.platform}|${row.campaignId || normName(row.campaignName) || 'sem-campanha'}`,
      adKey,
    });
  });

  const spendOfAd = (bucket) => {
    if (bucket.kind !== 'ad') return null;
    if (bucket.adId && adSpendId.has(`${bucket.platform}|${bucket.adId}`)) return adSpendId.get(`${bucket.platform}|${bucket.adId}`);
    if (bucket.adName && adSpendName.has(`${bucket.platform}|${normName(bucket.adName)}`)) return adSpendName.get(`${bucket.platform}|${normName(bucket.adName)}`);
    return null;
  };
  const spendOfCampaign = (platform, campaignId, campaignName) => {
    if (campaignId && campSpendId.has(`${platform}|${campaignId}`)) return campSpendId.get(`${platform}|${campaignId}`);
    if (campaignName && campSpendName.has(`${platform}|${normName(campaignName)}`)) return campSpendName.get(`${platform}|${normName(campaignName)}`);
    return null;
  };

  const stageCols = (counts) => stageList.map((s) => ({
    id: s.id, name: s.name, kind: s.kind, color: s.color || 'gray', count: counts[s.id] || 0,
  }));

  const rank = (kind) => (kind === 'unknown' ? 2 : kind === 'organic' ? 1 : 0);

  const ads = [...buckets.values()].map((b) => {
    const spend = spendOfAd(b);
    return {
      kind: b.kind,
      platform: b.platform,
      platformLabel: b.kind === 'organic' ? 'Orgânico' : b.kind === 'unknown' ? 'Origem desconhecida' : b.platformLabel,
      campaignId: b.campaignId,
      campaignName: b.campaignName,
      adsetName: b.adsetName,
      adId: b.adId,
      adName: b.kind === 'organic' ? 'Orgânico' : b.kind === 'unknown' ? 'Origem desconhecida' : b.adName,
      thumbnailUrl: b.thumbnailUrl,
      leads: b.leads,
      won: b.won,
      revenue: roundMoney(b.revenue),
      stages: stageCols(b.stageCounts),
      spend: spend == null ? null : roundMoney(spend),
      costPerLead: ratio(spend, b.leads),
      costPerSale: ratio(spend, b.won),
    };
  }).sort((a, b) => rank(a.kind) - rank(b.kind) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0) || String(a.adName || '').localeCompare(String(b.adName || ''), 'pt-BR'));

  const camps = new Map();
  const addCamp = (key, seed, deal, asSale) => {
    if (!camps.has(key)) {
      camps.set(key, { ...seed, leads: 0, won: 0, revenue: 0, stageCounts: {} });
    }
    const c = camps.get(key);
    if (!deal) return c;
    if (!asSale) {
      c.leads += 1;
      c.stageCounts[deal.stageId] = (c.stageCounts[deal.stageId] || 0) + 1;
    } else {
      c.won += 1;
      c.revenue += Number(deal.value) || 0;
    }
    return c;
  };

  (Array.isArray(deals) ? deals : []).forEach((deal) => {
    const origin = originOfDeal(deal);
    const key = origin.kind === 'ad' ? `camp|${origin.campaignKey}` : origin.kind === 'organic' ? 'organic' : 'unknown';
    const seed = origin.kind === 'ad' ? {
      kind: 'ad', platform: origin.platform, platformLabel: origin.platformLabel,
      campaignId: origin.campaignId, campaignName: origin.campaignName || 'Campanha sem nome',
    } : origin.kind === 'organic' ? {
      kind: 'organic', platform: 'organic', platformLabel: 'Orgânico', campaignId: null, campaignName: 'Orgânico',
    } : {
      kind: 'unknown', platform: null, platformLabel: 'Origem desconhecida', campaignId: null, campaignName: 'Origem desconhecida',
    };
    if (inRange(deal.createdAt)) addCamp(key, seed, deal, false);
    const won = wonAt(deal);
    if (won && inRange(won)) addCamp(key, seed, deal, true);
  });

  const seenCamp = new Set([...camps.keys()]);
  (Array.isArray(spendRows) ? spendRows : []).forEach((row) => {
    if (!row) return;
    const platform = row.platform === 'google' ? 'google' : 'meta';
    const campaignKey = `${platform}|${row.campaignId || normName(row.campaignName) || 'sem-campanha'}`;
    const key = `camp|${campaignKey}`;
    if (seenCamp.has(key)) return;
    seenCamp.add(key);
    addCamp(key, {
      kind: 'ad', platform, platformLabel: PLATFORM_LABEL[platform],
      campaignId: row.campaignId || null, campaignName: row.campaignName || 'Campanha sem nome',
    }, null, false);
  });

  const campaigns = [...camps.values()].map((c) => {
    const spend = c.kind === 'ad' ? spendOfCampaign(c.platform, c.campaignId, c.campaignName) : null;
    return {
      kind: c.kind,
      platform: c.platform,
      platformLabel: c.platformLabel,
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      leads: c.leads,
      won: c.won,
      revenue: roundMoney(c.revenue),
      stages: stageCols(c.stageCounts),
      spend: spend == null ? null : roundMoney(spend),
      costPerLead: ratio(spend, c.leads),
      costPerSale: ratio(spend, c.won),
    };
  }).sort((a, b) => rank(a.kind) - rank(b.kind) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0) || String(a.campaignName || '').localeCompare(String(b.campaignName || ''), 'pt-BR'));

  return { ads, campaigns, notice: notice || null };
}

module.exports = {
  PLATFORMS, normName, isPaid, touchKey,
  touchFromUtm, parseWhatsappReferral, MOCK_CTWA_REFERRAL,
  contactFromInstantLead, touchFromInstantLead, organicTouch,
  applyTouch, enrichWithCatalog, present, buildAdReport,
};
