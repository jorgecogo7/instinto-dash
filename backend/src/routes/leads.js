const express = require('express');
const crypto = require('crypto');
const leadsStore = require('../data/leadsStore');
const accountsStore = require('../data/accountsStore');
const leadScoringService = require('../services/leadScoringService');

const router = express.Router();

const STAGES = ['novo', 'contatado', 'qualificado', 'proposta', 'fechado', 'perdido'];
const EDITABLE_FIELDS = ['name', 'email', 'phone', 'company', 'niche', 'budget', 'message', 'stage', 'owner', 'notes'];

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

function pickEditableFields(body) {
  const clean = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === 'stage') {
      if (STAGES.includes(body.stage)) clean.stage = body.stage;
      continue;
    }
    clean[field] = sanitizeString(body[field], field === 'message' || field === 'notes' ? 2000 : 200);
  }
  return clean;
}

// GET /api/leads — lista todos os leads (funil de Captação & CRM).
router.get('/', async (req, res) => {
  try {
    res.json(await leadsStore.getAll());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads — cadastro manual de lead (time comercial adicionando
// alguém que chegou por fora do formulário público, ex: indicação, DM).
router.post('/', async (req, res) => {
  const name = sanitizeString(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório.' });

  try {
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      email: sanitizeString(req.body.email, 160),
      phone: sanitizeString(req.body.phone, 40),
      company: sanitizeString(req.body.company, 120),
      niche: sanitizeString(req.body.niche, 80),
      budget: sanitizeString(req.body.budget, 60),
      message: sanitizeString(req.body.message, 2000),
      source: 'manual',
      stage: 'novo',
      owner: sanitizeString(req.body.owner, 40) || null,
      notes: null,
      score: null,
      temperature: null,
      reasoning: null,
      nextAction: null,
      scoredAt: null,
      convertedAccountId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await leadsStore.add(lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id — move de estágio no funil, edita dados, anota.
router.patch('/:id', async (req, res) => {
  const changes = pickEditableFields(req.body);
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
  }
  try {
    const updated = await leadsStore.update(req.params.id, changes);
    if (!updated) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', async (req, res) => {
  try {
    const removed = await leadsStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/score — pede pra IA avaliar o lead (score, temperatura, próxima ação).
router.post('/:id/score', async (req, res) => {
  try {
    const lead = await leadsStore.getById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

    const result = await leadScoringService.scoreLead(lead);
    const updated = await leadsStore.update(req.params.id, result);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/leads/:id/convert — vira cliente de verdade (cria uma linha
// em "accounts" pré-preenchida com o que o lead já informou, e marca o
// lead como fechado + o id da conta criada, pra rastrear a origem).
router.post('/:id/convert', async (req, res) => {
  try {
    const lead = await leadsStore.getById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    if (lead.convertedAccountId) return res.status(400).json({ error: 'Esse lead já foi convertido em cliente.' });

    const accounts = await accountsStore.getAll();
    let id = lead.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cliente';
    if (accounts.some((a) => a.id === id)) id = `${id}-${Date.now()}`;

    const newAccount = {
      id,
      name: lead.name,
      niche: lead.niche || '—',
      startDate: new Date().toISOString().slice(0, 10),
      contractValue: 0,
      dailyBudget: 0,
      payment: 'cartao',
      pixBalance: null,
      status: 'onboarding',
      owner: lead.owner || 'JC',
      site: null,
      instagram: null,
      drive: null,
      shareToken: crypto.randomBytes(24).toString('base64url'),
      meta: { status: 'not_connected', adAccountId: null, pageId: null, igBusinessId: null },
      google: { status: 'not_connected', customerId: null },
      instagramApi: { status: 'not_connected', igUserId: null },
      leadSource: lead.source,
    };
    await accountsStore.add(newAccount);
    const updatedLead = await leadsStore.update(req.params.id, { stage: 'fechado', convertedAccountId: id });

    res.status(201).json({ lead: updatedLead, account: newAccount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
