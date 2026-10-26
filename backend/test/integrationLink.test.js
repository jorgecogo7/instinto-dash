const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const link = require('../src/lib/integrationLink');
const { visibilityOf } = require('../src/lib/clientAccess');
const { createSessionToken } = require('../src/lib/auth');
const { requireAdminAuth } = require('../src/middleware/adminAuth');
const accountsStore = require('../src/data/accountsStore');
const accountsRoutes = require('../src/routes/accounts');
const cache = require('../src/lib/cache');

function sample() {
  return {
    id: 'otica',
    name: 'Ótica Visão',
    shareToken: 'share-do-cliente',
    clientVisibility: { social: true, ads: true },
    clientAuth: { username: 'otica', passwordHash: 'salt:secreto', v: 'ab' },
    gtm: { publicId: 'GTM-TESTE01', containerId: '9' },
    activityLog: [{ id: 'old', text: 'Nota antiga', author: 'JC', at: '2026-01-01T00:00:00.000Z' }],
    meta: {
      status: 'connected',
      adAccountId: 'act_123',
      pageId: '555',
      igBusinessId: '999',
      accountName: 'Conta Meta',
      currency: 'BRL',
      accountActive: true,
      sync: { enabled: true, lastStatus: 'ok', nextSyncAt: '2026-01-02T00:00:00.000Z' },
    },
    google: { status: 'connected', customerId: '123-456-7890', accountName: 'Conta Google' },
    instagramApi: { status: 'connected', igUserId: '999', username: 'otica', error: 'antigo' },
  };
}

test('desconectar Google só zera o Google', () => {
  const account = sample();
  const patch = link.disconnectPatch(account, 'google');
  assert.deepEqual(Object.keys(patch), ['google']);
  assert.equal(patch.google.status, 'not_connected');
  assert.equal(patch.google.customerId, null);
  assert.equal(patch.google.accountName, null);
  assert.equal(patch.meta, undefined);
  assert.equal(patch.gtm, undefined);
});

test('desconectar Meta Ads tira a conta de anúncios e mantém Página e Instagram', () => {
  const account = sample();
  const patch = link.disconnectPatch(account, 'meta');
  assert.deepEqual(Object.keys(patch), ['meta']);
  assert.equal(patch.meta.status, 'not_connected');
  assert.equal(patch.meta.adAccountId, null);
  assert.equal(patch.meta.accountName, null);
  assert.equal(patch.meta.pageId, '555');
  assert.equal(patch.meta.igBusinessId, '999');
  assert.equal(patch.meta.sync.enabled, false);
  assert.equal(patch.meta.sync.nextSyncAt, null);
  assert.equal(patch.meta.currency, null);
});

test('desconectar Instagram não mexe na conta de anúncios nem na Página', () => {
  const account = sample();
  const patch = link.disconnectPatch(account, 'instagram');
  assert.equal(patch.meta.adAccountId, 'act_123');
  assert.equal(patch.meta.pageId, '555');
  assert.equal(patch.meta.status, 'connected');
  assert.equal(patch.meta.igBusinessId, null);
  assert.equal(patch.instagramApi.unlinked, true);
  assert.equal(patch.instagramApi.igUserId, null);
  assert.equal(patch.instagramApi.username, null);
  assert.equal(patch.instagramApi.status, 'not_connected');
  assert.equal(patch.google, undefined);
  assert.equal(patch.gtm, undefined);
});

test('plataforma desconhecida não gera alteração', () => {
  assert.equal(link.disconnectPatch(sample(), 'gtm'), null);
  assert.equal(link.disconnectPatch(sample(), 'cliente'), null);
});

test('link de compartilhamento: visibilidade social continua mandando, e remover Instagram esconde a seção', () => {
  const on = sample();
  assert.equal(visibilityOf(on).social && link.hasInstagramLink(on), true);

  const hidden = sample();
  hidden.clientVisibility = { social: false };
  assert.equal(visibilityOf(hidden).social, false);
  assert.equal(link.hasInstagramLink(hidden), true);
  assert.equal(visibilityOf(hidden).social && link.hasInstagramLink(hidden), false);

  const removed = link.disconnectPatch(on, 'instagram');
  const after = { ...on, ...removed };
  assert.equal(visibilityOf(after).social, true);
  assert.equal(link.hasInstagramLink(after), false);
  assert.equal(link.instagramUnlinked(after), true);
});

test('Página sozinha continua contando como Instagram até alguém remover de propósito', () => {
  assert.equal(link.hasInstagramLink({ meta: { pageId: '555' }, instagramApi: {} }), true);
  assert.equal(link.integrationIsLinked({ instagramApi: { unlinked: true }, meta: { pageId: '555', igBusinessId: '1' } }, 'instagram'), false);
});

