/**
 * Google Tag Manager (API v2) por cliente: achar o contêiner pelo GTM-XXXX,
 * conferir tags, criar tags num espaço de trabalho próprio e publicar.
 *
 * Regras:
 * - Nada é apagado no GTM. Só leitura, criação (tags, acionadores, espaço de
 *   trabalho, variáveis nativas) e publicação.
 * - Criar tag só mexe no rascunho do espaço "Instinto Digital".
 * - Publicar só acontece pela rota de publicação, com confirmação explícita.
 * - Tokens vêm só das variáveis de ambiente. Nunca vão para log nem resposta.
 */
const config = require('../config');
const cache = require('../lib/cache');
const mockGtm = require('../data/mockGtm');
const { audit, classifyTag, tagTypeLabel, triggerTypeLabel, ALL_PAGES_TRIGGER } = require('../lib/gtmAudit');

const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2/';
const WORKSPACE_NAME = 'Instinto Digital';
const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.publish',
];
const GTM_SCOPES = SCOPES.slice(1);

function httpError(status, message, extra) { const e = new Error(message); e.status = status; Object.assign(e, extra || {}); return e; }

/* ---------------- credenciais ---------------- */

function credentials() {
  const ownClient = !!config.gtm.clientId;
  const clientId = config.gtm.clientId || config.google.clientId;
  const clientSecret = config.gtm.clientSecret || config.google.clientSecret;
  let refreshToken = config.gtm.refreshToken;
  let source = refreshToken ? 'GOOGLE_GTM_REFRESH_TOKEN' : null;
  // O refresh token só vale com o mesmo cliente OAuth que o gerou.
  if (!refreshToken && !ownClient && config.google.refreshToken) { refreshToken = config.google.refreshToken; source = 'GOOGLE_REFRESH_TOKEN'; }
  return { clientId, clientSecret, refreshToken, source, ownClient };
}

function capabilities() {
  const c = credentials();
  const missing = [];
  if (!c.clientId || !c.clientSecret) missing.push(c.ownClient ? 'GOOGLE_GTM_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  if (!c.refreshToken) missing.push('GOOGLE_GTM_REFRESH_TOKEN');
  return {
    mode: config.useMockData ? 'mock' : 'real',
    oauthClient: !!(c.clientId && c.clientSecret),
    oauthClientSource: c.ownClient ? 'GOOGLE_GTM_CLIENT_ID' : 'GOOGLE_CLIENT_ID',
    tokenSource: c.refreshToken ? c.source : null,
    ready: config.useMockData || missing.length === 0,
    missing: config.useMockData ? [] : missing,
    redirectUri: config.gtm.redirectUri,
    agencyEmail: config.gtm.agencyEmail || null,
    workspaceName: WORKSPACE_NAME,
  };
}

async function getAccessToken() {
  const cached = cache.get('gtm:accessToken');
  if (cached) return cached.token;
  const c = credentials();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw httpError(409, 'O acesso do sistema ao Tag Manager ainda não foi configurado. Use "Autorizar Tag Manager" e coloque o token em GOOGLE_GTM_REFRESH_TOKEN no hPanel.', { code: 'not_configured' });
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    // Só o código do erro vai pro log (nunca o corpo inteiro).
    console.error('GTM: falha ao renovar o token do Google:', json.error || res.status);
    throw httpError(409, json.error === 'invalid_grant'
      ? 'O token do Google para o Tag Manager expirou ou foi revogado. Use "Autorizar Tag Manager" de novo e troque GOOGLE_GTM_REFRESH_TOKEN no hPanel.'
      : 'Não consegui renovar o acesso do Google para o Tag Manager. Confira GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no hPanel.', { code: 'token_error' });
  }
  const scopes = String(json.scope || '').split(/\s+/).filter(Boolean);
  cache.set('gtm:accessToken', { token: json.access_token, scopes }, 50 * 60);
  return json.access_token;
}

