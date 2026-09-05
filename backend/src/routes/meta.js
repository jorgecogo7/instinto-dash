const express = require('express');
const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');

const router = express.Router();

// GET /api/meta/:clientId/campaigns — campanhas > conjuntos > anúncios de um cliente
router.get('/:clientId/campaigns', async (req, res) => {
  const account = accountsStore.getAll().find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (account.meta.status !== 'connected') {
    return res.status(409).json({ error: 'Conta Meta ainda não conectada para este cliente.' });
  }

  try {
    const campaigns = await metaService.getCampaignsWithAds(account.meta.adAccountId);
    res.json(campaigns);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
