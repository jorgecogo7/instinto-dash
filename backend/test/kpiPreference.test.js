// node --test test/kpiPreference.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kpi = require('../src/lib/kpiPreference');
const { pickResult, accountResultLabel, RESULT_LABELS } = require('../src/services/metaService');

const MSG = 'onsite_conversion.messaging_conversation_started_7d';
const FORM = 'onsite_conversion.lead_grouped';
const act = (type, value) => ({ action_type: type, value: String(value) });

function row(actions, preference) {
  const res = pickResult(actions, preference);
  return { results: res.value, resultLabel: res.type ? RESULT_LABELS[res.type] : null };
}

test('outros clientes continuam no automático', () => {
  assert.strictEqual(kpi.effective({ id: 'clinica-exemplo' }), 'auto');
  assert.strictEqual(kpi.effective({ id: 'seiza', kpiPreference: 'auto' }), 'auto');
  assert.strictEqual(kpi.effective({ id: 'loja', kpiPreference: 'leads' }), 'leads');
  assert.strictEqual(kpi.normalize('LEADS'), 'leads');
  assert.strictEqual(kpi.normalize('conversas'), null);
  assert.deepStrictEqual(kpi.reportOptions({ id: 'loja' }, { from: '2026-10-26', to: '2026-11-01' }), {
    from: '2026-10-26', to: '2026-11-01', kpiPreference: 'auto',
  });
});

test('Ara, Seiza e Síntese priorizam formulário até alguém gravar o contrário', () => {
  for (const id of ['ara-faria-lima', 'seiza', 's-ntese-moema']) {
    assert.strictEqual(kpi.effective({ id }), 'leads');
    assert.strictEqual(kpi.reportOptions({ id }).kpiPreference, 'leads');
  }
});

test('automático: compra ganha de lead e lead ganha de conversa', () => {
  assert.strictEqual(pickResult([act('lead', 3), act('purchase', 1)]).type, 'purchase');
  assert.deepStrictEqual(pickResult([act('lead', 4), act(MSG, 9)]), { type: 'lead', value: 4 });
  assert.deepStrictEqual(pickResult([act(MSG, 9)]), { type: MSG, value: 9 });
  assert.strictEqual(accountResultLabel([row([act(MSG, 9)], 'auto')], 'auto'), 'Conversas iniciadas');
});

test('leads: WhatsApp antigo não vira o resultado quando o Instant Form está zerado', () => {
  const wppOnly = [act(MSG, 12)];
  const formZero = [act(FORM, 0), act(MSG, 2)];
  assert.deepStrictEqual(pickResult(wppOnly, 'leads'), { type: FORM, value: 0 });
  assert.deepStrictEqual(pickResult(formZero, 'leads'), { type: FORM, value: 0 });
  const rows = [row(wppOnly, 'leads'), row(formZero, 'leads')];
  assert.strictEqual(rows.reduce((s, r) => s + r.results, 0), 0);
  assert.strictEqual(accountResultLabel(rows, 'leads'), 'Leads (formulário)');
});

test('leads conta o formulário e não soma a mesma conversão duas vezes', () => {
  const both = [act('lead', 5), act(FORM, 5), act(MSG, 8)];
  assert.deepStrictEqual(pickResult(both, 'leads'), { type: FORM, value: 5 });
  const onlySite = [act('offsite_conversion.fb_pixel_lead', 3), act(MSG, 7)];
  assert.deepStrictEqual(pickResult(onlySite, 'leads'), { type: 'offsite_conversion.fb_pixel_lead', value: 3 });
  assert.strictEqual(accountResultLabel([row(both, 'leads')], 'leads'), 'Leads (formulário)');
});

test('painel esconde Mensagens na preferência de leads e mantém para os outros', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const start = html.indexOf('function metaExtraPanelsHtml(');
  assert.ok(start >= 0);
  let i = html.indexOf('{', start);
  let depth = 0;
  let end = i;
  for (; end < html.length; end += 1) {
    if (html[end] === '{') depth += 1;
    else if (html[end] === '}') {
      depth -= 1;
      if (depth === 0) { end += 1; break; }
    }
  }
  const ctx = {
    kpi2Html: ({ label }) => `<div class="kpi2">${label}</div>`,
    brl2: (v) => String(v),
    intFmt: (v) => String(v),
    pct2: (v) => String(v),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  const t = { purchases: 0, conversations: 8, firstReplies: 3, blocks: 0, replyRate: 10, costPerConversation: 4, purchaseValue: 0, roas: 0, avgTicket: 0, costPerPurchase: 0 };
  const p = { purchases: 0, conversations: 2, firstReplies: 1, blocks: 0, replyRate: 5, costPerConversation: 6, purchaseValue: 0, roas: 0, avgTicket: 0, costPerPurchase: 0 };
  const shown = ctx.metaExtraPanelsHtml(t, p, '');
  const hidden = ctx.metaExtraPanelsHtml(t, p, '', { hideMessages: true });
  assert.match(shown, /Mensagens/);
  assert.match(shown, /Conversas iniciadas/);
  assert.doesNotMatch(hidden, /Mensagens/);
  assert.doesNotMatch(hidden, /Conversas iniciadas/);
});
