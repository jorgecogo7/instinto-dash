// Script de uso único: gera o Refresh Token do Google Ads.
// Rode com: node get-google-refresh-token.js
//
// Diferente da versão anterior, este script sobe um servidorzinho local
// na porta 4000 e captura a resposta do Google sozinho — você só precisa
// abrir o link, fazer login e clicar em "Permitir". Nada de copiar/colar.

require('dotenv').config();
const http = require('http');
const https = require('https');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4000/auth/google/callback';
const PORT = 4000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('\n⚠ Faltam GOOGLE_CLIENT_ID e/ou GOOGLE_CLIENT_SECRET no seu .env. Preencha os dois antes de rodar este script.\n');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

function exchangeCodeForToken(code) {
  const data = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const req = https.request(
    {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const json = JSON.parse(body);
        if (json.refresh_token) {
          console.log('\n✅ Deu certo! Este é o seu Refresh Token:\n');
          console.log(json.refresh_token);
          console.log('\nCole esse valor em GOOGLE_REFRESH_TOKEN= no seu arquivo .env\n');
        } else {
          console.log('\n⚠ Não veio um refresh_token na resposta. Resposta completa do Google:');
          console.log(json);
          console.log(
            '\nSe já tinha autorizado esse mesmo app antes, tente revogar o acesso em ' +
            'myaccount.google.com/permissions (procure "Instinto Dash Backend") e rode este script de novo.\n'
          );
        }
        process.exit(0);
      });
    }
  );
  req.on('error', (e) => {
    console.error('Erro na requisição:', e.message);
    process.exit(1);
  });
  req.write(data);
  req.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end('Deu erro na autorização. Pode fechar esta aba e olhar o terminal.');
    console.log('\n⚠ O Google devolveu um erro:', error, '\n');
    server.close();
    process.exit(1);
  }

  if (code) {
    res.end('<h2>Pronto! Pode fechar esta aba e voltar pro terminal.</h2>');
    server.close();
    exchangeCodeForToken(code);
  }
});

server.listen(PORT, () => {
  console.log('\n========================================================');
  console.log('Abra este link no navegador e faça login com a conta');
  console.log('Google DONA da sua MCC (a mesma que você usa em ads.google.com):');
  console.log('\n' + authUrl + '\n');
  console.log('Depois de clicar em "Continuar"/"Permitir", volte aqui —');
  console.log('o terminal termina sozinho assim que o Google responder.');
  console.log('========================================================\n');
  console.log('Esperando você autorizar no navegador...\n');
});
