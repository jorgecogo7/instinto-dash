const { verifySessionToken } = require('../lib/auth');

// Exige um token de sessão válido (do login do dono) no cabeçalho
// Authorization. Usado nas rotas administrativas — tudo que lista todos
// os clientes, edita, cria ou apaga.
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login de novo.' });
  }
  // Login de cliente nunca acessa rotas da agência.
  if (session.role === 'client') {
    return res.status(403).json({ error: 'Acesso restrito à agência.' });
  }
  req.user = session;
  next();
}

module.exports = { requireAdminAuth };
