/**
 * Sincronização da conta de anúncios da Meta (por cliente).
 *
 * - Automática: a cada 3 horas para quem tiver "Ativar sync" ligado.
 * - Manual: botão "Sincronizar agora" na aba Integrações do cliente.
 *
 * Cada rodada consulta a Meta de verdade (últimos 7 dias, ignorando o
 * cache), confirma que a conta ainda responde (token, permissão, status) e
 * guarda no cadastro do cliente: quando foi, se deu certo, um resumo e — se
 * deu errado — o MOTIVO em português, pra aparecer na tela.
 */

const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');

const INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 horas
const STALE_RUNNING_MS = 3 * 60 * 1000; // "sincronizando" há mais que isso = travou/reiniciou
const DELAY_BETWEEN_ACCOUNTS_MS = 1000;
const PERIOD_LABEL = 'últimos 7 dias';

const inFlight = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dá um "tipo" ao erro (pra a tela mostrar ícone/cor/dica) a partir da mensagem
// amigável que o metaService já devolve.
function classifyError(message) {
  const m = String(message || '');
  if (/token da meta (é inválido|expirou)|META_SYSTEM_USER_TOKEN/i.test(m)) {
    return { kind: 'token', hint: 'Gere um novo token do usuário do sistema no Gerenciador de Negócios e atualize META_SYSTEM_USER_TOKEN no servidor.' };
  }
  if (/não encontrou essa conta|não existe|ID da conta/i.test(m)) {
    return { kind: 'conta', hint: 'Confira se o ID (act_...) está certo e se a conta pertence ao seu Gerenciador de Negócios.' };
  }
  if (/não tem permissão|permiss/i.test(m)) {
    return { kind: 'permissao', hint: 'No Gerenciador de Negócios, atribua essa conta de anúncios ao usuário do sistema (acesso ao ativo).' };
  }
  if (/limitou as consultas|excesso de requisi/i.test(m)) {
    return { kind: 'limite', hint: 'É temporário. A próxima sincronização automática tenta de novo; ou use "Sincronizar agora" em alguns minutos.' };
  }
  if (/timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND|inesperado/i.test(m)) {
    return { kind: 'rede', hint: 'A Meta demorou ou não respondeu. Costuma passar sozinho — tente de novo em alguns minutos.' };
  }
  if (/não configurado|modo de exemplo/i.test(m)) {
    return { kind: 'config', hint: 'Defina META_SYSTEM_USER_TOKEN e USE_MOCK_DATA=false no servidor e reimplante.' };
  }
  return { kind: 'outro', hint: null };
}

function summarize(campaigns) {
  let spend = 0; let results = 0; let ads = 0; let campaignsWithSpend = 0;
  for (const c of campaigns || []) {
    const cs = (c.insights && c.insights.spend) || 0;
    if (cs > 0) campaignsWithSpend += 1;
    spend += cs;
    results += (c.insights && c.insights.conversions) || 0;
    for (const s of c.adsets || []) for (const a of s.ads || []) if (((a.insights && a.insights.spend) || 0) > 0) ads += 1;
  }
  return {
    period: PERIOD_LABEL,
    campaigns: (campaigns || []).length,
    campaignsWithSpend,
    adsWithSpend: ads,
    spend: Math.round(spend * 100) / 100,
    results,
  };
}

async function readAccount(id) {
  return (await accountsStore.getAll()).find((a) => a.id === id) || null;
}

// Grava só o bloco meta.sync, partindo do cadastro mais recente (não sobrescreve
// o que foi editado enquanto a sincronização rodava).
async function writeSync(id, patch, extraMeta = {}) {
  const fresh = await readAccount(id);
  if (!fresh) return null;
  const meta = { ...(fresh.meta || {}), ...extraMeta, sync: { ...((fresh.meta || {}).sync || {}), ...patch } };
  return accountsStore.update(id, { meta });
}

function isRunning(sync) {
  return !!(sync && sync.lastStatus === 'running' && sync.startedAt && Date.now() - Date.parse(sync.startedAt) < STALE_RUNNING_MS);
}

/**
 * Sincroniza UM cliente. Nunca lança erro: o resultado (ok ou falha com
 * motivo) fica gravado em account.meta.sync.
 * trigger: 'manual' | 'auto' | 'salvar'
 */
