// node --test test/activeKeywords.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const kw = require('../src/lib/activeKeywords');
const kpi = require('../src/lib/kpiPreference');
const mockGoogle = require('../src/data/mockGoogle');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const on = { criterionStatus: 'ENABLED', adGroupStatus: 'ENABLED', campaignStatus: 'ENABLED', negative: false };

test('os quatro clientes escondem termos por padrão e o resto não', () => {
  for (const id of ['seiza', 'ara-faria-lima', 's-ntese-moema', 'arvis']) {
    assert.strictEqual(kw.effective({ id }), true);
    assert.strictEqual(kw.effective({ id, activeKeywordsOnly: false }), false);
    assert.strictEqual(kpi.reportOptions({ id }).activeKeywordsOnly, true);
    assert.strictEqual(kpi.reportOptions({ id, activeCreativesOnly: false }).activeKeywordsOnly, true);
  }
  assert.strictEqual(kw.effective({ id: 'clinica-exemplo' }), false);
  assert.strictEqual(kw.effective({ id: 'clinica-exemplo', activeKeywordsOnly: true }), true);
  assert.strictEqual(kw.normalize('não'), false);
  assert.strictEqual(kw.normalize('sim'), true);
  assert.strictEqual(kpi.reportOptions({ id: 'loja' }).activeKeywordsOnly, false);
});

test('palavra ativa exige critério, grupo e campanha ENABLED e não pode ser negativa', () => {
  assert.strictEqual(kw.keywordListed(on), true);
  assert.strictEqual(kw.keywordListed({ ...on, criterionStatus: 'PAUSED' }), false);
  assert.strictEqual(kw.keywordListed({ ...on, criterionStatus: 'REMOVED' }), false);
  assert.strictEqual(kw.keywordListed({ ...on, adGroupStatus: 'PAUSED' }), false);
  assert.strictEqual(kw.keywordListed({ ...on, campaignStatus: 'REMOVED' }), false);
  assert.strictEqual(kw.keywordListed({ ...on, negative: true }), false);
  const rows = [
    { keyword: 'marca', ...on, clicks: 10 },
    { keyword: 'pausada', ...on, criterionStatus: 'PAUSED', clicks: 9 },
    { keyword: 'grupo', ...on, adGroupStatus: 'PAUSED', clicks: 8 },
    { keyword: 'campanha', ...on, campaignStatus: 'PAUSED', clicks: 7 },
    { keyword: 'negativa', ...on, negative: true, clicks: 6 },
    { keyword: 'removida', ...on, criterionStatus: 'REMOVED', clicks: 5 },
  ];
  assert.deepStrictEqual(kw.filterKeywords(rows).map((k) => k.keyword), ['marca']);
  assert.match(kw.keywordStatusWhere(), /ad_group_criterion\.status = 'ENABLED'/);
  assert.match(kw.keywordStatusWhere(), /negative = FALSE/);
  assert.match(kw.keywordStatusWhere(), /ad_group\.status = 'ENABLED'/);
  assert.match(kw.keywordStatusWhere(), /campaign\.status = 'ENABLED'/);
});

test('sem status a lista de palavras fica; termos de pesquisa saem e os totais não mudam', () => {
  assert.strictEqual(kw.filterKeywords(mockGoogle.keywords), mockGoogle.keywords);
  const shown = kw.presentGoogleReport(mockGoogle, true);
  assert.notStrictEqual(shown, mockGoogle);
  assert.strictEqual(shown.searchTerms, null);
  assert.strictEqual(shown.activeKeywordsOnly, true);
  assert.strictEqual(shown.totals, mockGoogle.totals);
  assert.strictEqual(shown.campaigns, mockGoogle.campaigns);
  assert.strictEqual(shown.dailySpend, mockGoogle.dailySpend);
  assert.strictEqual(shown.keywords.length, mockGoogle.keywords.length);
  assert.ok(mockGoogle.searchTerms.length > 0);
  assert.strictEqual(kw.presentGoogleReport(mockGoogle, false), mockGoogle);
  const paused = { keyword: 'antiga', criterionStatus: 'PAUSED', adGroupStatus: 'ENABLED', campaignStatus: 'ENABLED', negative: false };
  const mixed = kw.presentGoogleReport({
    totals: { spend: 80 },
    keywords: [{ keyword: 'viva', ...on }, paused],
    searchTerms: [{ term: 'busca solta', spend: 12 }],
    campaigns: [{ name: 'Pesquisa', spend: 80 }],
  }, true);
  assert.strictEqual(mixed.totals.spend, 80);
  assert.strictEqual(mixed.campaigns[0].spend, 80);
  assert.deepStrictEqual(mixed.keywords.map((k) => k.keyword), ['viva']);
  assert.strictEqual(mixed.searchTerms, null);
});

test('a tela tem o interruptor separado e o PDF só lista termo quando o relatório manda', () => {
  assert.match(html, /id="cdActiveKeywords"/);
  assert.match(html, /Ocultar termos de pesquisa \/ mostrar só palavras-chave ativas/);
  assert.match(html, /activeKeywordsOnly/);
  assert.match(html, /googleActiveKeywordsOnly/);
  assert.match(html, /Termos de pesquisa com mais investimento/);
  assert.match(html, /google\.searchTerms/);
});
