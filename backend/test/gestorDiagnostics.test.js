const test = require('node:test');
const assert = require('node:assert');
const diag = require('../src/services/gestorDiagnostics');

const range = { from: '2026-09-01', to: '2026-09-30' };

// Graph API falsa: só responde GET e registra cada caminho pedido.
function fakeGraph() {
  const calls = [];
  const data = {
    'act_123': { id: 'act_123', name: 'Conta', currency: 'BRL', timezone_name: 'America/Sao_Paulo' },
    'act_123/insights': [
      { campaign_id: 'c1', adset_id: 's1', ad_id: 'a1', ad_name: 'Ad 1', spend: '100.50', impressions: '5000', reach: '2000', clicks: '20', ctr: '0.4', cpc: '5.02', frequency: '4.1', actions: [{ action_type: 'lead', value: '5' }, { action_type: 'link_click', value: '20' }] },
    ],
    'act_123/campaigns': [
      { id: 'c1', name: 'Leads Set', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '5000' },
      { id: 'c9', name: 'Velha', effective_status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' },
    ],
    'act_123/adsets': [
      { id: 's1', name: 'Conj 1', campaign_id: 'c1', effective_status: 'ACTIVE', optimization_goal: 'LINK_CLICKS', destination_type: 'ON_AD',
        targeting: { age_min: 25, age_max: 55, genders: [2], geo_locations: { cities: [{ key: '1', name: 'São Paulo', radius: 10, distance_unit: 'kilometer' }] },
          flexible_spec: [{ interests: [{ id: '6003', name: 'Odontologia' }] }], custom_audiences: [{ id: 'x', name: 'LAL 1%' }], targeting_automation: { advantage_audience: 1 } } },
    ],
    'act_123/ads': [
      { id: 'a1', name: 'Ad 1', adset_id: 's1', campaign_id: 'c1', effective_status: 'ACTIVE',
        creative: { id: 'cr1', thumbnail_url: 'https://t/1.jpg', object_story_spec: { link_data: { message: 'Texto', name: 'Título', description: 'Desc', call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: 'f1' } } } } } },
      { id: 'a9', name: 'Ad velho', adset_id: 's9', campaign_id: 'c9', effective_status: 'PAUSED', creative: {} },
    ],
    f1: { id: 'f1', name: 'Form 1', status: 'ACTIVE', is_optimized_for_quality: false, questions: [{ key: 'full_name', type: 'FULL_NAME' }, { key: 'phone', type: 'PHONE' }] },
  };
  return {
    calls,
    graphGet: async (path, params) => { calls.push(path); if (!(path in data)) throw new Error('nao existe'); return data[path]; },
    graphGetAll: async (path, params) => { calls.push(path); if (!(path in data)) throw new Error('nao existe'); return data[path]; },
  };
}

test('meta: monta campanha, conjunto, anúncio e formulário sem inventar', async () => {
  const g = fakeGraph();
  const d = await diag.fetchMetaDiagnostics('123', range, g);
  assert.deepStrictEqual(Object.keys(d.errors), []);
  assert.strictEqual(d.campaigns.length, 1, 'campanha pausada sem gasto fica de fora');
  assert.strictEqual(d.campaigns[0].dailyBudget, 50);
  assert.strictEqual(d.adSets[0].targeting.genders[0], 'feminino');
  assert.deepStrictEqual(d.adSets[0].targeting.interests, ['Odontologia']);
  assert.strictEqual(d.adSets[0].targeting.advantageAudience, true);
  assert.strictEqual(d.adSets[0].targeting.placements.automatic, true);
  assert.strictEqual(d.ads.length, 1);
  assert.strictEqual(d.ads[0].destination.type, 'formulario');
  assert.strictEqual(d.ads[0].creative.headlines[0], 'Título');
  assert.strictEqual(d.ads[0].metrics.results, 5);
  assert.strictEqual(d.ads[0].metrics.costPerResult, 20.1);
  assert.strictEqual(d.leadForms[0].higherIntent, false);
  const rules = d.signals.map((s) => s.rule);
  ['form_more_volume', 'form_no_qualifying_question', 'advantage_audience_on', 'high_frequency', 'optimization_mismatch', 'low_ctr'].forEach((r) => assert.ok(rules.includes(r), r));
});