async function syncAccount(accountId, { trigger = 'manual' } = {}) {
  if (inFlight.has(accountId)) return readAccount(accountId);
  inFlight.add(accountId);
  try {
    const account = await readAccount(accountId);
    if (!account) return null;
    const meta = account.meta || {};
    const prev = meta.sync || {};
    const enabled = !!prev.enabled;
    const startedAt = new Date().toISOString();

    await writeSync(accountId, { lastStatus: 'running', startedAt, lastTrigger: trigger });

    const fail = async (message) => {
      const c = classifyError(message);
      const failures = (prev.consecutiveFailures || 0) + 1;
      return writeSync(accountId, {
        lastStatus: 'error',
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
        lastErrorKind: c.kind,
        lastErrorHint: c.hint,
        consecutiveFailures: failures,
        nextSyncAt: enabled ? new Date(Date.now() + INTERVAL_MS).toISOString() : null,
      });
    };

    if (!meta.adAccountId) return fail('Este cliente ainda não tem um ID de conta de anúncios da Meta. Preencha e clique em Salvar.');
    if (!metaService.hasRealCredentials()) {
      return fail('O token da Meta não está configurado no servidor (ou o modo de exemplo está ligado), então não dá para consultar a conta de verdade.');
    }

    try {
      const verified = await metaService.verifyAdAccount(meta.adAccountId);
      const campaigns = await metaService.getCampaignsWithAds(meta.adAccountId, 'last_7d', null, { force: true });
      const now = new Date().toISOString();
      // Aproveita a rodada pra reconferir o Instagram (e registrar o motivo se falhar).
      try {
        const ig = await metaService.resolveInstagram({ pageId: meta.pageId, igBusinessId: meta.igBusinessId });
        if (ig.status !== 'not_connected') {
          const fresh = await readAccount(accountId);
          await accountsStore.update(accountId, {
            instagramApi: { ...((fresh && fresh.instagramApi) || {}), status: ig.status, igUserId: ig.igUserId || null, username: ig.username || null, error: ig.error || null, checkedAt: ig.checkedAt },
            ...(ig.status === 'connected' && ig.igUserId !== meta.igBusinessId ? { meta: { ...((fresh && fresh.meta) || meta), igBusinessId: ig.igUserId } } : {}),
          });
        }
      } catch (e) { console.warn('Sync: conferência do Instagram falhou:', e.message); }
      const extraMeta = verified
        ? { status: 'connected', accountName: verified.name, currency: verified.currency, accountActive: verified.active }
        : {};
      const warning = verified && verified.active === false
        ? 'A conta de anúncios está desativada ou restrita na Meta — os anúncios podem estar parados.'
        : null;
      return await writeSync(accountId, {
        lastStatus: 'ok',
        lastAttemptAt: now,
        lastSyncAt: now,
        lastError: null,
        lastErrorKind: null,
        lastErrorHint: null,
        warning,
        consecutiveFailures: 0,
        summary: summarize(campaigns),
        nextSyncAt: enabled ? new Date(Date.now() + INTERVAL_MS).toISOString() : null,
      }, extraMeta);
    } catch (err) {
      return fail(err && err.message ? err.message : 'Erro desconhecido ao falar com a Meta.');
    }
  } finally {
    inFlight.delete(accountId);
  }
}

// Passa por todos os clientes com sync ligado e sincroniza quem já passou de 3h
// desde a última tentativa. Chamado de tempos em tempos pelo servidor.
async function runDue() {
  const done = [];
  for (const account of await accountsStore.getAll()) {
    const meta = account.meta || {};
    const sync = meta.sync || {};
    if (!sync.enabled || meta.status !== 'connected' || !meta.adAccountId) continue;
    if (isRunning(sync)) continue;
    const last = Date.parse(sync.lastAttemptAt || '') || 0;
    if (Date.now() - last < INTERVAL_MS - 60 * 1000) continue;
    await syncAccount(account.id, { trigger: 'auto' });
    done.push(account.id);
    await sleep(DELAY_BETWEEN_ACCOUNTS_MS);
  }
  return done;
}

module.exports = { syncAccount, runDue, classifyError, isRunning, INTERVAL_MS };
