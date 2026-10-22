const crypto = require('crypto');
const config = require('../config');
const crmStore = require('../data/crmStore');
const crm = require('./crmService');

/**
 * WhatsApp do CRM, pela API oficial da Meta (WhatsApp Cloud API).
 *
 * - Cada cliente liga o próprio número (phone_number_id). A tabela
 *   crm_wa_numbers diz de qual cliente é cada número, então uma mensagem
 *   que chega pelo webhook só entra no CRM do dono do número.
 * - Mensagem nova de um telefone desconhecido cria o contato e um negócio
 *   na primeira etapa do primeiro funil do cliente.
 * - Em modo de teste (USE_MOCK_DATA=true) nada é enviado para a Meta: a
 *   mensagem fica gravada como "simulada".
 *
 * Variáveis de ambiente (hPanel): WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN,
 * WHATSAPP_APP_SECRET (ou META_APP_SECRET), WHATSAPP_API_VERSION (opcional).
 */

const { CrmError, uid, nowIso, str } = crm;
const WINDOW_MS = 24 * 60 * 60 * 1000; // janela de atendimento da Meta

const isMock = () => config.useMockData;

/* ---------- Webhook: verificação e assinatura ---------- */

// GET do webhook: a Meta manda hub.verify_token e espera receber hub.challenge de volta.
function verifyChallenge(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const expected = config.whatsapp.verifyToken;
  if (mode === 'subscribe' && expected && typeof token === 'string' && safeEqual(token, expected)) {
    return String(query['hub.challenge'] || '');
  }
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// POST do webhook: confere o cabeçalho X-Hub-Signature-256 com o segredo do app.
// Sem segredo configurado, só aceita em modo de teste.
function signatureOk(rawBody, header) {
  const secret = config.whatsapp.appSecret;
  if (!secret) return isMock();
  if (!rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(header, expected);
}

/* ---------- Conversas ---------- */

function textOf(m) {
  if (!m) return '';
  switch (m.type) {
    case 'text': return m.text && m.text.body;
    case 'button': return m.button && m.button.text;
    case 'interactive': return (m.interactive && (m.interactive.button_reply || m.interactive.list_reply || {}).title) || '[resposta]';
    case 'image': return (m.image && m.image.caption) || '📷 Imagem';
    case 'video': return (m.video && m.video.caption) || '🎥 Vídeo';
    case 'audio': return '🎤 Áudio';
    case 'document': return `📄 ${(m.document && m.document.filename) || 'Documento'}`;
    case 'sticker': return 'Figurinha';
    case 'location': return '📍 Localização';
    case 'contacts': return '👤 Contato';
    case 'reaction': return null; // reação não vira mensagem
    default: return `[${m.type || 'mensagem'}]`;
  }
}

async function dealForContact(clientId, contactId) {
  const deals = await crmStore.listDeals(clientId);
  return deals.find((d) => d.contactId === contactId) || null;
}

// Mensagem recebida (do webhook ou simulada). Cria contato, conversa e,
// se o contato ainda não tem negócio, um lead na primeira etapa.
async function receiveInbound(clientId, { from, profileName, text, type, waId, at }) {
  const phone = str(from, 40).replace(/\D/g, '');
  if (!phone) return null;
  let contact = await crmStore.findContactByPhone(clientId, phone);
  const ts = at || nowIso();
  if (!contact) {
    contact = {
      id: uid(), clientId, name: str(profileName, 120) || `+${phone}`, phone: `+${phone}`, email: null, company: null,
      tags: [], notes: null, source: 'whatsapp', createdAt: ts, updatedAt: ts,
    };
    await crmStore.addContact(clientId, contact);
  } else if (profileName && (!contact.name || contact.name === contact.phone || contact.name === `+${phone}`)) {
    contact.name = str(profileName, 120);
    contact.updatedAt = nowIso();
    await crmStore.saveContact(clientId, contact);
  }

  let conv = await crmStore.getConversationByContact(clientId, contact.id);
  if (!conv) conv = { id: uid(), contactId: contact.id, assignee: null, unread: 0, status: 'open', createdAt: ts };
  const msg = { id: uid(), conversationId: conv.id, direction: 'in', type: type || 'text', text: str(text, 4096), at: ts, status: 'received', waId: waId || null };
  const isNew = await crmStore.addMessage(clientId, msg);
  if (!isNew) return { duplicate: true };
  Object.assign(conv, { lastAt: ts, lastText: msg.text.slice(0, 160), lastDirection: 'in', lastInboundAt: ts, unread: (conv.unread || 0) + 1, status: 'open' });
  await crmStore.saveConversation(clientId, conv);

  let deal = await dealForContact(clientId, contact.id);
  if (!deal) {
    const pipeline = await crm.getPipeline(clientId);
    const funnel = pipeline.funnels[0];
    deal = {
      id: uid(), clientId, funnelId: funnel.id, contactId: contact.id,
      name: contact.name, phone: contact.phone, email: null, company: null,
      source: 'whatsapp', sourceDetail: 'WhatsApp', value: null, owner: null, tags: [], notes: null,
      stageId: funnel.stages[0].id, stageChangedAt: ts, createdAt: ts, updatedAt: ts, history: [],
    };
    crm.pushHistory(deal, { type: 'created', by: { role: 'system', name: 'WhatsApp' }, to: deal.stageId, text: 'Chegou pelo WhatsApp' });
    await crmStore.addDeal(clientId, deal);
  }
  return { contact, conversation: conv, message: msg, deal };
}

// Corpo do webhook da Meta: entry[].changes[].value com metadata.phone_number_id,
// contacts[], messages[] e statuses[].
async function handleWebhook(body) {
  const result = { messages: 0, statuses: 0, ignored: 0 };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return result;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v || !v.metadata) continue;
      const clientId = await crmStore.clientIdForPhoneNumber(v.metadata.phone_number_id);
      if (!clientId) { result.ignored += 1; continue; }
      const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
      for (const m of v.messages || []) {
        const text = textOf(m);
        if (text === null) continue;
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : nowIso();
        const r = await receiveInbound(clientId, { from: m.from, profileName: names.get(m.from), text, type: m.type, waId: m.id, at });
        if (r && !r.duplicate) result.messages += 1;
      }
      for (const s of v.statuses || []) {
        if (s && s.id && ['sent', 'delivered', 'read', 'failed'].includes(s.status)) {
          if (await crmStore.updateMessageStatusByWaId(clientId, s.id, s.status)) result.statuses += 1;
        }
      }
    }
  }
  return result;
}

