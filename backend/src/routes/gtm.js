/**
 * Google Tag Manager por cliente. Só a agência (admin).
 *
 * adminRouter, montado em /api/gtm com requireAdminAuth (cliente recebe 403,
 * sem login recebe 401):
 *   GET  /status                     configuração (sem segredos); ?check=1 confere escopos
 *   POST /oauth/start                devolve o link do Google para "Autorizar Tag Manager"
 *   GET  /:clientId                  contêiner vinculado
 *   POST /:clientId/connect          { publicId: 'GTM-XXXXXXX' }
 *   POST /:clientId/disconnect       desvincula só no sistema (não mexe no GTM)
 *   GET  /:clientId/audit            conferência (versão publicada + rascunho)
 *   POST /:clientId/tags             cria tag no rascunho "Instinto Digital"
 *   GET  /:clientId/pending          alterações pendentes do rascunho
 *   POST /:clientId/publish          { confirm: true, expected: [chaves] } cria versão e publica
 *   GET  /:clientId/log              histórico
 *
 * callbackRouter, montado em /api/gtm-oauth (público, protegido pelo state
 * assinado e de uso único): mostra o refresh token UMA vez na tela.
 * O token nunca é salvo no banco nem escrito em log.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const accountsStore = require('../data/accountsStore');
const logStore = require('../data/gtmLogStore');
const gtm = require('../services/gtmService');

const adminRouter = express.Router();
const callbackRouter = express.Router();

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('Tag Manager:', err.message);
  res.status(status).json({ error: status >= 500 && !err.code ? 'Erro ao falar com o Tag Manager. Tente de novo em instantes.' : err.message, ...(err.code ? { code: err.code } : {}), ...(err.changes ? { changes: err.changes } : {}), ...(err.versionId ? { versionId: err.versionId } : {}) });
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito à agência.' });
  next();
}
adminRouter.use(adminOnly);

/* ---------------- OAuth (Autorizar Tag Manager) ---------------- */

const usedNonces = new Map(); // nonce -> expira em (ms). Em memória: reiniciou, gera outro link.
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.tokenSecret).update(`gtm-oauth.${body}`).digest('base64url');
  return `${body}.${mac}`;
}
function verifyState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac || !config.tokenSecret) return null;
  const expect = crypto.createHmac('sha256', config.tokenSecret).update(`gtm-oauth.${body}`).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!p || !p.n || !(p.exp > Date.now())) return null;
  for (const [n, exp] of usedNonces) if (exp < Date.now()) usedNonces.delete(n);
  if (usedNonces.has(p.n)) return null;
  usedNonces.set(p.n, p.exp);
  return p;
}

function oauthClient() {
  const own = !!config.gtm.clientId;
  return { clientId: own ? config.gtm.clientId : config.google.clientId, clientSecret: own ? config.gtm.clientSecret : config.google.clientSecret };
}

adminRouter.get('/status', async (req, res) => {
  const out = { ...gtm.capabilities() };
  if (req.query.check === '1' && out.ready) {
    try { out.scopes = await gtm.checkScopes(); } catch (e) { out.scopes = { ok: false, error: e.message }; }
  }
  res.json(out);
});

adminRouter.post('/oauth/start', (req, res) => {
  if (!config.tokenSecret) return res.status(500).json({ error: 'TOKEN_SECRET não configurado.' });
  const state = sign({ n: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60 * 1000, u: req.user.username });
  if (config.useMockData) {
    // Modo de teste: não vai ao Google; cai direto na nossa página com um código falso.
    const local = `${req.protocol}://${req.get('host')}/api/gtm-oauth/callback`;
    return res.json({ url: `${local}?code=SIMULACAO&state=${encodeURIComponent(state)}`, mock: true });
  }
  const { clientId, clientSecret } = oauthClient();
  if (!clientId || !clientSecret) return res.status(409).json({ error: 'Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (ou GOOGLE_GTM_CLIENT_ID / GOOGLE_GTM_CLIENT_SECRET) no hPanel.' });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: config.gtm.redirectUri,
    response_type: 'code',
    scope: gtm.SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirectUri: config.gtm.redirectUri });
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(res, status, title, inner) {
  res.status(status);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8e8ea;margin:0;padding:24px}main{max-width:720px;margin:0 auto;background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:24px}h1{font-size:20px;margin:0 0 12px}p,li{line-height:1.55;color:#c9cbd1}code{background:#232836;padding:2px 6px;border-radius:6px}textarea{width:100%;box-sizing:border-box;min-height:96px;background:#0b0d11;color:#fff;border:1px solid #3a4150;border-radius:8px;padding:10px;font:13px ui-monospace,monospace;word-break:break-all}button{margin-top:10px;background:#7c5cff;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer}.warn{background:#3a2a10;border:1px solid #8a6a20;border-radius:8px;padding:10px 12px}.ok{color:#5fd38d}.bad{color:#ff7a7a}</style></head><body><main>${inner}</main></body></html>`);
}

