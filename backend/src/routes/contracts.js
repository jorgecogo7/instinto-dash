const express = require('express');
const crypto = require('crypto');
const contractsStore = require('../data/contractsStore');

const router = express.Router();

const EDITABLE_FIELDS = [
  'accountId', 'startDate', 'endDate', 'monthlyValue', 'autoRenew',
  'renewalPeriodMonths', 'documentUrl', 'notes', 'cancelled',
];

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function pickEditableFields(body) {
  const clean = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] !== undefined) clean[field] = body[field];
  }
  if (clean.startDate !== undefined && !isValidDate(clean.startDate)) delete clean.startDate;
  if (clean.endDate !== undefined && !isValidDate(clean.endDate)) delete clean.endDate;
  if (clean.monthlyValue !== undefined) {
    const n = Number(clean.monthlyValue);
    clean.monthlyValue = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  if (clean.renewalPeriodMonths !== undefined) {
    const n = Number(clean.renewalPeriodMonths);
    clean.renewalPeriodMonths = Number.isFinite(n) && n > 0 ? Math.round(n) : 12;
  }
  if (clean.autoRenew !== undefined) clean.autoRenew = !!clean.autoRenew;
  if (clean.cancelled !== undefined) clean.cancelled = !!clean.cancelled;
  if (clean.documentUrl !== undefined) clean.documentUrl = sanitizeString(clean.documentUrl, 400);
  if (clean.notes !== undefined) clean.notes = sanitizeString(clean.notes, 2000);
  if (clean.accountId !== undefined) clean.accountId = sanitizeString(clean.accountId, 191);
  return clean;
}

// Deriva o status a partir das datas — nunca fica "desatualizado" porque
// não é gravado no banco, é recalculado toda vez que a lista é lida.
function withStatus(contract) {
  if (contract.cancelled) return { ...contract, status: 'cancelado' };
  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = Math.ceil((new Date(contract.endDate) - new Date(today)) / 86400000);
  let status = 'ativo';
  if (daysLeft < 0) status = 'vencido';
  else if (daysLeft <= 30) status = 'vencendo';
  return { ...contract, status, daysLeft };
}

// GET /api/contracts — todos os contratos, com status calculado.
router.get('/', async (req, res) => {
  try {
    const contracts = (await contractsStore.getAll()).map(withStatus);
    res.json(contracts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contracts — cria um novo contrato pra um cliente.
router.post('/', async (req, res) => {
  const accountId = sanitizeString(req.body.accountId, 191);
  if (!accountId) return res.status(400).json({ error: 'Selecione o cliente.' });
  if (!isValidDate(req.body.startDate) || !isValidDate(req.body.endDate)) {
    return res.status(400).json({ error: 'Informe data de início e de fim válidas.' });
  }

  const monthlyValue = Number(req.body.monthlyValue);
  const renewalPeriodMonths = Number(req.body.renewalPeriodMonths);

  try {
    const contract = {
      id: crypto.randomBytes(8).toString('hex'),
      accountId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      monthlyValue: Number.isFinite(monthlyValue) && monthlyValue >= 0 ? monthlyValue : 0,
      autoRenew: !!req.body.autoRenew,
      renewalPeriodMonths: Number.isFinite(renewalPeriodMonths) && renewalPeriodMonths > 0 ? Math.round(renewalPeriodMonths) : 12,
      documentUrl: sanitizeString(req.body.documentUrl, 400),
      notes: sanitizeString(req.body.notes, 2000),
      cancelled: false,
      renewalHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await contractsStore.add(contract);
    res.status(201).json(withStatus(contract));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contracts/:id — edita campos (protegido contra mass assignment).
router.patch('/:id', async (req, res) => {
  const changes = pickEditableFields(req.body);
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
  }
  changes.updatedAt = new Date().toISOString();
  try {
    const updated = await contractsStore.update(req.params.id, changes);
    if (!updated) return res.status(404).json({ error: 'Contrato não encontrado.' });
    res.json(withStatus(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contracts/:id/renew — renova manualmente: empurra o vencimento
// pra frente pelo período de renovação, a partir do vencimento atual (ou de
// hoje, se já tiver vencido) e registra no histórico do contrato.
router.post('/:id/renew', async (req, res) => {
  try {
    const contract = await contractsStore.getById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });

    const today = new Date();
    const currentEnd = new Date(contract.endDate);
    const base = currentEnd > today ? currentEnd : today;
    const newEnd = new Date(base);
    newEnd.setMonth(newEnd.getMonth() + (contract.renewalPeriodMonths || 12));

    const updated = await contractsStore.update(req.params.id, {
      endDate: newEnd.toISOString().slice(0, 10),
      cancelled: false,
      renewalHistory: [...(contract.renewalHistory || []), { renewedAt: new Date().toISOString(), previousEndDate: contract.endDate }],
      updatedAt: new Date().toISOString(),
    });
    res.json(withStatus(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contracts/:id
router.delete('/:id', async (req, res) => {
  try {
    const removed = await contractsStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Contrato não encontrado.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Exportado à parte (não é rota) pra ser usado pelo job em segundo plano do
// server.js: renova sozinho todo contrato com autoRenew=true que já venceu.
module.exports.autoRenewExpiredContracts = async function autoRenewExpiredContracts() {
  const contracts = await contractsStore.getAll();
  const today = new Date();
  let renewed = 0;
  for (const contract of contracts) {
    if (contract.cancelled || !contract.autoRenew) continue;
    if (new Date(contract.endDate) >= today) continue;
    const newEnd = new Date(contract.endDate);
    newEnd.setMonth(newEnd.getMonth() + (contract.renewalPeriodMonths || 12));
    await contractsStore.update(contract.id, {
      endDate: newEnd.toISOString().slice(0, 10),
      renewalHistory: [...(contract.renewalHistory || []), { renewedAt: new Date().toISOString(), previousEndDate: contract.endDate, automatic: true }],
      updatedAt: new Date().toISOString(),
    });
    renewed += 1;
  }
  return renewed;
};
