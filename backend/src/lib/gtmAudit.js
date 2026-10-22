/**
 * Conferência (auditoria) de um contêiner do Google Tag Manager.
 * Função pura: recebe as listas de tags, acionadores e variáveis (formato da
 * Tag Manager API v2) e devolve um checklist em pt-BR. Não chama nenhuma API.
 */

// Acionadores nativos do GTM (não aparecem na lista de triggers da API).
const BUILTIN_TRIGGERS = {
  2147479553: 'Todas as páginas',
  2147479572: 'Inicialização de consentimento (todas as páginas)',
  2147479573: 'Inicialização (todas as páginas)',
};
const ALL_PAGES = ['2147479553', '2147479573', '2147479572'];

const TAG_TYPES = {
  html: 'HTML personalizado',
  googtag: 'Google tag',
  gaawc: 'GA4 configuração (antiga)',
  gaawe: 'GA4 evento',
  awct: 'Conversão do Google Ads',
  sp: 'Remarketing do Google Ads',
  gclidw: 'Vinculador de conversões',
  ua: 'Universal Analytics (descontinuado)',
  img: 'Imagem personalizada',
  flc: 'Floodlight (contador)',
  fls: 'Floodlight (vendas)',
};
const TRIGGER_TYPES = {
  pageview: 'Visualização de página', domReady: 'DOM pronto', windowLoaded: 'Janela carregada',
  formSubmission: 'Envio de formulário', linkClick: 'Clique em link', click: 'Clique em elemento',
  customEvent: 'Evento personalizado', timer: 'Temporizador', scrollDepth: 'Rolagem',
  elementVisibility: 'Visibilidade de elemento', historyChange: 'Mudança no histórico',
  youTubeVideo: 'Vídeo do YouTube', init: 'Inicialização', consentInit: 'Inicialização de consentimento',
  jsError: 'Erro de JavaScript', triggerGroup: 'Grupo de acionadores',
};

function tagTypeLabel(type) {
  if (!type) return 'Desconhecido';
  if (TAG_TYPES[type]) return TAG_TYPES[type];
  if (type.startsWith('cvt_')) return 'Modelo da galeria da comunidade';
  return type;
}
function triggerTypeLabel(type) { return TRIGGER_TYPES[type] || type || 'Desconhecido'; }

function params(tag) {
  const out = {};
  for (const p of tag.parameter || []) out[p.key] = p;
  return out;
}
function pval(tag, key) {
  const p = params(tag)[key];
  return p && typeof p.value === 'string' ? p.value.trim() : '';
}
// Texto de todos os parâmetros (inclui listas e mapas), pra achar IDs em modelos da comunidade.
function allParamText(tag) {
  const walk = (p) => [p.value || '', ...(p.list || []).map(walk), ...(p.map || []).map(walk)].join(' ');
  return (tag.parameter || []).map((p) => `${p.key}=${walk(p)}`).join(' ');
}

function uniq(a) { return [...new Set(a.filter(Boolean))]; }

