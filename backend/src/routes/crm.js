const express = require('express');
const crm = require('../services/crmService');
const wa = require('../services/whatsappService');
const accountsStore = require('../data/accountsStore');
const { visibilityOf } = require('../lib/clientAccess');

/**
 * Rotas do CRM de um cliente. O mesmo conjunto de rotas serve dois lugares,
 * mudando só DE ONDE vem o clientId:
 *   - admin:   /api/crm/:clientId/...  (requireAdminAuth, qualquer cliente)
 *   - cliente: /api/client/crm/...     (requireClientAuth, sempre req.client.id;
 *              o cliente não tem como escolher outro id)
 * Toda função do serviço recebe esse clientId e só lê/grava dados dele.
 */
function buildRouter(resolve, { admin }) {
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
  const cid = (req) => req.crmClientId;
  const role = admin ? 'admin' : 'client';

  /* ---- Funil de vendas ---- */
  router.get('/', wrap(async (req, res) => {
    const board = await crm.getBoard(cid(req));
    const settings = await crm.getSettings(cid(req));
    res.json({ ...board, me: req.crmActor.name, role, whatsapp: crm.whatsappView(settings, role), mock: wa.isMock() });
  }));

  router.put('/pipeline', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await crm.saveStages(cid(req), b.stages, req.crmActor, b.funnelId, b.funnelName));
  }));
  router.post('/funnels', wrap(async (req, res) => res.status(201).json(await crm.createFunnel(cid(req), req.body))));
  router.delete('/funnels/:funnelId', wrap(async (req, res) => {
    await crm.deleteFunnel(cid(req), req.params.funnelId);
    res.status(204).end();
  }));

  router.post('/deals', wrap(async (req, res) => {
    res.status(201).json(await crm.createDeal(cid(req), req.body, req.crmActor));
  }));
  router.patch('/deals/:dealId', wrap(async (req, res) => {
    res.json(await crm.updateDeal(cid(req), req.params.dealId, req.body, req.crmActor));
  }));
  router.post('/deals/:dealId/comments', wrap(async (req, res) => {
    res.status(201).json(await crm.addComment(cid(req), req.params.dealId, req.body && req.body.text, req.crmActor));
  }));
  router.delete('/deals/:dealId', wrap(async (req, res) => {
    await crm.removeDeal(cid(req), req.params.dealId);
    res.status(204).end();
  }));

  /* ---- Contatos ---- */
  router.get('/contacts', wrap(async (req, res) => res.json({ contacts: await crm.listContacts(cid(req)) })));
  router.post('/contacts', wrap(async (req, res) => res.status(201).json(await crm.createContact(cid(req), req.body))));
  router.post('/contacts/import', wrap(async (req, res) => {
    res.json(await crm.importContacts(cid(req), req.body && req.body.rows));
  }));
  router.patch('/contacts/:contactId', wrap(async (req, res) => res.json(await crm.updateContact(cid(req), req.params.contactId, req.body))));
  router.delete('/contacts/:contactId', wrap(async (req, res) => {
    await crm.deleteContact(cid(req), req.params.contactId);
    res.status(204).end();
  }));

  /* ---- Etiquetas ---- */
  router.get('/tags', wrap(async (req, res) => res.json({ tags: await crm.listTags(cid(req)) })));
  router.post('/tags', wrap(async (req, res) => res.status(201).json(await crm.createTag(cid(req), req.body))));
  router.patch('/tags/:tagId', wrap(async (req, res) => res.json(await crm.updateTag(cid(req), req.params.tagId, req.body))));
  router.delete('/tags/:tagId', wrap(async (req, res) => {
    await crm.deleteTag(cid(req), req.params.tagId);
    res.status(204).end();
  }));

  /* ---- Relatórios ---- */
  router.get('/reports', wrap(async (req, res) => res.json(await crm.report(cid(req), req.query || {}))));

  /* ---- Conversas (WhatsApp) ---- */
  router.get('/conversations', wrap(async (req, res) => {
    const settings = await crm.getSettings(cid(req));
    res.json({ conversations: await wa.listConversations(cid(req)), me: req.crmActor.name, whatsapp: crm.whatsappView(settings, role), mock: wa.isMock() });
  }));
  router.post('/conversations', wrap(async (req, res) => {
    res.status(201).json(await wa.openForContact(cid(req), req.body && req.body.contactId));
  }));
  router.get('/conversations/:convId', wrap(async (req, res) => {
    res.json(await wa.getConversation(cid(req), req.params.convId, { markRead: req.query.read === '1' }));
  }));
  router.patch('/conversations/:convId', wrap(async (req, res) => {
    res.json(await wa.updateConversation(cid(req), req.params.convId, req.body));
  }));
  router.post('/conversations/:convId/messages', wrap(async (req, res) => {
    res.status(201).json(await wa.sendMessage(cid(req), req.params.convId, req.body && req.body.text, req.crmActor));
  }));

  if (admin) {
    // Só a agência liga o número (os IDs da conta da Meta são internos).
    router.put('/whatsapp', wrap(async (req, res) => res.json(await crm.saveWhatsappConfig(cid(req), req.body))));
    // Modo de teste: simula uma mensagem chegando, pelo mesmo caminho do webhook.
    router.post('/whatsapp/simulate', wrap(async (req, res) => {
      if (!wa.isMock()) return res.status(404).json({ error: 'Disponível só em modo de teste.' });
      const b = req.body || {};
      const r = await wa.receiveInbound(cid(req), { from: b.from, profileName: b.name, text: b.text || 'Olá!', type: 'text', waId: null });
      if (!r) return res.status(400).json({ error: 'Informe o telefone.' });
      res.status(201).json({ conversationId: r.conversation.id, contactId: r.contact.id, dealId: r.deal.id });
    }));
  }

  return router;
}

// Admin: escolhe o cliente pela URL, mas só se ele existir.
const adminRouter = buildRouter(async (req) => {
  const account = await accountsStore.getById(req.params.clientId);
  if (!account) return { status: 404, error: 'Cliente não encontrado.' };
  return { clientId: account.id, actor: { role: 'admin', name: 'Instinto Digital' } };
}, { admin: true });

// Cliente: sempre o próprio, e só se a agência liberou o CRM pra ele.
const clientRouter = buildRouter(async (req) => {
  if (!visibilityOf(req.client).crm) return { status: 403, error: 'Esta seção não está liberada para você.' };
  return { clientId: req.client.id, actor: { role: 'client', name: req.client.clientAuth?.username || req.client.name } };
}, { admin: false });

module.exports = { adminRouter, clientRouter };
