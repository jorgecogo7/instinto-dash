/**
 * Saúde da integração: confere, cliente por cliente, o que falta pra o
 * sistema enxergar tudo (conta de anúncios, Página, Instagram ligado à
 * Página, ativos atribuídos ao usuário do sistema, Google Ads, GTM) e
 * devolve um checklist com o passo a passo pra corrigir em linguagem simples.
 *
 * Com o token da Meta configurado, testa de verdade na Graph API (se o
 * usuário do sistema não consegue ler o ativo, é porque ele não foi
 * atribuído). Sem token (ou em modo mock), usa só o que está salvo.
 * Resultado fica em cache por 10 minutos; "Conferir agora" força de novo.
 * Rota só da agência (montada atrás de requireAdminAuth).
 */
const accountsStore = require('../data/accountsStore');
const metaService = require('./metaService');
const cache = require('../lib/cache');

const SYSTEM_USER = 'Dash Instinto Backend';
const CACHE_TTL = 600;
const BM_PATH = 'Gerenciador de Negócios da Instinto > Configurações do negócio';

const FIX = {
  adMissing: 'Peça ao cliente pra adicionar a Instinto Digital como parceira na conta de anúncios (no Gerenciador de Negócios dele: Configurações > Contas de anúncios > Atribuir parceiro). Depois cole o ID (act_...) no card "Integração Meta" abaixo e clique em Salvar.',
  adAssign: `No ${BM_PATH} > Contas > Contas de anúncios, abra essa conta > Atribuir pessoas > Usuários do sistema > "${SYSTEM_USER}" com acesso total. Depois clique em Salvar no card "Integração Meta".`,
  adInactive: 'A conta de anúncios não está ativa na Meta (pode ser pagamento pendente, bloqueio ou conta desativada). Abra o Gerenciador de Anúncios dessa conta e veja o aviso no topo.',
  pageMissing: 'Peça ao cliente pra compartilhar a Página do Facebook com a Instinto Digital (Configurações do negócio > Contas > Páginas > Atribuir parceiro). Depois cole o ID da Página no card "Integração Meta" e clique em Salvar.',
  pageAssign: `No ${BM_PATH} > Contas > Páginas, abra a Página > Atribuir pessoas > Usuários do sistema > "${SYSTEM_USER}" com acesso total. Depois clique em Salvar no card "Integração Meta".`,
  igNotLinked: 'O Instagram precisa ser profissional (Empresa ou Criador) e estar ligado à Página. No app do Instagram do cliente: Configurações > Tipo de conta e ferramentas > Mudar para conta profissional, e depois vincular à Página do Facebook (na Página: Configurações > Contas vinculadas > Instagram).',
  igAssign: `No ${BM_PATH} > Contas > Contas do Instagram, abra o perfil > Atribuir pessoas > "${SYSTEM_USER}" (Conteúdo, Mensagens, Insights e Anúncios). Depois clique em Salvar no card "Integração Meta".`,
  igNeedsPage: 'Preencha o ID da Página do Facebook no card "Integração Meta". O sistema descobre o Instagram sozinho pela Página.',
  syncError: 'Clique em "Sincronizar agora" no card "Integração Meta". Se o erro voltar, o motivo aparece logo abaixo do botão.',
  syncOff: 'Marque "Ativar sync" no card "Integração Meta" pra os números atualizarem sozinhos a cada 3 horas.',
  googleMissing: 'Vincule a conta Google Ads do cliente à MCC da Instinto e cole o ID (000-000-0000) no card "Integração Google Ads". Se o cliente não anuncia no Google, mude o "Modelo do painel" para Meta Ads e esse item some.',
  googleError: 'Confira se a conta ainda está vinculada à MCC da Instinto e clique em "Conectar e verificar" de novo no card "Integração Google Ads".',
  gtmMissing: 'Peça ao cliente pra adicionar jorgelcogo@gmail.com como usuário no contêiner do Tag Manager e conecte o código GTM-XXXXXXX no card "Google Tag Manager".',
};