/** Confere (sem mostrar o token) se o token tem os escopos do Tag Manager. */
async function checkScopes() {
  if (config.useMockData) return { ok: true, missingScopes: [], mock: true };
  await getAccessToken();
  const { scopes } = cache.get('gtm:accessToken') || { scopes: [] };
  if (!scopes.length) return { ok: null, missingScopes: [] };
  const missingScopes = GTM_SCOPES.filter((s) => !scopes.includes(s)).map((s) => s.split('/').pop());
  return { ok: missingScopes.length === 0, missingScopes };
}

/* ---------------- chamadas à API ---------------- */

function mapGoogleError(status, json) {
  const g = (json && json.error) || {};
  const msg = String(g.message || '');
  const reasons = JSON.stringify(g.details || g.errors || '');
  if (status === 401) return httpError(409, 'O Google recusou o acesso ao Tag Manager. Use "Autorizar Tag Manager" de novo.', { code: 'auth' });
  if (status === 403 && /SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(msg + reasons) && /scope/i.test(msg + reasons)) {
    return httpError(409, 'O token do Google ainda não tem permissão do Tag Manager. Clique em "Autorizar Tag Manager" e troque o token no hPanel.', { code: 'scope' });
  }
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(msg + reasons)) {
    return httpError(409, 'A Tag Manager API não está ativada no projeto do Google Cloud. Ative em APIs e serviços > Biblioteca > "Tag Manager API".', { code: 'api_disabled' });
  }
  if (status === 403) return httpError(403, 'A conta Google da agência não tem permissão para isso neste contêiner.', { code: 'forbidden' });
  if (status === 404) return httpError(404, 'O Google não encontrou esse item no Tag Manager.', { code: 'not_found' });
  if (status === 429) return httpError(429, 'O Google limitou as chamadas ao Tag Manager por alguns instantes. Espere 1 minuto e tente de novo.', { code: 'quota' });
  if (status === 400) return httpError(400, `O Tag Manager recusou o pedido: ${msg.slice(0, 300) || 'dados inválidos'}`, { code: 'bad_request' });
  return httpError(502, 'O Tag Manager não respondeu agora. Tente de novo em instantes.', { code: 'upstream' });
}

// A Tag Manager API tem cota baixa por projeto: chamadas em fila, com intervalo.
let queue = Promise.resolve();
const MIN_GAP_MS = 350;
function throttled(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)));
  return run;
}

async function request(method, path, body) {
  if (config.useMockData) {
    try { return await mockGtm.request(method, path, body); } catch (e) { throw mapGoogleError(e.status || 500, { error: { message: e.message } }); }
  }
  const doFetch = async () => {
    const token = await getAccessToken();
    return fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  return throttled(async () => {
    let res = await doFetch();
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2500)); res = await doFetch(); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mapGoogleError(res.status, json);
    return json;
  });
}

async function listAll(path, key) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const json = await request('GET', path + (pageToken ? `${path.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}` : ''));
    out.push(...(json[key] || []));
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

const cPath = (link) => `accounts/${link.accountId}/containers/${link.containerId}`;
const wPath = (link, ws) => `${cPath(link)}/workspaces/${ws.workspaceId}`;

/* ---------------- achar o contêiner ---------------- */

function normalizePublicId(v) { return String(v || '').trim().toUpperCase(); }
function validPublicId(v) { return /^GTM-[A-Z0-9]{4,12}$/.test(v); }

