/**
 * Formato dos rascunhos de campanha (Meta e Google Pesquisa).
 *
 * sanitize*(): limpa o que veio da tela ou de um agente. É tolerante (um
 *   rascunho pode estar pela metade), só descarta o que é inválido.
 * validate*(): checagem completa, usada ao enviar para aprovação e de novo
 *   na hora de publicar. Devolve a lista de problemas em português.
 */

const META_OBJECTIVES = {
  mensagens: 'Mensagens no WhatsApp',
  trafego: 'Tráfego para o site',
  cadastros: 'Cadastros no site (pixel)',
  vendas: 'Vendas no site (pixel)',
  alcance: 'Alcance / reconhecimento',
};
const META_CTAS = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'BOOK_TRAVEL', 'GET_QUOTE', 'SUBSCRIBE', 'ORDER_NOW', 'WHATSAPP_MESSAGE', 'APPLY_NOW', 'DOWNLOAD'];
const META_POSITIONS = ['facebook_feed', 'facebook_stories', 'facebook_reels', 'instagram_feed', 'instagram_stories', 'instagram_reels', 'instagram_explore'];
const SPECIAL_CATEGORIES = ['NONE', 'HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES'];
const GOOGLE_BIDDING = ['maximize_clicks', 'maximize_conversions', 'manual_cpc'];
const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'];
const LANGUAGES = { pt: 1014, en: 1000, es: 1003, it: 1004, fr: 1002, de: 1001 };
// Países com código de segmentação do Google (geoTargetConstants/<id>).
const GOOGLE_COUNTRIES = {
  BR: 2076, PT: 2620, US: 2840, ES: 2724, IT: 2380, FR: 2250, DE: 2276, GB: 2826,
  AR: 2032, MX: 2484, CL: 2152, CO: 2170, UY: 2858, PY: 2600, CA: 2124,
};
// União Europeia: a Meta exige beneficiário e pagador (lei DSA) quando o anúncio mira esses países.
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v) => v === true;
// Um rascunho pode ter vários conjuntos e vários anúncios. O teto evita
// um payload acidentalmente enorme; a tela para antes disso.
const MAX_AD_SETS = 25;
const MAX_ADS_PER_SET = 25;
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const date = (d) => (isDate(d) ? d : '');
const isUrl = (u) => /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(u || '');
const strList = (arr, maxItems, maxLen) => (Array.isArray(arr) ? arr : typeof arr === 'string' ? arr.split(/[\n;]+/) : [])
  .map((x) => str(String(x ?? ''), maxLen)).filter(Boolean).slice(0, maxItems);
const intIn = (v, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };

// Data de hoje em São Paulo (é o fuso da agência).
function todaySP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/* ===================== Meta ===================== */

function sanitizeCountries(list) {
  return strList(list, 10, 2).map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
}

// Público completo (nível da campanha). Com partial=true, só entram as chaves
// que o conjunto mandou: o resto herda o público da campanha na hora de publicar.
function sanitizeAudience(a = {}, partial = false) {
  const countries = sanitizeCountries(a.countries);
  const full = {
    countries: countries.length ? countries : ['BR'],
    cities: strList(a.cities, 20, 80),
    ageMin: intIn(a.ageMin, 18, 65) ?? 18,
    ageMax: intIn(a.ageMax, 18, 65) ?? 65,
    gender: ['male', 'female'].includes(a.gender) ? a.gender : 'all',
    interests: strList(a.interests, 20, 80),
    advantage: bool(a.advantage),
  };
  if (!partial) return full;
  const patch = {};
  if (a.countries !== undefined) patch.countries = full.countries;
  if (a.cities !== undefined) patch.cities = full.cities;
  if (a.ageMin !== undefined && a.ageMin !== '') patch.ageMin = full.ageMin;
  if (a.ageMax !== undefined && a.ageMax !== '') patch.ageMax = full.ageMax;
  if (a.gender !== undefined) patch.gender = full.gender;
  if (a.interests !== undefined) patch.interests = full.interests;
  if (a.advantage !== undefined) patch.advantage = full.advantage;
  return patch;
}