const AD_STATUS = { 2: 'desativada', 3: 'pagamento pendente', 7: 'em análise de risco', 8: 'pagamento pendente de acerto', 9: 'em período de carência', 100: 'aguardando encerramento', 101: 'encerrada' };

const isAuthError = (e) => [10, 100, 200, 294, 803].includes(e.code) || /permission|permiss|does not exist|cannot be loaded/i.test(e.raw || e.message || '');

function item(key, label, state, detail, fix, extra = {}) {
  return { key, label, state, detail: detail || '', fix: fix || '', ...extra };
}

/* Checagem ao vivo na Meta (só com token). Devolve o que conseguiu ler. */
async function liveMeta(meta) {
  const out = { ad: null, page: null, ig: null };
  const adId = meta.adAccountId ? metaService.normalizeAdAccountId(meta.adAccountId) : '';
  const tasks = [];
  if (adId) tasks.push(metaService.graphGet(adId, { fields: 'name,account_status' })
    .then((j) => { out.ad = { ok: true, name: j.name, active: j.account_status === 1, accountStatus: j.account_status }; })
    .catch((e) => { out.ad = { ok: false, auth: isAuthError(e), error: e.message }; }));
  if (meta.pageId) tasks.push(metaService.graphGet(meta.pageId, { fields: 'name,instagram_business_account{id,username}' })
    .then((j) => { out.page = { ok: true, name: j.name, ig: j.instagram_business_account || null }; })
    .catch((e) => { out.page = { ok: false, auth: isAuthError(e), error: e.message }; }));
  if (meta.igBusinessId) tasks.push(metaService.graphGet(meta.igBusinessId, { fields: 'id,username' })
    .then((j) => { out.ig = { ok: !!j.username, username: j.username, id: j.id }; })
    .catch((e) => { out.ig = { ok: false, auth: isAuthError(e), error: e.message }; }));
  await Promise.all(tasks);
  return out;
}

function usesMeta(model) { return model !== 'google'; }
function usesGoogle(model) { return model !== 'meta'; }

