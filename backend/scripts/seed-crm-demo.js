/**
 * Coloca alguns leads de EXEMPLO no CRM de um cliente, só para testar a tela
 * localmente. Só roda com USE_MOCK_DATA=true explícito, para nunca encher de
 * dado falso um banco de produção. Todo lead criado leva a tag "Exemplo".
 *
 *   USE_MOCK_DATA=true node scripts/seed-crm-demo.js <clientId>
 */
require('dotenv').config();
const crm = require('../src/services/crmService');
const db = require('../src/data/db');

(async () => {
  if (process.env.USE_MOCK_DATA !== 'true') {
    console.error('Recusado: rode com USE_MOCK_DATA=true (isso é só para teste local).');
    process.exit(1);
  }
  const clientId = process.argv[2];
  if (!clientId) { console.error('Uso: node scripts/seed-crm-demo.js <clientId>'); process.exit(1); }
  const actor = { role: 'system', name: 'Exemplo' };
  const samples = [
    { name: 'Ana Souza', phone: '(11) 98888-1234', email: 'ana@example.com', source: 'form', sourceDetail: 'Formulário de exemplo', value: 1200, stageId: 'novo' },
    { name: 'Bruno Lima', phone: '(21) 97777-4321', source: 'campaign', sourceDetail: 'Campanha de exemplo', value: 3500, owner: 'Equipe', stageId: 'em_contato' },
    { name: 'Carla Mendes', email: 'carla@example.com', source: 'manual', value: 800, stageId: 'proposta' },
    { name: 'Diego Rocha', phone: '(31) 96666-0000', source: 'manual', value: 5000, stageId: 'negociacao' },
    { name: 'Elisa Prado', phone: '(41) 95555-1111', source: 'form', sourceDetail: 'Formulário de exemplo', value: 2200, stageId: 'ganho' },
  ];
  for (const s of samples) await crm.createDeal(clientId, { ...s, tags: ['Exemplo'] }, actor);
  console.log(`${samples.length} leads de exemplo criados no CRM de ${clientId}.`);
  await db.getPool().end();
})().catch((e) => { console.error(e); process.exit(1); });
