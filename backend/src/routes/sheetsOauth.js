/**
 * "Conectar Google Sheets": o admin autoriza a conta Google da agência e
 * a tela mostra o refresh token UMA vez. O token não é salvo no banco
 * nem escrito em log. Quem cola no hPanel é o Jorge, na variável
 * GOOGLE_SHEETS_REFRESH_TOKEN (não mexe no token do Tag Manager).
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const sheets = require('../services/sheetsService');

const callbackRouter = express.Router();
const usedNonces = new Map();

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.tokenSecret).update(`sheets-oauth.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac || !config.tokenSecret) return null;
  const expect = crypto.createHmac('sha256', config.tokenSecret).update(`sheets-oauth.${body}`).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!p || !p.n || !(p.exp > Date.now())) return null;
  for (const [n, exp] of usedNonces) if (exp < Date.now()) usedNonces.delete(n);
  if (usedNonces.has(p.n)) return null;
  usedNonces.set(p.n, p.exp);
  return p;
}

function start(req) {
  if (!config.tokenSecret) throw httpError(500, 'TOKEN_SECRET não configurado.');
  const state = sign({ n: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60 * 1000, u: req.user && req.user.username });
  if (config.useMockData) {
    const local = `${req.protocol}://${req.get('host')}/api/sheets-oauth/callback`;
    return { url: `${local}?code=SIMULACAO&state=${encodeURIComponent(state)}`, mock: true };
  }
  const { clientId, clientSecret, redirectUri } = sheets.oauthClient();
  if (!clientId || !clientSecret) {
    throw httpError(409, 'Falta o cliente OAuth no hPanel (GOOGLE_GTM_CLIENT_ID / GOOGLE_GTM_CLIENT_SECRET, ou GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: sheets.SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirectUri, mock: false };
}

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
  if (!st) return page(res, 400, 'Link expirado', '<h1>Link expirado ou já usado</h1><p>Volte ao painel e clique em <b>Conectar Google Sheets</b> de novo. O link vale 10 minutos e só pode ser usado uma vez.</p>');
  if (req.query.error) return page(res, 400, 'Autorização cancelada', `<h1>Autorização não concluída</h1><p>O Google respondeu: <code>${esc(String(req.query.error).slice(0, 80))}</code>. Volte ao painel e tente de novo.</p>`);
  const code = String(req.query.code || '');
  if (!code) return page(res, 400, 'Sem código', '<h1>O Google não mandou o código de autorização</h1><p>Volte ao painel e tente de novo.</p>');

  let token = '';
  let scopes = [];
  const { clientId, clientSecret, redirectUri } = sheets.oauthClient();
  if (config.useMockData) {
    token = 'SIMULACAO-token-de-teste-nao-funciona-no-Google';
    scopes = sheets.SCOPES;
  } else {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('Conectar Google Sheets: troca do código falhou:', json.error || r.status);
        return page(res, 400, 'Erro', `<h1>O Google recusou a troca do código</h1><p>Erro: <code>${esc(json.error || r.status)}</code>. Confira se o URI de redirecionamento <code>${esc(redirectUri)}</code> está cadastrado no cliente OAuth (tipo Aplicativo da Web, o mesmo "Dash Instinto" do Tag Manager) e tente de novo.</p>`);
      }
      token = json.refresh_token || '';
      scopes = String(json.scope || '').split(/\s+/).filter(Boolean);
    } catch (e) {
      return page(res, 502, 'Erro', '<h1>Não consegui falar com o Google</h1><p>Tente de novo em instantes.</p>');
    }
  }
  console.log(`Conectar Google Sheets: autorização concluída por ${st.u || 'admin'} (token exibido na tela, não salvo).`);
  const need = sheets.SCOPES.map((s) => s.split('/').pop());
  const got = scopes.map((s) => s.split('/').pop());
  const scopeList = need.map((s) => `<li class="${got.includes(s) ? 'ok' : 'bad'}">${got.includes(s) ? 'OK' : 'FALTOU'}: ${esc(s)}</li>`).join('');
  if (!token) {
    return page(res, 200, 'Sem refresh token', `<h1>O Google não mandou um token novo</h1><p class="warn">Isso acontece quando esta conta já tinha autorizado o app antes. Remova o acesso do app em <b>myaccount.google.com/permissions</b> e clique em <b>Conectar Google Sheets</b> de novo. Não apague o token do Tag Manager.</p><ul>${scopeList}</ul>`);
  }
  page(res, 200, 'Token do Google Sheets', `<h1>${config.useMockData ? 'SIMULAÇÃO: ' : ''}Token do Google Sheets gerado</h1>
<p class="warn"><b>Este token aparece só agora.</b> Ele não fica salvo no sistema. Copie, cole no hPanel e feche esta página. Não substitua o <code>GOOGLE_GTM_REFRESH_TOKEN</code>: este aqui é outra variável.</p>
<textarea id="t" readonly>${esc(token)}</textarea><br><button type="button" id="c">Copiar token</button> <span id="m"></span>
<h2 style="font-size:16px;margin-top:22px">Onde colar</h2>
<ol>
<li>hPanel &gt; Websites &gt; api.instintodigital.com.br &gt; Node.js (Variáveis de ambiente).</li>
<li>Crie ou edite a variável <code>GOOGLE_SHEETS_REFRESH_TOKEN</code> e cole o token.</li>
<li>Salve e reinicie o app Node.js.</li>
<li>No painel, em Integrações, o cartão do Google Sheets deve mostrar "Conectado".</li>
</ol>
<h2 style="font-size:16px">Permissões concedidas</h2><ul>${scopeList}</ul>
<script>document.getElementById('c').onclick=function(){var t=document.getElementById('t');t.select();try{navigator.clipboard.writeText(t.value).then(function(){document.getElementById('m').textContent='Copiado.'},function(){document.execCommand('copy');document.getElementById('m').textContent='Copiado.'})}catch(e){document.execCommand('copy');document.getElementById('m').textContent='Copiado.'}}</script>`);
});

module.exports = { callbackRouter, start };
