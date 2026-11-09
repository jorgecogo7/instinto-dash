/**
 * Cota diária da Google Ads API (developer token).
 *
 * A cota renova à meia-noite do Pacífico. Quando estoura, a API responde
 * RESOURCE_EXHAUSTED com "Retry in N seconds". Continuar tentando só
 * gasta o que já acabou e ainda mostra o erro cru no painel.
 *
 * Este módulo:
 *  - abre um disjuntor até o horário que a API pediu, e não deixa passar
 *    nenhuma consulta nova nesse intervalo (também depois de um restart,
 *    se o banco estiver configurado);
 *  - guarda a última resposta boa por chave, com validade curta (dado
 *    fresco) e uma validade bem maior (dado velho, servido só com a cota
 *    estourada);
 *  - junta chamadas idênticas que chegam ao mesmo tempo numa só.
 *
 * A Meta não usa isto.
 */

const config = require('../config');
const period = require('./period');

const OPEN_TTL_SECONDS = 45 * 60;
const CLOSED_TTL_SECONDS = 6 * 60 * 60;
const STALE_SECONDS = 36 * 60 * 60;
const CIRCUIT_FALLBACK_MS = 60 * 60 * 1000;
const CIRCUIT_KEY = '__quota_circuit__';

class GoogleQuotaError extends Error {
  constructor(retryAtMs) {
    super('Limite diário da API do Google Ads atingido. Os dados voltam sozinhos depois que a cota renova.');
    this.name = 'GoogleQuotaError';
    this.code = 'RESOURCE_EXHAUSTED';
    this.retryAt = retryAtMs || null;
  }
}

function isQuotaError(err) {
  if (!err) return false;
  if (err.code === 'RESOURCE_EXHAUSTED' || err.name === 'GoogleQuotaError') return true;
  return /RESOURCE_EXHAUSTED|quotaError/i.test(String(err.message || ''));
}

