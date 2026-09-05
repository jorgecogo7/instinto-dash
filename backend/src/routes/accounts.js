const express = require('express');
const accountsStore = require('../data/accountsStore');

const router = express.Router();

// GET /api/accounts — lista clientes, status de conexão e dados de gestão
// (contrato, nicho, orçamento diário) usados na aba "Clientes" do frontend.
router.get('/', (req, res) => {
  res.json(accountsStore.getAll());
});

// POST /api/accounts — cadastra um novo cliente. É este endpoint que o
// formulário "+ Novo cliente" do frontend chama. Fica salvo em
// accounts.json e sobrevive a reiniciar o servidor.
router.post('/', (req, res) => {
  const { name, niche, contractValue, dailyBudget, owner, site, instagram, drive, payment, pixBalance } = req.body;
  if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório.' });

  const accounts = accountsStore.getAll();
  let id = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (accounts.some((a) => a.id === id)) id = `${id}-${Date.now()}`;

  const newAccount = {
    id,
    name,
    niche: niche || '—',
    startDate: new Date().toISOString().slice(0, 10),
    contractValue: Number(contractValue) || 0,
    dailyBudget: Number(dailyBudget) || 0,
    payment: payment === 'pix' ? 'pix' : 'cartao',
    pixBalance: payment === 'pix' ? Number(pixBalance) || 0 : null,
    status: 'onboarding',
    owner: owner || 'JC',
    site: site || null,
    instagram: instagram || null,
    drive: drive || null,
    meta: { status: 'not_connected', adAccountId: null },
    google: { status: 'not_connected', customerId: null },
    instagramApi: { status: 'not_connected', igUserId: null },
  };

  accountsStore.add(newAccount);
  res.status(201).json(newAccount);
});

// PATCH /api/accounts/:id — edita campos de gestão de um cliente já
// cadastrado (ex: mudar valor de contrato, status, vincular conta Meta/Google).
router.patch('/:id', (req, res) => {
  const updated = accountsStore.update(req.params.id, req.body);
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