test('histórico da remoção não leva segredo', () => {
  const account = sample();
  for (const platform of ['google', 'meta', 'instagram']) {
    const text = link.disconnectLogText(account, platform);
    assert.equal(/salt:secreto|share-do-cliente|password|token/i.test(text), false);
    assert.match(text, /cliente/);
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, method, reqPath, { token, body } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST /api/accounts/:id/disconnect exige admin e não apaga o cliente', async () => {
  const orig = { getById: accountsStore.getById, update: accountsStore.update };
  let stored = sample();
  let updates = 0;
  accountsStore.getById = async (id) => (id === stored.id ? stored : null);
  accountsStore.update = async (id, changes) => {
    assert.equal(id, stored.id);
    updates += 1;
    stored = Object.assign({}, stored, changes);
    return stored;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/accounts', requireAdminAuth, accountsRoutes);
  let server;
  const admin = createSessionToken('jc');
  const client = createSessionToken('otica', { role: 'client', clientId: 'otica', v: 'ab' });

  try {
    server = await listen(app);
    const port = server.address().port;
    const noAuth = await request(port, 'POST', '/api/accounts/otica/disconnect', { body: { platform: 'google' } });
    assert.equal(noAuth.status, 401);
    assert.equal(updates, 0);

    const asClient = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: client, body: { platform: 'google' } });
    assert.equal(asClient.status, 403);
    assert.equal(updates, 0);
    assert.equal(stored.google.customerId, '123-456-7890');

    const bad = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: admin, body: { platform: 'gtm' } });
    assert.equal(bad.status, 400);
    assert.equal(stored.gtm.publicId, 'GTM-TESTE01');

    const missing = await request(port, 'POST', '/api/accounts/nao-existe/disconnect', { token: admin, body: { platform: 'google' } });
    assert.equal(missing.status, 404);

    cache.set('integration-health:otica', { ok: 1 }, 60);
    cache.set('integration-health:all', { ok: 1 }, 60);
    cache.set('integration-health:outro', { ok: 1 }, 60);

    const google = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: admin, body: { platform: 'google' } });
    assert.equal(google.status, 200);
    assert.equal(google.json.id, 'otica');
    assert.equal(google.json.name, 'Ótica Visão');
    assert.equal(google.json.shareToken, 'share-do-cliente');
    assert.equal(google.json.clientAuth.passwordHash, undefined);
    assert.equal(google.json.google.status, 'not_connected');
    assert.equal(google.json.google.customerId, null);
    assert.equal(google.json.meta.adAccountId, 'act_123');
    assert.equal(google.json.gtm.publicId, 'GTM-TESTE01');
    assert.equal(stored.clientAuth.passwordHash, 'salt:secreto');
    assert.equal(stored.activityLog[0].text, 'Nota antiga');
    assert.match(stored.activityLog[1].text, /Google Ads desconectado/);
    assert.equal(/salt:secreto|share-do-cliente/.test(stored.activityLog[1].text), false);
    assert.equal(cache.get('integration-health:otica'), null);
    assert.equal(cache.get('integration-health:all'), null);
    assert.deepEqual(cache.get('integration-health:outro'), { ok: 1 });

    const again = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: admin, body: { platform: 'google' } });
    assert.equal(again.status, 200);
    assert.equal(updates, 1);

    const meta = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: admin, body: { platform: 'meta' } });
    assert.equal(meta.status, 200);
    assert.equal(stored.id, 'otica');
    assert.equal(stored.name, 'Ótica Visão');
    assert.equal(stored.meta.adAccountId, null);
    assert.equal(stored.meta.pageId, '555');
    assert.equal(stored.meta.igBusinessId, '999');
    assert.equal(stored.meta.sync.enabled, false);
    assert.equal(stored.instagramApi.username, 'otica');
    assert.equal(stored.gtm.containerId, '9');
    assert.equal(stored.clientVisibility.social, true);

    const ig = await request(port, 'POST', '/api/accounts/otica/disconnect', { token: admin, body: { platform: 'instagram' } });
    assert.equal(ig.status, 200);
    assert.equal(stored.id, 'otica');
    assert.equal(stored.meta.pageId, '555');
    assert.equal(stored.meta.adAccountId, null);
    assert.equal(stored.instagramApi.unlinked, true);
    assert.equal(stored.instagramApi.igUserId, null);
    assert.equal(link.hasInstagramLink(stored), false);
    assert.equal(visibilityOf(stored).social, true);
    assert.equal(stored.shareToken, 'share-do-cliente');
    assert.equal(updates, 3);
  } finally {
    accountsStore.getById = orig.getById;
    accountsStore.update = orig.update;
    if (server) server.close();
  }
});

test('a rota de contas da agência continua atrás do login de admin', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/accounts',\s*requireAdminAuth,\s*accountsRoutes\)/);
  assert.match(server, /app\.use\('\/api\/client',\s*requireClientAuth,\s*clientRoutes\)/);
});
