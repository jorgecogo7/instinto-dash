/**
 * Campanhas: rascunho, aprovação e publicação (sempre PAUSADA) na Meta e no Google.
 * Montado em /api/campaigns/:clientId, só para a agência (requireAdminAuth).
 * Cliente logado nunca chega aqui (403 no middleware).
 *
 * Fluxo: rascunho -> pending_approval -> publishing -> published | failed
 * Quem pode o quê:
 *   - criar, editar, pedir aprovação: qualquer sessão da agência (admin hoje;
 *     os agentes gestores de tráfego no futuro)
 *   - aprovar e publicar, pedir ajustes: só o admin
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const accountsStore = require('../data/accountsStore');
const store = require('../data/campaignsStore');
const spec = require('../lib/campaignSpec');
const publisher = require('../services/campaignPublisher');

const router = express.Router({ mergeParams: true });

const EDITABLE = ['draft', 'pending_approval', 'failed'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const who = (req) => ({ by: req.user.username || 'desconhecido', role: req.user.role || 'admin' });
const isAdmin = (req) => req.user.role === 'admin';
function logEntry(req, action, detail) {
  return { at: new Date().toISOString(), ...who(req), action, ...(detail ? { detail } : {}) };
}
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Carrega o cliente da URL; 404 se não existir. Nada de dado de outro cliente.
async function loadClient(req, res) {
  const accounts = await accountsStore.getAll();
  const account = accounts.find((a) => a.id === req.params.clientId);
  if (!account) { res.status(404).json({ error: 'Cliente não encontrado.' }); return null; }
  return account;
}
function currencyOf(account) { return (account.meta && account.meta.currency) || 'BRL'; }

function clientSummary(account) {
  const m = account.meta || {};
  const g = account.google || {};
  return {
    id: account.id,
    name: account.name,
    currency: currencyOf(account),
    meta: { status: m.status || 'not_connected', adAccountId: m.adAccountId || null, pageId: m.pageId || null, igBusinessId: m.igBusinessId || null, accountName: m.accountName || null },
    google: { status: g.status || 'not_connected', customerId: g.customerId || null },
  };
}

// GET /api/campaigns/:clientId : resumo do cliente, o que está habilitado e os rascunhos.
router.get('/', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const drafts = await store.list(account.id);
  const metaReady = publisher.readiness('meta');
  const googleReady = publisher.readiness('google');
  res.json({
    client: clientSummary(account),
    capabilities: {
      mode: config.useMockData ? 'mock' : 'real',
      canPublish: isAdmin(req),
      meta: { ready: metaReady.ok, missing: metaReady.missing, adsManagement: req.query.check === '1' ? await publisher.metaWriteCheck() : undefined, apiVersion: config.campaigns.metaApiVersion },
      google: { ready: googleReady.ok, missing: googleReady.missing, types: ['search'] },
    },
    drafts: drafts.map(listItem),
  });
});

function listItem(d) {
  return {
    id: d.id, platform: d.platform, name: d.name, status: d.status, currency: d.currency,
    budget: d.spec.budget, budgetType: d.platform === 'google' ? 'daily' : d.spec.budgetType,
    objective: d.platform === 'meta' ? d.spec.objective : 'search',
    startDate: d.spec.startDate, endDate: d.spec.endDate,
    createdAt: d.createdAt, updatedAt: d.updatedAt, createdBy: d.createdBy,
    mock: d.publish ? !!d.publish.mock : undefined,
  };
}

router.get('/drafts/:id', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const draft = await store.get(account.id, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Rascunho não encontrado.' });
  res.json({ ...draft, problems: spec.validate(draft.platform, draft.spec, { account }) });
});

// POST /drafts {platform, name, spec}
router.post('/drafts', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const platform = req.body.platform;
  if (!['meta', 'google'].includes(platform)) return res.status(400).json({ error: 'Plataforma deve ser "meta" ou "google".' });
  const name = clean(req.body.name, 200);
  if (!name) return res.status(400).json({ error: 'Dê um nome para a campanha.' });
  const now = new Date().toISOString();
  const draft = {
    id: crypto.randomUUID(),
    platform,
    name,
    notes: clean(req.body.notes, 2000),
    status: 'draft',
    currency: currencyOf(account),
    spec: spec.sanitize(platform, req.body.spec || {}),
    createdAt: now,
    updatedAt: now,
    createdBy: who(req),
    log: [logEntry(req, 'criou')],
  };
  await store.add(account.id, draft);
  res.status(201).json({ ...draft, problems: spec.validate(platform, draft.spec, { account }) });
});

// PATCH /drafts/:id {name?, notes?, spec?}
router.patch('/drafts/:id', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const draft = await store.get(account.id, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Rascunho não encontrado.' });
  if (!EDITABLE.includes(draft.status)) return res.status(409).json({ error: 'Campanha já publicada (ou publicando) não pode ser editada aqui.' });
  const prev = draft.status;
  if (req.body.name !== undefined) {
    const name = clean(req.body.name, 200);
    if (!name) return res.status(400).json({ error: 'Dê um nome para a campanha.' });
    draft.name = name;
  }
  if (req.body.notes !== undefined) draft.notes = clean(req.body.notes, 2000);
  if (req.body.spec !== undefined) draft.spec = spec.sanitize(draft.platform, req.body.spec || {});
  draft.updatedAt = new Date().toISOString();
  // Mexeu depois de pedir aprovação: volta pra rascunho, a aprovação tem que ver a versão final.
  draft.status = 'draft';
  draft.log.push(logEntry(req, 'editou', prev === 'pending_approval' ? 'voltou para rascunho (precisa de nova aprovação)' : undefined));
  const saved = await store.save(account.id, draft, [prev]);
  if (!saved) return res.status(409).json({ error: 'O rascunho mudou enquanto você editava. Recarregue.' });
  res.json({ ...saved, problems: spec.validate(saved.platform, saved.spec, { account }) });
});

router.delete('/drafts/:id', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const removed = await store.remove(account.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Rascunho não encontrado (ou já publicado, que não se apaga daqui).' });
  res.status(204).end();
});

// POST /drafts/:id/request-approval : checagem completa e fila de aprovação.
router.post('/drafts/:id/request-approval', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const draft = await store.get(account.id, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Rascunho não encontrado.' });
  if (!['draft', 'failed'].includes(draft.status)) return res.status(409).json({ error: `Status atual não permite pedir aprovação (${draft.status}).` });
  const problems = spec.validate(draft.platform, draft.spec, { account });
  if (draft.platform === 'meta' && draft.spec.creative.assetId && !(await store.getAsset(account.id, draft.spec.creative.assetId))) {
    problems.push('A imagem do anúncio não foi encontrada. Envie de novo.');
  }
  if (problems.length) return res.status(422).json({ error: 'O rascunho ainda tem pendências.', problems });
  const prev = draft.status;
  draft.status = 'pending_approval';
  draft.updatedAt = new Date().toISOString();
  draft.approvalRequest = { at: draft.updatedAt, ...who(req), note: clean(req.body.note, 1000) };
  draft.log.push(logEntry(req, 'pediu aprovação', draft.approvalRequest.note || undefined));
  const saved = await store.save(account.id, draft, [prev]);
  if (!saved) return res.status(409).json({ error: 'O rascunho mudou no meio do caminho. Recarregue.' });
  res.json(saved);
});

// POST /drafts/:id/reject {note} : só admin. Volta pra rascunho com o pedido de ajuste.
router.post('/drafts/:id/reject', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Só o administrador aprova ou devolve campanhas.' });
  const account = await loadClient(req, res);
  if (!account) return;
  const draft = await store.get(account.id, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Rascunho não encontrado.' });
  if (draft.status !== 'pending_approval') return res.status(409).json({ error: 'Só dá pra devolver campanha que está aguardando aprovação.' });
  draft.status = 'draft';
  draft.updatedAt = new Date().toISOString();
  draft.log.push(logEntry(req, 'pediu ajustes', clean(req.body.note, 1000) || undefined));
  const saved = await store.save(account.id, draft, ['pending_approval']);
  if (!saved) return res.status(409).json({ error: 'O rascunho mudou no meio do caminho. Recarregue.' });
  res.json(saved);
});

// POST /drafts/:id/publish : só admin, só depois de pedida a aprovação. Cria tudo PAUSADO.
router.post('/drafts/:id/publish', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Só o administrador aprova e publica campanhas.' });
  const account = await loadClient(req, res);
  if (!account) return;
  const draft = await store.get(account.id, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Rascunho não encontrado.' });
  if (draft.status !== 'pending_approval') {
    return res.status(409).json({ error: draft.status === 'published' ? 'Essa campanha já foi publicada.' : 'Envie para aprovação antes de publicar.' });
  }
  // Rechecagem com os dados atuais do cliente (as integrações podem ter mudado).
  const problems = spec.validate(draft.platform, draft.spec, { account });
  if (problems.length) return res.status(422).json({ error: 'O rascunho tem pendências.', problems });
  const ready = publisher.readiness(draft.platform);
  if (!ready.ok) return res.status(409).json({ error: `Publicação real desligada. Falta configurar: ${ready.missing.join(', ')}.`, missing: ready.missing });

  const image = draft.platform === 'meta' ? await store.getAsset(account.id, draft.spec.creative.assetId) : null;
  if (draft.platform === 'meta' && !image) return res.status(422).json({ error: 'A imagem do anúncio não foi encontrada. Envie de novo.' });

  // Trava: só uma publicação por rascunho, mesmo com dois cliques simultâneos.
  const approvedAt = new Date().toISOString();
  draft.status = 'publishing';
  draft.approval = { at: approvedAt, ...who(req) };
  draft.log.push(logEntry(req, 'aprovou e mandou publicar (pausada)'));
  const locked = await store.save(account.id, draft, ['pending_approval']);
  if (!locked) return res.status(409).json({ error: 'Essa campanha já está sendo publicada.' });

  try {
    const result = await publisher.publish(draft, account, { image });
    draft.status = 'published';
    draft.publish = { at: new Date().toISOString(), ...who(req), mock: result.mock, ids: result.ids, warnings: result.warnings || [], requests: result.requests };
    draft.log.push(logEntry(req, result.mock ? 'publicou (simulação, nada enviado)' : 'publicou PAUSADA', Object.entries(result.ids).map(([k, v]) => `${k}: ${v}`).join(', ')));
  } catch (err) {
    console.error('Publicação de campanha falhou:', err.message);
    draft.status = 'failed';
    draft.publish = { at: new Date().toISOString(), ...who(req), error: err.message, partialIds: err.partial || {} };
    const partial = Object.entries(err.partial || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    draft.log.push(logEntry(req, 'falhou ao publicar', partial ? `${err.message} | criado (pausado): ${partial}` : err.message));
  }
  draft.updatedAt = new Date().toISOString();
  await store.save(account.id, draft, ['publishing']);
  res.status(draft.status === 'published' ? 200 : 502).json(draft);
});

// POST /assets {dataUrl, name} : imagem do criativo (JPG ou PNG, até 5 MB).
router.post('/assets', async (req, res) => {
  const account = await loadClient(req, res);
  if (!account) return;
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(req.body.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Envie uma imagem JPG ou PNG.' });
  const data = Buffer.from(m[2], 'base64');
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  if (!(isJpeg || isPng)) return res.status(400).json({ error: 'O arquivo não parece ser uma imagem JPG ou PNG.' });
  if (data.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Imagem acima de 5 MB.' });
  const asset = await store.addAsset(account.id, { id: crypto.randomUUID(), mime: isPng ? 'image/png' : 'image/jpeg', name: clean(req.body.name, 200), data });
  res.status(201).json(asset);
});

router.get('/assets/:assetId', async (req, res) => {
  const asset = await store.getAsset(req.params.clientId, req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'Imagem não encontrada.' });
  res.setHeader('Content-Type', asset.mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(asset.data);
});


module.exports = router;