test('meta: falha parcial vira errors e o resto segue', async () => {
  const g = fakeGraph();
  const orig = g.graphGet;
  g.graphGet = async (p, q) => { if (p === 'f1') throw new Error('sem permissão no formulário'); return orig(p, q); };
  const d = await diag.fetchMetaDiagnostics('act_123', range, g);
  assert.match(d.errors['leadForm:f1'], /permissão/);
  assert.strictEqual(d.ads.length, 1);
});

test('meta: só lê (nenhum POST/DELETE possível pelas dependências)', async () => {
  const g = fakeGraph();
  await diag.fetchMetaDiagnostics('123', range, g);
  assert.ok(g.calls.every((p) => typeof p === 'string'));
});

test('modo demonstração não inventa dados', async () => {
  const acc = { meta: { status: 'connected', adAccountId: '1' }, google: { status: 'connected', customerId: '1' } };
  const m = await diag.metaFor(acc, range, { metaReal: false });
  const gg = await diag.googleFor(acc, range, { googleReal: false });
  assert.strictEqual(m.available, false); assert.strictEqual(m.testMode, true); assert.strictEqual(m.campaigns, undefined);
  assert.strictEqual(gg.available, false); assert.strictEqual(gg.testMode, true);
  const off = await diag.metaFor({ meta: {} }, range, { metaReal: true });
  assert.strictEqual(off.connected, false);
});

