const config = require('../config');
const mockInstagram = require('../data/mockInstagram');
const cache = require('../lib/cache');
const period = require('../lib/period');
const { graphGet, graphGetAll } = require('./metaService');

// 20 min — dado orgânico do Instagram não muda a cada segundo, e cada
// carregamento "frio" faz várias consultas à Graph API.
const REPORT_CACHE_TTL_SECONDS = 60 * 20;
const MAX_POSTS_WITH_INSIGHTS = 40;

function hasRealCredentials() {
  return !config.useMockData && Boolean(config.meta.systemUserToken);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return period.toISODate(d);
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'IG';
}

// Executa tarefas assíncronas com no máximo `limit` ao mesmo tempo.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Motivos de falha de cada consulta (por conta), pra mostrar na tela em vez de engolir.
const WARN = new Map();
function warn(igId, what, e) {
  const msg = `${what}: ${(e && (e.raw || e.message)) || e}`;
  console.warn(`Instagram ${igId} — ${msg}`);
  const list = WARN.get(igId);
  if (list && !list.includes(msg)) list.push(msg);
}

/* ---------- Métricas da conta ---------- */

// Série diária (period=day) de uma métrica, em janelas de 30 dias.
// Devolve { 'AAAA-MM-DD': valor } ou null se a Meta não liberar a métrica.
// follower_count: a Meta só entrega os últimos 30 dias, sem contar hoje.
function clampFollowerRange(range) {
  const today = period.toISODate(new Date(Date.now() - 3 * 3600e3));
  const d = (iso, n) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return period.toISODate(x); };
  const min = d(today, -30), max = d(today, -1);
  const from = range.from < min ? min : range.from;
  const to = range.to > max ? max : range.to;
  return from > to ? null : { from, to };
}

