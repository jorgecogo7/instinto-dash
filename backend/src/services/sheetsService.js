/**
 * Planilha de respostas de cada formulário, na conta Google da agência.
 *
 * Por que OAuth da agência (e não uma service account):
 * a planilha precisa ser da conta jorgelcogo@gmail.com, para o Jorge abrir
 * no Drive dele e mandar o link ao cliente. Arquivo criado por service
 * account fica com a service account. Transferir a propriedade para um
 * @gmail.com não funciona (o Google só transfere dentro de um Workspace)
 * e delegação de domínio também exige Workspace. O token é separado do
 * Tag Manager (GOOGLE_SHEETS_REFRESH_TOKEN): reautorizar Planilhas não
 * troca o token do GTM nem o do Google Ads.
 *
 * Gravar uma resposta nunca pode falhar o envio do lead. scheduleAppend
 * só agenda o trabalho e engole o erro (tenta de novo, registra e segue).
 */
const cache = require('../lib/cache');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];
const TAB = 'Respostas';
const TAIL_KEYS = ['qualified', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'page'];
const HEADER = {
  createdAt: 'Data/hora',
  qualified: 'Qualificado/Desqualificado',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  page: 'Página de origem',
};

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra || {});
  return e;
}

function cleanTitlePart(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || fallback;
}

/** '<Cliente> — <Nome do formulário> (respostas)' */
function spreadsheetTitle(clientName, formName) {
  return `${cleanTitlePart(clientName, 'Instinto Digital')} — ${cleanTitlePart(formName, 'Formulário')} (respostas)`.slice(0, 180);
}

function questionFields(form) {
  return (form && Array.isArray(form.fields) ? form.fields : []).filter((f) => f && f.type !== 'statement' && f.id);
}

function desiredKeys(form) {
  return ['createdAt', ...questionFields(form).map((f) => `q:${f.id}`), ...TAIL_KEYS];
}

/**
 * Cabeçalhos na ordem das colunas. Pergunta removida mantém o texto antigo.
 * Dois rótulos iguais ganham " (2)" para não parecer que a coluna sumiu.
 */
function headersFor(columns, form) {
  const labels = new Map(questionFields(form).map((f) => [String(f.id), String(f.label || '').trim() || 'Pergunta']));
  const used = new Map();
  return columns.map((c) => {
    let header;
    if (HEADER[c.key]) header = HEADER[c.key];
    else if (String(c.key).startsWith('q:')) {
      const id = String(c.key).slice(2);
      header = labels.has(id) ? labels.get(id) : (c.header || 'Pergunta removida');
    } else header = c.header || c.key;
    const n = (used.get(header) || 0) + 1;
    used.set(header, n);
    return n === 1 ? header : `${header} (${n})`;
  });
}

/**
 * Colunas só crescem para a direita. Pergunta nova entra no fim;
 * as que já existiam não mudam de lugar (a linha antiga continua batendo).
 */
function planColumns(existing, form) {
  const current = (Array.isArray(existing) ? existing : [])
    .filter((c) => c && c.key)
    .map((c) => ({ key: String(c.key).slice(0, 80), header: String(c.header || '') }))
    .filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i);
  const have = new Set(current.map((c) => c.key));
  const added = [];
  const columns = current.slice();
  desiredKeys(form).forEach((key) => {
    if (have.has(key)) return;
    columns.push({ key, header: '' });
    added.push(key);
    have.add(key);
  });
  const headers = headersFor(columns, form);
  let headersChanged = added.length > 0 || columns.length !== current.length;
  const next = columns.map((c, i) => {
    if (c.header !== headers[i]) headersChanged = true;
    return { key: c.key, header: headers[i] };
  });
  return { columns: next, headers, added, headersChanged };
}

function formatDateTime(iso, timeZone = 'America/Sao_Paulo') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function qualificationCell(result) {
  if (!result || !result.usesQualification) return '';
  return result.qualified ? 'Qualificado' : 'Desqualificado';
}

