const gestorStore = require('../data/gestorStore');

// Chave de API dos gestores (IA). Só vale nas rotas /api/gestor (ler métricas
// e gravar análises). Não é sessão de login: nas rotas da agência e do
// cliente ela é recusada (401), então não dá pra publicar, pausar ou editar nada.
async function requireGestorKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-gestor-key'] || '').trim();
  try {
    if (!key) {
      if (!(await gestorStore.countActiveKeys())) {
        return res.status(503).json({ error: 'API dos gestores ainda não liberada: o Jorge precisa criar uma chave no painel (cliente > Análise do gestor > Acesso dos gestores).', code: 'not_configured' });
      }
      return res.status(401).json({ error: 'Falta a chave: envie o cabeçalho "Authorization: Bearer <chave>".', code: 'missing_key' });
    }
    const rec = await gestorStore.findActiveKey(key);
    if (!rec) return res.status(401).json({ error: 'Chave inválida ou revogada.', code: 'invalid_key' });
    req.gestorKey = { id: rec.id, label: rec.label };
    gestorStore.touchKey(rec).catch(() => {});
    next();
  } catch (err) {
    console.error('Chave de gestor:', err.message);
    res.status(503).json({ error: 'Não foi possível conferir a chave agora (banco indisponível).', code: 'unavailable' });
  }
}

module.exports = { requireGestorKey };