test('google: lê campanhas, palavras-chave, termos e anúncios via GAQL', async () => {
  const queries = [];
  const rows = {
    campaign: [{ campaign: { id: '1', name: 'Pesquisa', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', networkSettings: { targetSearchNetwork: true, targetContentNetwork: true } }, campaignBudget: { amountMicros: '30000000' }, metrics: { costMicros: '90000000', impressions: '1000', clicks: '50', ctr: 0.05, averageCpc: '1800000', conversions: 0 } }],
    keyword_view: [{ campaign: { name: 'Pesquisa' }, adGroup: { name: 'G1' }, adGroupCriterion: { keyword: { text: 'dentista', matchType: 'BROAD' }, qualityInfo: { qualityScore: 6 } }, metrics: { costMicros: '10000000' } }],
    search_term_view: [{ searchTermView: { searchTerm: 'dentista gratis', status: 'NONE' }, campaign: { name: 'Pesquisa' }, segments: { searchTermMatchType: 'BROAD' }, metrics: { costMicros: '5000000', conversions: 0 } }],
    ad_group_ad: [{ adGroupAd: { status: 'ENABLED', adStrength: 'POOR', ad: { id: '9', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://x'], responsiveSearchAd: { headlines: [{ text: 'H1' }], descriptions: [{ text: 'D1' }] } } }, metrics: {} }],
    conversion_action: [{ conversionAction: { name: 'Page view', category: 'PAGE_VIEW', primaryForGoal: true } }],
  };
  const runGAQL = async (cid, q) => {
    queries.push(q);
    assert.match(q.trim(), /^SELECT/);
    const from = (q.match(/FROM\s+(\w+)/) || [])[1];
    if (from === 'campaign_criterion') throw new Error('recusado');
    return rows[from] || [];
  };
  const d = await diag.fetchGoogleDiagnostics('123-456', range, { runGAQL, getAccessToken: async () => 'x' });
  assert.strictEqual(d.campaigns[0].dailyBudget, 30);
  assert.strictEqual(d.campaigns[0].network.contentNetwork, true);
  assert.strictEqual(d.keywords[0].matchType, 'BROAD');
  assert.strictEqual(d.searchTerms[0].term, 'dentista gratis');
  assert.deepStrictEqual(d.ads[0].headlines, ['H1']);
  assert.ok(d.errors['negativas (campanha)']);
  const rules = d.signals.map((s) => s.rule);
  ['search_with_display', 'spend_no_conversions', 'broad_match', 'terms_without_conversion', 'weak_primary_conversion'].forEach((r) => assert.ok(rules.includes(r), r));
});

test('targeting: locais com raio, exclusões, gênero 0 = todos', () => {
  const t = diag.summarizeTargeting({
    genders: [0],
    geo_locations: { places: [{ key: 'p1', name: 'Hospital X', radius: 2, distance_unit: 'kilometer' }], neighborhoods: [{ key: 'n1', name: 'Moema' }], subcities: [{ key: 's1', name: 'Zona Sul' }], geo_markets: [{ key: 'DMA:1', name: 'Mercado 1' }] },
    excluded_geo_locations: { regions: [{ key: '1', name: 'Bahia' }] },
  });
  assert.deepStrictEqual(t.genders, ['todos']);
  assert.deepStrictEqual(t.geo.places, ['Hospital X (+2 kilometer)']);
  assert.deepStrictEqual(t.geo.neighborhoods, ['Moema']);
  assert.deepStrictEqual(t.geo.subcities, ['Zona Sul']);
  assert.deepStrictEqual(t.geo.geoMarkets, ['Mercado 1']);
  assert.deepStrictEqual(t.excludedGeo.regions, ['Bahia']);
  assert.deepStrictEqual(diag.summarizeTargeting({ genders: [1, 2] }).genders, ['masculino', 'feminino']);
});

test('destino: perfil do Instagram não vira site', () => {
  const d1 = diag.adDestination({ object_story_spec: { link_data: { call_to_action: { type: 'VIEW_INSTAGRAM_PROFILE' } } } }, {});
  assert.strictEqual(d1.type, 'perfil_instagram');
  const d2 = diag.adDestination({ call_to_action: { type: 'INSTAGRAM_PROFILE' } }, { destination_type: 'INSTAGRAM_PROFILE' });
  assert.strictEqual(d2.type, 'perfil_instagram');
  assert.strictEqual(diag.adDestination({ link_url: 'https://site.com' }, {}).type, 'site');
});

test('formulário sem acesso: mensagem própria de formulário, com o detalhe da Meta', async () => {
  const g = fakeGraph();
  const orig = g.graphGet;
  g.graphGet = async (path, params) => {
    if (path === 'f1') { const e = new Error('A Meta não encontrou essa conta de anúncios'); e.code = 100; e.raw = 'Object with ID f1 does not exist'; throw e; }
    return orig(path, params);
  };
  const d = await diag.fetchMetaDiagnostics('123', range, g);
  const msg = d.errors['leadForm:f1'];
  assert.ok(msg.startsWith('Não foi possível ler o formulário'), msg);
  assert.ok(msg.includes('Object with ID f1 does not exist'));
  assert.ok(!/conta de anúncios/.test(msg));
});

test('criativo dinâmico sem texto: usa a mensagem da publicação e tolera falha', async () => {
  const g = fakeGraph();
  const orig = g.graphGet;
  let fail = false;
  g.graphGetAll = (() => { const o = g.graphGetAll; return async (path, params) => {
    const r = await o(path, params);
    if (path === 'act_123/ads') return r.map((a) => (a.id === 'a1' ? { ...a, creative: { id: 'cr1', effective_object_story_id: 'pg_post', asset_feed_spec: { titles: [{ text: 'T1' }, { text: 'T2' }] } } } : a));
    return r;
  }; })();
  g.graphGet = async (path, params) => {
    if (path === 'pg_post') { if (fail) throw new Error('sem acesso'); return { message: 'Texto do post' }; }
    return orig(path, params);
  };
  let d = await diag.fetchMetaDiagnostics('123', range, g);
  assert.deepStrictEqual(d.ads[0].creative.primaryTexts, ['Texto do post']);
  assert.strictEqual(d.ads[0].creative.primaryTextSource, 'publicacao');
  fail = true;
  d = await diag.fetchMetaDiagnostics('123', range, g);
  assert.deepStrictEqual(d.ads[0].creative.primaryTexts, []);
  assert.ok(!Object.keys(d.errors).some((k) => k.includes('post')));
});
