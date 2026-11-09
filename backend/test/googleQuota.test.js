// node --test test/googleQuota.test.js
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'sec';
process.env.GOOGLE_REFRESH_TOKEN = 'rt';
process.env.GOOGLE_DEVELOPER_TOKEN = 'dev';
process.env.GOOGLE_LOGIN_CUSTOMER_ID = '111-222-3333';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const quota = require('../src/lib/googleQuota');
const period = require('../src/lib/period');
const google = require('../src/services/googleService');
const health = require('../src/services/healthService');
const memCache = require('../src/lib/cache');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const RANGE = { from: '2026-11-01', to: '2026-11-02' };
const PREV_FROM = '2026-10-30';
const PREV_TO = '2026-10-31';
const originalFetch = global.fetch;

function json(body) {
  return { json: async () => body };
}

function campaignRow(id, name, status, date, metrics) {
  return {
    campaign: { id, name, status, advertisingChannelType: 'SEARCH' },
    segments: { date },
    metrics,
  };
}

const CAMPAIGN_ROWS = [
  campaignRow('1', 'Marca', 'ENABLED', '2026-11-01', { costMicros: '2000000', clicks: '2', impressions: '100', conversions: 1, allConversions: 2, absoluteTopImpressionPercentage: 0.5, conversionsValue: 4 }),
  campaignRow('1', 'Marca', 'ENABLED', '2026-11-02', { costMicros: '2000000', clicks: '2', impressions: '100', conversions: 1, allConversions: 2, absoluteTopImpressionPercentage: 0.5, conversionsValue: 4 }),
  campaignRow('2', 'Pausada', 'PAUSED', '2026-11-01', { costMicros: '5000000', clicks: '5', impressions: '50', conversions: 0, allConversions: 0, absoluteTopImpressionPercentage: 0, conversionsValue: 0 }),
  campaignRow('1', 'Marca', 'ENABLED', '2026-10-30', { costMicros: '1000000', clicks: '1', impressions: '10', conversions: 0, allConversions: 0, absoluteTopImpressionPercentage: 0.2, conversionsValue: 0 }),
];

const KEYWORD_ROWS = [{
  adGroupCriterion: { keyword: { text: 'marca', matchType: 'EXACT' }, qualityInfo: { qualityScore: 8 } },
  metrics: { costMicros: '1000000', impressions: '10', clicks: '2', ctr: 0.2, averageCpc: '500000', conversions: 1 },
}];

function rowsFor(query) {
  if (query.includes('gender_view')) {
    return [{ adGroupCriterion: { gender: { type: 'FEMALE' } }, metrics: { impressions: '10', clicks: '2', costMicros: '1000000', conversions: 1 } }];
  }
  if (query.includes('age_range_view')) {
    return [{ adGroupCriterion: { ageRange: { type: 'AGE_RANGE_25_34' } }, metrics: { impressions: '5', clicks: '1', costMicros: '500000', conversions: 0 } }];
  }
  if (query.includes('keyword_view')) return KEYWORD_ROWS;
  if (query.includes('segments.device')) {
    return [{ segments: { device: 'MOBILE' }, metrics: { impressions: '10', clicks: '2', costMicros: '1000000', conversions: 1 } }];
  }
  if (query.includes('segments.date') && query.includes('FROM campaign')) return CAMPAIGN_ROWS;
  return [];
}

const quotaBody = {
  error: {
    message: 'Resource has been exhausted (e.g. check quota).',
    details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'Too many requests. Retry in 41106 seconds.' }] }],
  },
};

let searches = [];

function installFetch({ failGender = false, failGenderHard = false } = {}) {
  searches = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'tok' });
    const query = JSON.parse(opts.body).query;
    searches.push(query);
    if (failGender && query.includes('gender_view')) return json(quotaBody);
    if (failGenderHard && query.includes('gender_view')) {
      return json({ error: { message: 'Request contains an invalid argument.', details: [{ errors: [{ message: 'campo inválido' }] }] } });
    }
    const pageToken = JSON.parse(opts.body).pageToken;
    if (pageToken) return json({ results: [] });
    if (query.includes('keyword_view')) return json({ results: rowsFor(query), nextPageToken: 'p2' });
    return json({ results: rowsFor(query) });
  };
}

