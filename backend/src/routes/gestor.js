const express = require('express');
const accountsStore = require('../data/accountsStore');
const gestorStore = require('../data/gestorStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const period = require('../lib/period');
const { buildAnalysis, STATUSES } = require('../lib/gestorAnalysis');
const { requireGestorKey } = require('../middleware/gestorAuth');
const diagnostics = require('../services/gestorDiagnostics');

/**
 * "Análise do gestor": comentário interno da agência sobre cada cliente.
 * O cliente NUNCA vê isto: as rotas abaixo exigem login da agência
 * (requireAdminAuth, que devolve 403 pra login de cliente) ou a chave dos
 * gestores (só /api/gestor). Nenhuma rota de cliente, link público,
 * relatório ou PDF lê a tabela gestor_analyses.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,190}$/;

async function findClient(id) {
  if (!SLUG.test(String(id || ''))) return null;
  return accountsStore.getById(id);
}

// Período pedido. Sem from/to = últimos 30 dias completos até ontem (America/Sao_Paulo). Máx. 400 dias.
function readRange(q) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
  if (q.from || q.to) {
    if (!ok(q.from) || !ok(q.to) || q.from > q.to) return { error: 'Use from e to no formato AAAA-MM-DD, com from <= to.' };
    if (period.daysInRange({ from: q.from, to: q.to }) > 400) return { error: 'Período máximo: 400 dias.' };
    return { range: { from: q.from, to: q.to } };
  }
  return { range: period.defaultRange(30) };
}

const platformFlags = (a) => ({
  meta: a.meta?.status === 'connected',
  google: a.google?.status === 'connected',
});

// ============ Rotas da agência (login do Jorge) ============
const adminRouter = express.Router();

adminRouter.get('/:clientId', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ analyses: await gestorStore.listAnalyses(account.id, req.query.limit) });
});

// Jorge também pode escrever uma análise à mão.
adminRouter.post('/:clientId', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const { analysis, error } = buildAnalysis(req.body, { clientId: account.id, author: 'Jorge', source: 'agencia' });
  if (error) return res.status(400).json({ error });
  res.status(201).json(await gestorStore.saveAnalysis(analysis));
});

// Aprovar / descartar uma sugestão.
adminRouter.patch('/:clientId/:analysisId/suggestions/:suggestionId', async (req, res) => {
  const status = String(req.body?.status || '');
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'status deve ser pendente, aprovada ou descartada.' });
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const a = await gestorStore.getAnalysis(account.id, req.params.analysisId);
  if (!a) return res.status(404).json({ error: 'Análise não encontrada.' });
  const s = (a.suggestions || []).find((x) => x.id === req.params.suggestionId);
  if (!s) return res.status(404).json({ error: 'Sugestão não encontrada.' });
  s.status = status;
  s.decidedAt = status === 'pendente' ? null : new Date().toISOString();
  await gestorStore.saveAnalysis(a);
  res.json(a);
});

adminRouter.delete('/:clientId/:analysisId', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const ok = await gestorStore.removeAnalysis(account.id, req.params.analysisId);
  if (!ok) return res.status(404).json({ error: 'Análise não encontrada.' });
  res.json({ ok: true });
});

// ============ Chaves dos gestores (login do Jorge) ============
const keysRouter = express.Router();

keysRouter.get('/keys', async (req, res) => {
  res.json({ keys: await gestorStore.listKeys() });
});

keysRouter.post('/keys', async (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
  if (!label) return res.status(400).json({ error: 'Dê um nome pra chave (ex.: o nome do gestor).' });
  const active = (await gestorStore.listKeys()).filter((k) => !k.revokedAt);
  if (active.length >= 20) return res.status(400).json({ error: 'Limite de 20 chaves ativas. Revogue alguma antes.' });
  // A chave em texto só aparece nesta resposta. Não é logada nem guardada.
  res.set('Cache-Control', 'no-store');
  res.status(201).json(await gestorStore.createKey(label));
});

keysRouter.delete('/keys/:id', async (req, res) => {
  const rec = await gestorStore.revokeKey(String(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Chave não encontrada.' });
  res.json(rec);
});

// ============ API dos gestores (IA, por chave) ============
// Só leitura de métricas + escrita de análises. Nada de publicar, pausar ou editar.
const machineRouter = express.Router();
machineRouter.use(requireGestorKey);
machineRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

machineRouter.get('/me', (req, res) => {
  res.json({ label: req.gestorKey.label, scopes: ['ler-metricas', 'escrever-analises'] });
});

machineRouter.get('/clients', async (req, res) => {
  const all = await accountsStore.getAll();
  res.json({
    clients: all.map((a) => ({
      id: a.id, name: a.name, niche: a.niche || null, status: a.status || null, platforms: platformFlags(a),
    })),
  });
});

async function metaPerformance(account, range) {
  if (account.meta?.status !== 'connected') return { connected: false, error: 'Meta Ads não conectado para este cliente.' };
  try {
    return { connected: true, report: await metaService.getAccountReport(account.meta.adAccountId, range) };
  } catch (e) {
    return { connected: true, error: e.message };
  }
}

async function googlePerformance(account, range) {
  if (account.google?.status !== 'connected') return { connected: false, error: 'Google Ads não conectado para este cliente.' };
  try {
    return { connected: true, report: await googleService.getAccountReport(account.google.customerId, range) };
  } catch (e) {
    return { connected: true, error: e.message };
  }
}

// true = servidor sem credenciais reais (dados de demonstração, não use pra analisar).
const testMode = () => ({ meta: !metaService.hasRealCredentials(), google: !googleService.hasRealCredentials() });

// Tudo de uma vez: Meta + Google do período.
machineRouter.get('/clients/:clientId/performance', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado. Veja a lista em GET /api/gestor/clients.' });
  const { range, error } = readRange(req.query);
  if (error) return res.status(400).json({ error });
  const [meta, google] = await Promise.all([metaPerformance(account, range), googlePerformance(account, range)]);
  res.json({ client: { id: account.id, name: account.name, niche: account.niche || null }, period: range, testMode: testMode(), meta, google });
});

machineRouter.get('/clients/:clientId/meta', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const { range, error } = readRange(req.query);
  if (error) return res.status(400).json({ error });
  const out = await metaPerformance(account, range);
  if (!out.connected) return res.status(409).json({ error: out.error });
  if (out.error) return res.status(502).json({ error: out.error });
  res.json({ client: { id: account.id, name: account.name }, period: range, testMode: testMode().meta, ...out.report });
});

machineRouter.get('/clients/:clientId/google', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const { range, error } = readRange(req.query);
  if (error) return res.status(400).json({ error });
  const out = await googlePerformance(account, range);
  if (!out.connected) return res.status(409).json({ error: out.error });
  if (out.error) return res.status(502).json({ error: out.error });
  res.json({ client: { id: account.id, name: account.name }, period: range, testMode: testMode().google, ...out.report });
});

machineRouter.get('/clients/:clientId/analyses', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ analyses: await gestorStore.listAnalyses(account.id, req.query.limit || 10) });
});

machineRouter.post('/clients/:clientId/analyses', async (req, res) => {
  const account = await findClient(req.params.clientId);
  if (!account) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const { analysis, error } = buildAnalysis(req.body, { clientId: account.id, author: req.gestorKey.label, source: 'gestor-api' });
  if (error) return res.status(400).json({ error });
  analysis.keyLabel = req.gestorKey.label;
  res.status(201).json(await gestorStore.saveAnalysis(analysis));
});

// Diagnóstico (somente leitura): como cada campanha está montada + o que
// cada anúncio entregou. Serve pra explicar lead desqualificado ou pouco lead.
async function diagContext(req, res) {
  const account = await findClient(req.params.clientId);
  if (!account) { res.status(404).json({ error: 'Cliente não encontrado. Veja a lista em GET /api/gestor/clients.' }); return null; }
  const { range, error } = readRange(req.query);
  if (error) { res.status(400).json({ error }); return null; }
  return { account, range, head: { client: { id: account.id, name: account.name, niche: account.niche || null }, period: range, generatedAt: new Date().toISOString(), readOnly: true } };
}

machineRouter.get('/clients/:clientId/diagnostics', async (req, res) => {
  const ctx = await diagContext(req, res);
  if (!ctx) return;
  const [meta, google] = await Promise.all([diagnostics.metaFor(ctx.account, ctx.range), diagnostics.googleFor(ctx.account, ctx.range)]);
  res.json({ ...ctx.head, meta, google });
});

machineRouter.get('/clients/:clientId/diagnostics/meta', async (req, res) => {
  const ctx = await diagContext(req, res);
  if (!ctx) return;
  res.json({ ...ctx.head, meta: await diagnostics.metaFor(ctx.account, ctx.range) });
});

machineRouter.get('/clients/:clientId/diagnostics/google', async (req, res) => {
  const ctx = await diagContext(req, res);
  if (!ctx) return;
  res.json({ ...ctx.head, google: await diagnostics.googleFor(ctx.account, ctx.range) });
});

module.exports = { adminRouter, keysRouter, machineRouter };
