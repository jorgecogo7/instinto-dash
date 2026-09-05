const express = require('express');
const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const insightsService = require('../services/insightsService');

const router = express.Router();

// GET /api/insights/:clientId?platform=meta|google
// Busca os dados reais da conta (via metaService/googleService, que já
// lidam com cache) e manda pra IA gerar as sugestões de melhoria.
router.get('/:clientId', async (req, res) => {
  const account = accountsStore.getAll().find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const platform = req.query.platform === 'google' ? 'google' : 'meta';

  try {
    const data =
      platform === 'meta'
        ? await metaService.getCampaignsWithAds(account.meta.adAccountId)
        : await googleService.getAccountReport(account.google.customerId);

    const insights = await insightsService.generateInsights(platform, data);
    res.json(insights);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
