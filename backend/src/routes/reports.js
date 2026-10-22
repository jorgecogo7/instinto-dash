const express = require('express');
const accountsStore = require('../data/accountsStore');
const reportsStore = require('../data/reportsStore');
const reportService = require('../services/reportService');

const router = express.Router();

// GET /api/reports — relatórios gerados + próximas datas por cliente.
router.get('/', async (req, res) => {
  const [reports, accounts] = await Promise.all([reportsStore.list(), accountsStore.getAll()]);
  const nextRuns = {};
  accounts.forEach((a) => {
    const s = reportService.normalizeSchedule(a.reportSchedule);
    if (s.enabled && a.status !== 'inativo') nextRuns[a.id] = reportService.nextRunDate(s);
  });
  res.json({ reports, nextRuns, smtpConfigured: reportService.smtpConfigured() });
});

// POST /api/reports/generate { clientId?, period: '7'|'14'|'30'|'last_month'|'auto' }
// Sem clientId: gera agora pra todos os clientes com agenda ligada.
router.post('/generate', async (req, res) => {
  const period = String(req.body.period || 'auto');
  const rangeFor = (schedule) => {
    if (period === 'last_month' || (period === 'auto' && schedule.frequency === 'monthly')) return reportService.previousMonthRange();
    const days = period === 'auto' ? (schedule.frequency === 'biweekly' ? 14 : 7) : Number(period);
    return reportService.lastDaysRange([7, 14, 30].includes(days) ? days : 7);
  };
  const accounts = (await accountsStore.getAll()).filter((a) => a.status !== 'inativo');
  const targets = req.body.clientId
    ? accounts.filter((a) => a.id === req.body.clientId)
    : accounts.filter((a) => reportService.normalizeSchedule(a.reportSchedule).enabled);
  if (!targets.length) {
    return res.status(400).json({ error: req.body.clientId ? 'Cliente não encontrado.' : 'Nenhum cliente com relatório automático ligado.' });
  }
  const out = [];
  for (const a of targets) {
    const schedule = reportService.normalizeSchedule(a.reportSchedule);
    // Gerado à mão não dispara e-mail sozinho (você revisa e envia).
    out.push(await reportService.generateFor(a, rangeFor(schedule), { sendMail: false }));
  }
  res.json(out);
});

// POST /api/reports/weekly/:clientId — "Relatório de segunda": últimos 7 dias completos,
// com as otimizações do histórico de status e o link do painel. Só gera o texto
// (fica na Central como pendente); nunca envia nada.
router.post('/weekly/:clientId', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const range = reportService.lastDaysRange(7);
  const report = await reportService.generateFor(account, range, { sendMail: false, weekly: true });
  res.json({ ...report, hasShareLink: !!account.shareToken });
});

// PATCH /api/reports/:id { status?: 'pending'|'sent', message? }
router.patch('/:id', async (req, res) => {
  const changes = {};
  if (['pending', 'sent'].includes(req.body.status)) {
    changes.status = req.body.status;
    changes.sentAt = req.body.status === 'sent' ? new Date().toISOString() : null;
    if (req.body.channel) changes.channel = String(req.body.channel).slice(0, 20);
  }
  if (typeof req.body.message === 'string') changes.message = req.body.message.slice(0, 5000);
  const updated = await reportsStore.update(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: 'Relatório não encontrado.' });
  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  const ok = await reportsStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Relatório não encontrado.' });
  res.status(204).end();
});

module.exports = router;
