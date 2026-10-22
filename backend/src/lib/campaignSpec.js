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

function sanitizeMeta(input = {}) {
  const a = input.audience || {};
  const p = input.placements || {};
  const c = input.creative || {};
  const d = input.dsa || {};
  const countries = strList(a.countries, 10, 2).map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
  return {
    objective: META_OBJECTIVES[input.objective] ? input.objective : 'mensagens',
    pixelId: str(String(input.pixelId ?? ''), 30).replace(/\D/g, ''),
    specialAdCategory: SPECIAL_CATEGORIES.includes(input.specialAdCategory) ? input.specialAdCategory : 'NONE',
    budgetType: input.budgetType === 'lifetime' ? 'lifetime' : 'daily',
    budget: money(input.budget),
    startDate: date(input.startDate),
    endDate: date(input.endDate),
    audience: {
      countries: countries.length ? countries : ['BR'],
      cities: strList(a.cities, 20, 80),
      ageMin: intIn(a.ageMin, 18, 65) ?? 18,
      ageMax: intIn(a.ageMax, 18, 65) ?? 65,
      gender: ['male', 'female'].includes(a.gender) ? a.gender : 'all',
      interests: strList(a.interests, 20, 80),
      advantage: bool(a.advantage),
    },
    placements: {
      mode: p.mode === 'manual' ? 'manual' : 'auto',
      positions: (Array.isArray(p.positions) ? p.positions : []).filter((x) => META_POSITIONS.includes(x)),
    },
    creative: {
      assetId: str(String(c.assetId ?? ''), 64),
      primaryText: str(c.primaryText, 2000),
      headline: str(c.headline, 255),
      description: str(c.description, 255),
      cta: META_CTAS.includes(c.cta) ? c.cta : '',
      link: str(c.link, 1000),
    },
    dsa: { beneficiary: str(d.beneficiary, 100), payor: str(d.payor, 100) },
  };
}

function validateMeta(spec, { account } = {}) {
  const e = [];
  if (!spec.budget) e.push('Informe o orçamento.');
  if (!spec.startDate) e.push('Informe a data de início.');
  else if (spec.startDate < todaySP()) e.push('A data de início já passou.');
  if (spec.budgetType === 'lifetime' && !spec.endDate) e.push('Orçamento total precisa de data de término.');
  if (spec.endDate && spec.startDate && spec.endDate < spec.startDate) e.push('A data de término é antes do início.');
  if (['cadastros', 'vendas'].includes(spec.objective) && !spec.pixelId) e.push('Esse objetivo precisa do ID do pixel da Meta.');
  if (spec.objective !== 'mensagens' && !isUrl(spec.creative.link)) e.push('Informe o link de destino (começando com https://).');
  if (spec.audience.ageMin > spec.audience.ageMax) e.push('A idade mínima é maior que a máxima.');
  if (spec.placements.mode === 'manual' && !spec.placements.positions.length) e.push('Escolha pelo menos um posicionamento.');
  if (!spec.creative.assetId) e.push('Envie a imagem do anúncio.');
  if (!spec.creative.primaryText) e.push('Escreva o texto principal do anúncio.');
  if (!spec.creative.headline) e.push('Escreva o título do anúncio.');
  if (spec.audience.countries.some((c) => EU.includes(c)) && (!spec.dsa.beneficiary || !spec.dsa.payor)) {
    e.push('Anúncio para a União Europeia: informe beneficiário e pagador (exigência da Meta).');
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
  META_OBJECTIVES, META_CTAS, META_POSITIONS, SPECIAL_CATEGORIES, GOOGLE_COUNTRIES, LANGUAGES, EU,
};