test.beforeEach(() => {
  quota.resetForTests();
  memCache.del('google:accessToken');
  installFetch();
});

test.after(() => {
  global.fetch = originalFetch;
});

test('aviso usa hora de São Paulo e a cota fechada dura bem mais que a de hoje', () => {
  const notice = quota.noticeFor(Date.parse('2026-11-09T21:37:00.000Z'));
  assert.equal(notice.message, 'Dados do Google de 18:37; limite da API atingido, atualiza sozinho depois');
  assert.equal(quota.parseRetryMs('Too many requests. Retry in 41106 seconds.', 1000), 1000 + 41106 * 1000);
  assert.equal(quota.reportTtlSeconds({ from: '2020-01-01', to: '2020-01-31' }), quota.CLOSED_TTL_SECONDS);
  assert.equal(quota.CLOSED_TTL_SECONDS, 6 * 60 * 60);
  assert.equal(quota.reportTtlSeconds({ from: period.todaySP(), to: period.todaySP() }), quota.OPEN_TTL_SECONDS);
  assert.equal(quota.OPEN_TTL_SECONDS, 45 * 60);
});

test('o painel mostra o aviso em vez do erro cru da API', () => {
  assert.match(html, /cdGoogleNotice/);
  assert.match(html, /googleQuotaNotice/);
  assert.match(html, /data\.googleNotice/);
  assert.match(html, /google-notice/);
  assert.doesNotMatch(html, /RESOURCE_EXHAUSTED/);
});

test('uma carga junta campanha, período anterior e série, e não repete a consulta', async () => {
  const report = await google.getAccountReport('123-456-7890', RANGE);
  assert.equal(report.campaigns.length, 1);
  assert.equal(report.campaigns[0].name, 'Marca');
  assert.equal(report.campaigns[0].spend, 4);
  assert.equal(report.campaigns[0].clicks, 4);
  assert.equal(report.campaigns[0].impressions, 200);
  assert.equal(report.campaigns[0].ctr, 2);
  assert.equal(report.campaigns[0].cpc, 1);
  assert.equal(report.totals.spend, 4);
  assert.equal(report.previousTotals.spend, 1);
  assert.equal(report.dailySpend.find((d) => d.date === '2026-11-01').spend, 7);
  assert.equal(report.dailySpend.find((d) => d.date === '2026-11-02').spend, 2);
  assert.equal(report.keywords.length, 1);
  assert.equal(report.genderBreakdown[0].label, 'Feminino');
  assert.equal(report.googleNotice, undefined);

  const wide = searches.filter((q) => q.includes(`BETWEEN '${PREV_FROM}' AND '${RANGE.to}'`) && q.includes('campaign.name'));
  assert.equal(wide.length, 1);
  assert.equal(searches.filter((q) => q.includes(`BETWEEN '${PREV_FROM}' AND '${PREV_TO}'`)).length, 0);
  assert.equal(searches.filter((q) => q.includes('gender_view')).length, 1);
  assert.equal(searches.filter((q) => q.includes('age_range_view')).length, 1);
  assert.equal(searches.filter((q) => q.includes('search_term_view')).length, 1);
  // palavra-chave pagina uma vez (nextPageToken) — continua 1 operação a mais, não um loop
  assert.equal(searches.filter((q) => q.includes('keyword_view')).length, 2);
  const first = searches.length;

  const again = await google.getAccountReport('123-456-7890', RANGE);
  assert.equal(again.totals.spend, 4);
  assert.equal(searches.length, first);
});

