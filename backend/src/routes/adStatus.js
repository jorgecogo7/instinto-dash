/**
 * Gerenciar status das campanhas que já existem nas contas do cliente.
 * Montado em /api/ad-status/:clientId com requireAdminAuth: login de cliente
 * recebe 403 no middleware e nunca chega aqui.
 *
 *   GET  /?platform=meta|google           árvore campanha > conjunto > anúncio
 *   POST /:platform/:level/:id/status     { status: 'PAUSED'|'ACTIVE', confirm: true, parent? }
 *   GET  /log                              últimas alterações (só agência)
 *
 * Pausar e ativar: só o admin (Jorge). Toda alteração vai para o histórico.
 */
const express = require('express');
const accountsStore = require('../data/accountsStore');
const logStore = require('../data/adStatusLogStore');
const service = require('../services/adStatusService');

const router = express.Router({ mergeParams: true });
const PLATFORMS = ['meta', 'google'];
const LEVEL_LABEL = { campaign: 'campanha', adset: 'conjunto', ad: 'anúncio' };

async function loadClient(req, res) {
  const accounts = await accountsStore.getAll();
  const account = accounts.find((a) => a.id === req.params.clientId);
  if (!account) { res.status(404).json({ error: 'Cliente não encontrado.' }); return null; }
  return account;
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('Gerenciar status:', err.message);
  res.status(status).json({ error: err.message || 'Erro ao falar com a plataforma.', ...(err.capabilities ? { capabilities: err.capabilities } : {}) });
}

router.get('/', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const platform = req.query.platform;
  if (!PLATFORMS.includes(platform)) {
    // Sem plataforma: só diz o que está disponível (sem chamar a Meta nem o Google).
    return res.json({ meta: service.capabilities(account, 'meta'), google: service.capabilities(account, 'google'), canChange: req.user.role === 'admin' });
  }
  try {
    const tree = await service.getTree(account, platform);
    res.json({ ...tree, canChange: req.user.role === 'admin', currency: (account.meta && account.meta.currency) || 'BRL' });
  } catch (err) { sendError(res, err); }
});

router.get('/log', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  res.json({ log: await logStore.list(account.id, req.query.limit) });
});

router.post('/:platform/:level/:id/status', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Só o administrador pausa ou ativa campanhas, conjuntos e anúncios.' });
  const { platform, level, id } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Plataforma deve ser "meta" ou "google".' });
  if (!service.LEVELS.includes(level)) return res.status(400).json({ error: 'Nível deve ser campaign, adset ou ad.' });
  const status = req.body && req.body.status;
  if (!['PAUSED', 'ACTIVE'].includes(status)) return res.status(400).json({ error: 'Envie status PAUSED ou ACTIVE.' });
  // Confirmação explícita: o painel só manda isso depois do "Confirmar" na janela.
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Confirme a alteração.' });
  const account = await loadClient(req, res);
  if (!account) return;
  const parent = req.body.parent ? String(req.body.parent) : undefined;
  const base = {
    at: new Date().toISOString(), by: req.user.username || 'desconhecido', role: req.user.role,
    platform, level, itemId: String(id), requested: status,
  };
  try {
    const r = await service.setStatus(account, platform, level, id, status, { parent });
    const entry = {
      ...base, name: r.after.name || r.before.name || null, oldStatus: r.before.status, newStatus: r.after.status,
      mock: r.mock, result: r.unchanged ? 'sem mudança' : 'ok',
    };
    await logStore.add(account.id, entry).catch((e) => console.error('Histórico de status não gravou:', e.message));
    res.json({ ok: true, mock: r.mock, unchanged: !!r.unchanged, item: { ...r.after, level }, log: entry });
  } catch (err) {
    if (err.status !== 400) {
      await logStore.add(account.id, { ...base, result: 'falhou', error: String(err.message).slice(0, 500) })
        .catch((e) => console.error('Histórico de status não gravou:', e.message));
    }
    console.error(`Gerenciar status: falhou ao mudar ${LEVEL_LABEL[level]} ${id}:`, err.message);
    sendError(res, err);
  }
});

module.exports = router;
