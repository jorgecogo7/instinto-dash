const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const http = require('node:http');
const express = require('express');

const formService = require('../src/services/formService');
const sheets = require('../src/services/sheetsService');
const formsStore = require('../src/data/formsStore');
const publicRoutes = require('../src/routes/public');
const formsRoutes = require('../src/routes/forms');
const sheetsOauth = require('../src/routes/sheetsOauth');
const { createSessionToken } = require('../src/lib/auth');
const { requireAdminAuth } = require('../src/middleware/adminAuth');

const {
  spreadsheetTitle, planColumns, rowFor, formatDateTime, qualificationCell, sheetCell, createService,
} = sheets;

function memoryStore(initial) {
  const forms = new Map();
  const responses = [];
  if (initial) forms.set(initial.id, initial);
  return {
    forms,
    responses,
    async getById(id) { return forms.get(id) || null; },
    async save(form) { forms.set(form.id, form); return form; },
    async getResponses(formId, limit, opts) {
      const list = responses.filter((r) => r.formId === formId);
      list.sort((a, b) => opts && opts.order === 'asc'
        ? String(a.createdAt).localeCompare(String(b.createdAt))
        : String(b.createdAt).localeCompare(String(a.createdAt)));
      return list.slice(0, limit || list.length);
    },
    async updateResponse(formId, response) {
      const i = responses.findIndex((r) => r.id === response.id && r.formId === formId);
      if (i < 0) return false;
      responses[i] = response;
      return true;
    },
  };
}

function formWith(fields) {
  const form = formService.normalizeForm({
    name: 'Captação',
    status: 'published',
    clientId: 'otica',
    fields,
  }, { id: 'form1', slug: 'captacao', createdAt: '2026-11-01T12:00:00.000Z' });
  form.slug = 'captacao';
  return form;
}

const q = (id, label, type = 'short_text') => ({ id, type, label, required: false });

test('título da planilha usa cliente, nome e o sufixo de respostas', () => {
  assert.equal(spreadsheetTitle('Ótica Visão', 'Captação'), 'Ótica Visão — Captação (respostas)');
  assert.equal(spreadsheetTitle('', ''), 'Instinto Digital — Formulário (respostas)');
  assert.equal(spreadsheetTitle('A\nB', 'C\tD'), 'A B — C D (respostas)');
});

test('cabeçalho inicial e linha seguem o pedido, no horário de Brasília', () => {
  const form = formWith([q('n', 'Qual é o seu nome?'), q('w', 'WhatsApp', 'phone'), q('info', 'Leia isto', 'statement')]);
  const plan = planColumns([], form);
  assert.deepEqual(plan.headers, [
    'Data/hora', 'Qual é o seu nome?', 'WhatsApp', 'Qualificado/Desqualificado',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'Página de origem',
  ]);
  assert.equal(formatDateTime('2026-11-06T21:40:00.000Z'), '06/11/2026 18:40:00');
  const row = rowFor(plan.columns, form, {
    createdAt: '2026-11-06T21:40:00.000Z',
    readable: [{ fieldId: 'n', answer: 'Ana' }, { fieldId: 'w', answer: '=5511' }],
    result: { usesQualification: true, qualified: false, score: 0 },
    meta: { utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'maio', utm_content: '', utm_term: 'oticas', url: 'https://loja.example/f', referrer: 'https://instagram.com' },
  });
  assert.equal(row[0], '06/11/2026 18:40:00');
  assert.equal(row[1], 'Ana');
  assert.equal(row[2], "'=5511");
  assert.equal(row[3], 'Desqualificado');
  assert.equal(row[4], 'meta');
  assert.equal(row[8], 'oticas');
  assert.equal(row[9], 'https://loja.example/f');
  assert.equal(qualificationCell({ usesQualification: true, qualified: true }), 'Qualificado');
  assert.equal(qualificationCell({ usesQualification: false, qualified: true }), '');
  assert.equal(sheetCell('+55 11'), "'+55 11");
});

