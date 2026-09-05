/**
 * Sincroniza os dados de todas as contas em sequência (não em paralelo).
 *
 * Com 17+ contas de clientes, disparar tudo ao mesmo tempo é a forma
 * mais rápida de tomar rate limit tanto do Meta quanto do Google. Esta
 * fila processa uma conta por vez, com uma pequena pausa entre elas,
 * e guarda o resultado no cache — assim o dashboard sempre lê dados já
 * prontos, em vez de esperar a chamada à API na hora de abrir a tela.
 */

const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');

const DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncAllAccounts() {
  const results = [];

  for (const account of accountsStore.getAll()) {
    const entry = { accountId: account.id, meta: null, google: null, errors: [] };

    if (account.meta.status === 'connected') {
      try {
        entry.meta = await metaService.getCampaignsWithAds(account.meta.adAccountId);
      } catch (err) {
        entry.errors.push(`meta: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }

    if (account.google.status === 'connected') {
      try {
        entry.google = await googleService.getAccountReport(account.google.customerId);
      } catch (err) {
        entry.errors.push(`google: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }

    results.push(entry);
  }

  return results;
}

module.exports = { syncAllAccounts };
