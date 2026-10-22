const express = require('express');
const crm = require('../services/crmService');
const accountsStore = require('../data/accountsStore');
const { visibilityOf } = require('../lib/clientAccess');

/**
 * Rotas do CRM de um cliente. O mesmo conjunto de rotas serve dois lugares,
 * mudando só DE ONDE vem o clientId:
 *   - admin:   /api/crm/:clientId/...  (requireAdminAuth, qualquer cliente)
 *   - cliente: /api/client/crm/...     (requireClientAuth, sempre req.client.id;
 *              o cliente não tem como escolher outro id)
 */
function buildRouter(resolve) {
  const router = express.Router({ mergeParams: true });

  router.use(async (req, res, next) => {
    try {
      const ctx = await resolve(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      req.crmClientId = ctx.clientId;
      req.crmActor = ctx.actor;
      next();
    } catch (err) { next(err); }
  });

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof crm.CrmError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Não foi possível concluir agora. Tente novamente.' });
    }
  };

  // Quadro completo: etapas + negócios.
  router.get('/', wrap(async (req, res) => res.json(await crm.getBoard(req.crmClientId))));

  router.put('/pipeline', wrap(async (req, res) => {
    res.json(await crm.saveStages(req.crmClientId, req.body && req.body.stages, req.crmActor));
  }));

  router.post('/deals', wrap(async (req, res) => {
    res.status(201).json(await crm.createDeal(req.crmClientId, req.body, req.crmActor));
  }));

  router.patch('/deals/:dealId', wrap(async (req, res) => {
    res.json(await crm.updateDeal(req.crmClientId, req.params.dealId, req.body, req.crmActor));
  }));

  router.post('/deals/:dealId/comments', wrap(async (req, res) => {
    res.status(201).json(await crm.addComment(req.crmClientId, req.params.dealId, req.body && req.body.text, req.crmActor));
  }));

  router.delete('/deals/:dealId', wrap(async (req, res) => {
    await crm.removeDeal(req.crmClientId, req.params.dealId);
    res.status(204).end();
  }));

  return router;
}

// Admin: escolhe o cliente pela URL, mas só se ele existir.
const adminRouter = buildRouter(async (req) => {
  const account = await accountsStore.getById(req.params.clientId);
  if (!account) return { status: 404, error: 'Cliente não encontrado.' };
  return { clientId: account.id, actor: { role: 'admin', name: 'Instinto Digital' } };
});

// Cliente: sempre o próprio, e só se a agência liberou o CRM pra ele.
const clientRouter = buildRouter(async (req) => {
  if (!visibilityOf(req.client).crm) return { status: 403, error: 'Esta seção não está liberada para você.' };
  return { clientId: req.client.id, actor: { role: 'client', name: req.client.clientAuth?.username || req.client.name } };
});

module.exports = { adminRouter, clientRouter };
