// node --test test/  (sem dependências)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const period = require('../src/lib/period');
const { resolveRange } = require('../src/services/adStatusMetrics');

// 26/10/2026 12:00 em São Paulo (UTC-3).
const SP_OCT_26_NOON = new Date('2026-10-26T15:00:00Z');
// 26/10/2026 23:59 em São Paulo: o dia UTC já é 27, o calendário de SP ainda é 26.
const SP_OCT_26_LATE = new Date('2026-10-27T02:59:00Z');
// 27/10/2026 00:00 em São Paulo.
const SP_OCT_27_MIDNIGHT = new Date('2026-10-27T03:00:00Z');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada no painel`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`função ${name} sem fechamento`);
}

function loadPanelRanges() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const names = ['spToday', 'isoDaysAgo', 'lastCompleteDaysRange', 'hjDay', 'mgToday', 'mgAddDays', 'mgRange'];
  const script = names.map((name) => extractFunction(html, name)).join('\n');
  const ctx = { Intl, Date, MG: { period: '7' }, cdCurrentRange: null };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

test('últimos 7 dias termina ontem: 26/10 → 19/10 a 25/10', () => {
  const range = period.defaultRange(7, SP_OCT_26_NOON);
  assert.deepEqual(range, { from: '2026-10-19', to: '2026-10-25' });
  assert.equal(period.daysInRange(range), 7);
  assert.ok(range.to < period.todaySP(SP_OCT_26_NOON));
});

test('últimos 14, 30 e 90 dias também terminam ontem', () => {
  assert.deepEqual(period.defaultRange(14, SP_OCT_26_NOON), { from: '2026-10-12', to: '2026-10-25' });
  assert.deepEqual(period.defaultRange(30, SP_OCT_26_NOON), { from: '2026-09-26', to: '2026-10-25' });
  assert.deepEqual(period.defaultRange(90, SP_OCT_26_NOON), { from: '2026-07-28', to: '2026-10-25' });
  assert.equal(period.daysInRange(period.defaultRange(30, SP_OCT_26_NOON)), 30);
  assert.equal(period.daysInRange(period.defaultRange(90, SP_OCT_26_NOON)), 90);
});

test('o dia em São Paulo não vira com o UTC depois das 21h', () => {
  assert.equal(period.todaySP(SP_OCT_26_LATE), '2026-10-26');
  assert.deepEqual(period.defaultRange(7, SP_OCT_26_LATE), { from: '2026-10-19', to: '2026-10-25' });
  assert.equal(period.todaySP(SP_OCT_27_MIDNIGHT), '2026-10-27');
  assert.deepEqual(period.defaultRange(7, SP_OCT_27_MIDNIGHT), { from: '2026-10-20', to: '2026-10-26' });
});

test('from/to explícito é respeitado, inclusive quando inclui hoje', () => {
  assert.deepEqual(period.normalizeRange('2026-10-26', '2026-10-26'), { from: '2026-10-26', to: '2026-10-26' });
  assert.deepEqual(period.normalizeRange('2026-10-01', '2026-10-26'), { from: '2026-10-01', to: '2026-10-26' });
  const custom = resolveRange('2026-10-20', '2026-10-26');
  assert.equal(custom.isDefault, false);
  assert.deepEqual({ from: custom.from, to: custom.to, days: custom.days }, { from: '2026-10-20', to: '2026-10-26', days: 7 });
});

test('sem from/to, as métricas do Gerenciar usam os 7 dias até ontem', () => {
  const fallback = resolveRange();
  const expected = period.defaultRange(7);
  assert.equal(fallback.isDefault, true);
  assert.deepEqual({ from: fallback.from, to: fallback.to, days: fallback.days }, { ...expected, days: 7 });
  assert.equal(period.daysInRange(fallback), 7);
});

test('o painel calcula o mesmo intervalo que o backend', () => {
  const panel = loadPanelRanges();
  panel.spToday = () => '2026-10-26';
  for (const n of [7, 14, 30, 90]) {
    assert.deepEqual(panel.lastCompleteDaysRange(n, '2026-10-26'), period.defaultRange(n, SP_OCT_26_NOON));
  }
  assert.equal(panel.hjDay(1), '2026-10-25');
  assert.equal(panel.hjDay(7), '2026-10-19');

  panel.MG.period = '7';
  assert.deepEqual(panel.mgRange(), { from: '2026-10-19', to: '2026-10-25' });
  panel.MG.period = '30';
  assert.deepEqual(panel.mgRange(), { from: '2026-09-26', to: '2026-10-25' });
  panel.MG.period = 'today';
  assert.deepEqual(panel.mgRange(), { from: '2026-10-26', to: '2026-10-26' });
  panel.MG.period = 'yesterday';
  assert.deepEqual(panel.mgRange(), { from: '2026-10-25', to: '2026-10-25' });
  panel.cdCurrentRange = { from: '2026-10-01', to: '2026-10-26' };
  panel.MG.period = 'panel';
  assert.deepEqual(panel.mgRange(), { from: '2026-10-01', to: '2026-10-26' });
});
