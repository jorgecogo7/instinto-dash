const { verifySessionToken } = require('../lib/auth');
const accountsStore = require('../data/accountsStore');

// Exige um login de CLIENTE válido. Confere no banco se o acesso continua
// ativo e se a senha não foi trocada depois do login (campo "v").
async function requireClientAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = verifySessionToken(token);
  if (!session || session.role !== 'client' || !session.clientId) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login de novo.' });
  }
  try {
    const account = (await accountsStore.getAll()).find((a) => a.id === session.clientId);
    const access = account && account.clientAuth;
    if (!account || account.status === 'inativo' || !access || access.v !== session.v) {
      return res.status(401).json({ error: 'Seu acesso foi alterado. Faça login de novo.' });
    }
    req.client = account;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno.' });
  }
}

module.exports = { requireClientAuth };
