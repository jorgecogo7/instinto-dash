const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const express = require('express');

const cache = require('../src/lib/cache');
const formWhatsapp = require('../src/services/formWhatsapp');
const formService = require('../src/services/formService');
const formsStore = require('../src/data/formsStore');
const accountsStore = require('../src/data/accountsStore');
const crmStore = require('../src/data/crmStore');
const crmService = require('../src/services/crmService');
const metaService = require('../src/services/metaService');
const formsRoutes = require('../src/routes/forms');
const publicRoutes = require('../src/routes/public');
const { createSessionToken } = require('../src/lib/auth');
const { requireAdminAuth } = require('../src/middleware/adminAuth');

const {
  normalizeWhatsappDigits, formatWhatsappDisplay, applyWhatsappPlaceholders,
  endingWhatsappPlan, resolveClientWhatsapp, waMeUrl,
} = formWhatsapp;

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada`);
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

test('normaliza número brasileiro e rejeita lixo', () => {
  assert.equal(normalizeWhatsappDigits('+55 (11) 98888-7777'), '5511988887777');
  assert.equal(normalizeWhatsappDigits('11988887777'), '5511988887777');
  assert.equal(normalizeWhatsappDigits('1133334444'), '551133334444');
  assert.equal(normalizeWhatsappDigits('5511988887777'), '5511988887777');
  assert.equal(normalizeWhatsappDigits('011988887777'), '5511988887777');
  assert.equal(normalizeWhatsappDigits('005511988887777'), '5511988887777');
  assert.equal(normalizeWhatsappDigits('447911123456'), '447911123456');
  assert.equal(normalizeWhatsappDigits(''), '');
  assert.equal(normalizeWhatsappDigits('abc'), '');
  assert.equal(normalizeWhatsappDigits('12345'), '');
  assert.equal(formatWhatsappDisplay('5511988887777'), '+55 11 98888-7777');
  assert.equal(formatWhatsappDisplay('551133334444'), '+55 11 3333-4444');
  assert.equal(formatWhatsappDisplay('447911123456'), '+447911123456');
});

test('número digitado substitui o do cliente; sem redirect o cliente não entra', () => {
  const client = { found: true, digits: '5511988887777', source: 'crm' };
  const manual = endingWhatsappPlan({ whatsapp: '(21) 97777-6666', whatsappRedirect: true }, client);
  assert.equal(manual.digits, '5521977776666');
  assert.equal(manual.source, 'manual');
  assert.equal(manual.redirect, true);

  const fromClient = endingWhatsappPlan({ whatsapp: '', whatsappRedirect: true }, client);
  assert.equal(fromClient.digits, '5511988887777');
  assert.equal(fromClient.source, 'crm');
  assert.equal(fromClient.redirect, true);

  const buttonOnly = endingWhatsappPlan({ whatsapp: '11988887777', whatsappRedirect: false }, client);
  assert.equal(buttonOnly.digits, '5511988887777');
  assert.equal(buttonOnly.redirect, false);
  assert.equal(buttonOnly.showButton, true);

  const legacy = endingWhatsappPlan({ whatsapp: '' }, client);
  assert.equal(legacy.digits, '');
  assert.equal(legacy.redirect, false);
  assert.equal(legacy.showButton, false);

  const missing = endingWhatsappPlan({ whatsappRedirect: true, whatsapp: '' }, { found: false });
  assert.equal(missing.redirect, false);
  assert.equal(missing.digits, '');
});

test('placeholder {nome} vira o primeiro nome', () => {
  assert.equal(applyWhatsappPlaceholders('Oi {nome}! Acabei de responder.', 'Maria Silva'), 'Oi Maria! Acabei de responder.');
  assert.equal(applyWhatsappPlaceholders('Oi {NOME}!', ''), 'Oi!');
  assert.equal(applyWhatsappPlaceholders('Olá {nome}', '  Ana   Souza '), 'Olá Ana');
  const url = waMeUrl('5511988887777', applyWhatsappPlaceholders('Oi {nome}!', 'João'));
  assert.equal(url, `https://wa.me/5511988887777?text=${encodeURIComponent('Oi João!')}`);
});