test('duas chamadas iguais ao mesmo tempo disparam uma carga só', async () => {
  const [a, b] = await Promise.all([
    google.getAccountReport('999', RANGE),
    google.getAccountReport('999', RANGE),
  ]);
  assert.equal(a.totals.spend, 4);
  assert.equal(b, a);
  // 5 blocos + página extra da palavra-chave + 3 extras. Sem o dedupe seriam o dobro.
  assert.equal(searches.length, 9);
});

test('cota estourada no gênero não repete a consulta e devolve o último relatório com aviso', async () => {
  const warm = await google.getAccountReport('555', RANGE);
  assert.equal(warm.totals.spend, 4);
  const afterWarm = searches.length;
  quota.expireFreshForTests();
  quota.trip(Date.now() + 41106 * 1000);
  const stale = await google.getAccountReport('555', RANGE);
  assert.equal(searches.length, afterWarm);
  assert.equal(stale.totals.spend, 4);
  assert.equal(stale.keywords.length, 1);
  assert.match(stale.googleNotice.message, /^Dados do Google de \d{2}:\d{2}; limite da API atingido, atualiza sozinho depois$/);
  assert.doesNotMatch(stale.googleNotice.message, /RESOURCE_EXHAUSTED|Retry in/);
});

test('sem cache, a cota no gênero não dispara o resto e o erro mostrado não é o cru', async () => {
  installFetch({ failGender: true });
  const report = await google.getAccountReport('777', RANGE);
  assert.equal(report.campaigns[0].spend, 4);
  assert.equal(report.genderBreakdown.length, 0);
  assert.match(report.googleNotice.message, /limite da API atingido/);
  assert.equal(searches.filter((q) => q.includes('search_term_view')).length, 0);
  assert.equal(searches.filter((q) => q.includes('ad_group_ad')).length, 0);
  const after = searches.length;
  const again = await google.getAccountReport('777', RANGE);
  assert.equal(searches.length, after);
  assert.equal(again.googleNotice.stale, true);

  quota.resetForTests();
  memCache.del('google:accessToken');
  installFetch({ failGenderHard: true });
  await assert.rejects(() => google.getAccountReport('888', RANGE), /\[gênero\]/);
});

test('criativos ativos e palavras ativas não acrescentam consulta', async () => {
  await google.getAccountReport('321', RANGE);
  const plain = searches.length;
  quota.resetForTests();
  memCache.del('google:accessToken');
  installFetch();
  await google.getAccountReport('321', { ...RANGE, activeCreativesOnly: true, activeKeywordsOnly: true });
  assert.ok(searches.length < plain);
  assert.equal(searches.filter((q) => q.includes('search_term_view')).length, 0);
  assert.equal(searches.filter((q) => q.includes('keyword_view')).length, 2);
  assert.ok(searches.some((q) => q.includes("ad_group_criterion.status = 'ENABLED'")));
  assert.ok(searches.some((q) => q.includes("approval_status != 'DISAPPROVED'")));
  assert.equal(searches.filter((q) => q.includes('gender_view')).length, 1);
  assert.equal(searches.filter((q) => q.includes(`BETWEEN '${PREV_FROM}' AND '${RANGE.to}'`)).length, 1);
});

test('alertas do Google não repetem as 4 consultas enquanto o cache vale, e a cota não vira alerta falso', async () => {
  const account = {
    id: 'h1', name: 'H', status: 'ativo',
    google: { status: 'connected', customerId: '999-000-1111' },
    meta: { status: 'not_connected' },
  };
  await health.checkAccount(account, 0, null);
  const first = searches.length;
  assert.equal(first, 4);
  await health.checkAccount(account, 0, null);
  assert.equal(searches.length, first);

  quota.resetForTests();
  quota.trip(Date.now() + 60 * 60 * 1000);
  const blocked = await health.checkAccount(account, 0, null);
  assert.equal(searches.length, first);
  assert.ok(blocked.errors.some((e) => e.platform === 'google' && /Limite diário/.test(e.message)));
  assert.equal(blocked.alerts.some((a) => a.platform === 'google'), false);
});