/** Aspas iniciais evitam que uma resposta vire fórmula na planilha. */
function sheetCell(value) {
  const s = String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, 49000);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function rowFor(columns, form, response) {
  const byField = new Map(((response && response.readable) || []).map((a) => [a.fieldId, a.answer]));
  const meta = (response && response.meta) || {};
  return (columns || []).map((c) => {
    if (c.key === 'createdAt') return formatDateTime(response && response.createdAt);
    if (c.key === 'qualified') return qualificationCell(response && response.result);
    if (c.key === 'page') return sheetCell(meta.url || meta.referrer || '');
    if (String(c.key).startsWith('utm_')) return sheetCell(meta[c.key] || '');
    if (String(c.key).startsWith('q:')) return sheetCell(byField.get(String(c.key).slice(2)) || '');
    return '';
  });
}

function publicSheets(sheets) {
  if (!sheets || typeof sheets !== 'object') return null;
  return {
    enabled: sheets.enabled !== false,
    spreadsheetId: sheets.spreadsheetId || '',
    url: sheets.url || '',
    title: sheets.title || '',
    shares: (Array.isArray(sheets.shares) ? sheets.shares : []).map((s) => ({
      email: s.email, role: s.role === 'writer' ? 'writer' : 'reader', sharedAt: s.sharedAt || '',
    })),
    lastError: sheets.lastError || null,
    headers: (Array.isArray(sheets.columns) ? sheets.columns : []).map((c) => c.header).filter(Boolean),
  };
}

function parseEmail(email) {
  const e = String(email || '').trim().toLowerCase().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function parseRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'editor' || r === 'writer') return 'writer';
  if (r === 'viewer' || r === 'reader') return 'reader';
  return null;
}