async function findContainer(publicIdRaw) {
  const publicId = normalizePublicId(publicIdRaw);
  if (!validPublicId(publicId)) throw httpError(400, 'Código inválido. Use o formato GTM-XXXXXXX (aparece no topo do Tag Manager do cliente).');
  const accounts = await listAll('accounts', 'account');
  for (const acc of accounts) {
    let containers;
    try { containers = await listAll(`accounts/${acc.accountId}/containers`, 'container'); } catch (e) { if (e.status === 403 || e.status === 404) continue; throw e; }
    const c = containers.find((x) => normalizePublicId(x.publicId) === publicId);
    if (c) {
      return {
        publicId, accountId: String(c.accountId), containerId: String(c.containerId),
        containerName: c.name || '', gtmAccountName: acc.name || '', usageContext: c.usageContext || [],
      };
    }
  }
  const who = config.gtm.agencyEmail ? `o e-mail ${config.gtm.agencyEmail}` : 'o e-mail Google da agência';
  throw httpError(404, `Não encontrei o contêiner ${publicId} entre os que a conta Google da agência acessa (${accounts.length} conta(s) do GTM). Peça ao cliente para adicionar ${who} como usuário desse contêiner no Tag Manager (Administrador > Gerenciamento de usuários, com permissão Publicar) e tente de novo.`, { code: 'container_not_found' });
}

/* ---------------- conferir ---------------- */

function fpDate(fingerprint) {
  const n = Number(fingerprint);
  return n > 1e12 && n < 4e12 ? new Date(n).toISOString() : null;
}

async function getWorkspaces(link) { return listAll(`${cPath(link)}/workspaces`, 'workspace'); }
async function findOurWorkspace(link) { return (await getWorkspaces(link)).find((w) => w.name === WORKSPACE_NAME) || null; }

async function getLive(link) {
  try { return await request('GET', `${cPath(link)}/versions:live`); } catch (e) { if (e.status === 404) return null; throw e; }
}

async function workspaceEntities(link, ws) {
  const [tags, triggers, variables] = [
    await listAll(`${wPath(link, ws)}/tags`, 'tag'),
    await listAll(`${wPath(link, ws)}/triggers`, 'trigger'),
    await listAll(`${wPath(link, ws)}/variables`, 'variable'),
  ];
  return { tags, triggers, variables };
}

function describeChanges(status) {
  const kinds = { tag: 'Tag', trigger: 'Acionador', variable: 'Variável', folder: 'Pasta', builtInVariable: 'Variável nativa', client: 'Cliente', transformation: 'Transformação', zone: 'Zona', customTemplate: 'Modelo' };
  const fem = { tag: true, variable: true, folder: true, builtInVariable: true, transformation: true, zone: true };
  const statusFem = { added: 'nova', updated: 'alterada', deleted: 'removida', changeStatusUnspecified: 'alterada', none: 'sem mudança' };
  const statusMasc = { added: 'novo', updated: 'alterado', deleted: 'removido', changeStatusUnspecified: 'alterado', none: 'sem mudança' };
  return (status.workspaceChange || []).map((ch) => {
    const kind = Object.keys(kinds).find((k) => ch[k]) || 'item';
    const ent = ch[kind] || {};
    const id = ent.tagId || ent.triggerId || ent.variableId || ent.folderId || ent.type || '';
    const typeLabel = kind === 'tag' ? tagTypeLabel(ent.type) : kind === 'trigger' ? triggerTypeLabel(ent.type) : (ent.type || '');
    return { key: `${kind}:${id}:${ch.changeStatus}`, kind, kindLabel: kinds[kind] || kind, id: String(id), name: ent.name || ent.type || '(sem nome)', typeLabel, changeStatus: ch.changeStatus, statusLabel: (fem[kind] ? statusFem : statusMasc)[ch.changeStatus] || ch.changeStatus };
  });
}

async function getPending(link) {
  const ws = await findOurWorkspace(link);
  if (!ws) return { workspace: null, changes: [], conflicts: 0 };
  const status = await request('GET', `${wPath(link, ws)}/status`);
  return { workspace: { id: ws.workspaceId, name: ws.name }, changes: describeChanges(status), conflicts: (status.mergeConflict || []).length };
}

function usableTriggers(triggers) {
  return [{ id: ALL_PAGES_TRIGGER, name: 'Todas as páginas', type: 'pageview', typeLabel: 'Visualização de página', builtin: true }]
    .concat(triggers.map((t) => ({ id: String(t.triggerId), name: t.name, type: t.type, typeLabel: triggerTypeLabel(t.type) })));
}