function sanitizePlacements(p = {}) {
  return {
    mode: p.mode === 'manual' ? 'manual' : 'auto',
    positions: (Array.isArray(p.positions) ? p.positions : []).filter((x) => META_POSITIONS.includes(x)),
  };
}

function sanitizeCreative(c = {}, partial = false) {
  const full = {
    assetId: str(String(c.assetId ?? ''), 64),
    primaryText: str(c.primaryText, 2000),
    headline: str(c.headline, 255),
    description: str(c.description, 255),
    cta: META_CTAS.includes(c.cta) ? c.cta : '',
    link: str(c.link, 1000),
  };
  if (!partial) return full;
  const patch = {};
  if (c.assetId !== undefined) patch.assetId = full.assetId;
  if (c.primaryText !== undefined) patch.primaryText = full.primaryText;
  if (c.headline !== undefined) patch.headline = full.headline;
  if (c.description !== undefined) patch.description = full.description;
  if (c.cta !== undefined) patch.cta = full.cta;
  if (c.link !== undefined) patch.link = full.link;
  return patch;
}

// "opt_out" pede para a Meta não aplicar Advantage+ no criativo.
// "default" (ou ausente) deixa o padrão da API.
function readEnhancements(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.creativeEnhancements === 'opt_out' || input.creativeEnhancements === 'default') return input.creativeEnhancements;
  if (input.advantageCreative === false || input.optOutAdvantageCreative === true || input.optOutCreativeEnhancements === true) return 'opt_out';
  if (input.advantageCreative === true) return 'default';
  return '';
}

function creativeFrom(input = {}) {
  const c = input.creative && typeof input.creative === 'object' ? input.creative : {};
  return sanitizeCreative({
    assetId: c.assetId ?? input.assetId,
    primaryText: c.primaryText ?? input.primaryText,
    headline: c.headline ?? input.headline,
    description: c.description ?? input.description,
    cta: c.cta ?? input.cta,
    link: c.link ?? input.link,
  }, true);
}

function sanitizeAd(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const ad = { name: str(input.name, 400), creative: creativeFrom(input) };
  const enh = readEnhancements(input);
  if (enh) ad.creativeEnhancements = enh;
  return ad;
}

function sanitizeAdSet(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const adsIn = Array.isArray(input.ads) ? input.ads : [];
  const set = {
    name: str(input.name, 400),
    ads: adsIn.slice(0, MAX_ADS_PER_SET).map(sanitizeAd).filter(Boolean),
  };
  if (input.audience && typeof input.audience === 'object') set.audience = sanitizeAudience(input.audience, true);
  if (input.placements && typeof input.placements === 'object') set.placements = sanitizePlacements(input.placements);
  return set;
}

function sanitizeMeta(input = {}) {
  const d = input.dsa || {};
  const out = {
    objective: META_OBJECTIVES[input.objective] ? input.objective : 'mensagens',
    pixelId: str(String(input.pixelId ?? ''), 30).replace(/\D/g, ''),
    specialAdCategory: SPECIAL_CATEGORIES.includes(input.specialAdCategory) ? input.specialAdCategory : 'NONE',
    budgetType: input.budgetType === 'lifetime' ? 'lifetime' : 'daily',
    budget: money(input.budget),
    startDate: date(input.startDate),
    endDate: date(input.endDate),
    audience: sanitizeAudience(input.audience || {}),
    placements: sanitizePlacements(input.placements || {}),
    creative: sanitizeCreative(input.creative || {}),
    dsa: { beneficiary: str(d.beneficiary, 100), payor: str(d.payor, 100) },
  };
  const enh = readEnhancements(input);
  if (enh) out.creativeEnhancements = enh;
  // Sem adSets (ou lista vazia): o formato antigo, de um conjunto e um anúncio, segue valendo.
  if (Array.isArray(input.adSets) && input.adSets.length) {
    out.adSets = input.adSets.slice(0, MAX_AD_SETS).map(sanitizeAdSet).filter(Boolean);
  }
  return out;
}

