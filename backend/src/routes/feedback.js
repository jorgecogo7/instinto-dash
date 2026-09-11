const express = require('express');
const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const insightsService = require('../services/insightsService');

const router = express.Router();

// GET /api/feedback/:clientId?platform=meta|google
// Gera a mensagem de feedback semanal pronta pra copiar, no mesmo
// formato que Jorge já usa manualmente pros clientes.
router.get('/:clientId', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const platform = req.query.platform === 'google' ? 'google' : 'meta';

  try {
    const data =
      platform === 'meta'
        ? await metaService.getCampaignsWithAds(account.meta.adAccountId)
        : await googleService.getAccountReport(account.google.customerId);

    const message = await insightsService.generateFeedbackMessage(platform, data);
    res.json({ message });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
