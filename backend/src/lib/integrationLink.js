/**
 * Desconectar uma integração sem apagar o cliente.
 *
 * Cada plataforma limpa só o vínculo dela (IDs e status guardados no
 * cadastro). Não mexe em nome, contrato, link de compartilhamento,
 * visibilidade, login do cliente nem no Tag Manager.
 *
 * Instagram: `unlinked` impede que a sincronização (ou abrir Redes
 * Sociais) descubra o perfil de novo pela Página do Facebook. Clicar
 * em Salvar na integração Meta liga outra vez.
 */

const PLATFORMS = ['google', 'meta', 'instagram'];

function instagramUnlinked(account) {
  return !!(account && account.instagramApi && account.instagramApi.unlinked);
}

// O que conta como "tem Instagram" no painel e no link de compartilhamento.
// A visibilidade (liga/desliga da seção) é outra coisa e não entra aqui.
function hasInstagramLink(account) {
  if (!account || instagramUnlinked(account)) return false;
  const ig = account.instagramApi || {};
  const meta = account.meta || {};
  return Boolean(ig.igUserId || meta.igBusinessId || meta.pageId);
}

function integrationIsLinked(account, platform) {
  if (!account) return false;
  const meta = account.meta || {};
  const google = account.google || {};
  const ig = account.instagramApi || {};
  if (platform === 'google') return !!(google.customerId || google.accountName || google.status === 'connected');
  if (platform === 'meta') {
    return !!(meta.adAccountId || meta.accountName || meta.status === 'connected' || meta.status === 'pending');
  }
  if (platform === 'instagram') {
    if (ig.unlinked) return false;
    return !!(meta.igBusinessId || ig.igUserId || ig.username || ig.status === 'connected' || ig.status === 'error' || ig.status === 'pending');
  }
  return false;
}

// Devolve só os campos que mudam. null = plataforma desconhecida.
function disconnectPatch(account, platform) {
  const meta = { ...((account && account.meta) || {}) };
  if (platform === 'google') {
    return { google: { status: 'not_connected', customerId: null, accountName: null } };
  }
  if (platform === 'meta') {
    return {
      meta: {
        ...meta,
        status: 'not_connected',
        adAccountId: null,
        accountName: null,
        currency: null,
        accountActive: null,
        sync: { enabled: false, intervalHours: 3, nextSyncAt: null },
      },
    };
  }
  if (platform === 'instagram') {
    return {
      meta: { ...meta, igBusinessId: null },
      instagramApi: {
        status: 'not_connected',
        igUserId: null,
        username: null,
        error: null,
        checkedAt: null,
        unlinked: true,
      },
    };
  }
  return null;
}

function disconnectLogText(account, platform) {
  const meta = (account && account.meta) || {};
  const google = (account && account.google) || {};
  const ig = (account && account.instagramApi) || {};
  if (platform === 'google') {
    const id = google.customerId ? ` (ID ${google.customerId})` : '';
    return `Google Ads desconectado${id}. Só essa conexão saiu do sistema; o cliente continua cadastrado.`;
  }
  if (platform === 'meta') {
    const id = meta.adAccountId ? ` (conta ${meta.adAccountId})` : '';
    return `Meta Ads desconectada${id}. A sincronização automática foi desligada. Página e Instagram continuam, se já estavam cadastrados. O cliente não foi apagado.`;
  }
  const who = ig.username ? ` (@${ig.username})` : (meta.igBusinessId ? ` (ID ${meta.igBusinessId})` : '');
  return `Instagram desconectado${who}. A conta de anúncios da Meta e a Página continuam. O cliente não foi apagado.`;
}

module.exports = {
  PLATFORMS,
  instagramUnlinked,
  hasInstagramLink,
  integrationIsLinked,
  disconnectPatch,
  disconnectLogText,
};