test('normalizeForm guarda o redirect e o número canônico, e formulário antigo fica desligado', () => {
  const saved = formService.normalizeForm({
    name: 'Captação',
    ending: { whatsapp: '+55 (11) 98888-7777', whatsappText: 'Oi {nome}!', whatsappRedirect: true },
  }, { id: '1', createdAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(saved.ending.whatsapp, '5511988887777');
  assert.equal(saved.ending.whatsappText, 'Oi {nome}!');
  assert.equal(saved.ending.whatsappRedirect, true);

  const old = formService.normalizeForm({
    ending: { whatsapp: '5511900000000', whatsappText: 'Oi' },
  }, { id: '2', createdAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(old.ending.whatsappRedirect, false);
  assert.equal(old.ending.whatsapp, '5511900000000');
});

test('CRM tem prioridade; Página da Meta só entra se o CRM não tiver número', async () => {
  let pageCalls = 0;
  let phoneCalls = 0;
  const deps = {
    getAccount: async () => ({ id: 'otica', meta: { pageId: '111' } }),
    getSettings: async () => ({ whatsapp: { phoneNumberId: '999', displayPhone: '+55 11 98888-7777' } }),
    fetchPhoneDisplay: async () => { phoneCalls += 1; return '5500000000000'; },
    fetchPageWhatsapp: async () => { pageCalls += 1; return '+55 21 90000-0000'; },
  };
  const crm = await resolveClientWhatsapp('otica', deps);
  assert.equal(crm.digits, '5511988887777');
  assert.equal(crm.display, '+55 11 98888-7777');
  assert.equal(crm.source, 'crm');
  assert.equal(phoneCalls, 0);
  assert.equal(pageCalls, 0);

  const viaPhone = await resolveClientWhatsapp('otica', {
    ...deps,
    getSettings: async () => ({ whatsapp: { phoneNumberId: '999', displayPhone: '' } }),
    fetchPhoneDisplay: async (id) => { phoneCalls += 1; assert.equal(id, '999'); return '+55 (11) 97777-6666'; },
  });
  assert.equal(viaPhone.digits, '5511977776666');
  assert.equal(viaPhone.source, 'crm');
  assert.equal(pageCalls, 0);

  const viaPage = await resolveClientWhatsapp('otica', {
    getAccount: async () => ({ id: 'otica', meta: { pageId: '111' } }),
    getSettings: async () => ({ whatsapp: null }),
    fetchPhoneDisplay: async () => { throw new Error('não deveria'); },
    fetchPageWhatsapp: async (pageId) => { pageCalls += 1; assert.equal(pageId, '111'); return '+55 21 98888-0000'; },
  });
  assert.equal(viaPage.digits, '5521988880000');
  assert.equal(viaPage.source, 'page');
  assert.equal(viaPage.display, '+55 21 98888-0000');

  const none = await resolveClientWhatsapp('otica', {
    getAccount: async () => ({ id: 'otica', meta: {} }),
    getSettings: async () => { throw new Error('crm fora'); },
    fetchPhoneDisplay: async () => null,
    fetchPageWhatsapp: async () => { throw new Error('sem permissão'); },
  });
  assert.equal(none.found, false);
  assert.equal(none.reason, 'not_found');

  const missing = await resolveClientWhatsapp('fantasma', {
    getAccount: async () => null,
    getSettings: async () => { throw new Error('não'); },
    fetchPageWhatsapp: async () => '5511999999999',
  });
  assert.equal(missing.reason, 'missing_client');
  assert.equal((await resolveClientWhatsapp('', deps)).reason, 'no_client');
});

function loadPanel() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const names = ['fmNormalizeWa', 'fmFormatWa', 'fmWhatsappPreview', 'fmEndingWaPlan'];
  const script = names.map((name) => extractFunction(html, name)).join('\n');
  const ctx = { fmClientWa: null };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

test('o editor mostra o mesmo número que o servidor, e avisa quando não acha', () => {
  const panel = loadPanel();
  const samples = ['+55 (11) 98888-7777', '11988887777', '5511988887777', '011988887777', '447911123456', '', 'abc', '12345'];
  samples.forEach((raw) => {
    assert.equal(panel.fmNormalizeWa(raw), normalizeWhatsappDigits(raw), raw);
    assert.equal(panel.fmFormatWa(raw), formatWhatsappDisplay(raw), raw);
  });

  const typed = panel.fmWhatsappPreview({ whatsapp: '11988887777', whatsappRedirect: true }, 'otica', { found: true, display: '+55 11 90000-0000' });
  assert.equal(typed.tone, 'ok');
  assert.match(typed.text, /Número digitado: \+55 11 98888-7777/);

  const clientOn = panel.fmWhatsappPreview({ whatsapp: '', whatsappRedirect: true }, 'otica', { found: true, display: '+55 11 98888-7777', source: 'crm' });
  assert.match(clientOn.text, /^WhatsApp do cliente: \+55 11 98888-7777\./);

  const fromPage = panel.fmWhatsappPreview({ whatsapp: '', whatsappRedirect: true }, 'otica', { found: true, display: '+55 21 98888-0000', source: 'page' });
  assert.match(fromPage.text, /WhatsApp do cliente: \+55 21 98888-0000 \(lido da Página do Facebook\)/);

  const missing = panel.fmWhatsappPreview({ whatsappRedirect: true }, 'otica', { found: false });
  assert.match(missing.text, /Nenhum WhatsApp encontrado para este cliente/);

  const noClient = panel.fmWhatsappPreview({ whatsappRedirect: true }, null, null);
  assert.match(noClient.text, /não está ligado a um cliente/);

  panel.fmClientWa = { clientId: 'otica', found: true, digits: '5511988887777' };
  const plan = panel.fmEndingWaPlan({ clientId: 'otica', ending: { whatsapp: '', whatsappRedirect: true } });
  assert.equal(plan.digits, '5511988887777');
  assert.equal(plan.redirect, true);
  const kept = panel.fmEndingWaPlan({ clientId: 'otica', ending: { whatsapp: '21977776666', whatsappRedirect: false } });
  assert.equal(kept.digits, '5521977776666');
  assert.equal(kept.redirect, false);
});

test('a página pública não manda desqualificado pro WhatsApp e preenche {nome}', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../form.html'), 'utf8');
  const script = ['fillWaText', 'waHandoff'].map((name) => extractFunction(html, name)).join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  assert.equal(ctx.fillWaText('Oi {nome}!', 'Maria Silva'), applyWhatsappPlaceholders('Oi {nome}!', 'Maria Silva'));

  const frm = {
    ending: {
      whatsappRedirect: true,
      whatsappNumber: '5511988887777',
      whatsappText: 'Oi {nome}!',
      redirectUrl: 'https://instinto.example/obrigado',
      buttonUrl: 'https://instinto.example',
    },
    endingDisqualified: { title: 'Obrigado pelo interesse!', redirectUrl: 'https://instinto.example/fim' },
  };
  const ok = ctx.waHandoff({ disqualified: false }, frm, 'Maria Silva');
  assert.equal(ok.auto, true);
  assert.equal(ok.link, `https://wa.me/5511988887777?text=${encodeURIComponent('Oi Maria!')}`);
  assert.equal(ok.redirect, '');

  const disq = ctx.waHandoff({ disqualified: true }, frm, 'Maria Silva');
  assert.equal(disq.auto, false);
  assert.equal(disq.link, '');
  assert.equal(disq.redirect, 'https://instinto.example/fim');

  const legacy = ctx.waHandoff({ disqualified: false }, {
    ending: { whatsapp: '5511900000000', whatsappText: 'Oi' },
    endingDisqualified: {},
  }, '');
  assert.equal(legacy.auto, false);
  assert.equal(legacy.link, 'https://wa.me/5511900000000?text=Oi');

  assert.match(html, /Te levando pro WhatsApp…/);
  assert.match(html, /setTimeout\(function\(\)\{ location\.href = hand\.link; \}, 1200\)/);
  const done = extractFunction(html, 'submit');
  assert.ok(done.indexOf('fb(') < done.indexOf('renderEnd('), 'o pixel de Lead dispara antes do redirecionamento');
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

test('editor salva o redirect e a página pública usa o WhatsApp do cliente', async () => {
  const orig = {
    getBySlug: formsStore.getBySlug,
    add: formsStore.add,
    getById: formsStore.getById,
    save: formsStore.save,
    addResponse: formsStore.addResponse,
    bumpStat: formsStore.bumpStat,
    accountGetById: accountsStore.getById,
    crmGetSettings: crmStore.getSettings,
    pageWa: metaService.getPageWhatsappNumber,
    addFromForm: crmService.addFromForm,
  };
  const stored = new Map();
  const bySlug = new Map();
  const remember = (form) => { stored.set(form.id, form); bySlug.set(form.slug, form); return form; };
  formsStore.getBySlug = async (slug) => bySlug.get(slug) || null;
  formsStore.add = async (form) => remember(form);
  formsStore.getById = async (id) => stored.get(id) || null;
  formsStore.save = async (form) => remember(form);
  formsStore.addResponse = async () => {};
  formsStore.bumpStat = async () => {};
  crmService.addFromForm = async () => {};
  const accounts = {
    otica: { id: 'otica', name: 'Ótica Visão', meta: { pageId: '111', status: 'connected' } },
    padaria: { id: 'padaria', name: 'Padaria', meta: { pageId: '222', status: 'connected' } },
  };
  accountsStore.getById = async (id) => accounts[id] || null;
  const settings = {
    otica: { whatsapp: { phoneNumberId: '555', displayPhone: '+55 (11) 98888-7777' } },
    padaria: { whatsapp: null },
  };
  crmStore.getSettings = async (id) => settings[id] || null;
  const pageNumbers = { 222: '+55 21 96666-5555' };
  let pageCalls = 0;
  metaService.getPageWhatsappNumber = async (pageId) => { pageCalls += 1; return pageNumbers[pageId] || null; };
  cache.del('form:client-wa:otica');
  cache.del('form:client-wa:padaria');

  const app = express();
  app.use(express.json());
  app.use('/api/forms', requireAdminAuth, formsRoutes);
  app.use('/api/public', publicRoutes);
  const admin = createSessionToken('jc');
  let server;
  try {
    server = await listen(app);
    const port = server.address().port;
    const created = await request(port, 'POST', '/api/forms', {
      token: admin,
      body: {
        name: 'Captação Ótica', slug: 'captacao-otica', clientId: 'otica', status: 'draft',
        fields: [{ id: 'n1', type: 'short_text', label: 'Qual é o seu nome?', required: true, mapTo: 'name' }, { id: 'q1', type: 'choice', label: 'Momento', required: true, options: [
          { id: 'a', label: 'Quero agora', qualification: 'neutral' },
          { id: 'b', label: 'Só olhando', qualification: 'disqualifies' },
        ] }],
        ending: { title: 'Prontinho!', text: 'Vamos falar no WhatsApp.', whatsapp: '', whatsappText: 'Oi {nome}!', whatsappRedirect: true, redirectUrl: 'https://instinto.example/site' },
        endingDisqualified: { title: 'Obrigado pelo interesse!', text: 'Fica de olho nas redes.', redirectUrl: '' },
        integrations: { createCrmLead: false },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.ending.whatsappRedirect, true);
    assert.equal(created.json.ending.whatsapp, '');

    const source = await request(port, 'GET', '/api/forms/whatsapp-source?clientId=otica', { token: admin });
    assert.equal(source.status, 200);
    assert.equal(source.json.found, true);
    assert.equal(source.json.digits, '5511988887777');
    assert.equal(source.json.display, '+55 11 98888-7777');
    assert.equal(source.json.source, 'crm');
    assert.equal(pageCalls, 0);
    assert.equal(source.json.phoneNumberId, undefined);

    const missingClient = await request(port, 'GET', '/api/forms/whatsapp-source?clientId=ninguem', { token: admin });
    assert.equal(missingClient.status, 404);

    const published = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { ...created.json, status: 'published' },
    });
    assert.equal(published.status, 200);
    assert.equal(published.json.ending.whatsappRedirect, true);

    const pub = await request(port, 'GET', '/api/public/forms/captacao-otica');
    assert.equal(pub.status, 200);
    assert.equal(pub.json.ending.whatsappNumber, '5511988887777');
    assert.equal(pub.json.ending.whatsappRedirect, true);
    assert.equal(pub.json.ending.whatsappText, 'Oi {nome}!');
    assert.equal(pub.json.tracking.capiToken, undefined);
    assert.equal(JSON.stringify(pub.json).includes('phoneNumberId'), false);

    const qualified = await request(port, 'POST', '/api/public/forms/captacao-otica/submit', {
      body: { answers: { n1: 'Maria Silva', q1: 'a' } },
    });
    assert.equal(qualified.status, 200);
    assert.equal(qualified.json.disqualified, false);

    const disq = await request(port, 'POST', '/api/public/forms/captacao-otica/submit', {
      body: { answers: { n1: 'João', q1: 'b' } },
    });
    assert.equal(disq.status, 200);
    assert.equal(disq.json.disqualified, true);

    const manual = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { ...published.json, ending: { ...published.json.ending, whatsapp: '(11) 90000-1111' } },
    });
    assert.equal(manual.status, 200);
    assert.equal(manual.json.ending.whatsapp, '5511900001111');
    cache.del('form:client-wa:otica');
    const overridden = await request(port, 'GET', '/api/public/forms/captacao-otica');
    assert.equal(overridden.json.ending.whatsappNumber, '5511900001111');
    assert.equal(overridden.json.ending.whatsappRedirect, true);

    const off = await request(port, 'PUT', `/api/forms/${created.json.id}`, {
      token: admin,
      body: { ...manual.json, ending: { ...manual.json.ending, whatsapp: '', whatsappRedirect: false } },
    });
    assert.equal(off.json.ending.whatsappRedirect, false);
    const hidden = await request(port, 'GET', '/api/public/forms/captacao-otica');
    assert.equal(hidden.json.ending.whatsappNumber, '');
    assert.equal(hidden.json.ending.whatsappRedirect, false);
    assert.equal(JSON.stringify(hidden.json).includes('5511988887777'), false);

    cache.del('form:client-wa:padaria');
    const bakery = await request(port, 'POST', '/api/forms', {
      token: admin,
      body: {
        name: 'Padaria', clientId: 'padaria', status: 'published',
        fields: [{ id: 'n1', type: 'short_text', label: 'Nome', mapTo: 'name' }],
        ending: { whatsappRedirect: true, whatsapp: '', title: 'Ok' },
        integrations: { createCrmLead: false },
      },
    });
    assert.equal(bakery.status, 201);
    const bakeryPub = await request(port, 'GET', `/api/public/forms/${bakery.json.slug}`);
    assert.equal(bakeryPub.json.ending.whatsappNumber, '5521966665555');
    assert.equal(bakeryPub.json.ending.whatsappRedirect, true);
    assert.ok(pageCalls >= 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    formsStore.getBySlug = orig.getBySlug;
    formsStore.add = orig.add;
    formsStore.getById = orig.getById;
    formsStore.save = orig.save;
    formsStore.addResponse = orig.addResponse;
    formsStore.bumpStat = orig.bumpStat;
    accountsStore.getById = orig.accountGetById;
    crmStore.getSettings = orig.crmGetSettings;
    metaService.getPageWhatsappNumber = orig.pageWa;
    crmService.addFromForm = orig.addFromForm;
    cache.del('form:client-wa:otica');
    cache.del('form:client-wa:padaria');
  }
});