async function listConversations(clientId) {
  const [convs, contacts, board] = await Promise.all([
    crmStore.listConversations(clientId), crmStore.listContacts(clientId), crm.getBoard(clientId),
  ]);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const stageById = new Map(board.pipeline.funnels.flatMap((f) => f.stages.map((s) => [s.id, s])));
  const dealByContact = new Map();
  board.deals.forEach((d) => { if (d.contactId && !dealByContact.has(d.contactId)) dealByContact.set(d.contactId, d); });
  return convs.map((c) => {
    const ct = byId.get(c.contactId) || {};
    const d = dealByContact.get(c.contactId);
    const s = d && stageById.get(d.stageId);
    return {
      ...c,
      contact: { id: ct.id, name: ct.name || ct.phone || 'Sem nome', phone: ct.phone || null, tags: ct.tags || [] },
      deal: d ? { id: d.id, stageId: d.stageId, stageName: s ? s.name : null, stageColor: s ? s.color : null, funnelId: d.funnelId } : null,
    };
  });
}

async function getConversation(clientId, id, { markRead } = {}) {
  const conv = await crmStore.getConversation(clientId, id);
  if (!conv) throw new CrmError(404, 'Conversa não encontrada.');
  if (markRead && conv.unread) { conv.unread = 0; await crmStore.saveConversation(clientId, conv); }
  const [messages, contact, deal] = await Promise.all([
    crmStore.listMessages(clientId, id), crmStore.getContact(clientId, conv.contactId), dealForContact(clientId, conv.contactId),
  ]);
  const windowOpen = !!conv.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < WINDOW_MS;
  return { conversation: conv, messages, contact, deal: deal ? { id: deal.id, stageId: deal.stageId, funnelId: deal.funnelId || null, value: deal.value, name: deal.name } : null, windowOpen };
}