async function getAudit(link) {
  const live = await getLive(link);
  const workspaces = await getWorkspaces(link);
  const ours = workspaces.find((w) => w.name === WORKSPACE_NAME) || null;
  let draft = null; let pending = { changes: [], conflicts: 0 };
  if (ours) {
    draft = await workspaceEntities(link, ours);
    const status = await request('GET', `${wPath(link, ours)}/status`);
    pending = { changes: describeChanges(status), conflicts: (status.mergeConflict || []).length };
  }
  const liveEntities = live ? { tags: live.tag || live.tags || [], triggers: live.trigger || live.triggers || [], variables: live.variable || live.variables || [] } : { tags: [], triggers: [], variables: [] };
  const triggersSource = draft || liveEntities;
  return {
    container: { publicId: link.publicId, name: link.containerName, gtmAccountName: link.gtmAccountName },
    live: live ? { versionId: String(live.containerVersionId || ''), name: live.name || '', date: fpDate(live.fingerprint), tags: liveEntities.tags.length, triggers: liveEntities.triggers.length, variables: liveEntities.variables.length } : null,
    workspace: ours ? { id: ours.workspaceId, name: ours.name, ...pending } : null,
    otherWorkspaces: workspaces.filter((w) => w !== ours).map((w) => w.name),
    auditLive: audit(liveEntities),
    auditDraft: draft ? audit(draft) : null,
    triggers: usableTriggers(triggersSource.triggers || []),
    webContainer: !(link.usageContext || []).length || (link.usageContext || []).includes('web'),
  };
}

/* ---------------- criar tags ---------------- */

async function ensureWorkspace(link, log) {
  const existing = await findOurWorkspace(link);
  if (existing) return existing;
  try {
    const ws = await request('POST', `${cPath(link)}/workspaces`, { name: WORKSPACE_NAME, description: 'Alterações feitas pelo Sistema Instinto Digital. Só vai ao ar quando a agência publicar.' });
    if (log) await log({ action: 'create_workspace', detail: `Espaço de trabalho "${WORKSPACE_NAME}" criado` });
    return ws;
  } catch (e) {
    if (e.status === 400) throw httpError(409, `Não consegui criar o espaço de trabalho "${WORKSPACE_NAME}". Contêiner gratuito aceita até 3 espaços de trabalho: publique ou feche um deles no Tag Manager e tente de novo.`);
    throw e;
  }
}

const NUM_ID = /^\d{6,20}$/;
function cleanText(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }

function pixelHtml(pixelId) {
  return `<!-- Meta Pixel (Sistema Instinto Digital) -->\n<script>\n!function(f,b,e,v,n,t,s)\n{if(f.fbq)return;n=f.fbq=function(){n.callMethod?\nn.callMethod.apply(n,arguments):n.queue.push(arguments)};\nif(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';\nn.queue=[];t=b.createElement(e);t.async=!0;\nt.src=v;s=b.getElementsByTagName(e)[0];\ns.parentNode.insertBefore(t,s)}(window, document,'script',\n'https://connect.facebook.net/en_US/fbevents.js');\nfbq('init', '${pixelId}');\nfbq('track', 'PageView');\n</script>\n<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"/></noscript>\n<!-- Fim do Meta Pixel -->`;
}

