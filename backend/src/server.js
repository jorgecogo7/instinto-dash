const express = require('express');

// Erro dentro de uma rota async (ex.: falha no banco) vira resposta 500 em vez
// de derrubar o processo inteiro — mesmo efeito do pacote express-async-errors.
{
  const Layer = require('express/lib/router/layer');
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return original.call(this, req, res, next);
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}
process.on('unhandledRejection', (err) => console.error('Promessa rejeitada sem tratamento:', err));
const config = require('./config');
const { securityHeaders, rateLimit } = require('./middleware/security');
const { requireAdminAuth } = require('./middleware/adminAuth');

const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const metaRoutes = require('./routes/meta');
const googleRoutes = require('./routes/google');
const instagramRoutes = require('./routes/instagram');
const insightsRoutes = require('./routes/insights');
const feedbackRoutes = require('./routes/feedback');
const leadsRoutes = require('./routes/leads');
const contractsRoutes = require('./routes/contracts');
const formsRoutes = require('./routes/forms');
const clientRoutes = require('./routes/client');
const mediaRoutes = require('./routes/media');
const reportsRoutes = require('./routes/reports');
const alertsRoutes = require('./routes/alerts');
const campaignsRoutes = require('./routes/campaigns');
const healthService = require('./services/healthService');
const reportService = require('./services/reportService');
const { requireClientAuth } = require('./middleware/clientAuth');
const publicRoutes = require('./routes/public');
const crmRoutes = require('./routes/crm');
const { syncAllAccounts } = require('./lib/syncQueue');
const metaSync = require('./lib/metaSync');

const app = express();
// Upload da imagem do criativo (Campanhas) é a única rota com corpo grande.
// Confere o login ANTES de ler os 8 MB; as demais seguem com o limite de 100 kb.
const bigJson = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/assets\/?$/.test(req.path)) {
    return requireAdminAuth(req, res, () => bigJson(req, res, next));
  }
  next();
});
// rawBody: o webhook do WhatsApp confere a assinatura em cima dos bytes originais.
app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/whatsapp/')) req.rawBody = buf; } }));

app.use(securityHeaders);
// Webhook do WhatsApp antes do limite por IP: a Meta manda rajadas de eventos.
app.use('/api/whatsapp', require('./routes/whatsapp'));

// CORS vem ANTES do limite de requisições: se o limite responder 429 sem esses
// cabeçalhos, o navegador esconde a resposta e o painel só vê "Failed to fetch".
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    // Guarda o preflight no navegador por 10 min: bem menos idas ao servidor
    // (e ao CDN, que às vezes devolve 307 e derruba o preflight).
    res.setHeader('Access-Control-Max-Age', '600');
    return res.sendStatus(204);
  }
  next();
});
app.use(rateLimit);

// Login — a única rota administrativa que NÃO exige estar logado (óbvio, é ela que gera o login).
app.use('/api/auth', authRoutes);

// Rota pública — o link que o cliente abre. Sem login, sem chave, só
// enxerga o cliente daquele token específico.
app.use('/api/public', publicRoutes);
// Imagens da Meta com CORS (pro PDF). Sem login: só repassa imagens públicas dos CDNs da Meta.
app.use('/api/media', mediaRoutes);

// Tudo abaixo daqui exige o dono estar logado (token de sessão válido).
app.use('/api/accounts', requireAdminAuth, accountsRoutes);
app.use('/api/meta', requireAdminAuth, metaRoutes);
app.use('/api/google', requireAdminAuth, googleRoutes);
app.use('/api/instagram', requireAdminAuth, instagramRoutes);
app.use('/api/insights', requireAdminAuth, insightsRoutes);
app.use('/api/feedback', requireAdminAuth, feedbackRoutes);
app.use('/api/leads', requireAdminAuth, leadsRoutes);
app.use('/api/contracts', requireAdminAuth, contractsRoutes);
app.use('/api/forms', requireAdminAuth, formsRoutes);
app.use('/api/reports', requireAdminAuth, reportsRoutes);
app.use('/api/alerts', requireAdminAuth, alertsRoutes);
app.use('/api/crm/:clientId', requireAdminAuth, crmRoutes.adminRouter);
app.use('/api/campaigns/:clientId', requireAdminAuth, campaignsRoutes);
// Área do cliente (login próprio de cada cliente).
app.use('/api/client/crm', requireClientAuth, crmRoutes.clientRouter);
app.use('/api/client', requireClientAuth, clientRoutes);

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
    aiConfigured: !!config.anthropic.apiKey,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
});