callbackRouter.get('/callback', async (req, res) => {
  const st = verifyState(req.query.state);
  if (!st) return page(res, 400, 'Link expirado', '<h1>Link expirado ou já usado</h1><p>Volte ao painel e clique em <b>Autorizar Tag Manager</b> de novo. O link vale 10 minutos e só pode ser usado uma vez.</p>');
  if (req.query.error) return page(res, 400, 'Autorização cancelada', `<h1>Autorização não concluída</h1><p>O Google respondeu: <code>${esc(String(req.query.error).slice(0, 80))}</code>. Volte ao painel e tente de novo.</p>`);
  const code = String(req.query.code || '');
  if (!code) return page(res, 400, 'Sem código', '<h1>O Google não mandou o código de autorização</h1><p>Volte ao painel e tente de novo.</p>');

  let token; let scopes = [];
  if (config.useMockData) {
    token = 'SIMULACAO-token-de-teste-nao-funciona-no-Google';
    scopes = gtm.SCOPES;
  } else {
    const { clientId, clientSecret } = oauthClient();
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: config.gtm.redirectUri, grant_type: 'authorization_code' }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('Autorizar Tag Manager: troca do código falhou:', json.error || r.status);
        return page(res, 400, 'Erro', `<h1>O Google recusou a troca do código</h1><p>Erro: <code>${esc(json.error || r.status)}</code>. Confira se o URI de redirecionamento <code>${esc(config.gtm.redirectUri)}</code> está cadastrado no cliente OAuth (tipo Aplicativo da Web) e tente de novo.</p>`);
      }
      token = json.refresh_token || '';
      scopes = String(json.scope || '').split(/\s+/).filter(Boolean);
    } catch (e) {
      return page(res, 502, 'Erro', '<h1>Não consegui falar com o Google</h1><p>Tente de novo em instantes.</p>');
    }
  }
  console.log(`Autorizar Tag Manager: autorização concluída por ${st.u || 'admin'} (token exibido na tela, não salvo).`);
  const need = gtm.SCOPES.map((s) => s.split('/').pop());
  const got = scopes.map((s) => s.split('/').pop());
  const scopeList = need.map((s) => `<li class="${got.includes(s) ? 'ok' : 'bad'}">${got.includes(s) ? 'OK' : 'FALTOU'}: ${esc(s)}</li>`).join('');
  if (!token) {
    return page(res, 200, 'Sem refresh token', `<h1>O Google não mandou um token novo</h1><p class="warn">Isso acontece quando esta conta já tinha autorizado antes. Remova o acesso do app em <b>myaccount.google.com/permissions</b> e clique em <b>Autorizar Tag Manager</b> de novo.</p><ul>${scopeList}</ul>`);
  }
  page(res, 200, 'Token do Tag Manager', `<h1>${config.useMockData ? 'SIMULAÇÃO: ' : ''}Token do Tag Manager gerado</h1>
<p class="warn"><b>Este token aparece só agora.</b> Ele não fica salvo no sistema. Copie, cole no hPanel e feche esta página.</p>
<textarea id="t" readonly>${esc(token)}</textarea><br><button type="button" id="c">Copiar token</button> <span id="m"></span>
<h2 style="font-size:16px;margin-top:22px">Onde colar</h2>
<ol><li>hPanel &gt; Websites &gt; api.instintodigital.com.br &gt; Node.js (Variáveis de ambiente).</li>
<li>Crie ou edite a variável <code>GOOGLE_GTM_REFRESH_TOKEN</code> e cole o token.</li>
<li>Salve e reinicie o app Node.js.</li>
<li>No painel, em Integrações, o cartão do Google Tag Manager deve mostrar "Acesso configurado".</li></ol>
<h2 style="font-size:16px">Permissões concedidas</h2><ul>${scopeList}</ul>
<script>document.getElementById('c').onclick=function(){var t=document.getElementById('t');t.select();try{navigator.clipboard.writeText(t.value).then(function(){document.getElementById('m').textContent='Copiado.'},function(){document.execCommand('copy');document.getElementById('m').textContent='Copiado.'})}catch(e){document.execCommand('copy');document.getElementById('m').textContent='Copiado.'}}</script>`);
});

/* ---------------- por cliente ---------------- */