function sheetLink(id, returned) {
  if (returned && /^https:\/\/docs\.google\.com\/spreadsheets\//.test(returned)) return returned;
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function createService(cfg, deps = {}) {
  const fetchFn = deps.fetch || global.fetch;
  const store = deps.formsStore || require('../data/formsStore');
  const accounts = deps.accountsStore || require('../data/accountsStore');
  const cacheKey = deps.cacheKey || 'sheets:accessToken';
  const retryDelay = deps.retryDelay || ((attempt) => 300 * (attempt + 1));
  const sheetsCfg = cfg.sheets || {};
  const gtmCfg = cfg.gtm || {};
  const googleCfg = cfg.google || {};

  function credentials() {
    let clientId = '';
    let clientSecret = '';
    let source = 'GOOGLE_CLIENT_ID';
    if (sheetsCfg.clientId) {
      clientId = sheetsCfg.clientId;
      clientSecret = sheetsCfg.clientSecret || '';
      source = 'GOOGLE_SHEETS_CLIENT_ID';
    } else if (gtmCfg.clientId) {
      clientId = gtmCfg.clientId;
      clientSecret = gtmCfg.clientSecret || '';
      source = 'GOOGLE_GTM_CLIENT_ID';
    } else if (googleCfg.clientId) {
      clientId = googleCfg.clientId;
      clientSecret = googleCfg.clientSecret || '';
      source = 'GOOGLE_CLIENT_ID';
    }
    const refreshToken = sheetsCfg.refreshToken || '';
    return { clientId, clientSecret, refreshToken, source };
  }

  function capabilities() {
    const c = credentials();
    const missing = [];
    if (!c.clientId || !c.clientSecret) {
      missing.push(c.source === 'GOOGLE_GTM_CLIENT_ID'
        ? 'GOOGLE_GTM_CLIENT_ID / GOOGLE_GTM_CLIENT_SECRET'
        : c.source === 'GOOGLE_SHEETS_CLIENT_ID'
          ? 'GOOGLE_SHEETS_CLIENT_ID / GOOGLE_SHEETS_CLIENT_SECRET'
          : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
    }
    if (!c.refreshToken) missing.push('GOOGLE_SHEETS_REFRESH_TOKEN');
    return {
      mode: cfg.useMockData ? 'mock' : 'real',
      ready: !!cfg.useMockData || missing.length === 0,
      missing: cfg.useMockData ? [] : missing,
      redirectUri: sheetsCfg.redirectUri || 'https://api.instintodigital.com.br/api/sheets-oauth/callback',
      oauthClientSource: c.source,
      tokenSource: c.refreshToken ? 'GOOGLE_SHEETS_REFRESH_TOKEN' : null,
      agencyEmail: sheetsCfg.agencyEmail || null,
    };
  }

  function oauthClient() {
    const c = credentials();
    return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: capabilities().redirectUri, source: c.source };
  }

  function mapGoogleError(status, json) {
    const g = (json && json.error) || {};
    const msg = String(g.message || (typeof g === 'string' ? g : '') || '');
    const reasons = JSON.stringify(g.details || g.errors || g);
    if (status === 401) return httpError(409, 'O Google recusou o acesso às planilhas. Conecte de novo e troque GOOGLE_SHEETS_REFRESH_TOKEN no hPanel.', { code: 'auth' });
    if (status === 403 && /insufficient|SCOPE_INSUFFICIENT|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg + reasons)) {
      return httpError(409, 'O token do Google ainda não tem permissão de Planilhas. Clique em "Conectar Google Sheets" e troque o token no hPanel.', { code: 'scope' });
    }
    if (status === 403 && /SERVICE_DISABLED|has not been used|accessNotConfigured|API has not been used/i.test(msg + reasons)) {
      return httpError(409, 'Falta ativar a API no projeto instinto-dash. Em APIs e serviços > Biblioteca, ative "Google Sheets API" e "Google Drive API".', { code: 'api_disabled' });
    }
    if (status === 403) return httpError(403, 'A conta Google da agência não tem permissão para alterar essa planilha.', { code: 'forbidden' });
    if (status === 404) return httpError(404, 'O Google não encontrou a planilha. Crie de novo pelo botão do formulário.', { code: 'not_found' });
    if (status === 429) return httpError(429, 'O Google limitou as gravações por alguns instantes. Tente de novo em um minuto.', { code: 'quota' });
    if (/duplicate/i.test(reasons + msg)) return httpError(409, 'Esse e-mail já tem acesso à planilha.', { code: 'duplicate' });
    if (status === 400) return httpError(400, `O Google recusou o pedido: ${msg.slice(0, 240) || 'dados inválidos'}`, { code: 'bad_request' });
    return httpError(502, 'O Google Sheets não respondeu agora. Tente de novo em instantes.', { code: 'upstream' });
  }

  async function getAccessToken() {
    if (cfg.useMockData) return 'mock-access-token';
    const cached = cache.get(cacheKey);
    if (cached && cached.token) return cached.token;
    const c = credentials();
    if (!c.clientId || !c.clientSecret || !c.refreshToken) {
      throw httpError(409, 'O Google Sheets ainda não está conectado. Use "Conectar Google Sheets" em Integrações.', { code: 'not_configured' });
    }
    let res;
    let json;
    try {
      res = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: c.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(15000),
      });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      throw httpError(502, 'Não consegui renovar o acesso do Google Sheets. Tente de novo em instantes.', { code: 'upstream' });
    }
    if (!json.access_token) {
      console.error('Google Sheets: falha ao renovar o token:', json.error || res.status);
      throw httpError(409, json.error === 'invalid_grant'
        ? 'O token do Google Sheets expirou ou foi revogado. Conecte de novo e troque GOOGLE_SHEETS_REFRESH_TOKEN no hPanel.'
        : 'Não consegui renovar o acesso do Google Sheets. Confira o cliente OAuth e o GOOGLE_SHEETS_REFRESH_TOKEN no hPanel.',
      { code: json.error === 'invalid_grant' ? 'auth' : 'token_error' });
    }
    const scopes = String(json.scope || '').split(/\s+/).filter(Boolean);
    cache.set(cacheKey, { token: json.access_token, scopes }, 50 * 60);
    return json.access_token;
  }

  async function checkScopes() {
    if (cfg.useMockData) return { ok: true, missingScopes: [], mock: true };
    await getAccessToken();
    const scopes = (cache.get(cacheKey) || {}).scopes || [];
    if (!scopes.length) return { ok: null, missingScopes: [] };
    const missingScopes = SCOPES.filter((s) => !scopes.includes(s)).map((s) => s.split('/').pop());
    return { ok: missingScopes.length === 0, missingScopes };
  }

  async function api(method, url, body, retryAuth = true) {
    if (cfg.useMockData) return deps.mockApi ? deps.mockApi(method, url, body) : {};
    const token = await getAccessToken();
    let res;
    try {
      res = await fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw httpError(502, 'O Google Sheets não respondeu agora. Tente de novo em instantes.', { code: 'upstream' });
    }
    if (res.status === 401 && retryAuth) {
      cache.del(cacheKey);
      return api(method, url, body, false);
    }
    const text = await res.text();
    let json = {};
    if (text) { try { json = JSON.parse(text); } catch (e) { json = {}; } }
    if (!res.ok) throw mapGoogleError(res.status, json);
    return json;
  }

  async function withRetry(fn) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fn(); } catch (e) {
        last = e;
        const retry = !e.status || e.status === 429 || e.status >= 500;
        if (!retry || attempt === 2) break;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }
    throw last;
  }

  async function clientNameOf(clientId) {
    if (!clientId) return 'Instinto Digital';
    try {
      const account = await accounts.getById(clientId);
      return (account && String(account.name || '').trim()) || 'Cliente';
    } catch (e) {
      return 'Cliente';
    }
  }

  async function writeHeaders(spreadsheetId, headers) {
    if (!headers.length) return;
    const end = columnLetter(headers.length);
    await withRetry(() => api(
      'PUT',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${TAB}!A1:${end}1`)}?valueInputOption=RAW`,
      { range: `${TAB}!A1:${end}1`, majorDimension: 'ROWS', values: [headers] },
    ));
  }

  async function appendRows(spreadsheetId, rows) {
    if (!rows.length) return;
    await withRetry(() => api(
      'POST',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${TAB}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: rows },
    ));
  }

  async function createSpreadsheet(title, headers) {
    if (cfg.useMockData) {
      const id = `mock-${title.length}`;
      return { spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
    }
    const created = await withRetry(() => api('POST', 'https://sheets.googleapis.com/v4/spreadsheets', {
      properties: { title, locale: 'pt_BR', timeZone: 'America/Sao_Paulo' },
      sheets: [{
        properties: { title: TAB, gridProperties: { frozenRowCount: 1 } },
        data: [{
          startRow: 0,
          startColumn: 0,
          rowData: [{
            values: headers.map((h) => ({
              userEnteredValue: { stringValue: h },
              userEnteredFormat: { textFormat: { bold: true } },
            })),
          }],
        }],
      }],
    }));
    return { spreadsheetId: created.spreadsheetId, url: sheetLink(created.spreadsheetId, created.spreadsheetUrl) };
  }

  function blankSheets(extra) {
    return {
      enabled: true, spreadsheetId: '', url: '', title: '', columns: [], shares: [], lastError: null,
      createdAt: new Date().toISOString(), ...extra,
    };
  }

  async function ensureHeadersUnlocked(form) {
    if (!form.sheets || !form.sheets.spreadsheetId) return form;
    const plan = planColumns(form.sheets.columns, form);
    if (!plan.headersChanged) return form;
    await writeHeaders(form.sheets.spreadsheetId, plan.headers);
    form.sheets.columns = plan.columns;
    await store.save(form);
    return form;
  }

  async function rememberError(formId, err) {
    try {
      const current = await store.getById(formId);
      if (!current) return;
      current.sheets = current.sheets || blankSheets();
      current.sheets.lastError = String((err && err.message) || 'erro').slice(0, 300);
      await store.save(current);
    } catch (e) {
      console.error('Google Sheets: não registrei o erro', formId, e.message);
    }
  }

  async function provisionUnlocked(formId) {
    const form = await store.getById(formId);
    if (!form) return null;
    if (!capabilities().ready) return { configured: false, form };
    if (form.sheets && form.sheets.spreadsheetId) {
      try {
        await ensureHeadersUnlocked(form);
        if (form.sheets.lastError) { form.sheets.lastError = null; await store.save(form); }
      } catch (e) {
        await rememberError(formId, e);
        const again = await store.getById(formId);
        return { configured: true, form: again || form, error: e };
      }
      return { configured: true, form: await store.getById(formId) };
    }
    const clientName = await clientNameOf(form.clientId);
    const title = spreadsheetTitle(clientName, form.name);
    const plan = planColumns([], form);
    try {
      const created = await createSpreadsheet(title, plan.headers);
      // No modo de teste o id precisa ser estável por formulário, não pelo título.
      const spreadsheetId = cfg.useMockData
        ? `mock-${String(form.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`
        : created.spreadsheetId;
      form.sheets = blankSheets({
        enabled: true,
        spreadsheetId,
        url: cfg.useMockData ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : created.url,
        title,
        columns: plan.columns,
        shares: (form.sheets && form.sheets.shares) || [],
        lastError: null,
      });
      await store.save(form);
      return { configured: true, form };
    } catch (e) {
      console.error('Google Sheets: não criei a planilha', formId, e.message);
      form.sheets = blankSheets({
        enabled: true,
        title,
        lastError: String(e.message || 'erro').slice(0, 300),
        shares: (form.sheets && form.sheets.shares) || [],
      });
      await store.save(form);
      return { configured: true, form, error: e };
    }
  }

  async function appendUnlocked(formId, response) {
    const form = await store.getById(formId);
    if (!form || !form.sheets || form.sheets.enabled === false || !form.sheets.spreadsheetId) return { skipped: true };
    if (!response || response.sheetsSyncedAt) return { skipped: true };
    try {
      await ensureHeadersUnlocked(form);
      const columns = form.sheets.columns || [];
      await appendRows(form.sheets.spreadsheetId, [rowFor(columns, form, response)]);
      response.sheetsSyncedAt = new Date().toISOString();
      const saved = await store.updateResponse(form.id, response);
      if (!saved) console.error('Google Sheets: resposta gravada na planilha, mas não marquei no banco', form.id, response.id);
      if (form.sheets.lastError) {
        form.sheets.lastError = null;
        await store.save(form);
      }
      return { ok: true };
    } catch (e) {
      await rememberError(formId, e);
      throw e;
    }
  }

  async function findPermission(spreadsheetId, email) {
    const json = await api('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/permissions?fields=permissions(id,emailAddress,role,type)`);
    const list = json.permissions || [];
    return list.find((p) => p.type === 'user' && String(p.emailAddress || '').toLowerCase() === email) || null;
  }

  async function shareUnlocked(formId, email, role) {
    const form = await store.getById(formId);
    if (!form) return null;
    if (!capabilities().ready) {
      throw httpError(409, 'O Google Sheets ainda não está conectado. Use "Conectar Google Sheets" em Integrações.', { code: 'not_configured' });
    }
    if (!form.sheets || !form.sheets.spreadsheetId) {
      throw httpError(409, 'Este formulário ainda não tem planilha. Crie a planilha antes de compartilhar.', { code: 'no_sheet' });
    }
    const addr = parseEmail(email);
    const parsed = parseRole(role);
    if (!addr) throw httpError(400, 'Digite um e-mail válido. A pessoa precisa ter conta Google para abrir a planilha.');
    if (!parsed) throw httpError(400, 'Escolha se a pessoa pode ver ou editar.');
    if (!cfg.useMockData) {
      const existing = await findPermission(form.sheets.spreadsheetId, addr).catch((e) => {
        if (e.code === 'auth' || e.code === 'scope' || e.code === 'api_disabled') throw e;
        return null;
      });
      if (existing) {
        if (existing.role !== parsed && existing.id) {
          await withRetry(() => api('PATCH', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(form.sheets.spreadsheetId)}/permissions/${encodeURIComponent(existing.id)}`, { role: parsed }));
        }
      } else {
        try {
          await withRetry(() => api(
            'POST',
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(form.sheets.spreadsheetId)}/permissions?sendNotificationEmail=true`,
            { type: 'user', role: parsed, emailAddress: addr },
          ));
        } catch (e) {
          if (e.code !== 'duplicate') throw e;
        }
      }
    }
    const shares = (form.sheets.shares || []).filter((s) => String(s.email).toLowerCase() !== addr);
    shares.push({ email: addr, role: parsed, sharedAt: new Date().toISOString() });
    form.sheets.shares = shares;
    form.sheets.lastError = null;
    await store.save(form);
    return form;
  }

  async function backfillUnlocked(formId) {
    const form = await store.getById(formId);
    if (!form) return null;
    if (!capabilities().ready) {
      throw httpError(409, 'O Google Sheets ainda não está conectado. Use "Conectar Google Sheets" em Integrações.', { code: 'not_configured' });
    }
    if (!form.sheets || !form.sheets.spreadsheetId) {
      throw httpError(409, 'Este formulário ainda não tem planilha. Crie a planilha antes de sincronizar as respostas antigas.', { code: 'no_sheet' });
    }
    await ensureHeadersUnlocked(form);
    const all = await store.getResponses(form.id, 10000, { order: 'asc' });
    const pending = all.filter((r) => !r.sheetsSyncedAt);
    const skipped = all.length - pending.length;
    let sent = 0;
    let failed = 0;
    const chunkSize = 100;
    for (let i = 0; i < pending.length; i += chunkSize) {
      const slice = pending.slice(i, i + chunkSize);
      try {
        const columns = form.sheets.columns || [];
        await appendRows(form.sheets.spreadsheetId, slice.map((r) => rowFor(columns, form, r)));
        const stamp = new Date().toISOString();
        for (const r of slice) {
          r.sheetsSyncedAt = stamp;
          await store.updateResponse(form.id, r);
          sent += 1;
        }
      } catch (e) {
        failed += slice.length;
        await rememberError(formId, e);
        if (e.code === 'auth' || e.code === 'scope' || e.code === 'not_configured' || e.code === 'api_disabled') throw e;
        break;
      }
    }
    const fresh = await store.getById(formId);
    if (fresh && fresh.sheets && sent && !failed) {
      fresh.sheets.lastError = null;
      await store.save(fresh);
    }
    const finalForm = (await store.getById(formId)) || form;
    return {
      sent, skipped, failed, total: all.length, truncated: all.length >= 10000,
      sheets: publicSheets(finalForm.sheets),
    };
  }

  const locks = new Map();
  function withFormLock(id, fn) {
    const key = String(id);
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    // A fila engole o erro (o chamador é quem trata). Sem isso, o .finally
    // de uma promessa rejeitada vira rejeição sem dono.
    const settled = run.then(() => {}, () => {});
    locks.set(key, settled);
    settled.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
    return run;
  }

  function scheduleAppend(formId, response) {
    if (!formId || !response) return;
    setImmediate(() => {
      withFormLock(formId, () => appendUnlocked(formId, response))
        .catch((e) => console.error('Google Sheets: não gravei a resposta', formId, response.id, e.message));
    });
  }

  function scheduleEnsureHeaders(formId) {
    if (!formId) return;
    setImmediate(() => {
      withFormLock(formId, async () => {
        const form = await store.getById(formId);
        if (!form || !form.sheets || !form.sheets.spreadsheetId || !capabilities().ready) return;
        await ensureHeadersUnlocked(form);
      }).catch((e) => console.error('Google Sheets: não atualizei o cabeçalho', formId, e.message));
    });
  }

  return {
    capabilities,
    oauthClient,
    checkScopes,
    publicSheets,
    withFormLock,
    provision: (formId) => withFormLock(formId, () => provisionUnlocked(formId)),
    setEnabled: (formId, enabled) => withFormLock(formId, async () => {
      const form = await store.getById(formId);
      if (!form) return null;
      if (enabled && !capabilities().ready) {
        throw httpError(409, 'O Google Sheets ainda não está conectado. Use "Conectar Google Sheets" em Integrações.', { code: 'not_configured' });
      }
      if (enabled && (!form.sheets || !form.sheets.spreadsheetId)) {
        const out = await provisionUnlocked(formId);
        const again = (out && out.form) || await store.getById(formId);
        if (again && again.sheets) {
          again.sheets.enabled = true;
          await store.save(again);
        }
        return again;
      }
      form.sheets = form.sheets || blankSheets({ enabled: !!enabled });
      form.sheets.enabled = !!enabled;
      await store.save(form);
      return form;
    }),
    share: (formId, email, role) => withFormLock(formId, () => shareUnlocked(formId, email, role)),
    backfill: (formId) => withFormLock(formId, () => backfillUnlocked(formId)),
    scheduleAppend,
    scheduleEnsureHeaders,
  };
}

function columnLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const config = require('../config');
const singleton = createService(config);

module.exports = {
  SCOPES,
  spreadsheetTitle,
  planColumns,
  headersFor,
  rowFor,
  formatDateTime,
  qualificationCell,
  sheetCell,
  publicSheets,
  createService,
  ...singleton,
};
