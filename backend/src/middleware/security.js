const config = require('../config');

/**
 * Camada de segurança do backend, pensada pro estágio atual do projeto
 * (sem login de usuário ainda). Reúne 4 dos itens do checklist:
 *
 * - Restringir acessos: exige uma chave de API em toda escrita
 * - Bot protection: a mesma chave já barra bots genéricos
 * - Rate limit: no máximo N requisições por IP por minuto
 * - Security headers: cabeçalhos básicos contra clickjacking/sniffing
 *
 * Isso NÃO é um substituto de login de verdade — a chave fica visível
 * pra quem abrir o código-fonte do dashboard no navegador (afinal ela
 * precisa estar lá pra ele conseguir chamar a API). O que ela resolve é
 * barrar bots automáticos e gente batendo direto na API por fora do
 * dashboard sem querer/saber que existe. Quando o login for implementado,
 * essa chave pode ser removida ou substituída pelo token de sessão.
 */

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // impede o navegador de "adivinhar" tipo de arquivo
  res.setHeader('X-Frame-Options', 'DENY'); // impede a API ser carregada dentro de um <iframe> de outro site
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // força HTTPS em visitas futuras
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

// Limite simples em memória: X requisições por IP a cada minuto.
// Reseta ao reiniciar o servidor — para um volume de uso maior no
// futuro, trocar por um Redis, mas isso já barra abuso básico agora.
const requestLog = new Map();
const RATE_LIMIT = 60; // por minuto
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - 60_000;

  const entries = (requestLog.get(ip) || []).filter((t) => t > windowStart);
  entries.push(now);
  requestLog.set(ip, entries);

  if (entries.length > RATE_LIMIT) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um pouco e tente de novo.' });
  }
  next();
}

// Exige o cabeçalho X-API-Key em requisições que alteram dados.
function requireApiKey(req, res, next) {
  if (!config.apiSecret) return next(); // se ninguém configurou a chave ainda, não bloqueia (evita travar o app sem querer)
  const key = req.headers['x-api-key'];
  if (key !== config.apiSecret) {
    return res.status(401).json({ error: 'Chave de API ausente ou inválida.' });
  }
  next();
}

module.exports = { securityHeaders, rateLimit, requireApiKey };
