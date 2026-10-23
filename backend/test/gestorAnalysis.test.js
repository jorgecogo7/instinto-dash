// node --test test/  (sem dependências)
const test = require('node:test');
const assert = require('node:assert');
const { buildAnalysis } = require('../src/lib/gestorAnalysis');

const ctx = { clientId: 'cliente-x', author: 'Gestor IA', source: 'gestor-api' };

test('aceita análise completa e normaliza prioridade/área', () => {
  const { analysis, error } = buildAnalysis({
    title: 'Setembro', period: { from: '2026-09-01', to: '2026-09-30' }, platforms: ['meta', 'tiktok'],
    summary: 'ok', suggestions: [{ title: 'A', priority: 'Média', area: 'formulario' }, { title: 'B', priority: 'urgente', area: 'xyz' }, { detail: 'sem título' }],
  }, ctx);
  assert.equal(error, undefined);
  assert.equal(analysis.author, 'Gestor IA');
  assert.deepEqual(analysis.platforms, ['meta']);
  assert.equal(analysis.suggestions.length, 2);
  assert.equal(analysis.suggestions[0].priority, 'media');
  assert.equal(analysis.suggestions[1].priority, 'media');
  assert.equal(analysis.suggestions[1].area, 'outro');
  assert.ok(analysis.suggestions.every((s) => s.status === 'pendente'));
});

test('recusa análise vazia', () => {
  assert.ok(buildAnalysis({}, ctx).error);
  assert.ok(buildAnalysis(null, ctx).error);
});

test('recusa período invertido ou incompleto', () => {
  assert.ok(buildAnalysis({ summary: 'x', period: { from: '2026-09-30', to: '2026-09-01' } }, ctx).error);
  assert.ok(buildAnalysis({ summary: 'x', period: { from: '2026-09-01' } }, ctx).error);
});

test('corta textos longos e limita sugestões a 30', () => {
  const { analysis } = buildAnalysis({ summary: 'a'.repeat(20000), suggestions: Array.from({ length: 50 }, (_, i) => ({ title: 'S' + i })) }, ctx);
  assert.equal(analysis.summary.length, 8000);
  assert.equal(analysis.suggestions.length, 30);
});
