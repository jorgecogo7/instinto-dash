const express = require('express');
const crypto = require('crypto');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');
const metaService = require('../services/metaService');
const leadsStore = require('../data/leadsStore');

const router = express.Router();

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

// GET /api/public/:token — usado pelo link que você manda pro cliente.
// Não exige login nem chave de API (de propósito — é o link que o
// CLIENTE abre). Só devolve dados daquele cliente específico, nunca a
// lista completa, e nunca campos internos (contrato, saldo pix, etc.).
router.get('/:token', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });

  const safeAccount = {
    name: account.name,
    niche: account.niche,
    status: account.status,
    metaConnected: account.meta?.status === 'connected',
    googleConnected: account.google?.status === 'connected',
    instagramConnected: account.instagramApi?.status === 'connected',
  };

  const [metaData, googleData] = await Promise.allSettled([
    account.meta?.status === 'connected' ? metaService.getCampaignsWithAds(account.meta.adAccountId) : null,
    account.google?.status === 'connected' ? googleService.getAccountReport(account.google.customerId) : null,
  ]);

  res.json({
    account: safeAccount,
    meta: metaData.status === 'fulfilled' ? metaData.value : null,
    google: googleData.status === 'fulfilled' ? googleData.value : null,
  });
});

// POST /api/public/leads — o formulário de Captação & CRM que qualquer
// visitante preenche (link público, sem login, sem chave de API — de
// propósito). Só escreve um lead novo com estágio "novo"; não lê nem
// devolve dados de ninguém, então não tem o risco de vazamento que o
// GET acima tem que tomar cuidado com.
router.post('/leads', async (req, res) => {
  // honeypot: campo escondido no formulário que só um bot preenche.
  // Gente de verdade nunca vê nem toca nesse campo.
  if (req.body.website) return res.status(201).json({ ok: true });

  const name = sanitizeString(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Informe seu nome.' });

  const email = sanitizeString(req.body.email, 160);
  const phone = sanitizeString(req.body.phone, 40);
  if (!email && !phone) return res.status(400).json({ error: 'Informe pelo menos um contato (e-mail ou telefone).' });

  try {
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      email,
      phone,
      company: sanitizeString(req.body.company, 120),
      niche: sanitizeString(req.body.niche, 80),
      budget: sanitizeString(req.body.budget, 60),
      message: sanitizeString(req.body.message, 2000),
      source: 'formulario-publico',
      stage: 'novo',
      owner: null,
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
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Não foi possível enviar agora. Tente novamente em instantes.' });
  }
});

module.exports = router;
