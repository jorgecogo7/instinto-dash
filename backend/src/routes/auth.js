const express = require('express');
const config = require('../config');
const { verifyPassword, createSessionToken } = require('../lib/auth');

const router = express.Router();

// POST /api/auth/login — único login que existe (o dono da agência).
// Devolve um token de sessão que o dashboard guarda e manda em toda
// chamada administrativa dali pra frente (cabeçalho Authorization).
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!config.auth.username || !config.auth.passwordHash) {
    return res.status(500).json({ error: 'Login ainda não configurado no backend (faltam ADMIN_USERNAME/ADMIN_PASSWORD_HASH).' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }
  if (username !== config.auth.username || !verifyPassword(password, config.auth.passwordHash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  const token = createSessionToken(username);
  res.json({ token, username });
});

module.exports = router;
