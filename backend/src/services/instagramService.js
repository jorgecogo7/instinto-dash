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

/* ---------- Métricas da conta ---------- */

// Série diária (period=day) de uma métrica, em janelas de 30 dias.
// Devolve { 'AAAA-MM-DD': valor } ou null se a Meta não liberar a métrica.
async function dailyMetric(igId, metric, range) {
  const out = {};
  let any = false;
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
      console.warn(`Instagram: métrica diária ${metric} indisponível (${w.from}–${w.to}):`, e.message);
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
      console.warn(`Instagram: total de ${metric} indisponível (${w.from}–${w.to}):`, e.message);
    }
  }
  return any ? total : null;
}

async function accountTotals(igId, range) {
  const [reachDaily, followsDaily, profileViews, websiteClicks, engaged] = await Promise.all([
    dailyMetric(igId, 'reach', range),
    dailyMetric(igId, 'follower_count', range),
    totalMetric(igId, 'profile_views', range),
    totalMetric(igId, 'website_clicks', range),
    totalMetric(igId, 'accounts_engaged', range),
  ]);
  const sum = (m) => (m ? Object.values(m).reduce((s, v) => s + v, 0) : null);
  return {
    reachDaily, followsDaily,
    reach: sum(reachDaily),
    newFollowers: sum(followsDaily),
    profileVisits: profileViews,
    linkClicks: websiteClicks,
    engagedAccounts: engaged,
  };
}

/* ---------- Perfil dos seguidores ---------- */

async function demographic(igId, breakdown) {
  const attempts = [
    { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown },
    { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown, timeframe: 'this_month' },
  ];
  for (const params of attempts) {
    try {
      const json = await graphGet(`${igId}/insights`, params);
      const row = json.data && json.data[0];
      const results = (row && row.total_value && row.total_value.breakdowns
        && row.total_value.breakdowns[0] && row.total_value.breakdowns[0].results) || [];
      return results
        .map((r) => ({ label: (r.dimension_values || [])[0], value: num(r.value) }))
        .filter((r) => r.label);
    } catch (e) {
      console.warn(`Instagram: perfil dos seguidores por ${breakdown} indisponível:`, e.message);
    }
  }
  return [];
}

const GENDER_LABELS = { F: 'Feminino', M: 'Masculino', U: 'Desconhecido' };
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

async function demographics(igId) {
  const [age, gender, city, country] = await Promise.all(
    ['age', 'gender', 'city', 'country'].map((b) => demographic(igId, b)),
  );
  return {
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

async function mediaInsights(mediaId) {
  for (const metric of MEDIA_INSIGHT_ATTEMPTS) {
    try {
      const json = await graphGet(`${mediaId}/insights`, { metric });
      const out = {};
      (json.data || []).forEach((m) => {
        out[m.name] = num(m.values && m.values[0] && m.values[0].value);
      });
      return out;
    } catch (e) {
      // tenta com menos métricas (algumas não existem pra todo tipo de post)
    }
  }
  return {};
}

async function postsInRange(igId, range) {
  const since = Math.floor(new Date(`${range.from}T00:00:00Z`).getTime() / 1000);
  const until = Math.floor(new Date(`${nextDay(range.to)}T03:00:00Z`).getTime() / 1000);
  const media = await graphGetAll(`${igId}/media`, {
    fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count',
    since: String(since), until: String(until), limit: '50',
  }, 4);

  const recent = media.slice(0, MAX_POSTS_WITH_INSIGHTS);
  const insights = await mapLimit(recent, 5, (m) => mediaInsights(m.id));
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
  const [profile, cur, before, demo, posts] = await Promise.all([
    graphGet(igId, { fields: 'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count' }),
    accountTotals(igId, range),
    accountTotals(igId, prev),
    demographics(igId),
    postsInRange(igId, range).catch((e) => { console.warn('Instagram: posts indisponíveis:', e.message); return []; }),
  ]);

  const delta = (k) => (cur[k] === null || before[k] === null ? null : period.pctDelta(cur[k], before[k]));
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
    },
    daily,
    demographics: demo,
    posts,
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
  cache.set(cacheKey, result, REPORT_CACHE_TTL_SECONDS);
  return result;
}

module.exports = { getOrganicReport };
