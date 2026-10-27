/**
 * Gerenciar status das campanhas que já existem nas contas do cliente.
 * Montado em /api/ad-status/:clientId com requireAdminAuth: login de cliente
 * recebe 403 no middleware e nunca chega aqui.
 *
 *   GET  /?platform=meta|google[&from&to][&fresh=1]  árvore campanha > conjunto > anúncio, com métricas do período
 *        fresh=1 ignora o cache (o link do vídeo da Meta expira)
 *   POST /:platform/:level/:id/status     { status: 'PAUSED'|'ACTIVE', confirm: true, parent? }
 *   GET  /log                              últimas alterações (só agência)
 *   GET  /markers?from&to                  marcas do gráfico: pausas/ativações e campanhas publicadas
 *
 * Pausar e ativar: só o admin (Jorge). Toda alteração vai para o histórico.
 */
const express = require('express');
const accountsStore = require('../data/accountsStore');
const logStore = require('../data/adStatusLogStore');
const campaignsStore = require('../data/campaignsStore');
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
    const tree = await service.getTree(account, platform, { from: req.query.from, to: req.query.to, fresh: req.query.fresh === '1' });
    const currency = tree.currency || (platform === 'meta' && account.meta && account.meta.currency) || 'BRL';
    res.json({ ...tree, canChange: req.user.role === 'admin', currency });
  } catch (err) { sendError(res, err); }
});

router.get('/log', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  res.json({ log: await logStore.list(account.id, req.query.limit) });
});

// GET /markers?from&to : marcas pro gráfico do painel (só agência). Pausas/ativações
// feitas pelo sistema (resultado ok) e campanhas publicadas pela aba Campanhas.
const spDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
router.get('/markers', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000-00-00';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31';
  const inRange = (d) => d >= from && d <= to;
  const markers = [];
  try {
    for (const e of await logStore.list(account.id, 200)) {
      if (e.result !== 'ok' || !['PAUSED', 'ACTIVE'].includes(e.requested) || !e.at) continue;
      const date = spDay(e.at);
      if (!inRange(date)) continue;
      markers.push({ kind: e.requested === 'PAUSED' ? 'pause' : 'activate', date, at: e.at, platform: e.platform, level: e.level, levelLabel: LEVEL_LABEL[e.level] || e.level, name: e.name || null, by: e.by || null, mock: !!e.mock });
    }
    const drafts = await campaignsStore.list(account.id);
    for (const d of drafts) {
      if (d.status !== 'published' || !d.publish || !d.publish.at) continue;
      const date = spDay(d.publish.at);
      if (!inRange(date)) continue;
      markers.push({ kind: 'campaign', date, at: d.publish.at, platform: d.platform, level: 'campaign', levelLabel: 'campanha', name: d.name || null, by: d.publish.by || null, mock: !!d.publish.mock });
    }
  } catch (err) { return sendError(res, err); }
  markers.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  res.json({ markers });
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