/** Identifica o que cada tag faz (pixel da Meta, GA4, Google Ads, vinculador). */
function classifyTag(tag) {
  const type = tag.type || '';
  const out = { metaPixelIds: [], metaPixelBase: false, ga4Ids: [], adsIds: [], adsConversions: [], linker: false };
  if (type === 'html') {
    const html = pval(tag, 'html');
    if (/fbq\(\s*['"]init['"]/.test(html) || /connect\.facebook\.net\/[^"']*fbevents\.js/.test(html)) {
      out.metaPixelBase = /fbevents\.js/.test(html) || /fbq\(\s*['"]init['"]/.test(html);
      out.metaPixelIds = uniq([...html.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{6,20})/g)].map((m) => m[1]));
    }
    const gtagIds = [...html.matchAll(/\b(G-[A-Z0-9]{4,15}|AW-\d{6,15})\b/g)].map((m) => m[1]);
    out.ga4Ids = uniq(gtagIds.filter((i) => i.startsWith('G-')));
    out.adsIds = uniq(gtagIds.filter((i) => i.startsWith('AW-')));
    for (const m of html.matchAll(/send_to['"]?\s*:\s*['"](AW-\d{6,15})\/([\w-]+)['"]/g)) out.adsConversions.push({ id: m[1], label: m[2] });
  } else if (type === 'googtag') {
    const id = pval(tag, 'tagId').toUpperCase();
    if (id.startsWith('G-')) out.ga4Ids.push(id);
    if (id.startsWith('AW-')) out.adsIds.push(id);
  } else if (type === 'gaawc') {
    const id = pval(tag, 'measurementId').toUpperCase();
    if (id) out.ga4Ids.push(id);
  } else if (type === 'awct') {
    const id = pval(tag, 'conversionId').replace(/^AW-/i, '');
    const label = pval(tag, 'conversionLabel');
    out.adsConversions.push({ id: id ? `AW-${id}` : '', label });
    if (id) out.adsIds.push(`AW-${id}`);
  } else if (type === 'sp') {
    const id = pval(tag, 'conversionId').replace(/^AW-/i, '');
    if (id) out.adsIds.push(`AW-${id}`);
  } else if (type === 'gclidw') {
    out.linker = true;
  } else if (type.startsWith('cvt_')) {
    const text = allParamText(tag);
    const looksMeta = /pixel/i.test(text) || /facebook|meta/i.test(tag.name || '');
    if (looksMeta) {
      const ids = [...text.matchAll(/pixel\w*=([\d,\s]{6,})/gi)].flatMap((m) => m[1].split(/[,\s]+/));
      out.metaPixelIds = uniq(ids.filter((i) => /^\d{6,20}$/.test(i)));
      // Modelo da comunidade da Meta: evento PageView (ou sem evento) = código base.
      const ev = (text.match(/eventName=(\w+)/i) || [])[1];
      out.metaPixelBase = out.metaPixelIds.length > 0 && (!ev || /pageview/i.test(ev) || /standard/i.test(ev));
    }
  }
  return out;
}

function triggerNames(tag, triggersById) {
  return (tag.firingTriggerId || []).map((id) => BUILTIN_TRIGGERS[id] || (triggersById[id] && triggersById[id].name) || `Acionador ${id}`);
}
function firesAllPages(tag) { return (tag.firingTriggerId || []).some((id) => ALL_PAGES.includes(String(id))); }

/**
 * @param {{tags?:object[], triggers?:object[], variables?:object[]}} entities
 * @returns checklist + listas resumidas pra tela
 */
function audit(entities) {
  const tags = entities.tags || [];
  const triggers = entities.triggers || [];
  const variables = entities.variables || [];
  const triggersById = Object.fromEntries(triggers.map((t) => [String(t.triggerId), t]));
  const rows = tags.map((t) => ({ tag: t, c: classifyTag(t) }));
  const active = rows.filter((r) => !r.tag.paused);

  const items = [];
  const names = (list) => list.map((r) => r.tag.name);

  // 1. Pixel da Meta
  const pixelRows = active.filter((r) => r.c.metaPixelBase || r.c.metaPixelIds.length);
  const pixelIds = uniq(pixelRows.flatMap((r) => r.c.metaPixelIds));
  if (pixelRows.length) {
    const allPages = pixelRows.some((r) => firesAllPages(r.tag));
    items.push({
      key: 'meta_pixel', label: 'Pixel da Meta (código base)', status: allPages ? 'ok' : 'warn',
      detail: `${pixelIds.length ? `Pixel ${pixelIds.join(', ')}` : 'Pixel sem ID identificado'} em ${names(pixelRows).map((n) => `"${n}"`).join(', ')}.${allPages ? '' : ' Não dispara em todas as páginas, então o PageView pode faltar em parte do site.'}`,
      ids: pixelIds,
    });
  } else {
    items.push({ key: 'meta_pixel', label: 'Pixel da Meta (código base)', status: 'missing', detail: 'Nenhuma tag com o código base do Pixel da Meta. Sem ele, a Meta não recebe PageView nem conversões deste site pelo GTM.', ids: [] });
  }

  // 2. GA4 / Google tag
  const gaRows = active.filter((r) => r.c.ga4Ids.length);
  const gaIds = uniq(gaRows.flatMap((r) => r.c.ga4Ids));
  items.push(gaRows.length
    ? { key: 'ga4', label: 'GA4 (Google tag G-)', status: 'ok', detail: `${gaIds.join(', ')} em ${names(gaRows).map((n) => `"${n}"`).join(', ')}.`, ids: gaIds }
    : { key: 'ga4', label: 'GA4 (Google tag G-)', status: 'missing', detail: 'Nenhuma Google tag com ID de medição G- do Google Analytics 4.', ids: [] });

  // 3. Conversão do Google Ads
  const convs = active.flatMap((r) => r.c.adsConversions.map((cv) => ({ ...cv, tag: r.tag.name })));
  const noLabel = convs.filter((cv) => !cv.id || !cv.label);
  const adsIds = uniq(active.flatMap((r) => r.c.adsIds));
  if (convs.length) {
    items.push({
      key: 'ads_conversion', label: 'Conversão do Google Ads (AW- + rótulo)', status: noLabel.length ? 'warn' : 'ok',
      detail: convs.map((cv) => `${cv.id || 'sem ID'}${cv.label ? ` / ${cv.label}` : ' / sem rótulo'} ("${cv.tag}")`).join('; ') + '.' + (noLabel.length ? ' Há conversão sem ID ou sem rótulo: ela não registra nada.' : ''),
      ids: adsIds,
    });
  } else {
    items.push({
      key: 'ads_conversion', label: 'Conversão do Google Ads (AW- + rótulo)', status: 'missing',
      detail: adsIds.length ? `Existe ${adsIds.join(', ')}, mas nenhuma tag de conversão com rótulo.` : 'Nenhuma tag de conversão do Google Ads.',
      ids: adsIds,
    });
  }

  // 4. Vinculador de conversões
  const linkerRows = active.filter((r) => r.c.linker);
  const usesAds = convs.length > 0 || adsIds.length > 0;
  if (linkerRows.length) {
    const allPages = linkerRows.some((r) => firesAllPages(r.tag));
    items.push({ key: 'conversion_linker', label: 'Vinculador de conversões (Conversion Linker)', status: allPages ? 'ok' : 'warn', detail: `"${names(linkerRows).join('", "')}"${allPages ? ' dispara em todas as páginas.' : ' não dispara em todas as páginas; o gclid pode se perder.'}` });
  } else {
    items.push({ key: 'conversion_linker', label: 'Vinculador de conversões (Conversion Linker)', status: usesAds ? 'missing' : 'info', detail: usesAds ? 'Falta o vinculador. Sem ele, o Google Ads perde parte das conversões (o clique do anúncio não fica guardado).' : 'Recomendado assim que o site tiver conversão do Google Ads.' });
  }

  // 5. Duplicadas
  const dupes = [];
  const group = (keyFn, why) => {
    const map = new Map();
    for (const r of active) { const k = keyFn(r); if (!k) continue; if (!map.has(k)) map.set(k, []); map.get(k).push(r.tag.name); }
    for (const [k, list] of map) if (list.length > 1) dupes.push({ why: why(k), tags: list });
  };
  group((r) => (r.c.metaPixelBase && r.c.metaPixelIds.length ? r.c.metaPixelIds.sort().join(',') : null), (k) => `Código base do Pixel ${k} repetido (conta PageView em dobro)`);
  group((r) => (r.tag.type === 'googtag' || r.tag.type === 'gaawc' ? r.c.ga4Ids.concat(r.c.adsIds).join(',') || null : null), (k) => `Google tag ${k} repetida`);
  group((r) => (r.tag.type === 'awct' ? r.c.adsConversions.map((cv) => `${cv.id}/${cv.label}`).join(',') + '|' + (r.tag.firingTriggerId || []).slice().sort().join(',') : null), (k) => `Conversão ${k.split('|')[0]} repetida com o mesmo acionador (conversão em dobro)`);
  group((r) => (r.c.linker ? 'linker' : null), () => 'Mais de um vinculador de conversões');
  const nameCount = new Map();
  for (const r of rows) nameCount.set(r.tag.name, (nameCount.get(r.tag.name) || 0) + 1);
  for (const [n, c] of nameCount) if (c > 1) dupes.push({ why: `Nome "${n}" usado em ${c} tags`, tags: [n] });
  items.push(dupes.length
    ? { key: 'duplicates', label: 'Tags duplicadas', status: 'warn', detail: dupes.map((d) => `${d.why}: ${d.tags.map((t) => `"${t}"`).join(', ')}`).join('; ') + '.', duplicates: dupes }
    : { key: 'duplicates', label: 'Tags duplicadas', status: 'ok', detail: 'Nenhuma duplicada encontrada.', duplicates: [] });

  // Observações extras
  const notes = [];
  const paused = rows.filter((r) => r.tag.paused);
  if (paused.length) notes.push(`${paused.length} tag(s) pausada(s): ${paused.map((r) => `"${r.tag.name}"`).join(', ')}.`);
  const noTrigger = active.filter((r) => !(r.tag.firingTriggerId || []).length);
  if (noTrigger.length) notes.push(`${noTrigger.length} tag(s) sem acionador (nunca disparam): ${noTrigger.map((r) => `"${r.tag.name}"`).join(', ')}.`);
  if (rows.some((r) => r.tag.type === 'ua')) notes.push('Ainda há tag do Universal Analytics, que o Google desligou. Ela não coleta mais nada.');

  return {
    items,
    notes,
    summary: { ok: items.filter((i) => i.status === 'ok').length, warn: items.filter((i) => i.status === 'warn').length, missing: items.filter((i) => i.status === 'missing').length },
    tags: rows.map((r) => ({ id: r.tag.tagId, name: r.tag.name, type: r.tag.type, typeLabel: tagTypeLabel(r.tag.type), paused: !!r.tag.paused, triggers: triggerNames(r.tag, triggersById) })),
    triggers: triggers.map((t) => ({ id: t.triggerId, name: t.name, type: t.type, typeLabel: triggerTypeLabel(t.type) })),
    variables: variables.map((v) => ({ id: v.variableId, name: v.name, type: v.type })),
  };
}

module.exports = { audit, classifyTag, tagTypeLabel, triggerTypeLabel, BUILTIN_TRIGGERS, ALL_PAGES_TRIGGER: '2147479553' };
