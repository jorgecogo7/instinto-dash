/**
 * Coloca dados de EXEMPLO no CRM de um cliente, só para testar as telas
 * localmente. Só roda com USE_MOCK_DATA=true explícito, para nunca encher de
 * dado falso um banco de produção. Todo lead criado leva a etiqueta "Exemplo"
 * e os telefones são fictícios (prefixo 99990).
 *
 *   USE_MOCK_DATA=true node scripts/seed-crm-demo.js <clientId>
 */
require('dotenv').config();
const crm = require('../src/services/crmService');
const wa = require('../src/services/whatsappService');
const crmStore = require('../src/data/crmStore');
const db = require('../src/data/db');

const daysAgo = (n, h = 10) => { const d = new Date(Date.now() - n * 864e5); d.setHours(h, 0, 0, 0); return d.toISOString(); };

(async () => {
  if (process.env.USE_MOCK_DATA !== 'true') {
    console.error('Recusado: rode com USE_MOCK_DATA=true (isso é só para teste local).');
    process.exit(1);
  }
  const clientId = process.argv[2];
  if (!clientId) { console.error('Uso: node scripts/seed-crm-demo.js <clientId>'); process.exit(1); }
  const actor = { role: 'system', name: 'Exemplo' };
  const samples = [
    { name: 'Ana Exemplo', phone: '(11) 99990-0001', source: 'form', sourceDetail: 'Formulário de exemplo', value: 1200, stageId: 'novo', d: 1 },
    { name: 'Bruno Exemplo', phone: '(11) 99990-0002', source: 'campaign', sourceDetail: 'Campanha de exemplo', value: 3500, owner: 'Equipe', stageId: 'em_contato', d: 3, tags: ['Qualificado'] },
    { name: 'Carla Exemplo', email: 'carla@example.com', source: 'manual', value: 800, stageId: 'proposta', d: 6, tags: ['Qualificado'] },
    { name: 'Diego Exemplo', phone: '(11) 99990-0004', source: 'manual', value: 5000, stageId: 'negociacao', d: 9, owner: 'Equipe' },
    { name: 'Elisa Exemplo', phone: '(11) 99990-0005', source: 'form', sourceDetail: 'Formulário de exemplo', value: 2200, stageId: 'ganho', d: 12, tags: ['Qualificado'] },
    { name: 'Fábio Exemplo', phone: '(11) 99990-0006', source: 'campaign', value: 1500, stageId: 'perdido', d: 14, tags: ['Desqualificado'] },
    { name: 'Gabi Exemplo', phone: '(11) 99990-0007', source: 'form', value: 900, stageId: 'novo', d: 18 },
    { name: 'Hugo Exemplo', phone: '(11) 99990-0008', source: 'campaign', value: 4200, stageId: 'ganho', d: 22, owner: 'Equipe', tags: ['Qualificado'] },
    { name: 'Íris Exemplo', phone: '(11) 99990-0009', source: 'form', value: 600, stageId: 'em_contato', d: 35 },
    { name: 'João Exemplo', phone: '(11) 99990-0010', source: 'manual', value: 3000, stageId: 'ganho', d: 40, tags: ['Qualificado'] },
    { name: 'Karen Exemplo', phone: '(11) 99990-0011', source: 'campaign', value: 1100, stageId: 'perdido', d: 48, tags: ['Desqualificado'] },
  ];
  const order = ['novo', 'em_contato', 'proposta', 'negociacao', 'ganho'];
  for (const s of samples) {
    const { d, stageId, ...input } = s;
    const deal = await crm.createDeal(clientId, { ...input, tags: ['Exemplo', ...(input.tags || [])], stageId: 'novo' }, actor);
    // Reescreve datas e histórico para os relatórios terem algo para mostrar.
    const created = daysAgo(d);
    deal.createdAt = created; deal.updatedAt = created; deal.history = [{ id: crm.uid(), type: 'created', at: created, by: actor, to: 'novo' }];
    const path = stageId === 'perdido' ? ['novo', 'em_contato', 'perdido'] : order.slice(0, order.indexOf(stageId) + 1);
    path.slice(1).forEach((to, i) => {
      const at = new Date(new Date(created).getTime() + (i + 1) * 864e5 * 0.8).toISOString();
      deal.history.push({ id: crm.uid(), type: 'stage', at, by: actor, from: path[i], to });
      deal.stageChangedAt = at; deal.updatedAt = at;
    });
    deal.stageId = stageId;
    await crmStore.saveDeal(clientId, deal);
  }

  // Conversas de WhatsApp fictícias, pelo mesmo caminho do webhook.
  const chats = [
    { from: '5511999900020', name: 'Lia Exemplo', msgs: ['Oi! Vi o anúncio de vocês', 'Queria saber o valor'], reply: 'Oi Lia! Tudo bem? Já te passo os detalhes.', h: 2 },
    { from: '5511999900021', name: 'Marcos Exemplo', msgs: ['Bom dia, vocês atendem sábado?'], h: 5 },
    { from: '5511999900002', name: 'Bruno Exemplo', msgs: ['Pode me mandar a proposta por aqui?'], reply: 'Claro, Bruno! Mando ainda hoje.', h: 26 },
    { from: '5511999900022', name: 'Nina Exemplo', msgs: ['Olá', 'Ainda tem horário essa semana?'], h: 50 },
  ];
  for (const c of chats) {
    let r;
    for (let i = 0; i < c.msgs.length; i += 1) {
      const at = new Date(Date.now() - c.h * 36e5 + i * 6e4).toISOString();
      r = await wa.receiveInbound(clientId, { from: c.from, profileName: c.name, text: c.msgs[i], type: 'text', at });
    }
    const deal = r.deal;
    if (deal && !(deal.tags || []).includes('Exemplo')) { deal.tags = ['Exemplo', ...(deal.tags || [])]; await crmStore.saveDeal(clientId, deal); }
    const contact = await crmStore.getContact(clientId, r.contact.id);
    if (!(contact.tags || []).includes('Exemplo')) { contact.tags = ['Exemplo', ...(contact.tags || [])]; await crmStore.saveContact(clientId, contact); }
    if (c.reply) await wa.sendMessage(clientId, r.conversation.id, c.reply, { role: 'client', name: 'Equipe' });
  }
  await crm.ensureTags(clientId, ['Exemplo']);
  console.log(`${samples.length} leads e ${chats.length} conversas de exemplo criados no CRM de ${clientId}.`);
  await db.getPool().end();
})().catch((e) => { console.error(e); process.exit(1); });