async function checkAccount(account, { live }) {
  const meta = account.meta || {};
  const igApi = account.instagramApi || {};
  const g = account.google || {};
  const model = account.dashboardModel || 'auto';
  const items = [];
  const L = live ? await liveMeta(meta) : null;

  if (usesMeta(model)) {
    // Conta de anúncios
    if (!meta.adAccountId) {
      items.push(item('meta_ad', 'Conta de anúncios Meta', 'missing', 'Nenhuma conta de anúncios cadastrada.', FIX.adMissing));
    } else if (L && L.ad && !L.ad.ok) {
      items.push(item('meta_ad', 'Conta de anúncios Meta', 'error',
        L.ad.auth ? `O usuário do sistema "${SYSTEM_USER}" não consegue ler a conta ${metaService.normalizeAdAccountId(meta.adAccountId)}.` : L.ad.error,
        L.ad.auth ? FIX.adAssign : 'Tente "Conferir agora" em alguns minutos.'));
    } else if (L && L.ad && L.ad.ok && !L.ad.active) {
      items.push(item('meta_ad', 'Conta de anúncios Meta', 'warn', `"${L.ad.name}" não está ativa na Meta (${AD_STATUS[L.ad.accountStatus] || `status ${L.ad.accountStatus}`}).`, FIX.adInactive));
    } else if (!L && meta.status !== 'connected') {
      items.push(item('meta_ad', 'Conta de anúncios Meta', meta.status === 'pending' ? 'warn' : 'error', 'A conta está cadastrada mas ainda não foi confirmada na Meta.', FIX.adAssign));
    } else {
      items.push(item('meta_ad', 'Conta de anúncios Meta', 'ok', (L && L.ad && L.ad.name) || meta.accountName || ''));
    }

    // Sync automático
    const adItem = items[items.length - 1];
    if (meta.adAccountId && meta.status === 'connected' && adItem.state !== 'error') {
      const s = meta.sync || {};
      if (s.lastStatus === 'error') items.push(item('meta_sync', 'Sincronização automática', 'warn', s.lastError ? `Última sincronização falhou: ${s.lastError}` : 'A última sincronização falhou.', s.lastErrorHint ? `${s.lastErrorHint} Depois: ${FIX.syncError}` : FIX.syncError));
      else if (!s.enabled) items.push(item('meta_sync', 'Sincronização automática', 'warn', 'Desligada: os números só atualizam quando alguém abre o painel.', FIX.syncOff));
      else items.push(item('meta_sync', 'Sincronização automática', 'ok', s.lastSyncAt ? `Última: ${s.lastSyncAt}` : 'Ligada', '', { at: s.lastSyncAt || null }));
    }

    // Página
    if (!meta.pageId) {
      items.push(item('meta_page', 'Página do Facebook', 'missing', 'Nenhuma Página cadastrada.', FIX.pageMissing));
    } else if (L && L.page && !L.page.ok) {
      items.push(item('meta_page', 'Página do Facebook', 'error',
        L.page.auth ? `O usuário do sistema "${SYSTEM_USER}" não consegue ler a Página ${meta.pageId}.` : L.page.error,
        L.page.auth ? FIX.pageAssign : 'Tente "Conferir agora" em alguns minutos.'));
    } else {
      items.push(item('meta_page', 'Página do Facebook', 'ok', (L && L.page && L.page.name) || ''));
    }

    // Instagram
    const pageIg = L && L.page && L.page.ok ? L.page.ig : undefined;
    if (igApi.unlinked) {
      items.push(item('instagram', 'Instagram profissional', 'optional', 'Desconectado neste cliente. Para voltar, preencha o ID na integração Meta e clique em Salvar.'));
    } else if (L) {
      if (L.ig && L.ig.ok) {
        items.push(item('instagram', 'Instagram profissional', 'ok', `@${L.ig.username}`));
      } else if (pageIg && pageIg.id) {
        items.push(item('instagram', 'Instagram profissional', 'ok', pageIg.username ? `@${pageIg.username} (pela Página)` : 'Ligado à Página'));
      } else if (L.page && L.page.ok && !pageIg) {
        items.push(item('instagram', 'Instagram profissional', 'missing', `A Página "${L.page.name}" não tem Instagram profissional vinculado.`, FIX.igNotLinked));
      } else if (L.ig && !L.ig.ok) {
        items.push(item('instagram', 'Instagram profissional', 'error', `O usuário do sistema não consegue ler o Instagram ${meta.igBusinessId}.`, meta.pageId ? FIX.igAssign : FIX.igNeedsPage));
      } else if (!meta.pageId && !meta.igBusinessId) {
        items.push(item('instagram', 'Instagram profissional', 'missing', 'Sem Página e sem Instagram cadastrados.', FIX.igNeedsPage));
      } else {
        items.push(item('instagram', 'Instagram profissional', 'error', 'Não deu pra conferir o Instagram porque a Página não está acessível.', FIX.pageAssign));
      }
    } else if (igApi.status === 'connected') {
      items.push(item('instagram', 'Instagram profissional', 'ok', igApi.username ? `@${igApi.username}` : ''));
    } else if (igApi.status === 'error') {
      const notLinked = /não tem um Instagram profissional vinculado/i.test(igApi.error || '');
      items.push(item('instagram', 'Instagram profissional', notLinked ? 'missing' : 'error', notLinked ? 'A Página do Facebook não tem Instagram profissional vinculado.' : (igApi.error || 'A Meta não confirmou o Instagram.'), notLinked ? FIX.igNotLinked : FIX.igAssign));
    } else if (!meta.pageId && !meta.igBusinessId) {
      items.push(item('instagram', 'Instagram profissional', 'missing', 'Sem Página e sem Instagram cadastrados.', FIX.igNeedsPage));
    } else {
      items.push(item('instagram', 'Instagram profissional', 'warn', 'Ainda não conferido.', 'Clique em Salvar no card "Integração Meta" pra o sistema conferir.'));
    }
  }

  if (usesGoogle(model)) {
    if (g.status === 'connected') items.push(item('google', 'Google Ads', 'ok', g.accountName || g.customerId || ''));
    else if (g.customerId) items.push(item('google', 'Google Ads', 'error', `A conta ${g.customerId} está cadastrada mas não confirmou o acesso.`, FIX.googleError));
    else items.push(item('google', 'Google Ads', model === 'auto' ? 'optional' : 'missing', 'Nenhuma conta Google Ads conectada.', FIX.googleMissing));
  }

  if (account.gtm && (account.gtm.publicId || account.gtm.containerId)) items.push(item('gtm', 'Google Tag Manager', 'ok', account.gtm.publicId || ''));
  else items.push(item('gtm', 'Google Tag Manager', 'optional', 'Nenhum contêiner conectado.', FIX.gtmMissing));

  const count = (s) => items.filter((i) => i.state === s).length;
  const problems = count('error') + count('missing');
  return {
    id: account.id, name: account.name, status: account.status || null, model,
    items, summary: { ok: count('ok'), problems, warn: count('warn'), optional: count('optional'), total: items.length },
    level: problems ? 'bad' : count('warn') ? 'warn' : 'ok',
  };
}