/** Valida o pedido do painel e devolve o que será criado (sem chamar o GTM). */
function buildTagPlan(spec) {
  const kind = spec && spec.kind;
  const t = (key, value) => ({ type: 'template', key, value: String(value) });
  if (kind === 'meta_pixel') {
    const pixelId = cleanText(spec.pixelId, 20);
    if (!NUM_ID.test(pixelId)) throw httpError(400, 'ID do pixel inválido. São só números (15 ou 16 dígitos), no Gerenciador de Eventos da Meta.');
    return { kind, label: 'Pixel da Meta (código base)', match: { pixelId }, tag: { name: `Meta Pixel - Base (PageView) - ${pixelId}`, type: 'html', parameter: [t('html', pixelHtml(pixelId)), { type: 'boolean', key: 'supportDocumentWrite', value: 'false' }], firingTriggerId: [ALL_PAGES_TRIGGER] } };
  }
  if (kind === 'ga4') {
    const id = cleanText(spec.measurementId, 20).toUpperCase();
    if (!/^G-[A-Z0-9]{4,15}$/.test(id)) throw httpError(400, 'ID de medição inválido. Use o formato G-XXXXXXXXXX (GA4 > Administrador > Fluxos de dados).');
    return { kind, label: 'GA4 (Google tag)', match: { ga4: id }, tag: { name: `GA4 - Google tag - ${id}`, type: 'googtag', parameter: [t('tagId', id)], firingTriggerId: [ALL_PAGES_TRIGGER] } };
  }
  if (kind === 'conversion_linker') {
    return { kind, label: 'Vinculador de conversões', match: { linker: true }, tag: { name: 'Vinculador de conversões', type: 'gclidw', parameter: [], firingTriggerId: [ALL_PAGES_TRIGGER] } };
  }
  if (kind === 'ads_conversion') {
    const convId = cleanText(spec.conversionId, 20).toUpperCase().replace(/^AW-/, '');
    const label = cleanText(spec.conversionLabel, 64);
    if (!/^\d{6,15}$/.test(convId)) throw httpError(400, 'ID de conversão inválido. Use só os números do AW-XXXXXXXXX (Google Ads > Metas > Conversões > Configuração da tag).');
    if (!/^[\w-]{4,64}$/.test(label)) throw httpError(400, 'Rótulo de conversão inválido. Ele aparece junto do ID, depois da barra (AW-123/AbC-dEf).');
    const name = cleanText(spec.name, 80) || label;
    const value = spec.value === '' || spec.value == null ? null : Number(String(spec.value).replace(',', '.'));
    if (value != null && !(value >= 0 && value < 1e9)) throw httpError(400, 'Valor da conversão inválido.');
    const currency = cleanText(spec.currency || 'BRL', 3).toUpperCase();
    if (value != null && !/^[A-Z]{3}$/.test(currency)) throw httpError(400, 'Moeda inválida (ex.: BRL).');
    const trig = spec.trigger || {};
    let trigger;
    if (trig.mode === 'existing') {
      const id = cleanText(trig.triggerId, 20);
      if (!/^\d{1,20}$/.test(id)) throw httpError(400, 'Escolha um acionador.');
      trigger = { mode: 'existing', triggerId: id };
    } else if (trig.mode === 'new') {
      const tv = cleanText(trig.value, 120);
      if (!['pageview_contains', 'form_submit', 'link_click_contains'].includes(trig.type)) throw httpError(400, 'Tipo de acionador inválido.');
      if (trig.type !== 'form_submit' && !tv) throw httpError(400, trig.type === 'pageview_contains' ? 'Informe o trecho da URL (ex.: obrigado).' : 'Informe o trecho do link (ex.: wa.me).');
      trigger = { mode: 'new', type: trig.type, value: tv };
    } else throw httpError(400, 'Escolha quando a conversão dispara (acionador).');
    const parameter = [t('conversionId', convId), t('conversionLabel', label)];
    if (value != null) parameter.push(t('conversionValue', value), t('currencyCode', currency));
    return { kind, label: 'Conversão do Google Ads', match: { ads: `AW-${convId}/${label}` }, trigger, tag: { name: `Google Ads - Conversão - ${name}`, type: 'awct', parameter, firingTriggerId: [] } };
  }
  throw httpError(400, 'Tipo de tag inválido.');
}