async function dailyMetric(igId, metric, range) {
  const out = {};
  let any = false;
  if (metric === 'follower_count') {
    range = clampFollowerRange(range);
    if (!range) return null; // período todo fora da janela que a Meta libera
  }
  for (const w of period.chunkRange(range, 30)) {
    try {
      const json = await graphGet(`${igId}/insights`, {
        metric, period: 'day', since: w.from, until: nextDay(w.to),
      });
      const values = (json.data && json.data[0] && json.data[0].values) || [];
      values.forEach((v) => {
        const d = String(v.end_time || '').slice(0, 10);
        if (!d) return;
        // end_time é o fim do dia (meia-noite seguinte, horário do Pacífico):
        // o valor pertence ao dia anterior.
        const day = new Date(`${d}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() - 1);
        out[period.toISODate(day)] = num(v.value);
      });
      any = true;
    } catch (e) {
      warn(igId, `métrica diária ${metric}`, e);
    }
  }
  return any ? out : null;
}

// Total de uma métrica "total_value" no período (soma das janelas de 30 dias).
// Devolve null se a Meta não liberar a métrica.
async function totalMetric(igId, metric, range) {
  let total = 0;
  let any = false;
  for (const w of period.chunkRange(range, 30)) {
    try {
      const json = await graphGet(`${igId}/insights`, {
        metric, period: 'day', metric_type: 'total_value', since: w.from, until: nextDay(w.to),
      });
      const row = json.data && json.data[0];
      total += num(row && row.total_value && row.total_value.value);
      any = true;
    } catch (e) {
      warn(igId, `total de ${metric}`, e);
    }
  }
  return any ? total : null;
}

// Total com quebra (ex.: alcance por seguidores × não seguidores, por formato).
async function breakdownMetric(igId, metric, breakdown, range) {
  const out = {};
  let any = false;
  for (const w of period.chunkRange(range, 30)) {
    try {
      const json = await graphGet(`${igId}/insights`, {
        metric, period: 'day', metric_type: 'total_value', breakdown, since: w.from, until: nextDay(w.to),
      });
      const row = json.data && json.data[0];
      const results = (row && row.total_value && row.total_value.breakdowns && row.total_value.breakdowns[0]
        && row.total_value.breakdowns[0].results) || [];
      results.forEach((r) => { const k = (r.dimension_values || [])[0]; if (k) out[k] = (out[k] || 0) + num(r.value); });
      any = true;
    } catch (e) {
      warn(igId, `${metric} por ${breakdown}`, e);
    }
  }
  return any ? out : null;
}

// Melhores horários: seguidores online por hora (média dos últimos dias que a Meta liberar).
async function onlineFollowers(igId) {
  try {
    const today = period.toISODate(new Date(Date.now() - 3 * 3600e3));
    const d = (n) => { const x = new Date(`${today}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return period.toISODate(x); };
    const json = await graphGet(`${igId}/insights`, { metric: 'online_followers', period: 'lifetime', since: d(-7), until: today });
    const values = (json.data && json.data[0] && json.data[0].values) || [];
    const sum = Array(24).fill(0); let days = 0;
    values.forEach((v) => {
      const m = v.value || {};
      if (!Object.keys(m).length) return;
      days++;
      // horas vêm no fuso do Pacífico (UTC-7/-8): converte pra Brasília (UTC-3) ≈ +4/+5h; usa +4.
      Object.entries(m).forEach(([h, c]) => { sum[(Number(h) + 4) % 24] += num(c); });
    });
    return days ? sum.map((v) => Math.round(v / days)) : null;
  } catch (e) {
    warn(igId, 'seguidores online por hora', e);
    return null;
  }
}

async function accountTotals(igId, range, full = true) {
  const [reachDaily, followsDaily, profileViews, websiteClicks, engaged, views, interactions, likes, comments, shares, saves, reachUnique, reachByFollow, reachByType] = await Promise.all([
    dailyMetric(igId, 'reach', range),
    dailyMetric(igId, 'follower_count', range),
    totalMetric(igId, 'profile_views', range),
    totalMetric(igId, 'website_clicks', range),
    totalMetric(igId, 'accounts_engaged', range),
    totalMetric(igId, 'views', range),
    totalMetric(igId, 'total_interactions', range),
    totalMetric(igId, 'likes', range),
    totalMetric(igId, 'comments', range),
    totalMetric(igId, 'shares', range),
    totalMetric(igId, 'saves', range),
    totalMetric(igId, 'reach', range),
    full ? breakdownMetric(igId, 'reach', 'follow_type', range) : null,
    full ? breakdownMetric(igId, 'reach', 'media_product_type', range) : null,
  ]);
  const sum = (m) => (m ? Object.values(m).reduce((s, v) => s + v, 0) : null);
  return {
    reachDaily, followsDaily,
    reach: sum(reachDaily),
    newFollowers: sum(followsDaily),
    profileVisits: profileViews,
    linkClicks: websiteClicks,
    engagedAccounts: engaged,
    views, interactions, likes, comments, shares, saves, reachUnique,
    reachByFollow, reachByType,
  };
}

/* ---------- Perfil dos seguidores ---------- */

// Perfil dos seguidores. A Meta mudou os parâmetros várias vezes; tenta as
// combinações conhecidas e fica com a primeira que vier COM dados. Se só vier
// o público engajado (quem interagiu), usa ele e marca a fonte.
async function demographic(igId, breakdown) {
  const base = { period: 'lifetime', metric_type: 'total_value', breakdown };
  const attempts = [
    { ...base, metric: 'follower_demographics', timeframe: 'this_month', _src: 'followers' },
    { ...base, metric: 'follower_demographics', _src: 'followers' },
    { ...base, metric: 'follower_demographics', timeframe: 'this_week', _src: 'followers' },
    { ...base, metric: 'engaged_audience_demographics', timeframe: 'this_month', _src: 'engaged' },
    { ...base, metric: 'reached_audience_demographics', timeframe: 'this_month', _src: 'reached' },
  ];
  let lastErr = null, emptyRaw = null;
  for (const { _src, ...params } of attempts) {
    try {
      const json = await graphGet(`${igId}/insights`, params);
      const row = json.data && json.data[0];
      const results = (row && row.total_value && row.total_value.breakdowns
        && row.total_value.breakdowns[0] && row.total_value.breakdowns[0].results) || [];
      const rows = results
        .map((r) => ({ label: (r.dimension_values || [])[0], value: num(r.value) }))
        .filter((r) => r.label);
      if (rows.length) return { rows, source: _src };
      emptyRaw = emptyRaw || JSON.stringify(json).slice(0, 160);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) warn(igId, `perfil do público (${breakdown})`, lastErr);
  else if (emptyRaw) warn(igId, `perfil do público (${breakdown}) veio vazio`, emptyRaw);
  return { rows: [], source: null };
}

const GENDER_LABELS = { F: 'Feminino', M: 'Masculino', U: 'Desconhecido' };
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

async function demographics(igId) {
  const res = await Promise.all(
    ['age', 'gender', 'city', 'country'].map((b) => demographic(igId, b)),
  );
  const [age, gender, city, country] = res.map((r) => r.rows);
  const sources = [...new Set(res.map((r) => r.source).filter(Boolean))];
  return {
    source: sources.includes('followers') ? 'followers' : (sources[0] || null),
    age: AGE_ORDER.map((label) => ({ label, value: (age.find((a) => a.label === label) || {}).value || 0 })),
    gender: gender.map((g) => ({ label: GENDER_LABELS[g.label] || g.label, value: g.value }))
      .sort((a, b) => b.value - a.value),
    cities: city.sort((a, b) => b.value - a.value).slice(0, 10),
    countries: country.sort((a, b) => b.value - a.value).slice(0, 10),
  };
}

/* ---------- Publicações do período ---------- */

const MEDIA_INSIGHT_ATTEMPTS = [
  'reach,saved,shares,views,total_interactions',
  'reach,saved,shares,total_interactions',
  'reach,saved',
  'reach',
];

async function mediaInsights(mediaId, igId) {
  let last = null;
  for (const metric of MEDIA_INSIGHT_ATTEMPTS) {
    try {
      const json = await graphGet(`${mediaId}/insights`, { metric });
      const out = {};
      (json.data || []).forEach((m) => {
        out[m.name] = num(m.values && m.values[0] && m.values[0].value);
      });
      return out;
    } catch (e) {
      last = e; // tenta com menos métricas (algumas não existem pra todo tipo de post)
    }
  }
  if (last && igId) warn(igId, 'métricas das publicações', last);
  return {};
}

async function postsInRange(igId, range) {
  // A lista de mídias não filtra por data de forma confiável: busca as mais
  // recentes (vêm da mais nova pra mais antiga) e filtra pelo período aqui.
  const fromTs = new Date(`${range.from}T03:00:00Z`).getTime();
  const toTs = new Date(`${nextDay(range.to)}T03:00:00Z`).getTime();
  const media = [];
  let json = await graphGet(`${igId}/media`, {
    fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count',
    limit: '50',
  });
  for (let page = 0; page < 6; page++) {
    const items = json.data || [];
    media.push(...items);
    const oldest = items.length ? new Date(items[items.length - 1].timestamp).getTime() : 0;
    if (!json.paging || !json.paging.next || oldest < fromTs) break;
    json = await graphGet(json.paging.next);
  }
  const inRange = media.filter((m) => { const t = new Date(m.timestamp).getTime(); return t >= fromTs && t < toTs; });

  const recent = inRange.slice(0, MAX_POSTS_WITH_INSIGHTS);
  const insights = await mapLimit(recent, 5, (m) => mediaInsights(m.id, igId));
  return recent.map((m, i) => {
    const ins = insights[i] || {};
    const isReel = m.media_product_type === 'REELS';
    return {
      id: m.id,
      caption: m.caption || '',
      type: isReel ? 'REEL' : (m.media_type === 'CAROUSEL_ALBUM' ? 'CARROSSEL' : (m.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGEM')),
      thumbnailUrl: m.thumbnail_url || m.media_url || null,
      permalink: m.permalink,
      timestamp: m.timestamp,
      likes: num(m.like_count),
      comments: num(m.comments_count),
      reach: ins.reach ?? null,
      saved: ins.saved ?? null,
      shares: ins.shares ?? null,
      views: ins.views ?? null,
      interactions: ins.total_interactions ?? null,
    };
  });
}

/* ---------- Relatório ---------- */

async function fetchRealReport(igId, range) {
  const prev = period.previousRange(range);
  WARN.set(igId, []);
  const [profile, cur, before, demo, posts, online] = await Promise.all([
    graphGet(igId, { fields: 'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count' }),
    accountTotals(igId, range),
    accountTotals(igId, prev, false),
    demographics(igId),
    postsInRange(igId, range).catch((e) => { warn(igId, 'publicações', e); return []; }),
    onlineFollowers(igId),
  ]);

  const delta = (k) => (cur[k] === null || before[k] === null ? null : period.pctDelta(cur[k], before[k]));
  // Novos seguidores: só compara se o período anterior inteiro estiver na janela de 30 dias da Meta.
  const pc = clampFollowerRange(prev);
  if (!pc || pc.from !== prev.from || pc.to !== prev.to) before.newFollowers = null;
  const daily = period.eachDay(range).map((date) => ({
    date,
    newFollowers: cur.followsDaily ? (cur.followsDaily[date] || 0) : null,
    reach: cur.reachDaily ? (cur.reachDaily[date] || 0) : null,
  }));

  return {
    range,
    previousRange: prev,
    updatedAt: new Date().toISOString(),
    profile: {
      username: profile.username,
      displayName: profile.name || profile.username,
      bio: profile.biography || '',
      link: profile.website || '',
      pictureUrl: profile.profile_picture_url || null,
      avatarInitials: initials(profile.name || profile.username),
      postsCount: num(profile.media_count),
      followersCount: num(profile.followers_count),
      followingCount: num(profile.follows_count),
    },
    metrics: {
      followers: num(profile.followers_count),
      posts: num(profile.media_count),
      postsInPeriod: posts.length,
      newFollowers: cur.newFollowers,
      newFollowersDeltaPct: delta('newFollowers'),
      engagedAccounts: cur.engagedAccounts,
      engagedAccountsDeltaPct: delta('engagedAccounts'),
      reach: cur.reach,
      reachDeltaPct: delta('reach'),
      profileVisits: cur.profileVisits,
      profileVisitsDeltaPct: delta('profileVisits'),
      linkClicks: cur.linkClicks,
      linkClicksDeltaPct: delta('linkClicks'),
      reachUnique: cur.reachUnique, reachUniqueDeltaPct: delta('reachUnique'),
      views: cur.views, viewsDeltaPct: delta('views'),
      interactions: cur.interactions, interactionsDeltaPct: delta('interactions'),
      likes: cur.likes, likesDeltaPct: delta('likes'),
      comments: cur.comments, commentsDeltaPct: delta('comments'),
      shares: cur.shares, sharesDeltaPct: delta('shares'),
      saves: cur.saves, savesDeltaPct: delta('saves'),
      engagementRate: cur.interactions != null && cur.reachUnique ? (cur.interactions / cur.reachUnique) * 100 : null,
    },
    reachByFollow: cur.reachByFollow,
    reachByType: cur.reachByType,
    onlineByHour: online,
    daily,
    demographics: demo,
    posts,
    warnings: (WARN.get(igId) || []).slice(0, 8),
  };
}

/**
 * Perfil, métricas com variação vs período anterior, evolução diária,
 * perfil dos seguidores e publicações do período de uma conta Instagram
 * Business/Creator vinculada à Página do cliente.
 *
 * Sem token da Meta (ou USE_MOCK_DATA=true), ou sem o ID do Instagram
 * cadastrado, devolve os dados de exemplo (com `mock: true`).
 */
async function getOrganicReport(igUserId, options = {}) {
  const range = period.normalizeRange(options.from, options.to);
  const real = hasRealCredentials() && igUserId;
  const cacheKey = `instagram:report:${real ? igUserId : 'mock'}:${range.from}:${range.to}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = real ? await fetchRealReport(igUserId, range) : mockInstagram.build(range);
  // Se alguma métrica falhou, guarda por pouco tempo — pra refletir logo uma permissão corrigida.
  cache.set(cacheKey, result, (result.warnings || []).length ? 120 : REPORT_CACHE_TTL_SECONDS);
  return result;
}

module.exports = { getOrganicReport };
