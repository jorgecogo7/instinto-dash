const express = require('express');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');

const router = express.Router();

// GET /api/google/:clientId/report?from=YYYY-MM-DD&to=YYYY-MM-DD — campanhas,
// palavras-chave, termos de pesquisa e dispositivo de um cliente, num período
// escolhido (sem from/to, usa os últimos 30 dias).
router.get('/:clientId/report', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (account.google.status !== 'connected') {
    return res.status(409).json({ error: 'Conta Google Ads ainda não conectada para este cliente.' });
  }

  try {
    const report = await googleService.getAccountReport(account.google.customerId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(report);
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
