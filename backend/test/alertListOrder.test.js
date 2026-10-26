const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const block = html.match(/\/\* ALERT_ORDER_START \*\/([\s\S]*?)\/\* ALERT_ORDER_END \*\//);
assert.ok(block, 'bloco ALERT_ORDER no index.html');
const { alertItemKey, alertKeyClient, stabilizeAlertOrder, orderByKeys } = new Function(
  `${block[1]}; return { alertItemKey, alertKeyClient, stabilizeAlertOrder, orderByKeys };`
)();

const nippon = 'nippon';
const ana = 'ana';
const jordao = 'jordao';

test('cliente em primeiro continua em primeiro se ainda tem alerta, mesmo com reordenação por nome', () => {
  // Central de Alertas: Nippon tinha mais críticos. Depois do "já vi", todos ficam com 1
  // e a ordenação por nome colocaria Dr. Jordão na frente.
  const prev = [nippon, ana, jordao];
  const naturalDepois = [ana, jordao, nippon];
  const order = stabilizeAlertOrder(prev, naturalDepois, nippon);
  assert.deepEqual(order, [nippon, ana, jordao]);
  assert.equal(alertKeyClient(order[0]), nippon);
  assert.notEqual(order[0], jordao);
});

test('alerta que sai da lista: o próximo da ordem atual assume o topo, não quem o nome puxaria do meio', () => {
  const prev = [
    alertItemKey(nippon, 'meta:balance'),
    alertItemKey(ana, 'meta:status'),
    alertItemKey(jordao, 'meta:rejected'),
  ];
  // Sem o alerta do Nippon, a ordenação por data colocaria Dr. Jordão primeiro.
  const naturalDepois = [
    alertItemKey(jordao, 'meta:rejected'),
    alertItemKey(ana, 'meta:status'),
  ];
  const order = stabilizeAlertOrder(prev, naturalDepois, nippon);
  assert.deepEqual(order.map(alertKeyClient), [ana, jordao]);
  assert.equal(alertKeyClient(order[0]), ana);
});

test('Nippon segue em destaque na Hoje quando ainda tem outro alerta, mesmo que a data favoreça o Dr. Jordão', () => {
  const prev = [
    alertItemKey(nippon, 'meta:balance'),
    alertItemKey(ana, 'meta:status'),
    alertItemKey(jordao, 'meta:rejected'),
    alertItemKey(nippon, 'meta:nodelivery'),
  ];
  const naturalDepois = [
    alertItemKey(jordao, 'meta:rejected'),
    alertItemKey(ana, 'meta:status'),
    alertItemKey(nippon, 'meta:nodelivery'),
  ];
  const order = stabilizeAlertOrder(prev, naturalDepois, nippon);
  const items = order.map(k => ({ key: k, client: alertKeyClient(k) }));
  const shown = orderByKeys(items, order, it => it.key);
  assert.equal(shown[0].client, nippon);
  assert.deepEqual(shown.map(it => it.client), [nippon, ana, jordao]);
});

test('marcar um alerta que não está em primeiro não troca quem está em destaque', () => {
  const prev = [nippon, ana, jordao];
  const naturalDepois = [jordao, nippon, ana];
  const order = stabilizeAlertOrder(prev, naturalDepois, jordao);
  assert.equal(order[0], nippon);
  assert.deepEqual(order, [nippon, ana, jordao]);
});

test('alerta reativado entra sem tomar o lugar de quem já estava em primeiro', () => {
  const prev = [alertItemKey(nippon, 'meta:balance'), alertItemKey(ana, 'meta:status')];
  const naturalDepois = [
    alertItemKey(jordao, 'meta:rejected'),
    alertItemKey(nippon, 'meta:balance'),
    alertItemKey(ana, 'meta:status'),
  ];
  const order = stabilizeAlertOrder(prev, naturalDepois, jordao);
  assert.deepEqual(order.map(alertKeyClient), [nippon, ana, jordao]);
});
