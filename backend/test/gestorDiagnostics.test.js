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
