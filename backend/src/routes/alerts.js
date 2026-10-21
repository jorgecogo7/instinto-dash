const express = require('express');
const healthService = require('../services/healthService');

const router = express.Router();

// GET /api/alerts — saúde de todas as contas (último check).
router.get('/', async (req, res) => {
  const clients = await healthService.list();
  const checkedAt = clients.map((c) => c.checkedAt).sort().pop() || null;
  res.json({ checkedAt, clients });
});

// POST /api/alerts/check?clientId= — confere agora (todas ou uma conta).
router.post('/check', async (req, res) => {
  const clientId = req.query.clientId || req.body?.clientId || null;
  const results = await healthService.runAll({ clientId });
  res.json({ ok: true, checked: results.length, clients: clientId ? results : await healthService.list() });
});

// POST /api/alerts/:clientId/snooze { alertId, hours } — "já vi" (silencia por X horas; 0 = reativar).
router.post('/:clientId/snooze', async (req, res) => {
  const { alertId, hours } = req.body || {};
  if (!alertId) return res.status(400).json({ error: 'Informe o alerta.' });
  const rec = await healthService.snooze(req.params.clientId, alertId, Number(hours) || 0);
  if (!rec) return res.status(404).json({ error: 'Cliente sem verificação ainda.' });
  res.json(rec);
});

// GET /api/alerts/meta-token — quais permissões o token do usuário do sistema tem
// (diagnóstico: Instagram sem métricas costuma ser falta de instagram_manage_insights).
router.get('/meta-token', async (req, res) => {
  const metaService = require('../services/metaService');
  if (!metaService.hasRealCredentials()) return res.json({ configured: false });
  try {
    const perms = await metaService.graphGet('me/permissions');
    const granted = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    const needed = ['ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights'];
    res.json({ configured: true, granted, missing: needed.filter((p) => !granted.includes(p)) });
  } catch (e) {
    res.json({ configured: true, error: e.message });
  }
});

module.exports = router;
