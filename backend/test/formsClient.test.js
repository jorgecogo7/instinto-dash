const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const express = require('express');

const formsStore = require('../src/data/formsStore');
const accountsStore = require('../src/data/accountsStore');
const formsRoutes = require('../src/routes/forms');
const { createSessionToken } = require('../src/lib/auth');
const { requireAdminAuth } = require('../src/middleware/adminAuth');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada no painel`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`função ${name} sem fechamento`);
}

function loadPanelChoices() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const names = ['fmBuildCreateOptions', 'fmClientIdFromChoice', 'fmCreateHintText'];
  const script = names.map((name) => extractFunction(html, name)).join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

const panel = loadPanelChoices();
const accounts = [
  { id: 'otica', name: 'Ótica Visão' },
  { id: 'padaria', name: 'Padaria do Bairro' },
];

test('seletor lista os clientes e só pré-marca o cliente aberto', () => {
  const agency = panel.fmBuildCreateOptions(accounts, 'agency');
  assert.equal(agency.preset, '');
  assert.equal(agency.options[0].selected, true);
  assert.equal(agency.options[0].disabled, true);
  assert.equal(agency.options[1].value, '__agency__');
  assert.equal(agency.options[1].selected, false);
  assert.deepEqual(agency.options.slice(2).map((o) => o.value), ['otica', 'padaria']);
  assert.equal(agency.options.every((o) => o.value === '' || o.selected === false || o.value !== ''), true);

  const inside = panel.fmBuildCreateOptions(accounts, 'padaria');
  assert.equal(inside.preset, 'padaria');
  assert.equal(inside.options.find((o) => o.value === 'padaria').selected, true);
  assert.equal(inside.options.filter((o) => o.selected).length, 1);
  assert.equal(inside.options[0].selected, false);

  const missing = panel.fmBuildCreateOptions(accounts, 'sumiu');
  assert.equal(missing.preset, '');
  assert.equal(missing.options[0].selected, true);
});

test('a escolha vira o clientId gravado, e a agência fica sem cliente', () => {
  assert.equal(panel.fmClientIdFromChoice(''), null);
  assert.equal(panel.fmClientIdFromChoice('__agency__'), null);
  assert.equal(panel.fmClientIdFromChoice('otica'), 'otica');
});

test('o texto explica a troca quando o cliente não é o da tela', () => {
  const names = { otica: 'Ótica Visão', padaria: 'Padaria do Bairro' };
  assert.match(panel.fmCreateHintText('', { workspace: 'agency', names }), /Escolha para qual cliente/);
  assert.match(panel.fmCreateHintText('__agency__', { workspace: 'agency', names }), /funil da agência/);
  assert.match(panel.fmCreateHintText('otica', { workspace: 'agency', names }), /Ótica Visão/);
  assert.match(panel.fmCreateHintText('padaria', { workspace: 'otica', names }), /não aparece/);
  assert.match(panel.fmCreateHintText('otica', { workspace: 'otica', names }), /CRM de Ótica Visão/);
});

test('o painel abre o seletor antes de criar o formulário', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.match(html, /id="fmCreateModal"/);
  assert.match(html, /id="fmCreateClient"/);
  assert.match(html, /onclick="fmCreate\(\)"/);
  const create = extractFunction(html, 'fmCreate');
  assert.match(create, /fmBuildCreateOptions/);
  assert.doesNotMatch(create, /fmApi\(/);
  assert.match(extractFunction(html, 'fmSubmitCreate'), /fmClientIdFromChoice/);
  assert.doesNotMatch(html, /clientId: \(typeof WS/);
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
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

test('POST e PUT gravam o cliente escolhido e recusam cliente inexistente', async () => {
  const orig = {
    getBySlug: formsStore.getBySlug,
    add: formsStore.add,
    getById: formsStore.getById,
    save: formsStore.save,
    accountGetById: accountsStore.getById,
  };
  const stored = new Map();
  const accounts = new Set(['otica', 'padaria']);
  let lookups = 0;
  formsStore.getBySlug = async () => null;
  formsStore.add = async (form) => { stored.set(form.id, form); return form; };
  formsStore.getById = async (id) => stored.get(id) || null;
  formsStore.save = async (form) => { stored.set(form.id, form); return form; };
  accountsStore.getById = async (id) => { lookups += 1; return accounts.has(id) ? { id, name: id } : null; };

  const app = express();
  app.use(express.json());
  app.use('/api/forms', requireAdminAuth, formsRoutes);
  const admin = createSessionToken('jc');
  const client = createSessionToken('otica', { role: 'client', clientId: 'otica', v: 'ab' });
  let server;
  try {
    server = await listen(app);
    const port = server.address().port;

    const noAuth = await request(port, 'POST', '/api/forms', { body: { name: 'Sem login', clientId: 'otica' } });
    assert.equal(noAuth.status, 401);
    assert.equal(stored.size, 0);

    const asClient = await request(port, 'POST', '/api/forms', { token: client, body: { name: 'Cliente', clientId: 'otica' } });
    assert.equal(asClient.status, 403);

    lookups = 0;
    const agency = await request(port, 'POST', '/api/forms', { token: admin, body: { name: 'Captação da agência', clientId: null } });
    assert.equal(agency.status, 201);
    assert.equal(agency.json.clientId, null);
    assert.equal(lookups, 0);

    const created = await request(port, 'POST', '/api/forms', { token: admin, body: { name: 'Captação Ótica', clientId: 'otica' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.clientId, 'otica');
    assert.equal(created.json.name, 'Captação Ótica');
    assert.equal(stored.get(created.json.id).clientId, 'otica');

    const before = stored.size;
    const missing = await request(port, 'POST', '/api/forms', { token: admin, body: { name: 'Fantasma', clientId: 'nao-existe' } });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /Cliente não encontrado/);
    assert.equal(stored.size, before);

    const moved = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { ...created.json, clientId: 'padaria' },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.clientId, 'padaria');
    assert.equal(stored.get(created.json.id).clientId, 'padaria');

    const badMove = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { ...created.json, clientId: 'sumiu' },
    });
    assert.equal(badMove.status, 400);
    assert.equal(stored.get(created.json.id).clientId, 'padaria');

    stored.set('antigo', { ...created.json, id: 'antigo', slug: 'antigo', clientId: 'sumiu', fields: [] });
    lookups = 0;
    const keep = await request(port, 'PUT', '/api/forms/antigo', {
      token: admin,
      body: { name: 'Antigo', clientId: 'sumiu', status: 'draft', fields: [] },
    });
    assert.equal(keep.status, 200);
    assert.equal(keep.json.clientId, 'sumiu');
    assert.equal(lookups, 0);

    const toAgency = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { name: 'Captação Ótica', clientId: '' },
    });
    assert.equal(toAgency.status, 200);
    assert.equal(toAgency.json.clientId, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    formsStore.getBySlug = orig.getBySlug;
    formsStore.add = orig.add;
    formsStore.getById = orig.getById;
    formsStore.save = orig.save;
    accountsStore.getById = orig.accountGetById;
  }
});