// Permissões do token do usuário do sistema (o que falta afeta todos os clientes).
async function tokenCheck() {
  if (!metaService.hasRealCredentials()) return { configured: false, missing: [], note: 'Token da Meta não configurado no servidor (ou modo de teste): os itens foram conferidos só pelo que está salvo.' };
  try {
    const perms = await metaService.graphGetAll('me/permissions', {}, 2);
    const granted = new Set(perms.filter((p) => p.status === 'granted').map((p) => p.permission));
    const want = ['ads_read', 'ads_management', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights', 'business_management'];
    return { configured: true, missing: want.filter((p) => !granted.has(p)) };
  } catch (e) {
    return { configured: true, missing: [], error: e.message };
  }
}

async function getHealth({ accountId = null, refresh = false } = {}) {
  const live = metaService.hasRealCredentials();
  const key = `integration-health:${accountId || 'all'}`;
  if (!refresh) { const hit = cache.get(key); if (hit) return hit; }
  const all = await accountsStore.getAll();
  const list = accountId ? all.filter((a) => a.id === accountId) : all.filter((a) => a.status !== 'inativo');
  const clients = [];
  // 4 por vez, pra não estourar o limite de chamadas da Meta
  for (let i = 0; i < list.length; i += 4) {
    clients.push(...await Promise.all(list.slice(i, i + 4).map((a) => checkAccount(a, { live }).catch((e) => ({
      id: a.id, name: a.name, items: [], summary: { ok: 0, problems: 0, warn: 1, optional: 0, total: 0 }, level: 'warn', error: e.message,
    })))));
  }
  const order = { bad: 0, warn: 1, ok: 2 };
  clients.sort((a, b) => (order[a.level] - order[b.level]) || (b.summary.problems - a.summary.problems) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  const result = { checkedAt: new Date().toISOString(), live, token: accountId ? null : await tokenCheck(), systemUser: SYSTEM_USER, clients };
  cache.set(key, result, CACHE_TTL);
  // Conferiu um cliente só? Atualiza também a lista geral em cache, pra ela não mostrar o estado antigo.
  if (accountId && clients[0]) {
    const allHit = cache.get('integration-health:all');
    if (allHit) {
      allHit.clients = allHit.clients.map((c) => (c.id === accountId ? clients[0] : c));
      allHit.clients.sort((a, b) => (order[a.level] - order[b.level]) || (b.summary.problems - a.summary.problems) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
    }
  }
  return result;
}

module.exports = { getHealth, checkAccount, FIX };
