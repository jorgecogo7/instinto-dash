const express = require('express');
const config = require('../config');
const { verifyPassword, createSessionToken } = require('../lib/auth');
const accountsStore = require('../data/accountsStore');

const router = express.Router();

// POST /api/auth/login — login do dono da agência OU de um cliente.
// O dono entra com o usuário/senha do .env; cada cliente entra com o
// usuário e a senha gerados na aba "Acesso do cliente".
router.post('/login', async (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  if (config.auth.username && config.auth.passwordHash && username === config.auth.username) {
    if (!verifyPassword(password, config.auth.passwordHash)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    return res.json({ token: createSessionToken(username), username, role: 'admin' });
  }

  try {
    const wanted = username.toLowerCase();
    const account = (await accountsStore.getAll()).find((a) => a.clientAuth && a.clientAuth.username === wanted && a.status !== 'inativo');
    if (!account || !verifyPassword(password, account.clientAuth.passwordHash)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    await accountsStore.update(account.id, { clientAuth: { ...account.clientAuth, lastLoginAt: new Date().toISOString() } });
    const token = createSessionToken(wanted, { role: 'client', clientId: account.id, v: account.clientAuth.v });
    return res.json({ token, username: wanted, role: 'client', name: account.name });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Não foi possível entrar agora.' });
  }
});

module.exports = router;
