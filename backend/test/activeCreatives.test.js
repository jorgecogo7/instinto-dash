// node --test test/activeCreatives.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const active = require('../src/lib/activeCreatives');
const kpi = require('../src/lib/kpiPreference');
const mockMetaReport = require('../src/data/mockMetaReport');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

test('os quatro clientes começam ligados e o resto desligado', () => {
  for (const id of ['seiza', 'ara-faria-lima', 's-ntese-moema', 'arvis']) {
    assert.strictEqual(active.effective({ id }), true);
    assert.strictEqual(active.effective({ id, activeCreativesOnly: false }), false);
    assert.strictEqual(kpi.reportOptions({ id }).activeCreativesOnly, true);
  }
  assert.strictEqual(active.effective({ id: 'clinica-exemplo' }), false);
  assert.strictEqual(active.effective({ id: 'clinica-exemplo', activeCreativesOnly: true }), true);
  assert.strictEqual(active.effective({ id: 'clinica-exemplo', activeCreativesOnly: 'off' }), false);
  assert.strictEqual(active.normalize('sim'), true);
  assert.strictEqual(active.normalize('não'), false);
  assert.strictEqual(active.normalize('talvez'), null);
  assert.strictEqual(kpi.reportOptions({ id: 'clinica-exemplo' }, { from: '2026-10-01', to: '2026-10-07', fresh: true }).activeCreativesOnly, false);
});

test('Meta: ativo inclui em análise; pausado, reprovado e pai parado ficam de fora', () => {
  for (const status of ['ACTIVE', 'IN_PROCESS', 'PENDING_REVIEW', 'PREAPPROVED', 'WITH_ISSUES']) {
    assert.strictEqual(active.metaListed({ status }), true, status);
  }
  for (const status of ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED', 'PENDING_BILLING_INFO']) {
    assert.strictEqual(active.metaListed({ status }), false, status);
  }
  assert.strictEqual(active.metaListed({ status: 'ACTIVE', campaignStatus: 'PAUSED' }), false);
  assert.strictEqual(active.metaListed({ status: 'ACTIVE', adsetStatus: 'ARCHIVED' }), false);
  assert.strictEqual(active.metaListed({ status: 'ACTIVE', campaignStatus: 'ACTIVE', adsetStatus: 'ACTIVE' }), true);
  assert.strictEqual(active.metaListed({ status: 'IN_PROCESS', campaignStatus: 'ACTIVE' }), true);
  assert.strictEqual(active.metaListed({}), true);
});

test('sem status nenhum a lista fica; se os outros têm status, o sem status sai', () => {
  const unknown = [{ name: 'a', spend: 10 }, { name: 'b', spend: 4 }];
  assert.strictEqual(active.filterMetaAds(unknown), unknown);
  const mixed = [
    { name: 'on', status: 'ACTIVE', spend: 10 },
    { name: 'off', status: 'PAUSED', spend: 8 },
    { name: 'camp', status: 'CAMPAIGN_PAUSED', spend: 3 },
    { name: 'set', status: 'ADSET_PAUSED', spend: 2 },
    { name: 'review', status: 'PENDING_REVIEW', spend: 1 },
    { name: 'mystery', spend: 5 },
  ];
  assert.deepStrictEqual(active.filterMetaAds(mixed).map((a) => a.name), ['on', 'review']);
});

test('filtrar o relatório não muda totais, campanhas nem a série, e não altera o original', () => {
  const report = mockMetaReport.build({ from: '2026-10-01', to: '2026-10-07' }, 'act_test');
  const paused = report.ads.find((a) => a.status === 'PAUSED');
  assert.ok(paused);
  const shown = active.presentMetaReport(report, true);
  assert.notStrictEqual(shown, report);
  assert.strictEqual(shown.activeCreativesOnly, true);
  assert.strictEqual(shown.totals.spend, report.totals.spend);
  assert.strictEqual(shown.totals.results, report.totals.results);
  assert.strictEqual(shown.previousTotals.spend, report.previousTotals.spend);
  assert.deepStrictEqual(shown.daily, report.daily);
  assert.strictEqual(shown.campaigns.length, report.campaigns.length);
  const camp = shown.campaigns.find((c) => c.name === paused.campaign);
  assert.ok(camp);
  assert.ok(Math.abs(camp.spend - paused.spend) < 0.001);
  assert.ok(shown.ads.every((a) => a.status !== 'PAUSED'));
  assert.ok(!shown.ads.some((a) => a.name === paused.name));
  assert.strictEqual(shown.ads.length, report.ads.length - 1);
  assert.ok(report.ads.some((a) => a.status === 'PAUSED'));
  assert.strictEqual(active.presentMetaReport(report, false), report);
});

test('Google: anúncio, grupo e campanha ENABLED; reprovado fica de fora; em análise fica', () => {
  const on = { adStatus: 'ENABLED', adGroupStatus: 'ENABLED', campaignStatus: 'ENABLED' };
  assert.strictEqual(active.googleListed(on), true);
  assert.strictEqual(active.googleListed({ ...on, approvalStatus: 'APPROVED_LIMITED' }), true);
  assert.strictEqual(active.googleListed({ ...on, approvalStatus: 'UNKNOWN' }), true);
  assert.strictEqual(active.googleListed({ ...on, adStatus: 'PAUSED' }), false);
  assert.strictEqual(active.googleListed({ ...on, adGroupStatus: 'PAUSED' }), false);
  assert.strictEqual(active.googleListed({ ...on, campaignStatus: 'PAUSED' }), false);
  assert.strictEqual(active.googleListed({ ...on, adStatus: 'REMOVED' }), false);
  assert.strictEqual(active.googleListed({ ...on, approvalStatus: 'DISAPPROVED' }), false);
  const rows = [on, { ...on, adStatus: 'PAUSED', name: 'pausa' }, { ...on, approvalStatus: 'DISAPPROVED' }];
  assert.strictEqual(active.filterGoogleAds(rows).length, 1);
  const base = "campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'";
  assert.strictEqual(active.googleAdStrengthWhere(false), base);
  assert.ok(active.googleAdStrengthWhere(true).startsWith(base));
  assert.match(active.googleAdStrengthWhere(true), /DISAPPROVED/);
});

test('a tela tem o interruptor e esconde criativo com listed false sem mexer no gasto da campanha', () => {
  assert.match(html, /id="cdActiveCreatives"/);
  assert.match(html, /Mostrar apenas criativos ativos/);
  assert.match(html, /activeCreativesOnly/);
  assert.match(html, /metaActiveCreativesOnly/);
  assert.match(html, /a\.listed !== false/);
  assert.match(html, /googleActiveCreativesOnly/);
  const kpiStart = html.indexOf('const tSpend = metaCampaigns.reduce');
  const listStart = html.indexOf('const displayCampaigns = hidePaused');
  assert.ok(listStart > 0 && kpiStart > listStart);
  assert.match(html.slice(kpiStart, kpiStart + 180), /c\.n\.spend/);
});