function buildTrigger(trig) {
  const cond = (variable, value) => [{ type: 'contains', parameter: [{ type: 'template', key: 'arg0', value: variable }, { type: 'template', key: 'arg1', value }] }];
  if (trig.type === 'pageview_contains') return { trigger: { name: `Instinto - Página contém "${trig.value}"`, type: 'pageview', filter: cond('{{Page URL}}', trig.value) } };
  if (trig.type === 'link_click_contains') {
    return {
      builtIns: ['clickUrl', 'clickText'],
      trigger: { name: `Instinto - Clique em link com "${trig.value}"`, type: 'linkClick', filter: cond('{{Click URL}}', trig.value), waitForTags: { type: 'boolean', value: 'false' }, checkValidation: { type: 'boolean', value: 'false' } },
    };
  }
  // Envio de formulário: todos os formulários, ou só nas páginas que contêm o trecho.
  return {
    builtIns: ['formId', 'formClasses', 'formUrl'],
    trigger: { name: trig.value ? `Instinto - Envio de formulário em "${trig.value}"` : 'Instinto - Envio de formulário (todos)', type: 'formSubmission', ...(trig.value ? { filter: cond('{{Page URL}}', trig.value) } : {}), waitForTags: { type: 'boolean', value: 'false' }, checkValidation: { type: 'boolean', value: 'false' } },
  };
}

function findDuplicate(plan, tags) {
  for (const tg of tags) {
    const c = classifyTag(tg);
    if (plan.match.pixelId && c.metaPixelBase && c.metaPixelIds.includes(plan.match.pixelId)) return tg;
    if (plan.match.ga4 && (tg.type === 'googtag' || tg.type === 'gaawc') && c.ga4Ids.includes(plan.match.ga4)) return tg;
    if (plan.match.ads && c.adsConversions.some((cv) => `${cv.id}/${cv.label}` === plan.match.ads)) return tg;
    if (plan.match.linker && c.linker) return tg;
  }
  return null;
}

async function createTag(link, spec, { log, user } = {}) {
  if ((link.usageContext || []).length && !(link.usageContext || []).includes('web')) throw httpError(400, 'Só dá para criar tags em contêiner Web por aqui.');
  const plan = buildTagPlan(spec);
  const ws = await ensureWorkspace(link, log);
  const ent = await workspaceEntities(link, ws);
  const dup = findDuplicate(plan, ent.tags);
  if (dup) throw httpError(409, `Já existe "${dup.name}" fazendo isso neste contêiner. Não criei outra para não duplicar.`, { code: 'duplicate' });
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const created = { trigger: null };
  if (plan.trigger) {
    if (plan.trigger.mode === 'existing') {
      if (plan.trigger.triggerId !== ALL_PAGES_TRIGGER && !ent.triggers.some((x) => String(x.triggerId) === plan.trigger.triggerId)) throw httpError(400, 'Esse acionador não existe mais no contêiner. Atualize a conferência e escolha de novo.');
      plan.tag.firingTriggerId = [plan.trigger.triggerId];
    } else {
      const { trigger, builtIns } = buildTrigger(plan.trigger);
      const same = ent.triggers.find((x) => x.name === trigger.name);
      if (same) plan.tag.firingTriggerId = [String(same.triggerId)];
      else {
        if (builtIns) {
          try { await request('POST', `${wPath(link, ws)}/built_in_variables?${builtIns.map((b) => `type=${b}`).join('&')}`); } catch (e) { if (e.status !== 400 && e.status !== 409) throw e; }
        }
        const tr = await request('POST', `${wPath(link, ws)}/triggers`, { ...trigger, notes: `Criado pelo Sistema Instinto Digital (${user || 'admin'}, ${stamp})` });
        created.trigger = { id: String(tr.triggerId), name: tr.name };
        plan.tag.firingTriggerId = [String(tr.triggerId)];
        if (log) await log({ action: 'create_trigger', detail: `Acionador "${tr.name}" criado no rascunho`, itemId: String(tr.triggerId) });
      }
    }
  }
  const tag = await request('POST', `${wPath(link, ws)}/tags`, { ...plan.tag, tagFiringOption: 'oncePerEvent', notes: `Criada pelo Sistema Instinto Digital (${user || 'admin'}, ${stamp})` });
  if (log) await log({ action: 'create_tag', detail: `Tag "${tag.name}" (${plan.label}) criada no rascunho`, itemId: String(tag.tagId) });
  return { tag: { id: String(tag.tagId), name: tag.name, type: tag.type, typeLabel: tagTypeLabel(tag.type) }, trigger: created.trigger, workspace: { id: ws.workspaceId, name: ws.name } };
}

