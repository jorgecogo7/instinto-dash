/**
 * Métricas "extras" da Meta: e-commerce (compras, valor, ROAS, ticket médio)
 * e mensagens (conversas, primeiras respostas, bloqueios).
 * Compartilhado entre o relatório real e o de exemplo.
 */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
const MSG = {
  conversations: 'onsite_conversion.messaging_conversation_started_7d',
  firstReplies: 'onsite_conversion.messaging_first_reply',
  blocks: 'onsite_conversion.messaging_block',
};
const SUM_KEYS = ['purchases', 'purchaseValue', 'conversations', 'firstReplies', 'blocks'];

function firstOf(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const f = list.find((a) => a.action_type === t);
    if (f) return num(f.value);
  }
  return 0;
}

function extrasFromActions(actions, actionValues) {
  return {
    purchases: Math.round(firstOf(actions, PURCHASE_TYPES)),
    purchaseValue: firstOf(actionValues, PURCHASE_TYPES),
    conversations: Math.round(firstOf(actions, [MSG.conversations])),
    firstReplies: Math.round(firstOf(actions, [MSG.firstReplies])),
    blocks: Math.round(firstOf(actions, [MSG.blocks])),
  };
}

function deriveExtras(t) {
  const spend = num(t.spend);
  return {
    roas: spend > 0 && t.purchaseValue > 0 ? t.purchaseValue / spend : 0,
    avgTicket: t.purchases > 0 ? t.purchaseValue / t.purchases : 0,
    costPerPurchase: t.purchases > 0 ? spend / t.purchases : 0,
    costPerConversation: t.conversations > 0 ? spend / t.conversations : 0,
    replyRate: t.conversations > 0 ? (t.firstReplies / t.conversations) * 100 : 0,
  };
}

function addExtras(target, src) {
  SUM_KEYS.forEach((k) => { target[k] = (target[k] || 0) + (src[k] || 0); });
  return target;
}

const DELTA_KEYS = [...SUM_KEYS, 'roas', 'avgTicket', 'costPerPurchase', 'costPerConversation', 'replyRate'];

module.exports = { extrasFromActions, deriveExtras, addExtras, SUM_KEYS, DELTA_KEYS, PURCHASE_TYPES };