function usesAdSets(spec) {
  return !!(spec && Array.isArray(spec.adSets) && spec.adSets.length);
}

function mergeAudience(base, patch) {
  if (!patch || typeof patch !== 'object') return { ...base };
  const out = { ...base };
  if (patch.countries && patch.countries.length) out.countries = patch.countries;
  if (patch.cities) out.cities = patch.cities;
  if (patch.ageMin != null) out.ageMin = patch.ageMin;
  if (patch.ageMax != null) out.ageMax = patch.ageMax;
  if (patch.gender) out.gender = patch.gender;
  if (patch.interests && patch.interests.length) out.interests = patch.interests;
  if (patch.advantage !== undefined) out.advantage = !!patch.advantage;
  return out;
}

function mergePlacements(base, patch) {
  if (!patch || !patch.mode) return { mode: base.mode, positions: [...(base.positions || [])] };
  return { mode: patch.mode, positions: [...(patch.positions || [])] };
}

function mergeCreative(base, patch) {
  const out = { ...base };
  if (!patch) return out;
  for (const k of ['assetId', 'primaryText', 'headline', 'description', 'cta', 'link']) {
    if (typeof patch[k] === 'string' && patch[k]) out[k] = patch[k];
  }
  return out;
}

function adOptsOut(spec, ad) {
  if (ad && ad.creativeEnhancements === 'opt_out') return true;
  if (ad && ad.creativeEnhancements === 'default') return false;
  return spec.creativeEnhancements === 'opt_out';
}

/**
 * Plano que a publicação usa. Sem adSets, vira um conjunto e um anúncio com
 * os nomes de sempre (`Campanha | Conjunto` / `Campanha | Anúncio`), para
 * rascunhos antigos publicarem igual. Com adSets, os nomes são os do rascunho.
 */
function expandMetaPlan(spec, campaignName = '') {
  const baseAudience = spec.audience || sanitizeAudience({});
  const basePlacements = spec.placements || sanitizePlacements({});
  const baseCreative = spec.creative || sanitizeCreative({});
  if (!usesAdSets(spec)) {
    return {
      legacy: true,
      adSets: [{
        name: `${campaignName} | Conjunto`,
        audience: baseAudience,
        placements: basePlacements,
        ads: [{
          name: `${campaignName} | Anúncio`,
          creative: baseCreative,
          optOutCreative: spec.creativeEnhancements === 'opt_out',
        }],
      }],
    };
  }
  return {
    legacy: false,
    adSets: spec.adSets.map((set) => ({
      name: set.name,
      audience: mergeAudience(baseAudience, set.audience),
      placements: mergePlacements(basePlacements, set.placements),
      ads: (set.ads || []).map((ad) => ({
        name: ad.name,
        creative: mergeCreative(baseCreative, ad.creative),
        optOutCreative: adOptsOut(spec, ad),
      })),
    })),
  };
}