async function loadClient(req, res) {
  const accounts = await accountsStore.getAll();
  const account = accounts.find((a) => a.id === req.params.clientId);
  if (!account) { res.status(404).json({ error: 'Cliente não encontrado.' }); return null; }
  return { account, accounts };
}
function requireLink(account, res) {
  if (!account.gtm || !account.gtm.containerId) { res.status(409).json({ error: 'Este cliente ainda não tem Tag Manager conectado.' }); return null; }
  return account.gtm;
}
function logger(req, account) {
  return (entry) => logStore.add(account.id, {
    at: new Date().toISOString(), by: req.user.username, role: req.user.role, mock: !!config.useMockData,
    publicId: account.gtm && account.gtm.publicId, result: 'ok', ...entry,
  }).catch((e) => console.error('Histórico do Tag Manager:', e.message));
}

adminRouter.get('/:clientId', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    res.json({ linked: r.account.gtm || null, capabilities: gtm.capabilities() });
  } catch (e) { sendError(res, e); }
});

adminRouter.post('/:clientId/connect', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    const found = await gtm.findContainer(req.body && req.body.publicId);
    const link = { ...found, linkedAt: new Date().toISOString(), linkedBy: req.user.username };
    const prev = r.account.gtm && r.account.gtm.publicId;
    await accountsStore.update(r.account.id, { gtm: link });
    const others = r.accounts.filter((a) => a.id !== r.account.id && a.gtm && a.gtm.publicId === link.publicId).map((a) => a.name);
    await logger(req, { ...r.account, gtm: link })({ action: 'connect', detail: prev && prev !== link.publicId ? `Contêiner trocado de ${prev} para ${link.publicId}` : `Contêiner ${link.publicId} conectado` });
    res.json({ linked: link, warning: others.length ? `Atenção: este contêiner também está conectado em ${[...new Set(others)].slice(0, 5).join(', ')}${new Set(others).size > 5 ? ` e mais ${new Set(others).size - 5}` : ''}.` : null });
  } catch (e) { sendError(res, e); }
});

adminRouter.post('/:clientId/disconnect', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    if (!r.account.gtm) return res.json({ linked: null });
    await logger(req, r.account)({ action: 'disconnect', detail: `Contêiner ${r.account.gtm.publicId} desvinculado do sistema (nada foi alterado no Tag Manager)` });
    await accountsStore.update(r.account.id, { gtm: null });
    res.json({ linked: null });
  } catch (e) { sendError(res, e); }
});

adminRouter.get('/:clientId/audit', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    const link = requireLink(r.account, res); if (!link) return;
    res.json(await gtm.getAudit(link));
  } catch (e) { sendError(res, e); }
});

adminRouter.post('/:clientId/tags', async (req, res) => {
  const r = await loadClient(req, res).catch((e) => { sendError(res, e); return null; }); if (!r) return;
  const link = requireLink(r.account, res); if (!link) return;
  try {
    const out = await gtm.createTag(link, req.body || {}, { log: logger(req, r.account), user: req.user.username });
    res.status(201).json(out);
  } catch (e) {
    if (e.status && e.status !== 400) await logger(req, r.account)({ action: 'create_tag', result: e.code === 'duplicate' ? 'recusado' : 'erro', detail: `Falha ao criar tag (${(req.body && req.body.kind) || '?'}): ${e.message}` });
    sendError(res, e);
  }
});

adminRouter.get('/:clientId/pending', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    const link = requireLink(r.account, res); if (!link) return;
    res.json(await gtm.getPending(link));
  } catch (e) { sendError(res, e); }
});

adminRouter.post('/:clientId/publish', async (req, res) => {
  const r = await loadClient(req, res).catch((e) => { sendError(res, e); return null; }); if (!r) return;
  const link = requireLink(r.account, res); if (!link) return;
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Confirmação obrigatória para publicar.' });
  const log = logger(req, r.account);
  try {
    const out = await gtm.publish(link, req.body.expected, { log, user: req.user.username });
    await log({ action: 'publish', detail: `Versão ${out.versionId} publicada com ${out.changes.length} alteração(ões)`, itemId: out.versionId, changes: out.changes.map((c) => `${c.kindLabel} ${c.statusLabel}: ${c.name}`) });
    res.json(out);
  } catch (e) {
    if (e.code !== 'changed' && e.code !== 'nothing') await log({ action: 'publish', result: 'erro', detail: e.message, ...(e.versionId ? { itemId: e.versionId } : {}) });
    sendError(res, e);
  }
});

adminRouter.get('/:clientId/log', async (req, res) => {
  try {
    const r = await loadClient(req, res); if (!r) return;
    res.json({ entries: await logStore.list(r.account.id, req.query.limit) });
  } catch (e) { sendError(res, e); }
});

module.exports = { adminRouter, callbackRouter };