function parseRetryMs(text, now = Date.now()) {
  const match = String(text || '').match(/Retry in (\d+) seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return now + seconds * 1000;
}

function reportTtlSeconds(range, now = new Date()) {
  const today = period.todaySP(now);
  if (range && range.to >= today) return OPEN_TTL_SECONDS;
  return CLOSED_TTL_SECONDS;
}

function hhmmSP(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
  return `${pick('hour')}:${pick('minute')}`;
}

function noticeFor(cachedAtMs) {
  return {
    stale: true,
    cachedAt: new Date(cachedAtMs).toISOString(),
    message: `Dados do Google de ${hhmmSP(cachedAtMs)}; limite da API atingido, atualiza sozinho depois`,
  };
}

function withNotice(report, cachedAtMs) {
  return { ...report, googleNotice: noticeFor(cachedAtMs) };
}

let openUntil = 0;
const memory = new Map();
const inflight = new Map();
let hydrated = null;

function isOpen(now = Date.now()) {
  return now < openUntil;
}

function openUntilMs() {
  return openUntil || null;
}

function dbEnabled() {
  return !!(config.db && config.db.host);
}

function sweep(now = Date.now()) {
  for (const [key, entry] of memory) {
    if (entry.staleUntil < now) memory.delete(key);
  }
}

async function persist(key, entry) {
  if (!dbEnabled()) return;
  try {
    const db = require('../data/db');
    await db.ensureGoogleCacheTable();
    await db.getPool().query(
      `INSERT INTO google_ads_cache (cache_key, payload, fresh_until, stale_until, cached_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), fresh_until = VALUES(fresh_until),
         stale_until = VALUES(stale_until), cached_at = VALUES(cached_at)`,
      [String(key).slice(0, 191), JSON.stringify(entry.value), entry.freshUntil, entry.staleUntil, entry.cachedAt]
    );
  } catch (err) {
    console.warn('Cache do Google Ads não foi gravado no banco:', err.message);
  }
}

async function loadOne(key) {
  if (!dbEnabled()) return null;
  try {
    const db = require('../data/db');
    await db.ensureGoogleCacheTable();
    const [rows] = await db.getPool().query(
      'SELECT payload, fresh_until, stale_until, cached_at FROM google_ads_cache WHERE cache_key = ?',
      [String(key).slice(0, 191)]
    );
    if (!rows.length) return null;
    const row = rows[0];
    const value = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return {
      value,
      freshUntil: Number(row.fresh_until),
      staleUntil: Number(row.stale_until),
      cachedAt: Number(row.cached_at),
    };
  } catch (err) {
    console.warn('Cache do Google Ads não foi lido do banco:', err.message);
    return null;
  }
}

function persistCircuit() {
  const entry = {
    value: { openUntil },
    freshUntil: openUntil,
    staleUntil: openUntil,
    cachedAt: Date.now(),
  };
  persist(CIRCUIT_KEY, entry).catch(() => {});
}

function trip(retryAtMs, now = Date.now()) {
  const until = retryAtMs && retryAtMs > now ? retryAtMs : now + CIRCUIT_FALLBACK_MS;
  if (until <= openUntil) return openUntil;
  openUntil = until;
  const when = new Date(openUntil).toISOString();
  console.warn(`Google Ads: cota diária esgotada. Sem consultas novas até ${when}.`);
  persistCircuit();
  return openUntil;
}

function hydrate() {
  if (!hydrated) {
    hydrated = (async () => {
      if (!dbEnabled()) return;
      try {
        const db = require('../data/db');
        await db.ensureGoogleCacheTable();
        const now = Date.now();
        await db.getPool().query(
          'DELETE FROM google_ads_cache WHERE stale_until < ? AND cache_key <> ?',
          [now, CIRCUIT_KEY]
        );
        const row = await loadOne(CIRCUIT_KEY);
        if (row && row.value && Number(row.value.openUntil) > openUntil) openUntil = Number(row.value.openUntil);
      } catch (err) {
        console.warn('Cache do Google Ads: banco indisponível:', err.message);
      }
    })();
  }
  return hydrated;
}

function classify(entry, allowStale, now = Date.now()) {
  if (!entry) return null;
  if (now <= entry.freshUntil) return { value: entry.value, cachedAt: entry.cachedAt, stale: false };
  if (allowStale && now <= entry.staleUntil) return { value: entry.value, cachedAt: entry.cachedAt, stale: true };
  return null;
}

async function read(key, allowStale = false) {
  const cached = memory.get(key);
  if (cached) return classify(cached, allowStale);
  const loaded = await loadOne(key);
  if (!loaded || loaded.staleUntil < Date.now()) return null;
  memory.set(key, loaded);
  return classify(loaded, allowStale);
}

async function remember(key, value, freshSeconds, opts = {}) {
  const now = Date.now();
  sweep(now);
  const entry = {
    value,
    freshUntil: opts.staleOnly ? now - 1 : now + freshSeconds * 1000,
    staleUntil: now + (opts.staleSeconds || STALE_SECONDS) * 1000,
    cachedAt: opts.cachedAt || now,
  };
  memory.set(key, entry);
  await persist(key, entry);
  return entry;
}

function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

function expireFreshForTests() {
  const now = Date.now();
  for (const entry of memory.values()) {
    if (entry.freshUntil > now) entry.freshUntil = now - 1;
  }
}

function resetForTests() {
  openUntil = 0;
  memory.clear();
  inflight.clear();
  hydrated = Promise.resolve();
}

module.exports = {
  GoogleQuotaError,
  isQuotaError,
  parseRetryMs,
  reportTtlSeconds,
  noticeFor,
  withNotice,
  isOpen,
  openUntil: openUntilMs,
  trip,
  hydrate,
  read,
  remember,
  dedupe,
  resetForTests,
  expireFreshForTests,
  OPEN_TTL_SECONDS,
  CLOSED_TTL_SECONDS,
  STALE_SECONDS,
};