function collectAssetIds(spec, campaignName = '') {
  const ids = [];
  for (const set of expandMetaPlan(spec, campaignName).adSets) {
    for (const ad of set.ads) {
      const id = ad.creative && ad.creative.assetId;
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function describeMissingAssets(spec, campaignName, missingIds) {
  const missing = new Set(missingIds || []);
  if (!missing.size) return [];
  if (!usesAdSets(spec)) return ['A imagem do anúncio não foi encontrada. Envie de novo.'];
  const problems = [];
  const seen = new Set();
  for (const set of expandMetaPlan(spec, campaignName).adSets) {
    for (const ad of set.ads) {
      const id = ad.creative && ad.creative.assetId;
      if (!id || !missing.has(id) || seen.has(`${id}:${ad.name}`)) continue;
      seen.add(`${id}:${ad.name}`);
      problems.push(ad.name
        ? `A imagem do anúncio "${ad.name}" não foi encontrada. Envie de novo.`
        : 'A imagem do anúncio não foi encontrada. Envie de novo.');
    }
  }
  if (!problems.length && missing.size) problems.push('A imagem do anúncio não foi encontrada. Envie de novo.');
  return problems;
}

function validateMeta(spec, { account } = {}) {
  const e = [];
  if (!spec.budget) e.push('Informe o orçamento.');
  if (!spec.startDate) e.push('Informe a data de início.');
  else if (spec.startDate < todaySP()) e.push('A data de início já passou.');
  if (spec.budgetType === 'lifetime' && !spec.endDate) e.push('Orçamento total precisa de data de término.');
  if (spec.endDate && spec.startDate && spec.endDate < spec.startDate) e.push('A data de término é antes do início.');
  if (['cadastros', 'vendas'].includes(spec.objective) && !spec.pixelId) e.push('Esse objetivo precisa do ID do pixel da Meta.');
  if (!usesAdSets(spec)) {
    // Formato antigo: um público, um posicionamento e um anúncio no nível da campanha.
    if (spec.objective !== 'mensagens' && !isUrl(spec.creative.link)) e.push('Informe o link de destino (começando com https://).');
    if (spec.audience.ageMin > spec.audience.ageMax) e.push('A idade mínima é maior que a máxima.');
    if (spec.placements.mode === 'manual' && !spec.placements.positions.length) e.push('Escolha pelo menos um posicionamento.');
    if (!spec.creative.assetId) e.push('Envie a imagem do anúncio.');
    if (!spec.creative.primaryText) e.push('Escreva o texto principal do anúncio.');
    if (!spec.creative.headline) e.push('Escreva o título do anúncio.');
    if (spec.audience.countries.some((c) => EU.includes(c)) && (!spec.dsa.beneficiary || !spec.dsa.payor)) {
      e.push('Anúncio para a União Europeia: informe beneficiário e pagador (exigência da Meta).');
    }
  } else {
    const plan = expandMetaPlan(spec, '');
    const seenSets = new Set();
    const seenAds = new Set();
    let needsDsa = false;
    plan.adSets.forEach((set, i) => {
      const setLabel = set.name ? `conjunto "${set.name}"` : `conjunto ${i + 1}`;
      if (!set.name) e.push(`Dê um nome para o ${setLabel}.`);
      else if (seenSets.has(set.name)) e.push(`O nome de conjunto "${set.name}" está repetido.`);
      else seenSets.add(set.name);
      if (set.audience.ageMin > set.audience.ageMax) e.push(`No ${setLabel}, a idade mínima é maior que a máxima.`);
      if (set.placements.mode === 'manual' && !set.placements.positions.length) e.push(`No ${setLabel}, escolha pelo menos um posicionamento.`);
      if (set.audience.countries.some((c) => EU.includes(c))) needsDsa = true;
      if (!set.ads.length) e.push(`O ${setLabel} precisa de pelo menos um anúncio.`);
      set.ads.forEach((ad, j) => {
        const adLabel = ad.name ? `anúncio "${ad.name}"` : `anúncio ${j + 1} do ${setLabel}`;
        if (!ad.name) e.push(`Dê um nome para o ${adLabel}.`);
        else if (seenAds.has(ad.name)) e.push(`O nome de anúncio "${ad.name}" está repetido.`);
        else seenAds.add(ad.name);
        if (!ad.creative.assetId) e.push(`Envie a imagem do ${adLabel}.`);
        if (!ad.creative.primaryText) e.push(`Escreva o texto principal do ${adLabel}.`);
        if (!ad.creative.headline) e.push(`Escreva o título do ${adLabel}.`);
        if (spec.objective !== 'mensagens' && !isUrl(ad.creative.link)) e.push(`Informe o link de destino do ${adLabel} (começando com https://).`);
      });
    });
    if (needsDsa && (!spec.dsa.beneficiary || !spec.dsa.payor)) {
      e.push('Anúncio para a União Europeia: informe beneficiário e pagador (exigência da Meta).');
    }
  }
  if (account) {
    const m = account.meta || {};
    if (!m.adAccountId) e.push('Este cliente não tem conta de anúncios da Meta cadastrada (aba Integrações).');
    if (!m.pageId) e.push('Este cliente não tem a Página do Facebook cadastrada (aba Integrações).');
  }
  return e;
}

/* ===================== Google (Pesquisa) ===================== */

function sanitizeGoogle(input = {}) {
  const country = String(input.country || 'BR').toUpperCase();
  const kws = (Array.isArray(input.keywords) ? input.keywords : strList(input.keywords, 200, 80))
    .map((k) => (typeof k === 'string' ? { text: k } : k || {}))
    .map((k) => {
      let text = str(String(k.text ?? ''), 80);
      let match = MATCH_TYPES.includes(k.match) ? k.match : 'BROAD';
      // Mesmo jeito do Google Ads Editor: texto puro = ampla, "frase" e [exata].
      if (/^\[.*\]$/.test(text)) { text = text.slice(1, -1).trim(); match = 'EXACT'; } else if (/^".*"$/.test(text)) { text = text.slice(1, -1).trim(); match = 'PHRASE'; }
      return { text, match };
    })
    .filter((k) => k.text)
    .slice(0, 200);
  return {
    type: 'search',
    budget: money(input.budget),
    startDate: date(input.startDate),
    endDate: date(input.endDate),
    bidding: GOOGLE_BIDDING.includes(input.bidding) ? input.bidding : 'maximize_clicks',
    cpcBid: money(input.cpcBid),
    country: GOOGLE_COUNTRIES[country] ? country : 'BR',
    cities: strList(input.cities, 20, 80),
    language: LANGUAGES[input.language] ? input.language : 'pt',
    searchPartners: bool(input.searchPartners),
    keywords: kws,
    negatives: strList(input.negatives, 200, 80),
    finalUrl: str(input.finalUrl, 1000),
    headlines: strList(input.headlines, 15, 60),
    descriptions: strList(input.descriptions, 4, 120),
    path1: str(input.path1, 30),
    path2: str(input.path2, 30),
  };
}

function validateGoogle(spec, { account } = {}) {
  const e = [];
  if (!spec.budget) e.push('Informe o orçamento diário.');
  if (!spec.startDate) e.push('Informe a data de início.');
  else if (spec.startDate < todaySP()) e.push('A data de início já passou.');
  if (spec.endDate && spec.startDate && spec.endDate < spec.startDate) e.push('A data de término é antes do início.');
  if (spec.bidding === 'manual_cpc' && !spec.cpcBid) e.push('CPC manual precisa do lance máximo por clique.');
  if (!spec.keywords.length) e.push('Inclua pelo menos uma palavra-chave.');
  if (!isUrl(spec.finalUrl)) e.push('Informe a URL final (começando com https://).');
  if (spec.headlines.length < 3) e.push('O anúncio responsivo precisa de pelo menos 3 títulos.');
  spec.headlines.forEach((h, i) => { if (h.length > 30) e.push(`Título ${i + 1} passa de 30 caracteres (${h.length}).`); });
  if (spec.descriptions.length < 2) e.push('O anúncio responsivo precisa de pelo menos 2 descrições.');
  spec.descriptions.forEach((d, i) => { if (d.length > 90) e.push(`Descrição ${i + 1} passa de 90 caracteres (${d.length}).`); });
  if (spec.path1.length > 15 || spec.path2.length > 15) e.push('Os caminhos da URL de exibição têm até 15 caracteres cada.');
  if (account && !(account.google || {}).customerId) e.push('Este cliente não tem conta do Google Ads cadastrada (aba Integrações).');
  return e;
}

function sanitize(platform, spec) { return platform === 'google' ? sanitizeGoogle(spec) : sanitizeMeta(spec); }
function validate(platform, spec, ctx) { return platform === 'google' ? validateGoogle(spec, ctx) : validateMeta(spec, ctx); }

module.exports = {
  sanitize, validate, sanitizeMeta, sanitizeGoogle, validateMeta, validateGoogle, todaySP,
  usesAdSets, expandMetaPlan, collectAssetIds, describeMissingAssets,
  META_OBJECTIVES, META_CTAS, META_POSITIONS, SPECIAL_CATEGORIES, GOOGLE_COUNTRIES, LANGUAGES, EU,
  MAX_AD_SETS, MAX_ADS_PER_SET,
};
