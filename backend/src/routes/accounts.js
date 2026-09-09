const express = require('express');
const crypto = require('crypto');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');

const router = express.Router();

const EDITABLE_FIELDS = [
  'name', 'niche', 'contractValue', 'dailyBudget', 'owner',
  'site', 'instagram', 'drive', 'payment', 'pixBalance', 'status',
];

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

function pickEditableFields(body) {
  const clean = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] !== undefined) clean[field] = body[field];
  }
  return clean;
}

// GET /api/accounts — lista clientes, status de conexão e dados de gestão.
router.get('/', async (req, res) => {
  try {
    res.json(await accountsStore.getAll());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts — cadastra um novo cliente.
router.post('/', async (req, res) => {
  const name = sanitizeString(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório (até 120 caracteres).' });

  const contractValue = Number(req.body.contractValue);
  const dailyBudget = Number(req.body.dailyBudget);
  const pixBalance = Number(req.body.pixBalance);

  try {
    const accounts = await accountsStore.getAll();
    let id = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cliente';
    if (accounts.some((a) => a.id === id)) id = `${id}-${Date.now()}`;

    const newAccount = {
      id,
      name,
      niche: sanitizeString(req.body.niche, 60) || '—',
      startDate: new Date().toISOString().slice(0, 10),
      contractValue: Number.isFinite(contractValue) && contractValue >= 0 ? contractValue : 0,
      dailyBudget: Number.isFinite(dailyBudget) && dailyBudget >= 0 ? dailyBudget : 0,
      payment: req.body.payment === 'pix' ? 'pix' : 'cartao',
      pixBalance: req.body.payment === 'pix' && Number.isFinite(pixBalance) ? pixBalance : null,
      status: 'onboarding',
      owner: sanitizeString(req.body.owner, 40) || 'JC',
      site: sanitizeString(req.body.site, 200),
      instagram: sanitizeString(req.body.instagram, 60),
      drive: sanitizeString(req.body.drive, 300),
      // Token aleatório usado no link de compartilhamento (visualização do
      // cliente, sem login nenhum). 24 bytes ~= impossível de adivinhar.
      shareToken: crypto.randomBytes(24).toString('base64url'),
      meta: { status: 'not_connected', adAccountId: null, pageId: null, igBusinessId: null },
      google: { status: 'not_connected', customerId: null },
      instagramApi: { status: 'not_connected', igUserId: null },
    };

    await accountsStore.add(newAccount);
    res.status(201).json(newAccount);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/accounts/:id — edita campos de gestão (protegido contra mass assignment).
router.patch('/:id', async (req, res) => {
  const changes = pickEditableFields(req.body);
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
  }
  try {
    const updated = await accountsStore.update(req.params.id, changes);
    if (!updated) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id — remove um cliente cadastrado (hard delete —
// o dashboard usa PATCH status=inativo pro dia a dia, isso aqui fica
// disponível pra uma limpeza manual de verdade, se um dia precisar).
router.delete('/:id', async (req, res) => {
  try {
    const removed = await accountsStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/connect-google — o botão "Conectar Google Ads"
// do dashboard. Recebe o Customer ID que o cliente já tem vinculado à
// sua MCC, TESTA de verdade contra a API do Google (não salva às cegas)
// e só marca como conectado se a conta realmente responder.
router.post('/:id/connect-google', async (req, res) => {
  const customerId = sanitizeString(req.body.customerId, 20);
  if (!customerId) return res.status(400).json({ error: 'Informe o ID da conta Google Ads.' });

  try {
    const accounts = await accountsStore.getAll();
    const account = accounts.find((a) => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const verified = await googleService.verifyCustomerAccess(customerId);
    const updated = await accountsStore.update(req.params.id, {
      google: { status: 'connected', customerId, accountName: verified.name },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: `Não consegui confirmar essa conta: ${err.message}. Confira se o ID está certo e se ela já foi vinculada à sua MCC.`,
    });
  }
});

// POST /api/accounts/:id/meta-connection — salva os IDs do Meta (Ad
// Account, Página, Instagram Business) informados manualmente. Ainda
// não faz verificação real contra a API — isso liga quando o App do
// Meta for Developers estiver pronto (fica marcado como "pendente" até lá).
router.post('/:id/meta-connection', async (req, res) => {
  const adAccountId = sanitizeString(req.body.adAccountId, 40);
  const pageId = sanitizeString(req.body.pageId, 40);
  const igBusinessId = sanitizeString(req.body.igBusinessId, 40);

  try {
    const updated = await accountsStore.update(req.params.id, {
      meta: { status: adAccountId ? 'pending' : 'not_connected', adAccountId, pageId, igBusinessId },
    });
    if (!updated) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
