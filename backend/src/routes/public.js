const express = require('express');
const crypto = require('crypto');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');
const metaService = require('../services/metaService');
const leadsStore = require('../data/leadsStore');
const instagramService = require('../services/instagramService');

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

// Plataformas que o painel do cliente mostra (mesma regra do painel interno).
function wantedPlatforms(account) {
  const mOn = account.meta?.status === 'connected';
  const gOn = account.google?.status === 'connected';
  const model = account.dashboardModel || 'auto';
  const wanted = model === 'meta' ? ['meta'] : model === 'google' ? ['google']
    : model === 'combined' ? ['meta', 'google'] : [...(mOn ? ['meta'] : []), ...(gOn ? ['google'] : [])];
  return wanted.filter((p) => (p === 'meta' ? mOn : gOn));
}

// GET /api/public/:token/info — dados básicos pro painel do cliente (link
// compartilhado). Nada interno: sem contrato, saldo, IDs de conta etc.
router.get('/:token/info', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });
  res.json({
    name: account.name,
    niche: account.niche,
    platforms: wantedPlatforms(account),
    dashboardModel: account.dashboardModel || 'auto',
    hasInstagram: Boolean(account.instagramApi?.igUserId || account.meta?.igBusinessId || account.meta?.pageId),
  });
});

// GET /api/public/:token/(meta|google|instagram)?from&to — os mesmos
// relatórios do painel interno, só daquele cliente.
router.get('/:token/:kind(meta|google|instagram)', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });
  const range = { from: req.query.from, to: req.query.to };
  const kind = req.params.kind;
  try {
    if (kind === 'meta') {
      if (!wantedPlatforms(account).includes('meta')) return res.status(409).json({ error: 'Meta Ads não está ativo neste painel.' });
      return res.json(await metaService.getAccountReport(account.meta.adAccountId, range));
    }
    if (kind === 'google') {
      if (!wantedPlatforms(account).includes('google')) return res.status(409).json({ error: 'Google Ads não está ativo neste painel.' });
      return res.json(await googleService.getAccountReport(account.google.customerId, range));
    }
    let igUserId = account.instagramApi?.igUserId || account.meta?.igBusinessId || null;
    if (!igUserId && account.meta?.pageId) {
      const ig = await metaService.findInstagramForPage(account.meta.pageId);
      if (ig) {
        igUserId = ig.id;
        await accountsStore.update(account.id, { meta: { ...account.meta, igBusinessId: ig.id } });
      }
    }
    const report = await instagramService.getOrganicReport(igUserId, range);
    return res.json({ ...report, igConfigured: Boolean(igUserId) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Não foi possível carregar os dados agora. Tente de novo em instantes.' });
  }
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
