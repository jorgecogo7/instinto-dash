const express = require('express');
const accountsStore = require('../data/accountsStore');

const router = express.Router();

// Campos que o cliente (frontend) tem permissão de definir/editar.
// Qualquer coisa fora dessa lista no corpo da requisição é ignorada —
// isso é o que impede "mass assignment" (alguém mandando um PATCH com
// { "id": "outro-id", "meta": { "status": "connected" } } tentando
// forjar uma conexão que não existe de verdade).
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

// GET /api/accounts — lista clientes, status de conexão e dados de gestão
// (contrato, nicho, orçamento diário) usados na aba "Clientes" do frontend.
router.get('/', (req, res) => {
  res.json(accountsStore.getAll());
});

// POST /api/accounts — cadastra um novo cliente. É este endpoint que o
// formulário "+ Novo cliente" do frontend chama. Fica salvo em
// accounts.json e sobrevive a reiniciar o servidor.
router.post('/', (req, res) => {
  const name = sanitizeString(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório (até 120 caracteres).' });

  const contractValue = Number(req.body.contractValue);
  const dailyBudget = Number(req.body.dailyBudget);
  const pixBalance = Number(req.body.pixBalance);

  const accounts = accountsStore.getAll();
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
    meta: { status: 'not_connected', adAccountId: null },
    google: { status: 'not_connected', customerId: null },
    instagramApi: { status: 'not_connected', igUserId: null },
  };

  accountsStore.add(newAccount);
  res.status(201).json(newAccount);
});

// PATCH /api/accounts/:id — edita campos de gestão de um cliente já
// cadastrado. Só aceita os campos em EDITABLE_FIELDS — o resto do body
// é descartado (proteção contra mass assignment).
router.patch('/:id', (req, res) => {
  const changes = pickEditableFields(req.body);
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
  }
  const updated = accountsStore.update(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json(updated);
});

// DELETE /api/accounts/:id — remove um cliente cadastrado.
router.delete('/:id', (req, res) => {
  const removed = accountsStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.status(204).end();
});

module.exports = router;