async function updateConversation(clientId, id, input) {
  const conv = await crmStore.getConversation(clientId, id);
  if (!conv) throw new CrmError(404, 'Conversa não encontrada.');
  const b = input || {};
  if (b.assignee !== undefined) conv.assignee = str(b.assignee, 80) || null;
  if (b.status !== undefined) {
    if (!['open', 'closed'].includes(b.status)) throw new CrmError(400, 'Situação inválida.');
    conv.status = b.status;
  }
  await crmStore.saveConversation(clientId, conv);
  return conv;
}

async function callGraph(phoneNumberId, payload) {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data && data.error;
    console.warn('WhatsApp: envio recusado pela Meta:', e && e.code, e && e.message);
    throw new CrmError(502, 'A Meta recusou o envio. Confira o número e tente de novo.');
  }
  return data;
}

async function sendMessage(clientId, convId, text, actor) {
  const body = str(text, 4096);
  if (!body) throw new CrmError(400, 'Escreva a mensagem.');
  const conv = await crmStore.getConversation(clientId, convId);
  if (!conv) throw new CrmError(404, 'Conversa não encontrada.');
  const contact = await crmStore.getContact(clientId, conv.contactId);
  if (!contact || !contact.phone) throw new CrmError(400, 'Este contato não tem telefone.');
  const ts = nowIso();
  const msg = { id: uid(), conversationId: conv.id, direction: 'out', type: 'text', text: body, at: ts, status: 'simulated', waId: null, by: { role: actor.role, name: actor.name } };

  if (!isMock()) {
    const settings = await crm.getSettings(clientId);
    const wa = settings.whatsapp;
    if (!wa || !wa.phoneNumberId) throw new CrmError(400, 'O WhatsApp deste CRM ainda não foi conectado.');
    if (!config.whatsapp.token) throw new CrmError(503, 'O WhatsApp ainda não foi configurado no servidor.');
    const windowOpen = conv.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < WINDOW_MS;
    if (!windowOpen) throw new CrmError(400, 'Passaram mais de 24h desde a última mensagem do contato. A Meta só deixa responder com um modelo aprovado.');
    const to = String(contact.phone).replace(/\D/g, '');
    const data = await callGraph(wa.phoneNumberId, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } });
    msg.waId = (data.messages && data.messages[0] && data.messages[0].id) || null;
    msg.status = 'sent';
  }
  await crmStore.addMessage(clientId, msg);
  Object.assign(conv, { lastAt: ts, lastText: body.slice(0, 160), lastDirection: 'out', unread: 0 });
  if (!conv.assignee) conv.assignee = actor.name;
  await crmStore.saveConversation(clientId, conv);
  return msg;
}

// Começa uma conversa com um contato (sem mandar nada ainda).
async function openForContact(clientId, contactId) {
  const contact = await crmStore.getContact(clientId, String(contactId || ''));
  if (!contact) throw new CrmError(404, 'Contato não encontrado.');
  if (!contact.phone) throw new CrmError(400, 'Este contato não tem telefone.');
  let conv = await crmStore.getConversationByContact(clientId, contact.id);
  if (!conv) {
    const ts = nowIso();
    conv = { id: uid(), contactId: contact.id, assignee: null, unread: 0, status: 'open', createdAt: ts, lastAt: ts, lastText: '', lastDirection: null, lastInboundAt: null };
    await crmStore.saveConversation(clientId, conv);
  }
  return conv;
}

module.exports = {
  verifyChallenge, signatureOk, handleWebhook, receiveInbound,
  listConversations, getConversation, updateConversation, sendMessage, openForContact, isMock,
};
