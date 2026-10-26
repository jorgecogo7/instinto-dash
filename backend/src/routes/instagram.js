const express = require('express');
const accountsStore = require('../data/accountsStore');
const instagramService = require('../services/instagramService');
const metaService = require('../services/metaService');
const { instagramUnlinked } = require('../lib/integrationLink');

const router = express.Router();

// GET /api/instagram/:clientId/report[?from=AAAA-MM-DD&to=AAAA-MM-DD] — perfil, métricas e evolução diária
// (seguidores, alcance) do Instagram orgânico de um cliente. Não exige a
// conta estar "conectada" pra sempre devolver algo pra tela: sem
// credenciais reais do Meta configuradas, cai pros dados de exemplo — o
// mesmo comportamento já usado no Google Ads e no Meta Ads.
router.get('/:clientId/report', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

  try {
    let igUserId = account.instagramApi?.igUserId || account.meta?.igBusinessId || null;
    let igError = account.instagramApi?.status === 'error' ? account.instagramApi.error : null;
    // Conta removida de propósito: não descobre de novo pela Página.
    if (instagramUnlinked(account)) {
      igUserId = null;
      igError = null;
    }
    // Só a Página do Facebook cadastrada? Descobre o Instagram ligado a ela
    // e guarda no cliente — ou guarda o MOTIVO de não ter achado.
    if (!igUserId && !instagramUnlinked(account) && account.meta?.pageId && metaService.hasRealCredentials()) {
      const ig = await metaService.resolveInstagram({ pageId: account.meta.pageId });
      await accountsStore.update(account.id, {
        instagramApi: { ...(account.instagramApi || {}), status: ig.status, igUserId: ig.igUserId || null, username: ig.username || null, error: ig.error || null, checkedAt: ig.checkedAt },
        ...(ig.igUserId ? { meta: { ...account.meta, igBusinessId: ig.igUserId } } : {}),
      });
      if (ig.igUserId) { igUserId = ig.igUserId; igError = null; } else igError = ig.error || null;
    }
    try {
      const report = await instagramService.getOrganicReport(igUserId, {
        from: req.query.from, to: req.query.to,
      });
      res.json({ ...report, igConfigured: Boolean(igUserId), igError });
    } catch (e) {
      // Tinha ID mas a Meta recusou a leitura: registra o motivo pra aparecer em Integrações.
      if (!instagramUnlinked(account)) {
        await accountsStore.update(account.id, { instagramApi: { ...(account.instagramApi || {}), status: 'error', error: `Não consegui ler o Instagram: ${e.message}`, checkedAt: new Date().toISOString() } });
      }
      throw e;
    }
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