// Sincronização automática em segundo plano — sem isso, o cache só "esquenta"
// se alguém chamar POST /api/sync manualmente. Assim, na maioria das vezes o
// dashboard já abre com dado pronto, em vez de esperar a Google Ads API
// responder na hora (token + 6 consultas, alguns segundos). Roda pouco depois
// de o servidor subir e depois a cada 20 min (mesmo tempo do cache do relatório).
const SYNC_INTERVAL_MS = 20 * 60 * 1000;
function runBackgroundSync() {
  syncAllAccounts().catch((err) => console.error('Sincronização automática falhou:', err));
}

// Renovação automática de contratos — roda no mesmo ritmo da sincronização
// de contas. Só mexe em contratos com autoRenew=true que já venceram.
function runContractAutoRenew() {
  contractsRoutes.autoRenewExpiredContracts()
    .then((renewed) => { if (renewed) console.log(`Renovação automática de contratos: ${renewed} contrato(s) renovado(s).`); })
    .catch((err) => console.error('Renovação automática de contratos falhou:', err));
}

// Relatórios automáticos: confere de hora em hora quem tem relatório vencendo hoje.
function runScheduledReports() {
  reportService.runDue()
    .then((made) => { if (made.length) console.log(`Relatórios automáticos: ${made.length} gerado(s).`); })
    .catch((err) => console.error('Relatórios automáticos falharam:', err));
}
// Sincronização da conta de anúncios da Meta, a cada 3h, para quem ligou "Ativar sync"
// na aba Integrações. Confere a cada 10 min quem já passou de 3h desde a última tentativa
// (a data da última tentativa fica no banco, então reiniciar o servidor não dispara tudo de novo).
function runMetaSyncs() {
  metaSync.runDue()
    .then((ids) => { if (ids.length) console.log(`Sync Meta: ${ids.length} conta(s) sincronizada(s).`); })
    .catch((err) => console.error('Sync Meta falhou:', err));
}
setTimeout(runMetaSyncs, 45 * 1000);
setInterval(runMetaSyncs, 10 * 60 * 1000);

setTimeout(runScheduledReports, 2 * 60 * 1000);
setInterval(runScheduledReports, 60 * 60 * 1000);

// Alertas das contas (saldo, pagamento, reprovação, sem veicular): a cada hora.
function runHealthChecks() {
  healthService.runAll()
    .then((r) => { const n = r.reduce((s, c) => s + c.alerts.length, 0); if (n) console.log(`Alertas: ${n} aberto(s) em ${r.length} conta(s).`); })
    .catch((err) => console.error('Verificação de alertas falhou:', err));
}
setTimeout(runHealthChecks, 60 * 1000);
setInterval(runHealthChecks, 60 * 60 * 1000);

app.listen(config.port, () => {
  console.log(`Sistema Instinto Digital (API) rodando em http://localhost:${config.port}`);
  console.log(`Modo mock: ${config.useMockData ? 'ativado (dados de exemplo)' : 'desativado'}`);
  console.log(`Login configurado: ${config.auth.username ? 'sim' : 'não (defina ADMIN_USERNAME/ADMIN_PASSWORD_HASH)'}`);
  setTimeout(runBackgroundSync, 10 * 1000);
  setInterval(runBackgroundSync, SYNC_INTERVAL_MS);
  setTimeout(runContractAutoRenew, 15 * 1000);
  setInterval(runContractAutoRenew, SYNC_INTERVAL_MS);
});
