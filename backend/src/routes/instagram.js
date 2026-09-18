const express = require('express');
const accountsStore = require('../data/accountsStore');
const instagramService = require('../services/instagramService');

const router = express.Router();

// GET /api/instagram/:clientId/report — perfil, métricas e evolução diária
// (seguidores, alcance) do Instagram orgânico de um cliente. Não exige a
// conta estar "conectada" pra sempre devolver algo pra tela: sem
// credenciais reais do Meta configuradas, cai pros dados de exemplo — o
// mesmo comportamento já usado no Google Ads e no Meta Ads.
router.get('/:clientId/report', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

  try {
    const igUserId = account.instagramApi?.igUserId || account.meta?.igBusinessId || null;
    const report = await instagramService.getOrganicReport(igUserId);
    res.json(report);
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
