/**
 * Cache em memória bem simples.
 *
 * Com 17+ contas sendo consultadas, sem cache cada refresh de tela
 * dispara uma chamada nova pra cada plataforma x cada conta — isso
 * estoura limite de requisições rápido. Aqui guardamos o resultado
 * por alguns minutos antes de buscar de novo.
 *
 * Para produção com mais de uma instância do servidor rodando, troque
 * isso por Redis (a interface get/set continua igual).
 */

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlSeconds) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

module.exports = { get, set };
