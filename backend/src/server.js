const express = require('express');
const config = require('./config');
const { securityHeaders, rateLimit, requireApiKey } = require('./middleware/security');

const accountsRoutes = require('./routes/accounts');
const metaRoutes = require('./routes/meta');
const googleRoutes = require('./routes/google');
const insightsRoutes = require('./routes/insights');
const { syncAllAccounts } = require('./lib/syncQueue');

const app = express();
app.use(express.json({ limit: '100kb' })); // limite de tamanho do corpo da requisição, evita abuso com payload gigante

app.use(securityHeaders);
app.use(rateLimit);

// CORS — travado no domínio real do dashboard (não "*" liberado pra
// qualquer site). O navegador manda um "preflight" OPTIONS antes de
// POST/PATCH/DELETE perguntando permissão; respondemos 204 direto.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/accounts', requireApiKey, accountsRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/insights', insightsRoutes);

// Dispara a sincronização de todas as contas (usa a fila com pausa entre
// chamadas — ver src/lib/syncQueue.js). Em produção isso roda num cron
// (a cada 30-60 min, por exemplo), não a cada request.
app.post('/api/sync', requireApiKey, async (req, res) => {
  try {
    const results = await syncAllAccounts();
    res.json({ syncedAccounts: results.length, results });
  } catch (err) {
    console.error(err); // detalhe completo só no log do servidor
    res.status(500).json({ error: 'Não foi possível sincronizar as contas agora.' }); // mensagem genérica pro cliente
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mockData: config.useMockData, apiKeyRequired: !!config.apiSecret });
});

// Handler de erro "pega-tudo": qualquer erro não tratado nas rotas cai
// aqui em vez de vazar stack trace pro cliente (item "vazar conteúdo").
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
});

app.listen(config.port, () => {
  console.log(`Instinto Dash backend rodando em http://localhost:${config.port}`);
  console.log(`Modo mock: ${config.useMockData ? 'ativado (dados de exemplo)' : 'desativado'}`);
  console.log(`Chave de API exigida: ${config.apiSecret ? 'sim' : 'não (defina API_SECRET no .env)'}`);
});