/* ---------------- publicar ---------------- */

async function publish(link, expectedKeys, { log, user } = {}) {
  const ws = await findOurWorkspace(link);
  if (!ws) throw httpError(409, 'Não há nada do sistema para publicar neste contêiner.', { code: 'nothing' });
  // Traz o rascunho para a versão publicada mais recente (não apaga nada; só junta).
  const sync = await request('POST', `${wPath(link, ws)}:sync`);
  if ((sync.mergeConflict || []).length || (sync.syncStatus && sync.syncStatus.mergeConflict)) {
    throw httpError(409, 'O rascunho tem conflito com uma versão publicada por outra pessoa. Resolva no Tag Manager (espaço "Instinto Digital") antes de publicar.', { code: 'conflict' });
  }
  const status = await request('GET', `${wPath(link, ws)}/status`);
  const changes = describeChanges(status);
  if ((status.mergeConflict || []).length) throw httpError(409, 'O rascunho tem conflito. Resolva no Tag Manager antes de publicar.', { code: 'conflict' });
  if (!changes.length) throw httpError(409, 'Não há alterações pendentes para publicar.', { code: 'nothing' });
  const now = changes.map((c) => c.key).sort().join('|');
  const want = (Array.isArray(expectedKeys) ? expectedKeys : []).map(String).sort().join('|');
  if (now !== want) throw httpError(409, 'As alterações pendentes mudaram desde que você abriu a confirmação. Confira a lista nova antes de publicar.', { code: 'changed', changes });
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const cv = await request('POST', `${wPath(link, ws)}:create_version`, {
    name: `Instinto Digital - ${stamp}`,
    notes: `Publicado pelo Sistema Instinto Digital (${user || 'admin'}).\n${changes.map((c) => `${c.kindLabel} ${c.statusLabel}: ${c.name}`).join('\n')}`.slice(0, 2000),
  });
  if (cv.compilerError) throw httpError(422, 'O Tag Manager encontrou um erro ao montar a versão. Abra o espaço "Instinto Digital" no Tag Manager para ver o detalhe.', { code: 'compiler' });
  if (cv.syncStatus && (cv.syncStatus.syncError || cv.syncStatus.mergeConflict)) throw httpError(409, 'O rascunho ficou desatualizado. Tente de novo.', { code: 'sync' });
  const version = cv.containerVersion || {};
  const versionId = String(version.containerVersionId || '');
  if (log) await log({ action: 'create_version', detail: `Versão ${versionId} criada com ${changes.length} alteração(ões)`, itemId: versionId, changes: changes.map((c) => `${c.kindLabel} ${c.statusLabel}: ${c.name}`) });
  try {
    await request('POST', `${cPath(link)}/versions/${versionId}:publish`);
  } catch (e) {
    const msg = e.status === 403
      ? `A versão ${versionId} foi criada, mas a conta Google da agência não tem permissão Publicar neste contêiner. Peça ao cliente essa permissão, ou publique a versão ${versionId} direto no Tag Manager.`
      : `A versão ${versionId} foi criada, mas a publicação falhou: ${e.message}`;
    throw httpError(e.status === 403 ? 403 : 502, msg, { code: 'publish_failed', versionId });
  }
  return { versionId, versionName: version.name || '', changes };
}

module.exports = { capabilities, checkScopes, findContainer, getAudit, getPending, createTag, publish, buildTagPlan, normalizePublicId, validPublicId, SCOPES, WORKSPACE_NAME };
