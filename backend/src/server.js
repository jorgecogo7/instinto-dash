const express = require('express');
const config = require('./config');
const { securityHeaders, rateLimit } = require('./middleware/security');
const { requireAdminAuth } = require('./middleware/adminAuth');

const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const metaRoutes = require('./routes/meta');
const googleRoutes = require('./routes/google');
const insightsRoutes = require('./routes/insights');
const publicRoutes = require('./routes/public');
const { syncAllAccounts } = require('./lib/syncQueue');

const app = express();
app.use(express.json({ limit: '100kb' }));

app.use(securityHeaders);
app.use(rateLimit);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Login — a única rota administrativa que NÃO exige estar logado (óbvio, é ela que gera o login).
app.use('/api/auth', authRoutes);

// Rota pública — o link que o cliente abre. Sem login, sem chave, só
// enxerga o cliente daquele token específico.
app.use('/api/public', publicRoutes);

// Tudo abaixo daqui exige o dono estar logado (token de sessão válido).
app.use('/api/accounts', requireAdminAuth, accountsRoutes);
app.use('/api/meta', requireAdminAuth, metaRoutes);
app.use('/api/google', requireAdminAuth, googleRoutes);
app.use('/api/insights', requireAdminAuth, insightsRoutes);

app.post('/api/sync', requireAdminAuth, async (req, res) => {
  try {
    const results = await syncAllAccounts();
    res.json({ syncedAccounts: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Não foi possível sincronizar as contas agora.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mockData: config.useMockData,
    loginConfigured: !!(config.auth.username && config.auth.passwordHash),
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
});

app.listen(config.port, () => {
  console.log(`Instinto Dash backend rodando em http://localhost:${config.port}`);
  console.log(`Modo mock: ${config.useMockData ? 'ativado (dados de exemplo)' : 'desativado'}`);
  console.log(`Login configurado: ${config.auth.username ? 'sim' : 'não (defina ADMIN_USERNAME/ADMIN_PASSWORD_HASH)'}`);
});
