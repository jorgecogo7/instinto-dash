const express = require('express');
const config = require('./config');

const accountsRoutes = require('./routes/accounts');
const metaRoutes = require('./routes/meta');
const googleRoutes = require('./routes/google');
const insightsRoutes = require('./routes/insights');
const { syncAllAccounts } = require('./lib/syncQueue');

const app = express();
app.use(express.json());

// CORS bem simples pro frontend local — ajuste o domínio quando publicar.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  next();
});

app.use('/api/accounts', accountsRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/insights', insightsRoutes);

// Dispara a sincronização de todas as contas (usa a fila com pausa entre
// chamadas — ver src/lib/syncQueue.js). Em produção isso roda num cron
// (a cada 30-60 min, por exemplo), não a cada request.
app.post('/api/sync', async (req, res) => {
  try {
    const results = await syncAllAccounts();
    res.json({ syncedAccounts: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mockData: config.useMockData });
});

app.listen(config.port, () => {
  console.log(`Instinto Dash backend rodando em http://localhost:${config.port}`);
  console.log(`Modo mock: ${config.useMockData ? 'ativado (dados de exemplo)' : 'desativado'}`);
});
