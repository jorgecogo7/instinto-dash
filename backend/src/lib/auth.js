const crypto = require('crypto');
const config = require('../config');

/**
 * Login do dono da agência (só uma conta, você) — sem lib externa,
 * usando só o módulo "crypto" que já vem no Node.
 *
 * Senha: nunca guardamos ela em texto puro, só o hash (scrypt, o mesmo
 * algoritmo recomendado pra isso — mais lento de "quebrar" por força
 * bruta do que MD5/SHA1 puro).
 *
 * Sessão: em vez de guardar sessões num banco, geramos um token
 * assinado (HMAC) com data de expiração dentro dele. O servidor só
 * precisa checar a assinatura bater — não precisa lembrar de nada.
 */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

const SESSION_DAYS = 14;

function createSessionToken(username) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ username, expires })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', config.tokenSecret).update(payload).digest('base64url');
  const sigMatches =
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!sigMatches) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() > data.expires) return null; // token expirado
    return data;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, createSessionToken, verifySessionToken };
