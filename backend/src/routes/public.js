const express = require('express');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');
const metaService = require('../services/metaService');

const router = express.Router();

// GET /api/public/:token — usado pelo link que você manda pro cliente.
// Não exige login nem chave de API (de propósito — é o link que o
// CLIENTE abre). Só devolve dados daquele cliente específico, nunca a
// lista completa, e nunca campos internos (contrato, saldo pix, etc.).
router.get('/:token', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });

  const safeAccount = {
    name: account.name,
    niche: account.niche,
    status: account.status,
    metaConnected: account.meta?.status === 'connected',
    googleConnected: account.google?.status === 'connected',
    instagramConnected: account.instagramApi?.status === 'connected',
  };

  const [metaData, googleData] = await Promise.allSettled([
    account.meta?.status === 'connected' ? metaService.getCampaignsWithAds(account.meta.adAccountId) : null,
    account.google?.status === 'connected' ? googleService.getAccountReport(account.google.customerId) : null,
  ]);

  res.json({
    account: safeAccount,
    meta: metaData.status === 'fulfilled' ? metaData.value : null,
    google: googleData.status === 'fulfilled' ? googleData.value : null,
  });
});

module.exports = router;
