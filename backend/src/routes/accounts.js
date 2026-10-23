const express = require('express');
const crypto = require('crypto');
const accountsStore = require('../data/accountsStore');
const crmStore = require('../data/crmStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const { hashPassword } = require('../lib/auth');
const clientAccess = require('../lib/clientAccess');
const metaSync = require('../lib/metaSync');
const integrationHealth = require('../services/integrationHealthService');

const router = express.Router();

const EDITABLE_FIELDS = [
  'name', 'niche', 'contractValue', 'dailyBudget', 'owner',
  'site', 'instagram', 'drive', 'payment', 'pixBalance', 'status',
  'dashboardModel', 'clientVisibility', 'reportSchedule', 'goals',
];

// Modelo do painel de anúncios do cliente: quais plataformas aparecem.
// 'auto' = mostra o que estiver conectado.
const DASHBOARD_MODELS = new Set(['auto', 'meta', 'google', 'combined']);

// O hash da senha do cliente nunca sai do servidor; o painel só vê o usuário e datas.
function stripSecrets(a) {
  if (!a || !a.clientAuth) return a;
  const { passwordHash, v, ...rest } = a.clientAuth;
  return { ...a, clientAuth: rest };
}

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
    res.json((await accountsStore.getAll()).map(stripSecrets));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/integration-health — checklist de integração de todos os
// clientes (o que falta e como corrigir). ?refresh=1 ignora o cache de 10 min.
router.get('/integration-health', async (req, res) => {
  try {
    res.json(await integrationHealth.getHealth({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/integration-health — o mesmo checklist, de um cliente só.
router.get('/:id/integration-health', async (req, res) => {
  try {
    const r = await integrationHealth.getHealth({ accountId: req.params.id, refresh: req.query.refresh === '1' });
    if (!r.clients.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ checkedAt: r.checkedAt, live: r.live, systemUser: r.systemUser, ...r.clients[0] });
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
  if (changes.reportSchedule !== undefined) changes.reportSchedule = require('../services/reportService').normalizeSchedule(changes.reportSchedule);
  if (changes.goals !== undefined) changes.goals = clientAccess.sanitizeGoals(changes.goals);
  if (changes.clientVisibility !== undefined) changes.clientVisibility = clientAccess.sanitizeVisibility(changes.clientVisibility);
  if (changes.dashboardModel !== undefined && !DASHBOARD_MODELS.has(changes.dashboardModel)) {
    return res.status(400).json({ error: 'Modelo de dashboard inválido.' });
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo válido para atualizar.' });
  }
  try {
    const updated = await accountsStore.update(req.params.id, changes);
    if (!updated) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(stripSecrets(updated));
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
    // Leva junto o CRM do cliente (não fica nada órfão no banco).
    await crmStore.removeAllForClient(req.params.id).catch((e) => console.warn('CRM do cliente não foi apagado:', e.message));
    // Não deixa rascunho de campanha órfão para um cliente novo com o mesmo id.
    await require('../data/campaignsStore').removeAllForClient(req.params.id)
      .catch((e) => console.error('Limpeza de campanhas do cliente falhou:', e));
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
    res.json(stripSecrets(updated));
  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: `Não consegui confirmar essa conta: ${err.message}. Confira se o ID está certo e se ela já foi vinculada à sua MCC.`,
    });
  }
});

// POST /api/accounts/:id/meta-connection — salva os IDs do Meta (Ad
// Account, Página, Instagram Business). Com o token do usuário do sistema
// configurado, TESTA de verdade contra a Graph API e só marca como
// "conectado" se a Meta confirmar a conta de anúncios. Sem token, salva e
// deixa "pendente" (comportamento antigo), pra não perder o que foi digitado.
router.post('/:id/meta-connection', async (req, res) => {
  const adAccountId = sanitizeString(req.body.adAccountId, 40);
  const pageId = sanitizeString(req.body.pageId, 40);
  const igBusinessId = sanitizeString(req.body.igBusinessId, 40);

  try {
    const account = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

    // O bloco de sincronização (liga/desliga, última rodada, erro) sobrevive ao "Salvar".
    // Se a conta de anúncios mudou, o histórico da conta antiga não vale mais.
    const prevMeta = account.meta || {};
    const sameAccount = metaService.normalizeAdAccountId(prevMeta.adAccountId) === metaService.normalizeAdAccountId(adAccountId);
    const prevSync = sameAccount ? (prevMeta.sync || {}) : { enabled: (prevMeta.sync || {}).enabled };
    const syncEnabled = typeof req.body.syncEnabled === 'boolean' ? req.body.syncEnabled : !!prevSync.enabled;
    let meta = {
      status: 'not_connected', adAccountId, pageId, igBusinessId,
      sync: { ...prevSync, enabled: syncEnabled, intervalHours: 3 },
    };

    if (adAccountId) {
      meta.status = 'pending';
      let verified = null;
      try {
        verified = await metaService.verifyAdAccount(adAccountId);
      } catch (err) {
        return res.status(400).json({
          error: `Não consegui confirmar essa conta na Meta: ${err.message}`,
        });
      }
      if (verified) {
        meta = {
          ...meta,
          status: 'connected',
          adAccountId: verified.id,
          accountName: verified.name,
          currency: verified.currency,
          accountActive: verified.active,
        };
      }
    }

    // Instagram: confere de verdade (pelo ID ou pela Página) e guarda o motivo se falhar.
    const ig = await metaService.resolveInstagram({ pageId, igBusinessId });
    if (ig.status === 'connected') meta.igBusinessId = ig.igUserId;
    const instagramApi = {
      ...(account.instagramApi || {}),
      status: ig.status, igUserId: ig.igUserId || null, username: ig.username || null,
      error: ig.error || null, checkedAt: ig.checkedAt,
    };

    if (!syncEnabled || meta.status !== 'connected') meta.sync.nextSyncAt = null;
    const updated = await accountsStore.update(req.params.id, { meta, instagramApi });

    // Conectou (ou trocou) a conta com o sync ligado e ainda não há uma rodada válida
    // dessa conta? Já dispara a primeira em segundo plano — a tela acompanha pelo status.
    const needsFirstSync = syncEnabled && meta.status === 'connected' && !(meta.sync && meta.sync.lastSyncAt);
    if (needsFirstSync) {
      metaSync.syncAccount(req.params.id, { trigger: 'salvar' }).catch((e) => console.error('Sync inicial falhou:', e));
      const fresh = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
      return res.json(stripSecrets(fresh || updated));
    }
    res.json(stripSecrets(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/meta-sync — botão "Sincronizar agora". Responde na hora
// (a rodada roda em segundo plano); a tela consulta GET .../meta-sync até terminar.
router.post('/:id/meta-sync', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!account.meta || !account.meta.adAccountId) {
    return res.status(409).json({ error: 'Preencha o ID da conta de anúncios e clique em Salvar antes de sincronizar.' });
  }
  if (!metaSync.isRunning((account.meta || {}).sync)) {
    metaSync.syncAccount(req.params.id, { trigger: 'manual' }).catch((e) => console.error('Sync manual falhou:', e));
  }
  // Pequena espera pra a tela já receber "sincronizando" (e não o estado antigo).
  await new Promise((r) => setTimeout(r, 250));
  const fresh = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
  res.status(202).json({ sync: (fresh.meta || {}).sync || {}, status: (fresh.meta || {}).status });
});

// GET /api/accounts/:id/meta-sync — estado atual da sincronização (a tela usa pra acompanhar).
router.get('/:id/meta-sync', async (req, res) => {
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const meta = account.meta || {};
  res.json({ sync: meta.sync || {}, status: meta.status, accountName: meta.accountName || null });
});

// POST /api/accounts/:id/meta-sync-settings — liga/desliga o sync automático (a cada 3h).
router.post('/:id/meta-sync-settings', async (req, res) => {
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'Informe enabled: true ou false.' });
  const account = (await accountsStore.getAll()).find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const meta = account.meta || {};
  const sync = {
    ...(meta.sync || {}), enabled: req.body.enabled, intervalHours: 3,
    nextSyncAt: req.body.enabled && meta.status === 'connected'
      ? new Date(Date.now() + metaSync.INTERVAL_MS).toISOString() : null,
  };
  const updated = await accountsStore.update(req.params.id, { meta: { ...meta, sync } });
  // Ligou e a conta já está conectada, mas nunca sincronizou? Roda a primeira agora.
  if (req.body.enabled && meta.status === 'connected' && !sync.lastSyncAt) {
    metaSync.syncAccount(req.params.id, { trigger: 'salvar' }).catch((e) => console.error('Sync inicial falhou:', e));
  }
  res.json(stripSecrets(updated));
});

// POST /api/accounts/:id/client-access — cria (ou troca) o login do cliente.
// Devolve a senha UMA vez; no banco fica só o hash. Trocar a senha derruba
// quem estiver logado com a antiga.
router.post('/:id/client-access', async (req, res) => {
  try {
    const accounts = await accountsStore.getAll();
    const account = accounts.find((a) => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

    let username = account.clientAuth?.username;
    if (!username) {
      const base = clientAccess.slugUser(account.name);
      username = base;
      let n = 2;
      while (accounts.some((a) => a.id !== account.id && a.clientAuth?.username === username)) username = `${base}${n++}`;
    }
    const password = clientAccess.generatePassword(account.name);
    const clientAuth = {
      username,
      passwordHash: hashPassword(password),
      v: crypto.randomBytes(4).toString('hex'),
      createdAt: account.clientAuth?.createdAt || new Date().toISOString(),
      passwordSetAt: new Date().toISOString(),
      lastLoginAt: account.clientAuth?.lastLoginAt || null,
    };
    await accountsStore.update(account.id, { clientAuth });
    res.json({ username, password });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id/client-access — bloqueia o login do cliente.
router.delete('/:id/client-access', async (req, res) => {
  try {
    const updated = await accountsStore.update(req.params.id, { clientAuth: null });
    if (!updated) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.status(204).end();
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/log — adiciona uma entrada no histórico do
// cliente (ficha 360°). Só permite acrescentar (nunca editar ou apagar uma
// entrada antiga), pra manter o histórico confiável.
router.post('/:id/log', async (req, res) => {
  const text = sanitizeString(req.body.text, 500);
  if (!text) return res.status(400).json({ error: 'Escreva algo pra registrar no histórico.' });

  try {
    const accounts = await accountsStore.getAll();
    const account = accounts.find((a) => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      text,
      author: sanitizeString(req.body.author, 40) || 'JC',
      at: new Date().toISOString(),
    };
    const activityLog = [...(account.activityLog || []), entry];
    const updated = await accountsStore.update(req.params.id, { activityLog });
    res.status(201).json(stripSecrets(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
