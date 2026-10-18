const express = require('express');
const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');

const router = express.Router();

// GET /api/meta/:clientId/campaigns[?period=last_7d|last_14d|last_30d|this_month|last_month][&from=AAAA-MM-DD&to=AAAA-MM-DD]
// — campanhas > conjuntos > anúncios de um cliente (padrão: últimos 30 dias)
router.get('/:clientId/campaigns', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (account.meta.status !== 'connected') {
    return res.status(409).json({ error: 'Conta Meta ainda não conectada para este cliente.' });
  }

  try {
    const campaigns = await metaService.getCampaignsWithAds(
      account.meta.adAccountId,
      req.query.period,
      { from: req.query.from, to: req.query.to },
    );
    res.json(campaigns);
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

// GET /api/meta/:clientId/report?from=AAAA-MM-DD&to=AAAA-MM-DD — relatório
// completo: totais com período anterior, evolução diária, campanhas e todos
// os anúncios com investimento (com miniatura do criativo).
router.get('/:clientId/report', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (account.meta?.status !== 'connected') {
    return res.status(409).json({ error: 'Conta Meta ainda não conectada para este cliente.' });
  }
  try {
    const report = await metaService.getAccountReport(account.meta.adAccountId, {
      from: req.query.from, to: req.query.to,
    });
    res.json(report);
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
