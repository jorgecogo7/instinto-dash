const express = require('express');
const accountsStore = require('../data/accountsStore');
const instagramService = require('../services/instagramService');
const metaService = require('../services/metaService');

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
    // Só a Página do Facebook cadastrada? Descobre o Instagram ligado a ela
    // e guarda no cliente, pra não precisar digitar o ID na mão.
    if (!igUserId && account.meta?.pageId) {
      const ig = await metaService.findInstagramForPage(account.meta.pageId);
      if (ig) {
        igUserId = ig.id;
        await accountsStore.update(account.id, { meta: { ...account.meta, igBusinessId: ig.id } });
      }
    }
    const report = await instagramService.getOrganicReport(igUserId, {
      from: req.query.from, to: req.query.to,
    });
    res.json({ ...report, igConfigured: Boolean(igUserId) });
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