test('pergunta nova entra no fim e pergunta removida não muda as colunas já gravadas', () => {
  const first = formWith([q('a', 'Nome'), q('b', 'Empresa')]);
  const created = planColumns([], first);
  const renamed = formWith([q('a', 'Seu nome'), q('c', 'Cidade')]);
  const next = planColumns(created.columns, renamed);
  assert.deepEqual(next.columns.map((c) => c.key), [
    'createdAt', 'q:a', 'q:b', 'qualified', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'page', 'q:c',
  ]);
  assert.equal(next.columns[1].header, 'Seu nome');
  assert.equal(next.columns[2].header, 'Empresa');
  assert.equal(next.columns[next.columns.length - 1].header, 'Cidade');
  assert.equal(next.added.includes('q:c'), true);
  assert.equal(next.added.includes('q:a'), false);

  const dup = formWith([q('a', 'Cidade'), q('b', 'Cidade')]);
  const headers = planColumns([], dup).headers;
  assert.equal(headers[1], 'Cidade');
  assert.equal(headers[2], 'Cidade (2)');
});

test('o salvamento do editor não troca nem apaga a planilha', () => {
  const existing = {
    id: '1', slug: 'a', createdAt: '2026-01-01T00:00:00.000Z',
    sheets: {
      enabled: false,
      spreadsheetId: 'planilha-real',
      url: 'https://docs.google.com/spreadsheets/d/planilha-real/edit',
      title: 'Ótica — Captação (respostas)',
      columns: [{ key: 'createdAt', header: 'Data/hora' }],
      shares: [{ email: 'cliente@gmail.com', role: 'reader', sharedAt: '2026-01-02T00:00:00.000Z' }],
      lastError: null,
    },
  };
  const out = formService.normalizeForm({
    name: 'Novo nome',
    sheets: { spreadsheetId: 'evil', url: 'https://evil.example/x', enabled: true },
  }, existing);
  assert.equal(out.sheets.spreadsheetId, 'planilha-real');
  assert.equal(out.sheets.url, 'https://docs.google.com/spreadsheets/d/planilha-real/edit');
  assert.equal(out.sheets.enabled, false);
  assert.equal(out.sheets.shares[0].email, 'cliente@gmail.com');
  assert.equal(out.name, 'Novo nome');

  const fresh = formService.normalizeForm({ name: 'Sem planilha', sheets: { spreadsheetId: 'evil' } }, { id: '2', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(fresh.sheets, undefined);
});

function jsonResponse(status, obj) {
  const text = JSON.stringify(obj);
  return { status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => text };
}

function googleFetch(handler) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    let body = null;
    if (opts && opts.body && String(opts.body).startsWith('{')) body = JSON.parse(String(opts.body));
    const call = { url: String(url), method: opts && opts.method, body };
    calls.push(call);
    if (call.url.includes('oauth2.googleapis.com/token')) {
      return jsonResponse(200, {
        access_token: 'ya29.teste',
        scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      });
    }
    if (handler) {
      const custom = await handler(call, calls);
      if (custom) return custom;
    }
    if (call.url === 'https://sheets.googleapis.com/v4/spreadsheets' && call.method === 'POST') {
      return jsonResponse(200, { spreadsheetId: 'abc123', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit' });
    }
    if (call.url.includes(':append')) return jsonResponse(200, { updates: { updatedRows: (call.body.values || []).length } });
    if (call.url.includes('/values/')) return jsonResponse(200, {});
    if (call.url.includes('/permissions') && call.method === 'GET') return jsonResponse(200, { permissions: [] });
    if (call.url.includes('/permissions')) return jsonResponse(200, { id: 'perm1' });
    return jsonResponse(500, { error: { message: 'url inesperada' } });
  };
  return { fetch, calls };
}

function realConfig(over = {}) {
  return {
    useMockData: false,
    sheets: { refreshToken: 'rtok', redirectUri: 'https://api.instintodigital.com.br/api/sheets-oauth/callback', agencyEmail: 'jorgelcogo@gmail.com', ...(over.sheets || {}) },
    gtm: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', ...(over.gtm || {}) },
    google: over.google || {},
  };
}

test('criar, acrescentar coluna, gravar linha, compartilhar e reenviar antigas', async () => {
  const form = formWith([q('n', 'Nome')]);
  const store = memoryStore(form);
  const { fetch, calls } = googleFetch();
  const svc = createService(realConfig(), {
    fetch, formsStore: store, accountsStore: { async getById() { return { id: 'otica', name: 'Ótica Visão' }; } },
    cacheKey: 'sheets:test:flow', retryDelay: () => 0,
  });
  const created = await svc.provision(form.id);
  assert.equal(created.configured, true);
  assert.equal(created.form.sheets.spreadsheetId, 'abc123');
  assert.match(created.form.sheets.url, /docs\.google\.com\/spreadsheets\/d\/abc123/);
  assert.equal(created.form.sheets.title, 'Ótica Visão — Captação (respostas)');
  const createCall = calls.find((c) => c.url.endsWith('/v4/spreadsheets') && c.method === 'POST');
  assert.equal(createCall.body.properties.timeZone, 'America/Sao_Paulo');
  assert.equal(createCall.body.properties.locale, 'pt_BR');
  assert.equal(createCall.body.sheets[0].properties.title, 'Respostas');
  assert.deepEqual(createCall.body.sheets[0].data[0].rowData[0].values.map((v) => v.userEnteredValue.stringValue), created.form.sheets.columns.map((c) => c.header));

  const before = calls.length;
  await svc.provision(form.id);
  assert.equal(calls.length, before, 'cabeçalho igual não regrava a planilha');

  form.fields.push(q('e', 'E-mail', 'email'));
  await svc.provision(form.id);
  const headerPut = calls.filter((c) => c.method === 'PUT' && c.url.includes('/values/'));
  assert.equal(headerPut.length, 1);
  assert.equal(headerPut[0].body.values[0][headerPut[0].body.values[0].length - 1], 'E-mail');
  assert.equal(headerPut[0].body.values[0][1], 'Nome');

  const response = {
    id: 'r1', formId: form.id, createdAt: '2026-11-06T21:40:00.000Z',
    readable: [{ fieldId: 'n', answer: 'Ana' }, { fieldId: 'e', answer: 'ana@exemplo.com' }],
    result: { usesQualification: true, qualified: true },
    meta: { utm_source: 'google', url: 'https://dash.instintodigital.com.br/f/captacao' },
  };
  store.responses.push(response);
  const old = {
    id: 'r0', formId: form.id, createdAt: '2026-11-01T10:00:00.000Z', sheetsSyncedAt: '2026-11-01T10:00:01.000Z',
    readable: [{ fieldId: 'n', answer: 'Já foi' }], result: {}, meta: {},
  };
  store.responses.unshift(old);
  svc.scheduleAppend(form.id, response);
  assert.equal(svc.scheduleAppend(form.id, response), undefined);
  for (let i = 0; i < 30 && !response.sheetsSyncedAt; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(response.sheetsSyncedAt);
  const append = calls.filter((c) => c.url.includes(':append')).pop();
  assert.equal(append.body.values.length, 1);
  assert.equal(append.body.values[0][1], 'Ana');
  assert.equal(append.body.values[0][append.body.values[0].length - 1], 'ana@exemplo.com');
  assert.equal(append.body.values[0].includes('Qualificado'), true);

  const shared = await svc.share(form.id, 'Cliente@Gmail.com', 'viewer');
  assert.deepEqual(shared.sheets.shares.map((s) => ({ email: s.email, role: s.role })), [{ email: 'cliente@gmail.com', role: 'reader' }]);
  const perm = calls.find((c) => c.method === 'POST' && c.url.includes('/permissions'));
  assert.equal(perm.body.role, 'reader');
  assert.equal(perm.body.emailAddress, 'cliente@gmail.com');
  assert.match(perm.url, /sendNotificationEmail=true/);

  response.sheetsSyncedAt = undefined;
  const back = await svc.backfill(form.id);
  assert.equal(back.sent, 1);
  assert.equal(back.skipped, 1);
  assert.equal(back.failed, 0);
  assert.ok(response.sheetsSyncedAt);
});

test('falha ao gravar tenta de novo e não derruba quem chama', async () => {
  const form = formWith([q('n', 'Nome')]);
  form.sheets = {
    enabled: true, spreadsheetId: 'abc123', url: 'https://docs.google.com/spreadsheets/d/abc123/edit',
    title: 't', columns: planColumns([], form).columns, shares: [], lastError: null,
  };
  const store = memoryStore(form);
  let appends = 0;
  const { fetch } = googleFetch(async (call) => {
    if (call.url.includes(':append')) {
      appends += 1;
      if (appends < 3) return jsonResponse(500, { error: { message: 'backend error' } });
      return jsonResponse(200, {});
    }
    return null;
  });
  const svc = createService(realConfig(), {
    fetch, formsStore: store, cacheKey: 'sheets:test:retry', retryDelay: () => 0,
    accountsStore: { async getById() { return null; } },
  });
  const response = { id: 'r2', formId: form.id, createdAt: '2026-11-06T21:40:00.000Z', readable: [], result: {}, meta: {} };
  store.responses.push(response);
  svc.scheduleAppend(form.id, response);
  for (let i = 0; i < 30 && !response.sheetsSyncedAt; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(appends, 3);
  assert.ok(response.sheetsSyncedAt);

  appends = 0;
  const broken = { id: 'r3', formId: form.id, createdAt: '2026-11-06T22:00:00.000Z', readable: [], result: {}, meta: {} };
  store.responses.push(broken);
  const { fetch: failFetch } = googleFetch(async (call) => {
    if (call.url.includes(':append')) return jsonResponse(500, { error: { message: 'ainda fora' } });
    return null;
  });
  const svc2 = createService(realConfig(), {
    fetch: failFetch, formsStore: store, cacheKey: 'sheets:test:fail', retryDelay: () => 0,
    accountsStore: { async getById() { return null; } },
  });
  const logged = [];
  const orig = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    svc2.scheduleAppend(form.id, broken);
    for (let i = 0; i < 30 && !form.sheets.lastError; i++) await new Promise((r) => setTimeout(r, 10));
  } finally { console.error = orig; }
  assert.equal(broken.sheetsSyncedAt, undefined);
  assert.match(form.sheets.lastError, /não respondeu|Google/);
  assert.equal(logged.some((l) => l.includes('não gravei a resposta')), true);
  assert.equal(logged.some((l) => /ya29|rtok|refresh/.test(l)), false);
});

test('sem token não chama o Google e o modo de teste não sai da máquina', async () => {
  const form = formWith([q('n', 'Nome')]);
  const store = memoryStore(form);
  let called = 0;
  const svc = createService({ useMockData: false, sheets: {}, gtm: {}, google: {} }, {
    fetch: async () => { called += 1; return jsonResponse(500, {}); },
    formsStore: store, cacheKey: 'sheets:test:off',
    accountsStore: { async getById() { return null; } },
  });
  const out = await svc.provision(form.id);
  assert.equal(out.configured, false);
  assert.equal(called, 0);
  assert.equal(svc.capabilities().ready, false);
  assert.ok(svc.capabilities().missing.includes('GOOGLE_SHEETS_REFRESH_TOKEN'));
  await assert.rejects(svc.share(form.id, 'a@b.com', 'viewer'), (e) => e.code === 'not_configured');

  const mockStore = memoryStore(formWith([q('n', 'Nome')]));
  const mock = createService({ useMockData: true, sheets: {}, gtm: {}, google: {} }, {
    fetch: async () => { called += 1; return jsonResponse(500, {}); },
    formsStore: mockStore, cacheKey: 'sheets:test:mock',
    accountsStore: { async getById() { return { id: 'otica', name: 'Ótica Visão' }; } },
  });
  const made = await mock.provision('form1');
  assert.match(made.form.sheets.url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/mock-form1\/edit$/);
  assert.equal(called, 0);
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
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('o envio do lead não espera a planilha, e sem conexão a tela pede para conectar', async () => {
  const form = formService.normalizeForm({
    name: 'Lead', status: 'published',
    fields: [{ id: 'f1', type: 'short_text', label: 'Nome', required: true, mapTo: 'name' }],
    integrations: { createCrmLead: false, webhookUrl: '' },
  }, { id: 'leadform', slug: 'lead', createdAt: '2026-11-01T00:00:00.000Z' });
  form.slug = 'lead';
  form.status = 'published';
  const orig = {
    getBySlug: formsStore.getBySlug, addResponse: formsStore.addResponse, bumpStat: formsStore.bumpStat,
    scheduleAppend: sheets.scheduleAppend, capabilities: sheets.capabilities,
    getById: formsStore.getById, add: formsStore.add, save: formsStore.save, getBySlug2: formsStore.getBySlug,
  };
  formsStore.getBySlug = async () => form;
  formsStore.addResponse = async () => {};
  formsStore.bumpStat = async () => {};
  let scheduled = 0;
  sheets.scheduleAppend = () => { scheduled += 1; return new Promise(() => {}); };

  const app = express();
  app.use(express.json());
  app.use('/api/public', publicRoutes);
  app.use('/api/forms', requireAdminAuth, formsRoutes);
  app.use('/api/sheets-oauth', sheetsOauth.callbackRouter);
  const admin = createSessionToken('jc');
  let server;
  try {
    server = await listen(app);
    const port = server.address().port;
    const result = await Promise.race([
      request(port, 'POST', '/api/public/forms/lead/submit', { body: { answers: { f1: 'Ana' }, meta: { utm_source: 'meta' } } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('o envio ficou preso na planilha')), 1500)),
    ]);
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(scheduled, 1);

    sheets.scheduleAppend = () => { throw new Error('planilha explodiu'); };
    const again = await request(port, 'POST', '/api/public/forms/lead/submit', { body: { answers: { f1: 'Bia' } } });
    assert.equal(again.status, 200);

    sheets.capabilities = () => ({ ready: false, mode: 'real', missing: ['GOOGLE_SHEETS_REFRESH_TOKEN'], agencyEmail: 'jorgelcogo@gmail.com' });
    const status = await request(port, 'GET', '/api/forms/sheets/status', { token: admin });
    assert.equal(status.status, 200);
    assert.equal(status.json.ready, false);
    const ensure = await request(port, 'POST', '/api/forms/form-x/sheets/ensure', { token: admin, body: {} });
    assert.equal(ensure.status, 409);
    assert.equal(ensure.json.code, 'not_configured');
    assert.match(ensure.json.error, /Conectar Google Sheets/);

    const cb = await request(port, 'GET', '/api/sheets-oauth/callback');
    assert.equal(cb.status, 400);
    assert.match(cb.text, /Link expirado/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    formsStore.getBySlug = orig.getBySlug;
    formsStore.addResponse = orig.addResponse;
    formsStore.bumpStat = orig.bumpStat;
    formsStore.getById = orig.getById;
    formsStore.add = orig.add;
    formsStore.save = orig.save;
    sheets.scheduleAppend = orig.scheduleAppend;
    sheets.capabilities = orig.capabilities;
  }
});

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

test('o editor mostra conectar, abrir, copiar, compartilhar e sincronizar', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(['escapeHtml', 'escapeAttr', 'sheetsCardHtml', 'fmSheetsPanelHtml'].map((n) => extractFunction(html, n)).join('\n'), ctx);

  const off = ctx.sheetsCardHtml({ ready: false, mode: 'real', missing: ['GOOGLE_SHEETS_REFRESH_TOKEN'], agencyEmail: 'jorgelcogo@gmail.com' });
  assert.match(off, /Conectar Google Sheets/);
  assert.match(off, /ainda não está conectado/);
  assert.doesNotMatch(off, /cp-banner off/);
  assert.match(off, /jorgelcogo@gmail.com/);

  const panelOff = ctx.fmSheetsPanelHtml({ ready: false, mode: 'real' }, null, '');
  assert.match(panelOff, /Conectar Google Sheets/);
  assert.match(panelOff, /GOOGLE_SHEETS_REFRESH_TOKEN/);
  assert.doesNotMatch(panelOff, /fm-warn err/);

  const on = ctx.fmSheetsPanelHtml(
    { ready: true, mode: 'real' },
    { enabled: true, url: 'https://docs.google.com/spreadsheets/d/abc/edit', title: 'Ótica — Captação (respostas)', shares: [{ email: 'cliente@gmail.com', role: 'reader' }], lastError: null },
    '',
  );
  assert.match(on, /Abrir planilha/);
  assert.match(on, /Copiar link/);
  assert.match(on, /Sincronizar respostas antigas/);
  assert.match(on, /Pode ver/);
  assert.match(on, /Pode editar/);
  assert.match(on, /fmSheetsEnabled/);
  assert.match(on, /cliente@gmail.com/);
  assert.match(on, /https:\/\/docs\.google\.com\/spreadsheets\/d\/abc\/edit/);

  const paused = ctx.fmSheetsPanelHtml({ ready: true, mode: 'real' }, { enabled: false, url: 'https://docs.google.com/spreadsheets/d/abc/edit', shares: [] }, '');
  assert.match(paused, /sincronização está pausada/i);

  const fresh = ctx.fmSheetsPanelHtml({ ready: true, mode: 'real' }, null, '');
  assert.match(fresh, /Criar planilha/);
  assert.match(html, /id="sheetsCard"/);
  assert.match(html, /loadSheetsCard\(\)/);
});
