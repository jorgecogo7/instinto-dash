const express = require('express');
const accountsStore = require('../data/accountsStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const insightsService = require('../services/insightsService');
const { generateReportAnalysis } = require('../services/reportAnalysisService');
const config = require('../config');

const router = express.Router();

// GET /api/insights/status: diz se as sugestões por IA estão ativas (sem expor a chave).
router.get('/status', (req, res) => {
  res.json({ aiEnabled: !!(config.anthropic && config.anthropic.apiKey) });
});

// GET /api/insights/:clientId?platform=meta|google
// Busca os dados reais da conta (via metaService/googleService, que já
// lidam com cache) e manda pra IA gerar as sugestões de melhoria.
router.get('/:clientId', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
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
    console.error(err); res.status(502).json({ error: err.message });
  }
});

// POST /api/insights/:clientId/report-analysis { from, to } — texto da IA pra
// página "Análise das campanhas" do PDF (o gestor pode editar antes de gerar).
router.post('/:clientId/report-analysis', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const range = { from: req.body.from, to: req.body.to };
  try {
    const [meta, google] = await Promise.all([
      account.meta?.status === 'connected' ? metaService.getAccountReport(account.meta.adAccountId, range).catch(() => null) : null,
      account.google?.status === 'connected' ? googleService.getAccountReport(account.google.customerId, range).catch(() => null) : null,
    ]);
    if (!meta && !google) return res.status(400).json({ error: 'Sem dados de anúncios nesse período pra analisar.' });
    const analysis = await generateReportAnalysis({
      clientName: account.name, niche: account.niche, range: meta?.range || google?.range || range, meta, google,
    });
    res.json(analysis);
  } catch (err) {
    console.error(err); res.status(502).json({ error: err.message });
  }
});

module.exports = router;
