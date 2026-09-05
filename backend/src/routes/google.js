const express = require('express');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');

const router = express.Router();

// GET /api/google/:clientId/report — campanhas, palavras-chave e leilão de um cliente
router.get('/:clientId/report', async (req, res) => {
  const account = accountsStore.getAll().find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (account.google.status !== 'connected') {
    return res.status(409).json({ error: 'Conta Google Ads ainda não conectada para este cliente.' });
  }

  try {
    const report = await googleService.getAccountReport(account.google.customerId);
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
